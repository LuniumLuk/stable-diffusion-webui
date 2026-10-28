"""Runs a StableDiffusionProcessing job through the Anima DiT sidecar.

The router in processing.process_images() calls this instead of the SD pipeline
when the selected checkpoint belongs to a DiT backend. Everything the rest of
A1111 depends on -- prompts, seeds, infotext, saved files, Processed -- is
produced here; the torch UNet / CLIP paths are never touched.
"""

from __future__ import annotations

import os
import time

from modules import devices, images, model_registry, prompt_parser, shared
from modules.backends import anima
from modules.backends.sdcpp_server import SdcppError, server

# One try plus two retries: the sd-server intermittently fails to free device memory
# between jobs (batch count > 1 hits it most), and reports it as a failed generation
# with no images.  Retries hand the WebUI's cached blocks back and decode the VAE in
# smaller tiles, the same remedy the Qwen / Krea 2 sidecars use.
JOB_ATTEMPTS = 3
RETRY_DELAY = 3.0
RETRY_TILE_SIZE = 16


def _retryable_failure(failure: str) -> bool:
    """Transient sd-server failures worth another attempt (VRAM / decode flakes)."""
    text = (failure or "").lower()
    return "generation_failed" in text or "returned no results" in text


def _escalate_vae_tiles(payload: dict) -> None:
    """Retry attempts decode the VAE in smaller tiles, which asks for less memory."""
    tiling = dict(payload.get("vae_tiling_params") or {})
    tiling["enabled"] = True
    tiling["tile_size_x"] = RETRY_TILE_SIZE
    tiling["tile_size_y"] = RETRY_TILE_SIZE
    payload["vae_tiling_params"] = tiling


def _generate_with_retries(payload: dict, on_progress, label: str) -> dict:
    """Submits one payload and polls it, retrying transient sd-server failures."""
    failure = ""
    for attempt in range(1, JOB_ATTEMPTS + 1):
        if attempt > 1:
            shared.state.textinfo = f"{label} · retry {attempt} ({failure})"
            time.sleep(RETRY_DELAY)
            devices.torch_gc()
            _escalate_vae_tiles(payload)
        try:
            return server.wait(server.submit(payload), on_progress=on_progress, cancel_check=lambda: shared.state.interrupted)
        except SdcppError as error:
            failure = str(error)
            if attempt == JOB_ATTEMPTS or not _retryable_failure(failure):
                hint = f" (retried {attempt - 1}x; if it persists, try a smaller output size)" if attempt > 1 else ""
                raise SdcppError(f"{failure}{hint}") from error
    raise SdcppError(failure)


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


def _park_sd_model() -> None:
    """Move the loaded SD checkpoint to CPU so the sidecar gets the VRAM.

    The model object survives, and A1111's process_images_inner() already calls
    ensure_model_on_device() before the next SD job, so switching back is cheap.
    """
    from modules import sd_models

    if shared.sd_model is None:
        return

    shared.state.textinfo = "parking the SD checkpoint"
    sd_models.send_model_to_cpu(shared.sd_model)
    devices.torch_gc()


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
    if not server.ready_for(model.path, text_encoder, vae):
        _park_sd_model()
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

    # the sidecar gets what the SD pipeline conditions on: the branch that runs,
    # comments gone, directive lines dropped
    model_prompts = prompt_parser.without_condition_directives(p.all_prompts)
    model_negative_prompts = prompt_parser.without_condition_directives(p.all_negative_prompts)

    # the source prompts (comments and #if blocks intact) are what the PNG infotext and
    # the gallery keep next to the compiled ones - same split as the SD pipeline
    source_prompts = getattr(p, "all_prompts_with_comments", None) or p.all_prompts
    source_negative_prompts = getattr(p, "all_negative_prompts_with_comments", None) or p.all_negative_prompts

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
            prompt, loras, missing_loras = anima.extract_loras(model_prompts[index], model_registry.find_lora)
            if missing_loras:
                raise RuntimeError(
                    f"Anima LoRA not found: {', '.join(missing_loras)}. "
                    f"Put the file in {model_registry.lora_dir()} (installed: "
                    f"{', '.join(model_registry.list_loras()) or 'none'})."
                )
            negative = model_negative_prompts[index]
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
                loras=loras,
                denoising_strength=denoising_strength,
            )

            def on_progress(elapsed, index=index):
                shared.state.textinfo = f"Anima {index + 1}/{total} · {elapsed:.0f}s"

            try:
                status = _generate_with_retries(payload, on_progress, f"Anima {index + 1}/{total}")
            except SdcppError as error:
                if shared.state.interrupted and "cancel" in str(error).lower():
                    break
                raise

            decoded = anima.decode_images(status)
            if not decoded:
                raise SdcppError("stable-diffusion.cpp returned no images")

            image = decoded[0]
            source_prompt = source_prompts[index]
            source_negative = source_negative_prompts[index]
            infotext = processing.create_infotext(
                p, [source_prompt], [image_seed], [image_subseed],
                index=0, all_negative_prompts=[source_negative],
            )

            if save_samples:
                compiled_prompt, compiled_negative = p.compiled_prompts_for_image(index)
                images.save_image(
                    image, p.outpath_samples, "", image_seed, source_prompt,
                    opts.samples_format, info=infotext, p=p,
                    # the prompt as written with the picks drawn, indexed next to the source
                    compiled_prompt=compiled_prompt,
                    compiled_negative_prompt=compiled_negative,
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
