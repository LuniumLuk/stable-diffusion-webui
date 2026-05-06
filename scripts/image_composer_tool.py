import base64
import datetime
import io
import json
import os

import gradio as gr
from PIL import Image, ImageOps

from modules import infotext_utils as parameters_copypaste
from modules import script_callbacks, shared


_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_ROOT_DIR = os.path.dirname(_SCRIPT_DIR)


COMPOSER_HTML = """
<style>
#composer_root { display: grid; grid-template-columns: 280px 1fr; gap: 12px; }
#composer_left { display: grid; gap: 10px; }
#composer_left .composer-box { border: 1px solid var(--block-border-color); border-radius: 8px; padding: 10px; }
#composer_upload_row { margin-bottom: 8px; gap: 10px; }
#composer_upload_row #composer_bg_upload,
#composer_upload_row #composer_chars_upload { min-height: 110px; }
#composer_upload_row #composer_bg_upload .label-wrap,
#composer_upload_row #composer_chars_upload .label-wrap { margin-bottom: 4px; }
#composer_left h4 { margin: 0 0 8px 0; font-size: 14px; }
#composer_canvas_wrap { border: 1px solid var(--block-border-color); border-radius: 8px; padding: 8px; background: #0f172a; overflow: hidden; cursor: grab; }
#composer_canvas_wrap.panning { cursor: grabbing; }
#composer_canvas { width: 100%; height: 70vh; min-height: 420px; display: block; background:
linear-gradient(45deg,#1e293b 25%,transparent 25%),
linear-gradient(-45deg,#1e293b 25%,transparent 25%),
linear-gradient(45deg,transparent 75%,#1e293b 75%),
linear-gradient(-45deg,transparent 75%,#1e293b 75%);
background-size: 24px 24px; background-position: 0 0,0 12px,12px -12px,-12px 0;
}
#composer_layers { max-height: 210px; overflow: auto; display: grid; gap: 6px; }
.composer-layer-item { border: 1px solid #475569; color: #e2e8f0; border-radius: 6px; padding: 6px 8px; cursor: pointer; font-size: 12px; }
.composer-layer-item.active { border-color: #38bdf8; box-shadow: 0 0 0 1px #38bdf8 inset; }
#composer_actions { display: flex; gap: 8px; flex-wrap: wrap; }
#composer_actions button.active { border-color: #22d3ee; box-shadow: 0 0 0 1px #22d3ee inset; }
#composer_toolbox {
        margin-top: 10px;
        display: grid;
        gap: 8px;
}
.composer-tool-row {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        align-items: center;
}
.composer-tool-row button.active {
        border-color: #f59e0b;
        box-shadow: 0 0 0 1px #f59e0b inset;
}
#composer_draw_color {
        width: 42px;
        height: 30px;
        padding: 0;
        border: 1px solid #4b5563;
        border-radius: 6px;
        background: transparent;
}
#composer_brush_size {
        width: 130px;
}
.composer-tool-label {
        color: #cbd5e1;
        font-size: 12px;
}
#composer_bg_color_row {
        margin-top: 8px;
        display: flex;
        gap: 8px;
        align-items: center;
        flex-wrap: wrap;
}
#composer_bg_color {
        width: 42px;
        height: 30px;
        padding: 0;
        border: 1px solid #4b5563;
        border-radius: 6px;
        background: transparent;
}
#composer_bg_color_apply,
#composer_bg_color_random {
        font-size: 11px;
        padding: 4px 8px;
}
#composer_bg_lock_btn {
        margin-top: 6px;
        width: 100%;
        font-size: 11px;
        color: #9ca3af;
        border-color: #4b5563;
}
#composer_bg_lock_btn.active {
        color: #cbd5e1;
}
#composer_assets { max-height: 220px; overflow: auto; display: grid; gap: 8px; }
.composer-asset-item { border: 1px solid #475569; border-radius: 6px; padding: 6px; display: grid; grid-template-columns: 48px 1fr; gap: 8px; align-items: center; }
.composer-asset-item img { width: 48px; height: 48px; object-fit: cover; border-radius: 4px; border: 1px solid #334155; }
.composer-asset-meta { display: grid; gap: 4px; min-width: 0; }
.composer-asset-name { color: #e2e8f0; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.composer-asset-actions { display: flex; gap: 6px; }
.composer-asset-actions button { font-size: 11px; padding: 2px 6px; }
#composer_status_text { color: #cbd5e1; font-size: 12px; margin-top: 8px; }
</style>

<div id="composer_root">
    <div id="composer_left">
        <div class="composer-box">
            <h4>Layers</h4>
            <div id="composer_layers"></div>
            <div id="composer_actions" style="margin-top:8px;">
                                <button id="composer_lock_mode_btn" type="button" title="When enabled, canvas edits only affect the selected layer">Lock Edit To Selected: OFF</button>
                                <button id="composer_restore_bg_btn" type="button" title="Reset background position, scale, rotation and mirror to default">Restore BG Transform</button>
                <button id="composer_mirror_btn" type="button">Mirror Selected</button>
                <button id="composer_delete_btn" type="button">Delete Selected</button>
                <button id="composer_layer_up_btn" type="button" title="Move layer up (toward front)">&#9650; Up</button>
                <button id="composer_layer_down_btn" type="button" title="Move layer down (toward back)">&#9660; Down</button>
                                <button id="composer_bg_lock_btn" type="button" class="active" title="Background is locked by default. Enable this to edit only the background layer.">Lock Edit Background: OFF</button>
            </div>
                        <div id="composer_toolbox">
                                <div class="composer-tool-row">
                                        <button id="composer_tool_move_btn" type="button" class="active" title="Move, resize, and rotate layers">Move</button>
                                        <button id="composer_tool_brush_btn" type="button" title="Paint on a full-canvas overlay layer at the top of the stack">Brush</button>
                                        <button id="composer_tool_line_btn" type="button" title="Draw a straight line on a full-canvas overlay layer at the top of the stack">Line</button>
                                        <button id="composer_tool_picker_btn" type="button" title="Pick a color from the canvas">Pick Color</button>
                                        <button id="composer_tool_crop_btn" type="button" title="Drag a crop region on the selected layer">Crop</button>
                                </div>
                                <div class="composer-tool-row">
                                        <span class="composer-tool-label">Color</span>
                                        <input id="composer_draw_color" type="color" value="#ff3366" title="Brush and line color" />
                                        <span class="composer-tool-label">Size</span>
                                        <input id="composer_brush_size" type="range" min="1" max="96" step="1" value="18" title="Brush/line size" />
                                        <span id="composer_brush_size_value" class="composer-tool-label">18 px</span>
                                </div>
                                <div class="composer-tool-row">
                                        <button id="composer_crop_apply_btn" type="button" title="Apply the current crop selection to the selected layer">Apply Crop</button>
                                        <button id="composer_crop_cancel_btn" type="button" title="Cancel the current crop selection">Cancel Crop</button>
                                </div>
                        </div>
                        <div id="composer_bg_color_row">
                                <input id="composer_bg_color" type="color" value="#1e293b" title="Pure color background" />
                                <button id="composer_bg_color_apply" type="button" title="Use selected color as background">Use Color BG</button>
                                <button id="composer_bg_color_random" type="button" title="Random background color">Random</button>
                        </div>
                        <div id="composer_status_text">Tip: Background is locked by default. Enable background edit lock to edit only background. Selected-lock mode supports WASD move and +/- scale. Brush and line draw on a full-canvas top overlay. Right mouse drag pans the canvas view.</div>
                </div>
                <div class="composer-box">
                        <h4>Staged Character Images</h4>
                        <div id="composer_assets"></div>
        </div>
    </div>
    <div id="composer_canvas_wrap">
        <canvas id="composer_canvas" width="1280" height="768"></canvas>
    </div>
</div>
"""


def _image_from_data_url(value):
        if not value:
                return None

        if value.startswith("data:"):
                _, payload = value.split(",", 1)
                raw = base64.b64decode(payload)
        else:
                raw = base64.b64decode(value)

        with Image.open(io.BytesIO(raw)) as img:
                return img.convert("RGBA")


def compose_from_payload(payload_json):
        if not payload_json:
                raise gr.Error("No composer payload found. Add images first.")

        payload = json.loads(payload_json)
        width = int(payload.get("width", 1024))
        height = int(payload.get("height", 768))

        canvas = Image.new("RGBA", (width, height), (0, 0, 0, 0))

        bg_color = (payload.get("background_color") or "").strip()
        if bg_color:
                try:
                        c = bg_color.lstrip("#")
                        if len(c) == 6:
                                r = int(c[0:2], 16)
                                g = int(c[2:4], 16)
                                b = int(c[4:6], 16)
                                canvas = Image.new("RGBA", (width, height), (r, g, b, 255))
                except Exception:
                        pass

        # Backward compatibility with older payloads that only provided a background image.
        background = _image_from_data_url(payload.get("background"))
        if background is not None and not payload.get("layers"):
                background = background.resize((width, height), Image.Resampling.LANCZOS)
                canvas = Image.alpha_composite(canvas, background)

        for layer in payload.get("layers", []):
                layer_img = _image_from_data_url(layer.get("src"))
                if layer_img is None:
                        continue

                if layer.get("mirror", False):
                        layer_img = ImageOps.mirror(layer_img)

                scale = max(0.05, float(layer.get("scale", 1.0)))
                target_w = max(1, int(round(layer_img.width * scale)))
                target_h = max(1, int(round(layer_img.height * scale)))
                layer_img = layer_img.resize((target_w, target_h), Image.Resampling.LANCZOS)

                rot = float(layer.get("rot_deg", 0.0))
                if layer.get("mirror", False):
                        rot = -rot
                if abs(rot) > 0.001:
                        layer_img = layer_img.rotate(rot, resample=Image.Resampling.BICUBIC, expand=True)

                opacity = max(0.0, min(1.0, float(layer.get("opacity", 1.0))))
                if opacity < 1.0:
                        alpha = layer_img.getchannel("A")
                        alpha = alpha.point(lambda v: int(v * opacity))
                        layer_img.putalpha(alpha)

                center_x = float(layer.get("x", width / 2))
                center_y = float(layer.get("y", height / 2))
                paste_x = int(round(center_x - layer_img.width / 2))
                paste_y = int(round(center_y - layer_img.height / 2))

                stage = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
                stage.paste(layer_img, (paste_x, paste_y), layer_img)
                canvas = Image.alpha_composite(canvas, stage)

        saved_path = _save_composite_png(canvas)
        return canvas, f"Composited {len(payload.get('layers', []))} layer(s). Auto-saved: {saved_path}"


def _composer_output_dir() -> str:
        return os.path.join(_ROOT_DIR, "outputs", "composition")


def _save_composite_png(image: Image.Image) -> str:
        outdir = _composer_output_dir()
        os.makedirs(outdir, exist_ok=True)

        ts = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
        outpath = os.path.join(outdir, f"composition-{ts}.png")
        image.save(outpath, format="PNG")
        return outpath


def save_composite(image):
        if image is None:
                return "No composite image to save."

        outpath = _save_composite_png(image)
        return f"Saved: {outpath}"


def on_ui_tabs():
        with gr.Blocks(analytics_enabled=False) as composer_ui:
                with gr.Row(elem_id="composer_upload_row", equal_height=True):
                        with gr.Column(scale=1, min_width=220):
                                gr.Image(label="Background", type="filepath", image_mode="RGBA", sources=["upload"], elem_id="composer_bg_upload")
                        with gr.Column(scale=1, min_width=220):
                                gr.Files(label="Character PNGs", file_types=["image"], elem_id="composer_chars_upload")

                gr.HTML(COMPOSER_HTML)

                payload_state = gr.Textbox(value="", visible=False, elem_id="composer_payload_state")

                with gr.Row():
                        compose_btn = gr.Button("Compose to Output", variant="primary", elem_id="composer_compose")
                        save_btn = gr.Button("Save Output", elem_id="composer_save")
                        send_to_img2img = gr.Button("Send Output to img2img", elem_id="composer_send_to_img2img")
                        send_to_extras = gr.Button("Send Output to Extras", elem_id="composer_send_to_extras")

                output_image = gr.Image(label="Composite Output", type="pil", image_mode="RGBA", interactive=False, elem_id="composer_output")
                status = gr.Markdown("Ready.")

                compose_btn.click(
                        fn=compose_from_payload,
                        _js="composer_export_payload",
                        inputs=[payload_state],
                        outputs=[output_image, status],
                        show_progress=True,
                )

                save_btn.click(
                        fn=save_composite,
                        inputs=[output_image],
                        outputs=[status],
                        show_progress=False,
                )

                parameters_copypaste.register_paste_params_button(parameters_copypaste.ParamBinding(
                        paste_button=send_to_img2img,
                        tabname="img2img",
                        source_image_component=output_image,
                ))
                parameters_copypaste.register_paste_params_button(parameters_copypaste.ParamBinding(
                        paste_button=send_to_extras,
                        tabname="extras",
                        source_image_component=output_image,
                ))

        return [(composer_ui, "Composer", "composer")]


script_callbacks.on_ui_tabs(on_ui_tabs)
