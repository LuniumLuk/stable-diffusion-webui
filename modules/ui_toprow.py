import gradio as gr
import json

from modules import shared, ui_prompt_styles, prompt_presets
import modules.images

from modules.ui_components import ToolButton


class Toprow:
    """Creates a top row UI with prompts, generate button, styles, extra little buttons for things, and enables some functionality related to their operation"""

    prompt = None
    prompt_img = None
    negative_prompt = None

    button_interrogate = None
    button_deepbooru = None

    interrupt = None
    interrupting = None
    skip = None
    submit = None
    queue_btn = None
    queue_status = None

    paste = None
    clear_prompt_button = None
    apply_styles = None
    restore_progress_button = None

    token_counter = None
    token_button = None
    negative_token_counter = None
    negative_token_button = None

    ui_styles = None

    submit_box = None

    def __init__(self, is_img2img, is_compact=False, id_part=None):
        if id_part is None:
            id_part = "img2img" if is_img2img else "txt2img"

        self.id_part = id_part
        self.is_img2img = is_img2img
        self.is_compact = is_compact

        if not is_compact:
            with gr.Row(elem_id=f"{id_part}_toprow", variant="compact"):
                self.create_classic_toprow()
        else:
            self.create_submit_box()

    def create_classic_toprow(self):
        self.create_prompts()

        with gr.Column(scale=1, elem_id=f"{self.id_part}_actions_column"):
            self.create_submit_box()

            self.create_tools_row()

            self.create_styles_ui()

    def create_inline_toprow_prompts(self):
        if not self.is_compact:
            return

        self.create_prompts()

        with gr.Row(elem_classes=["toprow-compact-stylerow"]):
            with gr.Column(elem_classes=["toprow-compact-tools"]):
                self.create_tools_row()
            with gr.Column():
                self.create_styles_ui()

    def create_inline_toprow_image(self):
        if not self.is_compact:
            return

        self.submit_box.render()

    def create_prompts(self):
        def preset_choices():
            choices = prompt_presets.prompt_presets.get_presets()
            return choices if choices else ["(No presets)"]

        def save_preset_from_payload(payload):
            try:
                data = json.loads(payload or "{}")
            except Exception:
                return gr.update()

            name = str(data.get("name", "")).strip()
            content = str(data.get("content", "")).strip()
            if not name or not content:
                return gr.update()

            prompt_presets.prompt_presets.save_preset(name, content)
            return gr.update(choices=preset_choices(), value=name)

        def edit_preset_from_payload(payload):
            try:
                data = json.loads(payload or "{}")
            except Exception:
                return gr.update()

            name = str(data.get("name", "")).strip()
            content = data.get("content", None)
            if not name or name == "(No presets)" or content is None:
                return gr.update()

            prompt_presets.prompt_presets.save_preset(name, str(content))
            return gr.update(choices=preset_choices(), value=name)

        def delete_preset_by_name(name):
            selected = str(name or "").strip()
            if not selected or selected == "(No presets)":
                return gr.update()

            prompt_presets.prompt_presets.delete_preset(selected)
            return gr.update(choices=preset_choices(), value="")

        def keep_dropdown_selection_after_copy(name):
            selected = str(name or "")
            return gr.update(value=selected)

        with gr.Column(elem_id=f"{self.id_part}_prompt_container", elem_classes=["prompt-container-compact"] if self.is_compact else [], scale=6):
            # Prompt presets row
            with gr.Row(elem_id=f"{self.id_part}_presets_row", scale=1):
                preset_list = preset_choices()
                self.preset_dropdown = gr.Dropdown(
                    choices=preset_list,
                    value="",
                    label="Prompt Presets",
                    elem_id=f"{self.id_part}_preset_dropdown",
                    scale=5,
                    interactive=True,
                )
                with gr.Row(scale=1, min_width=150):
                    self.preset_add_btn = ToolButton(value="➕", elem_id=f"{self.id_part}_preset_add", tooltip="Save selected text as preset")
                    self.preset_edit_btn = ToolButton(value="✏️", elem_id=f"{self.id_part}_preset_edit", tooltip="Edit selected preset")
                    self.preset_delete_btn = ToolButton(value="🗑️", elem_id=f"{self.id_part}_preset_delete", tooltip="Delete selected preset")
                self.preset_payload = gr.Textbox(value="", visible=False, elem_id=f"{self.id_part}_preset_payload")
            
            with gr.Row(elem_id=f"{self.id_part}_prompt_row", elem_classes=["prompt-row"]):
                self.prompt = gr.Textbox(label="Prompt", elem_id=f"{self.id_part}_prompt", show_label=False, lines=3, placeholder="Prompt\n(Press Ctrl+Enter to generate, Alt+Enter to skip, Esc to interrupt)", elem_classes=["prompt"])
                self.prompt_img = gr.File(label="", elem_id=f"{self.id_part}_prompt_image", file_count="single", type="binary", visible=False)

            with gr.Row(elem_id=f"{self.id_part}_neg_prompt_row", elem_classes=["prompt-row"]):
                self.negative_prompt = gr.Textbox(label="Negative prompt", elem_id=f"{self.id_part}_neg_prompt", show_label=False, lines=3, placeholder="Negative prompt\n(Press Ctrl+Enter to generate, Alt+Enter to skip, Esc to interrupt)", elem_classes=["prompt"])

        self.prompt_img.change(
            fn=modules.images.image_data,
            inputs=[self.prompt_img],
            outputs=[self.prompt, self.prompt_img],
            show_progress=False,
        )
        
        # Setup preset button handlers with backend persistence and dropdown updates.
        self.preset_add_btn.click(
            fn=save_preset_from_payload,
            inputs=[self.preset_payload],
            outputs=[self.preset_dropdown],
            _js=f'function(){{ return [window.buildPromptPresetAddPayload("{self.id_part}")]; }}'
        )
        
        self.preset_edit_btn.click(
            fn=edit_preset_from_payload,
            inputs=[self.preset_payload],
            outputs=[self.preset_dropdown],
            _js=f'function(){{ return [window.buildPromptPresetEditPayload("{self.id_part}")]; }}'
        )
        
        self.preset_delete_btn.click(
            fn=delete_preset_by_name,
            inputs=[self.preset_dropdown],
            outputs=[self.preset_dropdown],
            _js='function(name){ return [window.confirmDeletePromptPreset(name) ? name : ""]; }'
        )

        self.preset_dropdown.change(
            fn=keep_dropdown_selection_after_copy,
            inputs=[self.preset_dropdown],
            outputs=[self.preset_dropdown],
            _js='function(name){ window.copyPromptPresetByName(name); return [name]; }'
        )

    def create_submit_box(self):
        with gr.Row(elem_id=f"{self.id_part}_generate_box", elem_classes=["generate-box"] + (["generate-box-compact"] if self.is_compact else []), render=not self.is_compact) as submit_box:
            self.submit_box = submit_box

            self.interrupt = gr.Button('Interrupt', elem_id=f"{self.id_part}_interrupt", elem_classes="generate-box-interrupt", tooltip="End generation immediately or after completing current batch")
            self.skip = gr.Button('Skip', elem_id=f"{self.id_part}_skip", elem_classes="generate-box-skip", tooltip="Stop generation of current batch and continues onto next batch")
            self.interrupting = gr.Button('Interrupting...', elem_id=f"{self.id_part}_interrupting", elem_classes="generate-box-interrupting", tooltip="Interrupting generation...")
            self.submit = gr.Button('Generate', elem_id=f"{self.id_part}_generate", variant='primary', tooltip="Right click generate forever menu")

            def interrupt_function():
                if not shared.state.stopping_generation and shared.state.job_count > 1 and shared.opts.interrupt_after_current:
                    shared.state.stop_generating()
                    gr.Info("Generation will stop after finishing this image, click again to stop immediately.")
                else:
                    shared.state.interrupt()

            self.skip.click(fn=shared.state.skip)
            self.interrupt.click(fn=interrupt_function, _js='function(){ showSubmitInterruptingPlaceholder("' + self.id_part + '"); }')
            self.interrupting.click(fn=interrupt_function)

        if not self.is_compact:
            gr.HTML(
                value=f"<div id=\"{self.id_part}_compare_dropzone\" class=\"prompt-compare-dropzone\" data-tabname=\"{self.id_part}\">Drop .txt or image here to compare against current prompt/settings</div>",
                elem_id=f"{self.id_part}_compare_dropzone_wrap",
            )

    def create_tools_row(self):
        with gr.Row(elem_id=f"{self.id_part}_tools"):
            from modules.ui import paste_symbol, clear_prompt_symbol, restore_progress_symbol

            self.paste = ToolButton(value=paste_symbol, elem_id="paste", tooltip="Read generation parameters from prompt or last generation if prompt is empty into user interface.")
            self.clear_prompt_button = ToolButton(value=clear_prompt_symbol, elem_id=f"{self.id_part}_clear_prompt", tooltip="Clear prompt")
            self.apply_styles = ToolButton(value=ui_prompt_styles.styles_materialize_symbol, elem_id=f"{self.id_part}_style_apply", tooltip="Apply all selected styles to prompts.")

            if self.is_img2img:
                self.button_interrogate = ToolButton('📎', tooltip='Interrogate CLIP - use CLIP neural network to create a text describing the image, and put it into the prompt field', elem_id="interrogate")
                self.button_deepbooru = ToolButton('📦', tooltip='Interrogate DeepBooru - use DeepBooru neural network to create a text describing the image, and put it into the prompt field', elem_id="deepbooru")

            self.queue_btn = gr.Button('Queue', elem_id=f"{self.id_part}_queue_btn", variant='secondary', tooltip="Add current settings to job queue")
            self.restore_progress_button = ToolButton(value=restore_progress_symbol, elem_id=f"{self.id_part}_restore_progress", visible=False, tooltip="Restore progress")

            self.token_counter = gr.HTML(value="<span>0/75</span>", elem_id=f"{self.id_part}_token_counter", elem_classes=["token-counter"], visible=False)
            self.token_button = gr.Button(visible=False, elem_id=f"{self.id_part}_token_button")
            self.negative_token_counter = gr.HTML(value="<span>0/75</span>", elem_id=f"{self.id_part}_negative_token_counter", elem_classes=["token-counter"], visible=False)
            self.negative_token_button = gr.Button(visible=False, elem_id=f"{self.id_part}_negative_token_button")

            self.clear_prompt_button.click(
                fn=lambda *x: x,
                _js="confirm_clear_prompt",
                inputs=[self.prompt, self.negative_prompt],
                outputs=[self.prompt, self.negative_prompt],
            )

            self.queue_status = gr.HTML("", elem_id=f"{self.id_part}_queue_status", elem_classes=["jq-notice-bar"])

    def create_styles_ui(self):
        self.ui_styles = ui_prompt_styles.UiPromptStyles(self.id_part, self.prompt, self.negative_prompt)
        self.ui_styles.setup_apply_button(self.apply_styles)
