"""Resize Input accordion for img2img / inpaint: pre-resize the init image (and mask) first."""

import gradio as gr

from modules import input_resize, scripts, ui_size
from modules.infotext_utils import PasteField
from modules.ui_components import InputAccordion


class ScriptResizeInput(scripts.ScriptBuiltinUI):
    section = "accordions"
    create_group = False

    def title(self):
        return "Resize Input"

    def show(self, is_img2img):
        return scripts.AlwaysVisible if is_img2img else False

    def ui(self, is_img2img):
        with InputAccordion(False, label="Resize Input", elem_id=self.elem_id("resize_input_enable")) as enable:
            mode = gr.Radio(
                choices=list(input_resize.MODE_LABELS),
                value="Scale",
                label="Resize by",
                elem_id=self.elem_id("resize_input_mode"),
                tooltip="Scale keeps the aspect ratio; Size sets an exact width and height",
            )

            with gr.Group(elem_id=self.elem_id("resize_input_scale_group")) as scale_group:
                scale = gr.Slider(
                    input_resize.MIN_SCALE,
                    input_resize.MAX_SCALE,
                    value=1.0,
                    step=0.05,
                    label="Scale",
                    elem_id=self.elem_id("resize_input_scale"),
                )

            with gr.Group(visible=False, elem_id=self.elem_id("resize_input_size_group")) as size_group:
                with gr.Row():
                    width = ui_size.size_input(512, elem_id=self.elem_id("resize_input_width"))
                    height = ui_size.size_input(512, label="Height", elem_id=self.elem_id("resize_input_height"))
                ui_size.size_preset_row(
                    width,
                    height,
                    elem_id=self.elem_id("resize_input_size_presets"),
                    elem_prefix=self.elem_id("resize_input_size"),
                    form_row=False,
                )
                fit = gr.Radio(
                    choices=list(input_resize.FIT_LABELS),
                    value="Aspect fill",
                    label="If the aspect ratio differs",
                    elem_id=self.elem_id("resize_input_fit"),
                    tooltip="Aspect fill covers the target box and center-crops; Stretch distorts to the exact size",
                )

            set_output = gr.Checkbox(
                True,
                label="Set output size to the resized input",
                elem_id=self.elem_id("resize_input_set_output"),
                tooltip="Also use the resized dimensions as the img2img width/height",
            )

            gr.Markdown(
                "Runs before the init image is encoded: the picture (and the inpaint mask) is resized "
                "once, downscales with area averaging, upscales with Lanczos. The Resize-by tab "
                "multiplies this resized input.",
                elem_id=self.elem_id("resize_input_hint"),
            )

        def switch_mode(selected):
            by_size = input_resize.canonical_mode(selected) == "size"
            return gr.update(visible=not by_size), gr.update(visible=by_size)

        mode.change(fn=switch_mode, inputs=[mode], outputs=[scale_group, size_group], show_progress=False)

        # the Resize-by preview/auto-detected size must follow the pre-resized input
        refresh_preview = dict(fn=None, _js="refreshImg2imgResizePreview", inputs=None, outputs=None, show_progress=False)
        enable.change(**refresh_preview)
        mode.change(**refresh_preview)
        fit.change(**refresh_preview)
        # change catches typed values (no release event), release catches drag ends
        scale.release(**refresh_preview)
        for field in (scale, width, height):
            field.change(**refresh_preview)

        self.infotext_fields = [
            PasteField(enable, lambda d: "Input resize" in d),
        ]

        return enable, mode, scale, width, height, fit, set_output

    def process(self, p, enable, mode, scale, width, height, fit, set_output):
        if not enable:
            return

        from modules.processing import StableDiffusionProcessingImg2Img

        if not isinstance(p, StableDiffusionProcessingImg2Img):
            return
        if not p.init_images:
            return

        canonical = input_resize.canonical_mode(mode)
        if canonical == "off":
            return

        def plan_for(image):
            return input_resize.plan_resize(
                image.width,
                image.height,
                canonical,
                scale=scale,
                width=width,
                height=height,
                fit=input_resize.FIT_LABELS.get(fit, fit),
            )

        resized = []
        first_plan = None
        first_image = None
        for image in p.init_images:
            plan = plan_for(image)
            out, _mask, _detail = input_resize.resize_pair(image, None, plan)
            resized.append(out)
            if plan is not None and first_plan is None:
                first_plan, first_image = plan, image

        if first_plan is None:
            return

        p.init_images = resized

        mask = getattr(p, "image_mask", None)
        if mask is not None:
            p.image_mask = input_resize.resize_pair(mask, None, plan_for(mask))[0]

        latent_mask = getattr(p, "latent_mask", None)
        if latent_mask is not None:
            p.latent_mask = input_resize.resize_pair(latent_mask, None, plan_for(latent_mask))[0]

        detail = f"{first_image.width}x{first_image.height} -> {first_plan['width']}x{first_plan['height']}"
        detail += " (area" if first_plan["downscale"] else " (lanczos"
        if canonical == "size":
            detail += ", aspect fill)" if first_plan["cover"] else ", stretch)"
        else:
            detail += ", scale)"

        scale_by = getattr(p, "resize_by_scale", None)
        if scale_by:
            detail = detail[:-1] + f", x{float(scale_by):g})"
        p.extra_generation_params["Input resize"] = detail

        size = input_resize.working_size(first_plan, set_output=set_output, scale_by=scale_by)
        if size is not None:
            p.width, p.height = size
