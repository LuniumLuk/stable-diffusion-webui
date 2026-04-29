from PIL import Image

from modules import errors, scripts_postprocessing, ui_components
import gradio as gr

try:
    from rembg import new_session, remove
except Exception as import_error:
    new_session = None
    remove = None
    rembg_import_error = import_error
else:
    rembg_import_error = None


class ScriptPostprocessingRembg(scripts_postprocessing.ScriptPostprocessing):
    name = "Remove Background (rembg)"
    order = 2500

    def __init__(self):
        self._sessions = {}

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

            if rembg_import_error is not None:
                gr.Markdown("rembg is not available in the current environment. Install it in .venv to enable this feature.")

        return {
            "enable": enable,
            "rembg_model": rembg_model,
            "rembg_alpha_matting": rembg_alpha_matting,
            "rembg_post_process_mask": rembg_post_process_mask,
            "rembg_only_mask": rembg_only_mask,
        }

    def _get_session(self, model_name):
        session = self._sessions.get(model_name)
        if session is None:
            session = new_session(model_name)
            self._sessions[model_name] = session
        return session

    def process(self, pp: scripts_postprocessing.PostprocessedImage, enable, rembg_model, rembg_alpha_matting, rembg_post_process_mask, rembg_only_mask):
        if not enable:
            return

        if remove is None or new_session is None:
            errors.report(f"rembg is unavailable: {rembg_import_error}")
            pp.info["rembg"] = "unavailable"
            return

        try:
            source = pp.image.convert("RGB")
            session = self._get_session(rembg_model)
            result = remove(
                source,
                session=session,
                alpha_matting=rembg_alpha_matting,
                post_process_mask=rembg_post_process_mask,
                only_mask=rembg_only_mask,
            )

            if isinstance(result, Image.Image):
                if rembg_only_mask:
                    pp.image = result.convert("L")
                else:
                    pp.image = result.convert("RGBA")
            else:
                pp.image = Image.fromarray(result)

            pp.nametags.append("rembg")
            pp.info["rembg model"] = rembg_model
            pp.info["rembg alpha matting"] = bool(rembg_alpha_matting)
            pp.info["rembg post-process mask"] = bool(rembg_post_process_mask)
            pp.info["rembg only mask"] = bool(rembg_only_mask)
        except Exception:
            errors.report("rembg postprocessing failed", exc_info=True)
