"""Automatic pose detection + inpaint pass after txt2img / hires fix / refiner."""

import threading

import gradio as gr

from modules import inpaint_pose, scripts, shared
from modules.infotext_utils import PasteField
from modules.ui_components import InputAccordion

_RUNNING = threading.local()

PART_LABELS = {
    "Face": "face",
    "Hands": "hands",
    "Feet": "feet",
}
_PART_CODES = set(PART_LABELS.values())

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
        return scripts.AlwaysVisible if not is_img2img else False

    def ui(self, is_img2img):
        with InputAccordion(False, label="Pose inpaint", elem_id=self.elem_id("pose_inpaint_enable")) as enable_pose_inpaint:
            with gr.Row():
                pose_parts = gr.CheckboxGroup(
                    choices=list(PART_LABELS.keys()),
                    value=list(PART_LABELS.keys()),
                    label="Parts",
                    elem_id=self.elem_id("pose_inpaint_parts"),
                )
                pose_radius = gr.Slider(
                    8,
                    400,
                    value=40,
                    step=2,
                    label="Point radius, px",
                    elem_id=self.elem_id("pose_inpaint_radius"),
                    tooltip="Fixed radius, used when 'Radius of skeleton' is 0",
                )
                pose_radius_percent = gr.Slider(
                    0.0,
                    25.0,
                    value=5.0,
                    step=0.5,
                    label="Radius of skeleton, %",
                    elem_id=self.elem_id("pose_inpaint_radius_percent"),
                    tooltip="Radius follows the figure: this percentage of the skeleton's longest side. 0 = use the fixed radius",
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
                pose_size = gr.Slider(
                    256,
                    2048,
                    value=1024,
                    step=64,
                    label="Inpaint size",
                    elem_id=self.elem_id("pose_inpaint_size"),
                    tooltip="Long side of each masked region that is re-generated (only masked, latent upscale)",
                )

            with gr.Row():
                pose_separate = gr.Checkbox(
                    True,
                    label="One inpaint per part",
                    elem_id=self.elem_id("pose_inpaint_separate"),
                    tooltip="Batch one only-masked pass per detected part (face, each hand, each foot) instead of one pass over all points",
                )
                pose_save_intermediate = gr.Checkbox(
                    False,
                    label="Save intermediate image",
                    elem_id=self.elem_id("pose_inpaint_save_intermediate"),
                    tooltip="Save the image before the pose inpaint pass with a -before-pose-inpaint suffix",
                )

            gr.Markdown(
                "Runs after Hires. fix and Refiner. Uses the compiled hires prompt when Hires. fix is enabled, "
                "otherwise the compiled main prompt. Each part is inpainted with its own mask, original masked "
                "content, only-masked area and latent upscale. DWPose models from the Inpaint tab's Pose masks "
                "panel give the best anime face/hand/foot points.",
                elem_id=self.elem_id("pose_inpaint_hint"),
            )

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
        )

    def setup(self, p, enable, parts, radius, denoising, steps, save_intermediate, inpaint_size=1024, separate_masks=True, radius_percent=0.0, extend=0.0):
        p.pose_inpaint_enabled = bool(enable)
        p.pose_inpaint_results = {}

        if not enable:
            return

        codes = [PART_LABELS.get(part, part) for part in (parts or []) if part in PART_LABELS or part in _PART_CODES]
        denoising_value = 0.4 if denoising is None else float(denoising)
        size_value = 1024 if inpaint_size is None else int(inpaint_size)
        percent_value = 0.0 if radius_percent is None else float(radius_percent)
        extend_value = 0.0 if extend is None else float(extend)
        p.pose_inpaint_config = {
            "parts": codes,
            "radius": max(1, min(1024, int(radius or 40))),
            "denoising": max(0.01, min(1.0, denoising_value)),
            "steps": max(0, min(150, int(steps or 0))),
            "save_intermediate": bool(save_intermediate),
            "inpaint_size": max(256, min(2048, size_value)),
            "separate_masks": True if separate_masks is None else bool(separate_masks),
            "radius_percent": max(0.0, min(50.0, percent_value)),
            "extend": max(0.0, min(2.0, extend_value)),
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

        try:
            pose = inpaint_pose.detect_pose(image, backend="auto")
        except inpaint_pose.PoseModelUnavailable as error:
            self._record(p, global_index, "skipped (no local pose model)")
            print(f"Pose inpaint skipped: {error}")
            return

        passes, points, radius = self._plan_passes(image, pose, config)
        if not passes:
            self._record(p, global_index, "skipped (no face/hand/foot points)")
            return

        if config.get("save_intermediate"):
            try:
                self._save_intermediate(p, image, batch_index)
            except Exception as error:  # noqa: BLE001 - saving the optional copy must not block inpainting
                print(f"Pose inpaint: could not save intermediate image: {error}")

        prompt, negative_prompt = inpaint_pose.choose_inpaint_prompt(p, global_index)
        steps = config.get("steps") or p.steps or 20
        denoising = config["denoising"]
        print(
            f"Pose inpaint: {pose.backend}, {points} points in {len(passes)} mask(s), r={radius}px, "
            f"extend={config.get('extend', 0):.2f}, prompt={prompt[:60]!r}"
        )

        result = self._inpaint(p, image, passes, prompt, negative_prompt, steps, denoising, global_index, batch_index)
        if result is None:
            self._record(p, global_index, "skipped (inpaint interrupted)")
            return

        pp.image = result
        percent = config.get("radius_percent", 0)
        radius_note = f"{percent:g}% of skeleton" if percent > 0 else "fixed"
        self._record(
            p,
            global_index,
            f"{pose.backend}, {points} points, {len(passes)} pass(es), size={config['inpaint_size']}, "
            f"r={radius}px ({radius_note}), extend={config.get('extend', 0):.2f}, "
            f"denoise={denoising:.2f}, steps={steps}",
        )

    @staticmethod
    def _plan_passes(image, pose, config):
        """``([(label, mask, width, height)], point count, radius px)`` - one pass per part, or one combined."""
        padding = 32
        size = config.get("inpaint_size", 1024)
        radius = inpaint_pose.resolve_radius(pose, config["radius"], config.get("radius_percent", 0))
        extend = config.get("extend", 0)

        if config.get("separate_masks", True):
            built = inpaint_pose.build_region_masks(pose, regions=config["parts"], radius=radius, extend=extend)
            passes = [
                (code, mask, *inpaint_pose.region_inpaint_size(mask, size, padding))
                for code, mask, _count in built
            ]
            return passes, sum(count for _code, _mask, count in built), radius

        mask, points = inpaint_pose.build_region_mask(pose, regions=config["parts"], radius=radius, extend=extend)
        if mask is None:
            return [], 0, radius
        width, height = inpaint_pose.inpaint_crop_size(image.width, image.height, size)
        return [("all", mask, width, height)], points, radius

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

    def _inpaint(self, p, image, passes, prompt, negative_prompt, steps, denoising, global_index, batch_index):
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
            for position, (label, mask, width, height) in enumerate(passes):
                if state.interrupted or state.stopping_generation:
                    print(f"Pose inpaint: interrupted before pass {position + 1}/{len(passes)}")
                    return None

                state.job = f"Pose inpaint {batch_index + 1}/{p.batch_size} - {label} ({position + 1}/{len(passes)})"
                state.job_no = position

                inner = self._inner_job(
                    CurrentModelInpaint,
                    p,
                    image=result,
                    mask=mask,
                    prompt=prompt,
                    negative_prompt=negative_prompt,
                    width=width,
                    height=height,
                    steps=steps,
                    denoising=denoising,
                    seed=seed,
                    subseed=subseed,
                    override_settings=override_settings,
                )
                processed = process_images(inner)
                if not processed or not processed.images:
                    print(f"Pose inpaint: pass {position + 1}/{len(passes)} ({label}) returned no image")
                    return None

                index = min(getattr(processed, "index_of_first_image", 0), len(processed.images) - 1)
                result = processed.images[index]
        finally:
            for name, value in saved_state.items():
                setattr(state, name, value)
            shared.total_tqdm.clear()

        print(f"Pose inpaint: finished {len(passes)} pass(es), last at {passes[-1][2]}x{passes[-1][3]}")
        return result

    @staticmethod
    def _inner_job(job_class, p, *, image, mask, prompt, negative_prompt, width, height, steps, denoising, seed, subseed, override_settings):
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
        return inner
