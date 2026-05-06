from PIL import Image

from modules import errors, rembg_utils, scripts_postprocessing, ui_components
import gradio as gr


class ScriptPostprocessingRembg(scripts_postprocessing.ScriptPostprocessing):
    name = "Remove Background (rembg)"
    order = 2500

    def ui(self):
        with ui_components.InputAccordion(False, label=self.name) as enable:
            rembg_model = gr.Dropdown(
                choices=["u2net", "u2netp", "u2net_human_seg", "isnet-general-use"],
                value="u2net",
                label="Model",
                elem_id="extras_rembg_model",
            )
            with gr.Row():
                rembg_alpha_matting = gr.Checkbox(
                    label="Alpha matting (slower, cleaner edges)",
                    value=False,
                    elem_id="extras_rembg_alpha_matting",
                )
                rembg_post_process_mask = gr.Checkbox(
                    label="Post-process mask",
                    value=False,
                    elem_id="extras_rembg_post_process_mask",
                )
                rembg_only_mask = gr.Checkbox(
                    label="Only mask",
                    value=False,
                    elem_id="extras_rembg_only_mask",
                )

            if rembg_utils.rembg_import_error is not None:
                gr.Markdown("rembg is not available in the current environment. Install it in .venv to enable this feature.")

        return {
            "enable": enable,
            "rembg_model": rembg_model,
            "rembg_alpha_matting": rembg_alpha_matting,
            "rembg_post_process_mask": rembg_post_process_mask,
            "rembg_only_mask": rembg_only_mask,
        }

    def process(self, pp: scripts_postprocessing.PostprocessedImage, enable, rembg_model, rembg_alpha_matting, rembg_post_process_mask, rembg_only_mask):
        if not enable:
            return

        if rembg_utils.rembg_import_error is not None:
            errors.report(f"rembg is unavailable: {rembg_utils.rembg_import_error}")
            pp.info["rembg"] = "unavailable"
            return

        result_image, result_info = rembg_utils.remove_background_image(
            pp.image,
            model_name=rembg_model,
            alpha_matting=rembg_alpha_matting,
            post_process_mask=rembg_post_process_mask,
            only_mask=rembg_only_mask,
        )
        if result_image is None:
            pp.info.update(result_info)
            return

        pp.image = result_image
        pp.nametags.append("rembg")
        pp.info.update(result_info)
