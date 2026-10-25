"""Runs a StableDiffusionProcessing job through the Anima DiT sidecar.

The router in processing.process_images() calls this instead of the SD pipeline
when the selected checkpoint belongs to a DiT backend. Everything the rest of
A1111 depends on -- prompts, seeds, infotext, saved files, Processed -- is
produced here; the torch UNet / CLIP paths are never touched.
"""

from __future__ import annotations

import os

from modules import devices, images, model_registry, shared
from modules.backends import anima
from modules.backends.sdcpp_server import SdcppError, server


def _text_encoder_and_vae():
    opts = shared.opts
    text_encoder = model_registry.resolve_component("text_encoders", getattr(opts, "anima_text_encoder", None))
    vae = model_registry.resolve_component("vae", getattr(opts, "anima_vae", None))
    if text_encoder is None or vae is None:
        missing = model_registry.missing_components()
        raise RuntimeError(
            "Anima backend is not configured. Put the model files under "
            + (missing[0] if missing else os.path.join(model_registry.ANIMA_DIR))
            + " (diffusion_models/, text_encoders/, vae/)."
        )
    return text_encoder, vae


def _extra_params(text_encoder, flow_shift):
    params = {
        "Model type": "Anima (DiT)",
        "Backend": "stable-diffusion.cpp",
        "Text encoder": os.path.splitext(os.path.basename(text_encoder))[0],
    }
    if flow_shift:
        params["Flow shift"] = round(float(flow_shift), 3)
    return params


def process_images_via_anima(p, model: model_registry.DitModel):
    from modules import processing  # local import: processing imports this package

    opts = shared.opts
    text_encoder, vae = _text_encoder_and_vae()

    reason = model.unsupported_reason
    if reason:
        raise RuntimeError(
            f"{model.name}: {reason}. Use a 2B Anima model (Nova Anime AM v4.0 or earlier), "
            "or wait for the 2.9B support work."
        )

    shared.state.job = "Anima"
    shared.state.textinfo = f"loading {model.name}"
    server.ensure_running(model.path, text_encoder, vae)

    p.fill_fields_from_opts()
    p.setup_prompts()

    seed = processing.get_fixed_seed(p.seed)
    subseed = processing.get_fixed_seed(p.subseed)
    p.all_seeds = [int(seed) + (x if p.subseed_strength == 0 else 0) for x in range(len(p.all_prompts))]
    p.all_subseeds = [int(subseed) + x for x in range(len(p.all_prompts))]

    # extension scripts are deliberately not run here: they expect a loaded SD
    # model (hypertile, ControlNet, …) and DiT jobs have none
    p.apply_random_picks()

    p.sd_model_name = model.name
    p.sd_model_hash = None
    p.sd_vae_name = os.path.basename(vae)
    p.sd_vae_hash = None

    flow_shift = float(getattr(opts, "anima_flow_shift", 0.0) or 0.0)
    p.extra_generation_params.update(_extra_params(text_encoder, flow_shift))

    init_image = None
    init_images = getattr(p, "init_images", None)
    if init_images:
        init_image = init_images[0]
    mask_image = getattr(p, "image_mask", None)
    if mask_image is None:
        mask_image = getattr(p, "mask", None)
    denoising_strength = getattr(p, "denoising_strength", None)

    total = max(1, p.n_iter * p.batch_size)
    shared.state.job_count = total
    shared.state.job_no = 0

    output_images, infotexts, seeds_out = [], [], []
    save_samples = p.save_samples()

    try:
        for index in range(total):
            if shared.state.interrupted:
                break

            shared.state.job_no = index
            prompt = p.all_prompts[index]
            negative = p.all_negative_prompts[index]
            image_seed = int(p.all_seeds[index])
            image_subseed = int(p.all_subseeds[index])

            payload = anima.build_payload(
                prompt=prompt,
                negative_prompt=negative,
                width=anima.clamp_side(p.width),
                height=anima.clamp_side(p.height),
                steps=p.steps,
                cfg_scale=p.cfg_scale,
                sampler_name=p.sampler_name,
                seed=image_seed,
                flow_shift=flow_shift,
                init_image=init_image,
                mask_image=mask_image,
                denoising_strength=denoising_strength,
            )

            def on_progress(elapsed, index=index):
                shared.state.textinfo = f"Anima {index + 1}/{total} · {elapsed:.0f}s"

            try:
                status = server.wait(
                    server.submit(payload),
                    on_progress=on_progress,
                    cancel_check=lambda: shared.state.interrupted,
                )
            except SdcppError as error:
                if shared.state.interrupted and "cancel" in str(error).lower():
                    break
                raise

            decoded = anima.decode_images(status)
            if not decoded:
                raise SdcppError("stable-diffusion.cpp returned no images")

            image = decoded[0]
            infotext = processing.create_infotext(
                p, [prompt], [image_seed], [image_subseed],
                index=0, all_negative_prompts=[negative],
            )

            if save_samples:
                images.save_image(
                    image, p.outpath_samples, "", image_seed, prompt,
                    opts.samples_format, info=infotext, p=p,
                )

            output_images.append(image)
            infotexts.append(infotext)
            seeds_out.append(image_seed)

        shared.state.textinfo = ""

        if not output_images:
            if shared.state.interrupted:
                return processing.Processed(p, [], seed=-1, info="Interrupted")
            raise RuntimeError("Anima backend produced no images")

        return processing.Processed(
            p, output_images,
            seed=seeds_out[0],
            info=infotexts[0],
            subseed=p.all_subseeds[0],
            all_prompts=p.all_prompts,
            all_negative_prompts=p.all_negative_prompts,
            all_seeds=p.all_seeds,
            all_subseeds=p.all_subseeds,
            infotexts=infotexts,
        )
    finally:
        devices.torch_gc()
