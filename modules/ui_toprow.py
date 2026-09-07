import gradio as gr
import html
import json

from modules import shared, ui_prompt_styles, prompt_presets
import modules.images

from modules.ui_components import ToolButton


# Fields that can be staged in img2img. Order matters: it must match the order
# of `stage_field_components` in modules/ui.py and the popup rendered by
# javascript/img2imgStagePanel.js.
IMG2IMG_STAGE_FIELDS = [
    ("prompt", "Prompt"),
    ("negative_prompt", "Negative prompt"),
    ("steps", "Sampling steps"),
    ("sampler_name", "Sampling method"),
    ("scheduler", "Schedule type"),
    ("seed", "Seed"),
    ("cfg_scale", "CFG Scale"),
    ("image_cfg_scale", "Image CFG Scale"),
    ("width", "Width"),
    ("height", "Height"),
    ("resize_tab", "Resize To/By"),
    ("scale_by", "Scale (Resize by)"),
    ("batch_count", "Batch count"),
    ("batch_size", "Batch size"),
    ("denoising_strength", "Denoising strength"),
    ("resize_mode", "Resize mode"),
    ("mask_blur", "Mask blur"),
    ("mask_mode", "Mask mode"),
    ("masked_content", "Masked content"),
    ("inpaint_area", "Inpaint area"),
    ("only_masked_padding", "Only masked padding"),
]

IMG2IMG_STAGE_KEYS = [key for key, _ in IMG2IMG_STAGE_FIELDS]


def stage_update_value(key, value, component):
    """Convert a stored stage value into the value Gradio expects for `component`.

    For index-typed radios the stored value is an index, but the frontend keeps
    the choice label as the component value, so convert back to the label.
    Returns None when the stored value cannot be mapped to a choice.
    """
    if isinstance(component, gr.Radio) and getattr(component, "type", None) == "index" and isinstance(value, (int, float)) and not isinstance(value, bool):
        idx = int(value)
        if 0 <= idx < len(component.choices):
            return component.choices[idx][1]
        return None
    return value


class Img2imgStageManager:
    """Keeps img2img generation-settings stages in memory and renders the stage list."""

    def __init__(self):
        self.stages = {}  # name -> {field_key: value}

    def _next_default_name(self):
        i = 1
        while f"#{i}" in self.stages:
            i += 1
        return f"#{i}"

    def list_html(self):
        fields_json = json.dumps([{"key": key, "label": label} for key, label in IMG2IMG_STAGE_FIELDS])
        fields_attr = html.escape(fields_json, quote=True)

        if not self.stages:
            body = '<span class="img2img-stage-empty">No stages yet</span>'
        else:
            rows = []
            for i, (name, stage) in enumerate(self.stages.items(), start=1):
                esc = html.escape(str(name), quote=True)
                count = len(stage)
                shortcut = f"Alt+{i}" if i <= 9 else ""
                rows.append(
                    '<div class="img2img-stage-item">'
                    f'<span class="img2img-stage-idx" title="{shortcut}">{i}</span>'
                    f'<span class="img2img-stage-name" title="{esc} ({count} fields)">{esc}</span>'
                    f'<button type="button" class="img2img-stage-btn apply" data-stage="{esc}" onclick="window.img2imgStageApply(this)">Apply</button>'
                    f'<button type="button" class="img2img-stage-btn drop" data-stage="{esc}" onclick="window.img2imgStageDrop(this)">Drop</button>'
                    '</div>'
                )
            body = ''.join(rows)

        return f'<div id="img2img_stage_list" class="img2img-stage-list" data-fields="{fields_attr}">{body}</div>'

    def capture(self, payload, *values):
        """Store a new stage from the currently selected fields. Returns (list html, cleared payload)."""
        try:
            data = json.loads(payload or "{}")
        except Exception:
            return gr.update(), gr.update(value="")

        requested = {str(f) for f in (data.get("fields") or [])}
        selected = [key for key in IMG2IMG_STAGE_KEYS if key in requested]
        if not selected:
            return gr.update(), gr.update(value="")

        name = str(data.get("name") or "").strip()
        if not name:
            name = self._next_default_name()

        values = list(values)
        stage = {}
        for i, key in enumerate(IMG2IMG_STAGE_KEYS):
            if key in selected and i < len(values):
                stage[key] = values[i]

        self.stages[name] = stage
        return self.list_html(), gr.update(value="")

    def drop(self, payload):
        name = str(payload or "").strip()
        self.stages.pop(name, None)
        return self.list_html()


img2img_stage_manager = Img2imgStageManager()


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

    staging_add_btn = None
    staging_list_html = None
    staging_payload = None
    staging_capture_btn = None
    staging_apply_btn = None
    staging_drop_btn = None
    staging_created = False
    stage_manager = None

    def __init__(self, is_img2img, is_compact=False, id_part=None):
        if id_part is None:
            id_part = "img2img" if is_img2img else "txt2img"

        self.id_part = id_part
        self.is_img2img = is_img2img
        self.is_compact = is_compact
        self.staging_created = False
        self.stage_manager = img2img_stage_manager

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
        self.create_staging_panel()

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
            self.create_staging_panel()

            gr.HTML(
                value=f"<div id=\"{self.id_part}_compare_dropzone\" class=\"prompt-compare-dropzone\" data-tabname=\"{self.id_part}\">Drop .txt or image here to compare against current prompt/settings</div>",
                elem_id=f"{self.id_part}_compare_dropzone_wrap",
            )

    def create_staging_panel(self):
        """Stage panel below the Generate button (img2img only). Wiring happens in modules/ui.py."""
        if not self.is_img2img or self.staging_created:
            return

        self.staging_created = True

        with gr.Group(elem_id=f"{self.id_part}_staging_panel", elem_classes=["img2img-staging-panel"]):
            with gr.Row(elem_id=f"{self.id_part}_staging_toolbar"):
                self.staging_add_btn = gr.Button("➕ Add stage", elem_id=f"{self.id_part}_stage_add", size="sm", tooltip="Capture current prompt/settings into a stage")

            self.staging_list_html = gr.HTML(value=self.stage_manager.list_html(), elem_id=f"{self.id_part}_stage_list_wrap")

            self.staging_payload = gr.Textbox(value="", visible=False, elem_id=f"{self.id_part}_stage_payload")
            self.staging_capture_btn = gr.Button(visible=False, elem_id=f"{self.id_part}_stage_capture_btn")
            self.staging_apply_btn = gr.Button(visible=False, elem_id=f"{self.id_part}_stage_apply_btn")
            self.staging_drop_btn = gr.Button(visible=False, elem_id=f"{self.id_part}_stage_drop_btn")

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
