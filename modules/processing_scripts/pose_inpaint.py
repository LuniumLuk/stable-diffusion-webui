"""Automatic pose detection + inpaint pass after txt2img / hires fix / refiner / img2img."""

import threading
from typing import Any, NamedTuple

import gradio as gr

from modules import inpaint_pose, prompt_parser, scripts, shared
from modules.infotext_utils import PasteField
from modules.ui_components import InputAccordion

_RUNNING = threading.local()

PART_LABELS = {
    "Face": "face",
    "Hands": "hands",
    "Feet": "feet",
}
_PART_CODES = set(PART_LABELS.values())

RADIUS_MODE_LABELS = {
    "px": "Pixels",
    "percent": "Skeleton %",
}
INPAINT_MODE_LABELS = {
    "scale": "Relative",
    "px": "Pixels",
}


class PosePass(NamedTuple):
    """One only-masked inpaint pass of the pose refinement."""

    part: Any  # POSE_INPAINT_PART of the pass: 'FACE' / 'FEET' / 'HANDS', None when mixed
    label: str
    mask: Any
    width: int
    height: int


_STATE_FIELDS = (
    "job",
    "job_no",
    "job_count",
    "job_timestamp",
    "processing_has_refined_job_count",
    "sampling_step",
    "sampling_steps",
    "current_latent",
    "current_image",
    "current_image_sampling_step",
    "id_live_preview",
    "textinfo",
)


def _is_dit_job(p) -> bool:
    try:
        from modules import backends

        return backends.is_dit_job(p)
    except (ImportError, AttributeError):
        return False


def _pose_infotext_for_image(p, index, use_main_prompt=False, **_kwargs):
    if use_main_prompt:
        return None
    global_index = getattr(p, "iteration", 0) * p.batch_size + index
    return getattr(p, "pose_inpaint_results", {}).get(global_index)


class ScriptPoseInpaint(scripts.ScriptBuiltinUI):
    section = "accordions"
    create_group = False
    setup_for_ui_only = False

    def title(self):
        return "Pose inpaint"

    def show(self, is_img2img):
        return scripts.AlwaysVisible

    def ui(self, is_img2img):
        with InputAccordion(False, label="Pose inpaint", elem_id=self.elem_id("pose_inpaint_enable")) as enable_pose_inpaint:
            with gr.Row():
                pose_parts = gr.CheckboxGroup(
                    choices=list(PART_LABELS.keys()),
                    value=list(PART_LABELS.keys()),
                    label="Parts",
                    elem_id=self.elem_id("pose_inpaint_parts"),
                )
                pose_radius_mode = gr.Radio(
                    choices=list(RADIUS_MODE_LABELS.values()),
                    value=RADIUS_MODE_LABELS["percent"],
                    label="Point size",
                    elem_id=self.elem_id("pose_inpaint_radius_mode"),
                    tooltip="Pixels uses a fixed radius; skeleton scales the radius to each detected figure",
                )
                pose_backend = gr.Radio(
                    choices=list(inpaint_pose.BACKEND_LABELS.values()),
                    value=inpaint_pose.BACKEND_LABELS["auto"],
                    label="Provider",
                    elem_id=self.elem_id("pose_inpaint_backend"),
                    tooltip="Auto prefers DWPose when its models are installed; COCO 17 always uses torchvision Keypoint R-CNN",
                )
                pose_max_people = gr.Slider(
                    1,
                    inpaint_pose.MAX_PEOPLE_LIMIT,
                    value=inpaint_pose.DEFAULT_MAX_PEOPLE,
                    step=1,
                    label="Max skeletons",
                    elem_id=self.elem_id("pose_inpaint_max_people"),
                    tooltip="Keep only the most confident and largest skeletons; each one gets its own masks",
                )

            with gr.Row():
                pose_radius = gr.Slider(
                    8,
                    400,
                    value=40,
                    step=2,
                    label="Point radius, px",
                    elem_id=self.elem_id("pose_inpaint_radius"),
                    visible=False,
                    tooltip="Fixed radius of the circle drawn around every detected point",
                )
                pose_radius_percent = gr.Slider(
                    0.5,
                    25.0,
                    value=5.0,
                    step=0.5,
                    label="Radius of skeleton, %",
                    elem_id=self.elem_id("pose_inpaint_radius_percent"),
                    tooltip="Radius follows each figure: this percentage of that skeleton's longest side",
                )
                pose_extend = gr.Slider(
                    0.0,
                    2.0,
                    value=0.5,
                    step=0.05,
                    label="Hand/foot extend",
                    elem_id=self.elem_id("pose_inpaint_extend"),
                    tooltip="Push hand and foot points along the forearm/shin (multiples of that bone) so fingers and toes are covered",
                )

            with gr.Row():
                pose_denoising = gr.Slider(0.0, 1.0, value=0.4, step=0.01, label="Denoising strength", elem_id=self.elem_id("pose_inpaint_denoising"))
                pose_steps = gr.Slider(
                    0,
                    150,
                    value=0,
                    step=1,
                    label="Steps",
                    elem_id=self.elem_id("pose_inpaint_steps"),
                    tooltip="0 = use the main generation steps",
                )
                pose_inpaint_mode = gr.Radio(
                    choices=list(INPAINT_MODE_LABELS.values()),
                    value=INPAINT_MODE_LABELS["scale"],
                    label="Inpaint size",
                    elem_id=self.elem_id("pose_inpaint_size_mode"),
                    tooltip="Pixels sets the long side directly; Relative multiplies the mask's pixel bounding size",
                )
                pose_inpaint_scale = gr.Slider(
                    1.0,
                    4.0,
                    value=inpaint_pose.DEFAULT_INPAINT_SCALE,
                    step=0.1,
                    label="Inpaint size scale",
                    elem_id=self.elem_id("pose_inpaint_scale"),
                    tooltip="Sampling size = the mask's pixel bounding size x this factor (2x regenerates at twice the mask size)",
                )
                pose_size = gr.Slider(
                    256,
                    2048,
                    value=1024,
                    step=64,
                    label="Inpaint size, px",
                    elem_id=self.elem_id("pose_inpaint_size"),
                    visible=False,
                    tooltip="Long side of each masked region that is re-generated (only masked, latent upscale)",
                )

            with gr.Row():
                pose_separate = gr.Checkbox(
                    True,
                    label="One inpaint per part",
                    elem_id=self.elem_id("pose_inpaint_separate"),
                    tooltip="Batch one only-masked pass per part of every used skeleton instead of one pass over all points",
                )
                pose_save_intermediate = gr.Checkbox(
                    False,
                    label="Save intermediate image",
                    elem_id=self.elem_id("pose_inpaint_save_intermediate"),
                    tooltip="Save the image before the pose inpaint pass with a -before-pose-inpaint suffix",
                )

            gr.Markdown(
                "Runs after the txt2img result (including Hires. fix and Refiner) using the compiled hires prompt "
                "when Hires. fix is enabled, otherwise the compiled main prompt."
                if not is_img2img
                else "Runs after the img2img result is composited, using the compiled main prompt.",
                elem_id=self.elem_id("pose_inpaint_when"),
            )
            gr.Markdown(
                "Each part of every used skeleton is inpainted with its own mask, original masked content, "
                "only-masked area and latent upscale. DWPose models from the Inpaint tab's Pose masks panel "
                "give the best anime face/hand/foot points.",
                elem_id=self.elem_id("pose_inpaint_hint"),
            )

        def switch_radius_mode(selected):
            percent = inpaint_pose.canonical_radius_mode(selected) == "percent"
            return gr.update(visible=not percent), gr.update(visible=percent)

        pose_radius_mode.change(fn=switch_radius_mode, inputs=[pose_radius_mode], outputs=[pose_radius, pose_radius_percent], show_progress=False)

        def switch_inpaint_mode(selected):
            relative = inpaint_pose.canonical_inpaint_mode(selected) == "scale"
            return gr.update(visible=relative), gr.update(visible=not relative)

        pose_inpaint_mode.change(fn=switch_inpaint_mode, inputs=[pose_inpaint_mode], outputs=[pose_inpaint_scale, pose_size], show_progress=False)

        self.infotext_fields = [
            PasteField(enable_pose_inpaint, lambda d: "Pose inpaint" in d),
        ]

        return (
            enable_pose_inpaint,
            pose_parts,
            pose_radius,
            pose_denoising,
            pose_steps,
            pose_save_intermediate,
            pose_size,
            pose_separate,
            pose_radius_percent,
            pose_extend,
            pose_radius_mode,
            pose_inpaint_mode,
            pose_inpaint_scale,
            pose_max_people,
            pose_backend,
        )

    def setup(
        self,
        p,
        enable,
        parts,
        radius,
        denoising,
        steps,
        save_intermediate,
        inpaint_size=1024,
        separate_masks=True,
        radius_percent=0.0,
        extend=0.0,
        radius_mode=None,
        inpaint_mode=None,
        inpaint_scale=None,
        max_people=None,
        backend=None,
    ):
        p.pose_inpaint_enabled = bool(enable)
        p.pose_inpaint_results = {}

        if not enable:
            return

        codes = [PART_LABELS.get(part, part) for part in (parts or []) if part in PART_LABELS or part in _PART_CODES]
        denoising_value = 0.4 if denoising is None else float(denoising)
        size_value = 1024 if inpaint_size is None else int(inpaint_size)
        percent_value = 0.0 if radius_percent is None else float(radius_percent)
        extend_value = 0.0 if extend is None else float(extend)
        # Older payloads / saved infotext have no mode: a non-zero percentage meant percent mode.
        if radius_mode is None:
            radius_mode = "percent" if percent_value > 0 else "px"
        radius_mode_value = inpaint_pose.canonical_radius_mode(radius_mode)
        inpaint_mode_value = inpaint_pose.canonical_inpaint_mode(inpaint_mode)
        scale_value = inpaint_pose.DEFAULT_INPAINT_SCALE if inpaint_scale is None else float(inpaint_scale)
        people_value = inpaint_pose.DEFAULT_MAX_PEOPLE if max_people is None else max_people
        p.pose_inpaint_config = {
            "parts": codes,
            "radius": max(1, min(1024, int(radius or 40))),
            "denoising": max(0.01, min(1.0, denoising_value)),
            "steps": max(0, min(150, int(steps or 0))),
            "save_intermediate": bool(save_intermediate),
            "inpaint_size": max(256, min(2048, size_value)),
            "separate_masks": True if separate_masks is None else bool(separate_masks),
            "radius_percent": max(0.0, min(50.0, percent_value)),
            "radius_mode": radius_mode_value,
            "extend": max(0.0, min(2.0, extend_value)),
            "inpaint_mode": inpaint_mode_value,
            "inpaint_scale": max(1.0, min(4.0, scale_value)),
            "max_people": inpaint_pose.clamp_max_people(people_value),
            "backend": inpaint_pose.canonical_backend(backend),
        }
        p.extra_generation_params["Pose inpaint"] = _pose_infotext_for_image

    def postprocess_image_after_composite(self, p, pp, *args):
        if not getattr(p, "pose_inpaint_enabled", False):
            return
        if getattr(_RUNNING, "active", False):
            return

        from modules.shared import state

        if state.interrupted or state.stopping_generation:
            return

        batch_index = getattr(p, "batch_index", 0) or 0
        global_index = getattr(p, "iteration", 0) * p.batch_size + batch_index
        config = getattr(p, "pose_inpaint_config", None) or {}

        if not config.get("parts"):
            self._record(p, global_index, "skipped (no parts)")
            return
        if _is_dit_job(p):
            self._record(p, global_index, "skipped (DiT backend)")
            return
        if shared.sd_model is None:
            self._record(p, global_index, "skipped (no SD model)")
            return

        _RUNNING.active = True
        try:
            self._run(p, pp, batch_index, global_index, config)
        except Exception as error:  # noqa: BLE001 - a failed refinement must not fail the generation
            self._record(p, global_index, f"failed ({error})")
            print(f"Pose inpaint: {error}")
        finally:
            _RUNNING.active = False

    @staticmethod
    def _record(p, index, value):
        results = getattr(p, "pose_inpaint_results", None)
        if results is None:
            p.pose_inpaint_results = results = {}
        results[index] = value

    def _run(self, p, pp, batch_index, global_index, config):
        image = pp.image.convert("RGB")
        backend = inpaint_pose.canonical_backend(config.get("backend"))

        try:
            detected = inpaint_pose.detect_pose(image, backend=backend)
        except inpaint_pose.PoseModelUnavailable as error:
            if backend == "auto":
                self._record(p, global_index, "skipped (no local pose model)")
            else:
                label = inpaint_pose.BACKEND_LABELS.get(backend, "pose")
                self._record(p, global_index, f"skipped ({label} model unavailable)")
            print(f"Pose inpaint skipped: {error}")
            return

        pose = detected.limit_people(config.get("max_people"))
        passes, points, radius = self._plan_passes(image, pose, config)
        if not passes:
            self._record(p, global_index, "skipped (no face/hand/foot points)")
            return

        if config.get("save_intermediate"):
            try:
                self._save_intermediate(p, image, batch_index)
            except Exception as error:  # noqa: BLE001 - saving the optional copy must not block inpainting
                print(f"Pose inpaint: could not save intermediate image: {error}")

        prompt, _ = inpaint_pose.choose_inpaint_prompt(p, global_index, part=passes[0].part)
        steps = config.get("steps") or p.steps or 20
        denoising = config["denoising"]
        print(
            f"Pose inpaint: {pose.backend}, {len(pose.people)} of {len(detected.people)} person(s), "
            f"{points} points in {len(passes)} mask(s), r={radius}px, "
            f"extend={config.get('extend', 0):.2f}, prompt={prompt[:60]!r}"
        )

        result = self._inpaint(p, image, passes, steps, denoising, global_index, batch_index)
        if result is None:
            self._record(p, global_index, "skipped (inpaint interrupted)")
            return

        pp.image = result
        percent = config.get("radius_percent", 0) if config.get("radius_mode") == "percent" else 0
        radius_note = f"{percent:g}% of skeleton" if percent > 0 else "fixed"
        if config.get("inpaint_mode") == "scale":
            size_note = f"x{config.get('inpaint_scale', 2):g} of mask"
        else:
            size_note = f"{config['inpaint_size']}px"
        people_note = f"{len(pose.people)}/{len(detected.people)} person(s)"
        self._record(
            p,
            global_index,
            f"{pose.backend}, {people_note}, {points} points, {len(passes)} pass(es), size={size_note}, "
            f"r={radius}px ({radius_note}), extend={config.get('extend', 0):.2f}, "
            f"denoise={denoising:.2f}, steps={steps}",
        )

    @staticmethod
    def _plan_passes(image, pose, config):
        """``([PosePass], point count, radius px)`` - one pass per part, or one combined.

        Each pass carries the POSE_INPAINT_PART of its body part, so the prompt can
        switch text per pass (``#if POSE_INPAINT_PART == HANDS``).  A combined pass
        reports the part when every selected region belongs to the same one.
        """
        padding = 32
        size = config.get("inpaint_size", 1024)
        percent = config.get("radius_percent", 0) if config.get("radius_mode", "percent") == "percent" else 0
        mode = config.get("inpaint_mode", "px")
        scale = config.get("inpaint_scale", inpaint_pose.DEFAULT_INPAINT_SCALE)
        extend = config.get("extend", 0)

        def pass_size(mask):
            return inpaint_pose.region_inpaint_size(mask, size, padding, mode=mode, scale=scale)

        if config.get("separate_masks", True):
            built = inpaint_pose.build_region_masks(
                pose,
                regions=config["parts"],
                radius=config["radius"],
                extend=extend,
                radius_percent=percent,
                radius_mode=config.get("radius_mode"),
            )
            passes = [
                PosePass(prompt_parser.pose_inpaint_part(item.region), item.label, item.mask, *pass_size(item.mask))
                for item in built
            ]
            radius = max((item.radius for item in built), default=0)
            return passes, sum(item.points for item in built), radius

        radius = inpaint_pose.resolve_radius(pose, config["radius"], percent, mode=config.get("radius_mode"))
        mask, points = inpaint_pose.build_region_mask(pose, regions=config["parts"], radius=radius, extend=extend)
        if mask is None:
            return [], 0, radius
        if mode == "scale":
            width, height = pass_size(mask)
        else:
            width, height = inpaint_pose.inpaint_crop_size(image.width, image.height, size)
        requested = {prompt_parser.pose_inpaint_part(code) for code in config["parts"]}
        part = requested.pop() if len(requested) == 1 else None
        return [PosePass(part or None, "all", mask, width, height)], points, radius

    def _save_intermediate(self, p, image, batch_index):
        if not p.save_samples():
            return
        if not p.seeds or not p.prompts:
            return

        from modules import images
        from modules.processing import create_infotext
        from modules.shared import opts

        info = create_infotext(
            p,
            p.prompts,
            p.seeds,
            p.subseeds,
            index=batch_index,
            all_negative_prompts=p.negative_prompts,
        )
        compiled_prompt, compiled_negative_prompt = p.compiled_prompts_for_image(batch_index)

        images.save_image(
            image,
            p.outpath_samples,
            "",
            p.seeds[batch_index],
            p.prompts[batch_index],
            opts.samples_format,
            info=info,
            p=p,
            suffix="-before-pose-inpaint",
            compiled_prompt=compiled_prompt,
            compiled_negative_prompt=compiled_negative_prompt,
        )

    def _inpaint(self, p, image, passes, steps, denoising, global_index, batch_index):
        from modules import shared
        from modules.processing import StableDiffusionProcessingImg2Img, process_images
        from modules.shared import state

        class CurrentModelInpaint(StableDiffusionProcessingImg2Img):
            @property
            def sd_model(self):
                return shared.sd_model

            @sd_model.setter
            def sd_model(self, value):
                pass

            def prompt_condition_macros(self):
                # a pose pass, even when a script injected #if blocks into its prompt
                return prompt_parser.stage_macros("pose_inpaint", pose_part=getattr(self, "pose_inpaint_part", None))

        override_settings = {
            "img2img_color_correction": False,
            "save_init_img": False,
        }
        checkpoint_info = getattr(shared.sd_model, "sd_checkpoint_info", None)
        checkpoint_title = getattr(checkpoint_info, "title", None)
        if checkpoint_title:
            override_settings["sd_model_checkpoint"] = checkpoint_title

        seed = p.seeds[batch_index] if p.seeds else (p.all_seeds[global_index] if p.all_seeds else -1)
        subseed = p.subseeds[batch_index] if p.subseeds else (p.all_subseeds[global_index] if p.all_subseeds else -1)

        saved_state = {name: getattr(state, name, None) for name in _STATE_FIELDS}
        state.job_count = len(passes)
        state.job_no = 0
        state.sampling_step = 0
        state.sampling_steps = 0

        result = image
        try:
            for position, pose_pass in enumerate(passes):
                if state.interrupted or state.stopping_generation:
                    print(f"Pose inpaint: interrupted before pass {position + 1}/{len(passes)}")
                    return None

                state.job = f"Pose inpaint {batch_index + 1}/{p.batch_size} - {pose_pass.label} ({position + 1}/{len(passes)})"
                state.job_no = position

                # the prompt may spell out per-part text (#if POSE_INPAINT_PART == FACE)
                pass_prompt, pass_negative_prompt = inpaint_pose.choose_inpaint_prompt(p, global_index, part=pose_pass.part)

                inner = self._inner_job(
                    CurrentModelInpaint,
                    p,
                    image=result,
                    mask=pose_pass.mask,
                    prompt=pass_prompt,
                    negative_prompt=pass_negative_prompt,
                    width=pose_pass.width,
                    height=pose_pass.height,
                    steps=steps,
                    denoising=denoising,
                    seed=seed,
                    subseed=subseed,
                    override_settings=override_settings,
                    pose_part=pose_pass.part,
                )
                processed = process_images(inner)
                if not processed or not processed.images:
                    print(f"Pose inpaint: pass {position + 1}/{len(passes)} ({pose_pass.label}) returned no image")
                    return None

                index = min(getattr(processed, "index_of_first_image", 0), len(processed.images) - 1)
                result = processed.images[index]
        finally:
            for name, value in saved_state.items():
                setattr(state, name, value)
            shared.total_tqdm.clear()

        print(f"Pose inpaint: finished {len(passes)} pass(es), last at {passes[-1].width}x{passes[-1].height}")
        return result

    @staticmethod
    def _inner_job(job_class, p, *, image, mask, prompt, negative_prompt, width, height, steps, denoising, seed, subseed, override_settings, pose_part=None):
        inner = job_class(
            sd_model=None,
            outpath_samples=p.outpath_samples,
            outpath_grids=p.outpath_grids,
            prompt=prompt,
            negative_prompt=negative_prompt,
            styles=[],
            batch_size=1,
            n_iter=1,
            cfg_scale=p.cfg_scale,
            width=width,
            height=height,
            init_images=[image],
            mask=mask,
            mask_blur=4,
            inpainting_fill=1,
            resize_mode=3,
            denoising_strength=denoising,
            image_cfg_scale=1.5,
            inpaint_full_res=True,
            inpaint_full_res_padding=32,
            inpainting_mask_invert=0,
            sampler_name=p.sampler_name or "Euler a",
            scheduler=p.scheduler,
            steps=max(1, int(steps)),
            seed=seed,
            subseed=subseed,
            subseed_strength=p.subseed_strength,
            seed_resize_from_h=p.seed_resize_from_h,
            seed_resize_from_w=p.seed_resize_from_w,
            restore_faces=False,
            tiling=p.tiling,
            override_settings=override_settings,
            do_not_save_samples=True,
            do_not_save_grid=True,
        )
        inner.scripts = None
        inner.script_args = None
        inner.user = p.user
        inner.is_api = p.is_api
        inner.pose_inpaint_part = pose_part
        return inner
