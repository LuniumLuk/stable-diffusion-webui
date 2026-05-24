import base64
import datetime
import io
import os

import gradio as gr
from PIL import Image

from modules import script_callbacks


CENSOR_HTML = """
<style>
#censor_panel_root {
    display: grid;
    grid-template-columns: 260px 1fr;
    gap: 12px;
}

#censor_controls {
    border: 1px solid var(--block-border-color);
    border-radius: 8px;
    padding: 12px;
    display: grid;
    align-content: start;
    gap: 10px;
}

#censor_controls label {
    font-size: 13px;
    color: var(--body-text-color);
}

#censor_line_width {
    width: 100%;
}

#censor_overwrite_width_btn {
    width: 100%;
}

#censor_line_shape {
    width: 100%;
    min-height: 2.4em;
    padding: 0.45em 0.7em;
    border-radius: 8px;
    border: 1px solid var(--block-border-color);
    background: var(--input-background-fill, var(--background-fill-primary, #ffffff));
    color: var(--body-text-color, #111827);
}

#censor_line_shape option {
    background: var(--input-background-fill, var(--background-fill-primary, #ffffff));
    color: var(--body-text-color, #111827);
}

#censor_line_width_value {
    font-size: 12px;
    color: var(--body-text-color-subdued, #94a3b8);
}

#censor_hint {
    margin-top: 4px;
    font-size: 12px;
    color: var(--body-text-color-subdued, #94a3b8);
}

#censor_save_panel {
    border: 1px solid var(--block-border-color);
    border-radius: 8px;
    padding: 10px;
    display: grid;
    gap: 8px;
}

#censor_save_btn {
    width: 100%;
}

#censor_save_status {
    font-size: 12px;
    color: var(--body-text-color-subdued, #94a3b8);
}

#censor_canvas_wrap {
    position: relative;
    border: 1px solid var(--block-border-color);
    border-radius: 8px;
    padding: 8px;
    background: #0f172a;
    min-height: 460px;
}

#censor_canvas {
    width: 100%;
    height: 72vh;
    min-height: 420px;
    display: block;
    border-radius: 6px;
    background:
        linear-gradient(45deg, #1e293b 25%, transparent 25%),
        linear-gradient(-45deg, #1e293b 25%, transparent 25%),
        linear-gradient(45deg, transparent 75%, #1e293b 75%),
        linear-gradient(-45deg, transparent 75%, #1e293b 75%);
    background-size: 24px 24px;
    background-position: 0 0, 0 12px, 12px -12px, -12px 0;
    cursor: crosshair;
    touch-action: none;
}

#censor_drop_hint {
    position: absolute;
    inset: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 6px;
    border: 2px dashed rgba(148, 163, 184, 0.6);
    color: #cbd5e1;
    font-size: 14px;
    pointer-events: none;
    text-align: center;
    padding: 12px;
}

#censor_drop_hint.hidden {
    display: none;
}

@media (max-width: 900px) {
    #censor_panel_root {
        grid-template-columns: 1fr;
    }

    #censor_canvas {
        height: 56vh;
    }
}
</style>

<div id="censor_panel_root">
    <div id="censor_controls">
        <label for="censor_brush_type">Brush type</label>
        <select id="censor_brush_type">
            <option value="line" selected>Line</option>
            <option value="mosaic">Mosaic</option>
        </select>
        <div id="censor_line_settings">
            <label for="censor_line_width">Line thickness</label>
            <input id="censor_line_width" type="range" min="1" max="96" step="1" value="18" />
            <div id="censor_line_width_value">18 px</div>
            <button id="censor_overwrite_width_btn" type="button">Overwrite Existing Line Width</button>
            <label for="censor_line_shape">Line ending shape</label>
            <select id="censor_line_shape">
                <option value="round" selected>Round</option>
                <option value="square">Rectangle</option>
                <option value="butt">Flat</option>
            </select>
        </div>
        <div id="censor_mosaic_settings" style="display:none">
            <label for="censor_mosaic_block_size">Mosaic block size</label>
            <input id="censor_mosaic_block_size" type="range" min="4" max="64" step="1" value="16" />
            <div id="censor_mosaic_block_size_value">16 px</div>
        </div>
        <div id="censor_hint">Select a brush. For Line: two left clicks draw a segment. For Mosaic: click and drag to pixelate. Right mouse drag moves the image. Ctrl+Z undo, Ctrl+Y redo.</div>
        <div id="censor_save_panel">
            <button id="censor_save_btn" type="button">Save to outputs/censored</button>
            <div id="censor_save_status">Ready.</div>
        </div>
    </div>

    <div id="censor_canvas_wrap">
        <canvas id="censor_canvas" width="1280" height="768"></canvas>
        <div id="censor_drop_hint">Drop image here</div>
    </div>
</div>
"""


def _image_from_data_url(data_url: str):
    if not data_url:
        return None

    try:
        if data_url.startswith("data:"):
            _, payload = data_url.split(",", 1)
            raw = base64.b64decode(payload)
        else:
            raw = base64.b64decode(data_url)
    except Exception:
        return None

    with Image.open(io.BytesIO(raw)) as img:
        return img.convert("RGBA")


def save_censored_image(data_url: str):
    image = _image_from_data_url(data_url)
    if image is None:
        return "No image to save. Load an image first."

    root_dir = os.path.dirname(os.path.dirname(__file__))
    outdir = os.path.join(root_dir, "outputs", "censored")
    os.makedirs(outdir, exist_ok=True)

    ts = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    outpath = os.path.join(outdir, f"censored-{ts}.png")
    image.save(outpath, format="PNG")
    return f"Saved: {outpath}"


def on_ui_tabs():
    with gr.Blocks(analytics_enabled=False) as censor_ui:
        gr.HTML(CENSOR_HTML)
        export_data = gr.Textbox(value="", visible=False, elem_id="censor_export_data")
        save_status = gr.Markdown("Ready.", elem_id="censor_save_status_md")

        save_btn = gr.Button("Save", visible=False, elem_id="censor_save_bridge_btn")
        save_btn.click(
            fn=save_censored_image,
            _js="censor_export_png",
            inputs=[export_data],
            outputs=[save_status],
            show_progress=False,
        )

    return [(censor_ui, "Censor", "censor_panel")]


script_callbacks.on_ui_tabs(on_ui_tabs)
