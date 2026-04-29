import base64
import datetime
import io
import json
import os

import gradio as gr
from PIL import Image, ImageOps

from modules import infotext_utils as parameters_copypaste
from modules import script_callbacks, shared


COMPOSER_HTML = """
<style>
#composer_root { display: grid; grid-template-columns: 280px 1fr; gap: 12px; }
#composer_left { display: grid; gap: 10px; }
#composer_left .composer-box { border: 1px solid var(--block-border-color); border-radius: 8px; padding: 10px; }
#composer_left h4 { margin: 0 0 8px 0; font-size: 14px; }
#composer_canvas_wrap { border: 1px solid var(--block-border-color); border-radius: 8px; padding: 8px; background: #0f172a; }
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
#composer_status_text { color: #cbd5e1; font-size: 12px; margin-top: 8px; }
</style>

<div id="composer_root">
    <div id="composer_left">
        <div class="composer-box">
            <h4>1) Background (drag/drop)</h4>
            <input id="composer_bg_input" type="file" accept="image/*" />
        </div>
        <div class="composer-box">
            <h4>2) Character PNGs (drag/drop multiple)</h4>
            <input id="composer_chars_input" type="file" accept="image/*" multiple />
        </div>
        <div class="composer-box">
            <h4>Layers</h4>
            <div id="composer_layers"></div>
            <div id="composer_actions" style="margin-top:8px;">
                <button id="composer_mirror_btn" type="button">Mirror Selected</button>
                <button id="composer_delete_btn" type="button">Delete Selected</button>
            </div>
            <div id="composer_status_text">Tip: Drag layer to move. Corner handle to resize. Top handle to rotate.</div>
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

        background = _image_from_data_url(payload.get("background"))
        if background is not None:
                background = background.resize((width, height), Image.Resampling.LANCZOS)
                canvas = background
        else:
                canvas = Image.new("RGBA", (width, height), (0, 0, 0, 0))

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

        return canvas, f"Composited {len(payload.get('layers', []))} layer(s)."


def save_composite(image):
        if image is None:
                return "No composite image to save."

        outdir = shared.opts.outdir_extras_samples or os.path.join(shared.cmd_opts.data_dir, "outputs", "extras-images")
        composer_dir = os.path.join(outdir, "composer")
        os.makedirs(composer_dir, exist_ok=True)

        ts = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
        outpath = os.path.join(composer_dir, f"composer-{ts}.png")
        image.save(outpath, format="PNG")
        return f"Saved: {outpath}"


def on_ui_tabs():
        with gr.Blocks(analytics_enabled=False) as composer_ui:
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
