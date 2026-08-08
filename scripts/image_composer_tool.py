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
/* ── Root layout ────────────────────────────── */
#composer_root { display: grid; grid-template-columns: 292px 1fr; gap: 12px; }
#composer_left  { display: grid; gap: 8px; align-content: start; }

/* ── Box shell ──────────────────────────────── */
#composer_left .composer-box {
  border: 1px solid var(--block-border-color, #334155);
  border-radius: 8px;
  overflow: hidden;
}
.cmp-box-header {
  padding: 5px 10px;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--body-text-color-subdued, #94a3b8);
  background: rgba(255,255,255,0.03);
  border-bottom: 1px solid var(--block-border-color, #334155);
  user-select: none;
}
.cmp-box-body   { padding: 8px 10px; display: grid; gap: 8px; }
.cmp-section-label {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: #475569;
  padding-top: 2px;
}

/* ── Layer list ─────────────────────────────── */
#composer_layers {
  max-height: 180px;
  overflow: auto;
  display: grid;
  gap: 3px;
}
.composer-layer-item {
  border: 1px solid #334155;
  color: #e2e8f0;
  border-radius: 5px;
  padding: 5px 8px;
  cursor: pointer;
  font-size: 11px;
  transition: border-color .1s, background .1s;
}
.composer-layer-item:hover  { background: rgba(56,189,248,.06); border-color: #475569; }
.composer-layer-item.active { border-color: #38bdf8; box-shadow: 0 0 0 1px #38bdf8 inset; background: rgba(56,189,248,.08); }

/* ── 4-button icon row (▲ ▼ ↔ ✕) ──────────── */
.cmp-icon-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 4px;
}
.cmp-icon-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 6px 2px 5px;
  border: 1px solid var(--block-border-color, #334155);
  border-radius: 6px;
  background: var(--block-background-fill, #1e293b);
  color: var(--body-text-color, #e2e8f0);
  cursor: pointer;
  transition: background .12s, border-color .12s;
}
.cmp-icon-btn .cmp-isym { font-size: 15px; line-height: 1; }
.cmp-icon-btn .cmp-ilbl { font-size: 9px;  color: #64748b; letter-spacing: .02em; }
.cmp-icon-btn:hover          { background: #1e3a5f; border-color: #38bdf8; }
.cmp-icon-btn:hover .cmp-ilbl { color: #7dd3fc; }
.cmp-icon-btn--danger:hover  { background: #450a0a; border-color: #ef4444; }
.cmp-icon-btn--danger:hover .cmp-isym { color: #fca5a5; }

/* ── Toggle buttons (lock modes) ────────────── */
.cmp-toggle-group { display: grid; gap: 4px; }
.cmp-toggle-btn {
  width: 100%;
  padding: 5px 10px;
  border: 1px solid #1e293b;
  border-radius: 6px;
  background: #0f172a;
  color: #4b5563;
  font-size: 11px;
  text-align: left;
  cursor: pointer;
  transition: background .12s, border-color .12s, color .12s;
}
.cmp-toggle-btn::before { content: "○  "; color: #334155; }
.cmp-toggle-btn:hover   { border-color: #334155; color: #94a3b8; }
.cmp-toggle-btn.active  {
  border-color: #22d3ee;
  background: rgba(34,211,238,.08);
  color: #e2e8f0;
  box-shadow: 0 0 0 1px #22d3ee22 inset;
}
.cmp-toggle-btn.active::before { content: "●  "; color: #22d3ee; }

/* ── Tool grid (5 tools) ────────────────────── */
.cmp-tool-grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 4px;
}
.cmp-tool-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 7px 2px 5px;
  border: 1px solid var(--block-border-color, #334155);
  border-radius: 6px;
  background: var(--block-background-fill, #1e293b);
  color: #94a3b8;
  cursor: pointer;
  font-size: 9px;
  letter-spacing: .02em;
  transition: background .12s, border-color .12s, color .12s;
}
.cmp-tool-icon { font-size: 17px; line-height: 1.1; color: #64748b; transition: color .12s; }
.cmp-tool-btn:hover                { background: #1e3a5f; border-color: #38bdf8; color: #cbd5e1; }
.cmp-tool-btn:hover .cmp-tool-icon { color: #38bdf8; }
.cmp-tool-btn.active               { border-color: #f59e0b; background: rgba(245,158,11,.1); color: #fcd34d; }
.cmp-tool-btn.active .cmp-tool-icon{ color: #fbbf24; }

/* ── Paint settings sub-panel ───────────────── */
.cmp-paint-panel {
  border: 1px solid #1e3a5f;
  border-radius: 6px;
  padding: 7px 9px;
  background: rgba(30,58,95,.18);
  display: grid;
  gap: 5px;
}
.cmp-paint-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.cmp-flabel {
  font-size: 10px;
  color: #475569;
  white-space: nowrap;
  flex-shrink: 0;
}
.cmp-fval {
  font-size: 10px;
  color: #64748b;
  white-space: nowrap;
  margin-left: auto;
}
#composer_draw_color {
  width: 28px;
  height: 22px;
  padding: 0;
  border: 1px solid #4b5563;
  border-radius: 4px;
  background: transparent;
  cursor: pointer;
  flex-shrink: 0;
}
#composer_brush_size { width: 100%; }

/* ── Crop actions ───────────────────────────── */
.cmp-crop-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px;
}
.cmp-sm-btn {
  font-size: 11px;
  padding: 4px 6px;
  border: 1px solid var(--block-border-color, #334155);
  border-radius: 5px;
  background: var(--block-background-fill, #1e293b);
  color: var(--body-text-color, #e2e8f0);
  cursor: pointer;
  text-align: center;
  transition: background .12s, border-color .12s;
}
.cmp-sm-btn:hover { background: #1e3a5f; border-color: #38bdf8; }

/* ── Full-width action button ───────────────── */
.cmp-full-btn {
  width: 100%;
  padding: 5px 10px;
  font-size: 11px;
  border: 1px solid var(--block-border-color, #334155);
  border-radius: 6px;
  background: var(--block-background-fill, #1e293b);
  color: var(--body-text-color, #e2e8f0);
  cursor: pointer;
  text-align: left;
  transition: background .12s, border-color .12s;
}
.cmp-full-btn:hover { background: #1e3a5f; border-color: #38bdf8; }

/* ── BG color row ───────────────────────────── */
.cmp-bg-color-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
#composer_bg_color {
  width: 32px;
  height: 24px;
  padding: 0;
  border: 1px solid #4b5563;
  border-radius: 4px;
  background: transparent;
  cursor: pointer;
  flex-shrink: 0;
}
#composer_bg_color_apply, #composer_bg_color_random {
  font-size: 11px;
  padding: 4px 8px;
  border: 1px solid var(--block-border-color, #334155);
  border-radius: 5px;
  background: var(--block-background-fill, #1e293b);
  color: var(--body-text-color, #e2e8f0);
  cursor: pointer;
  transition: background .12s, border-color .12s;
}
#composer_bg_color_apply:hover, #composer_bg_color_random:hover { background: #1e3a5f; border-color: #38bdf8; }

/* ── Canvas size input row ──────────────────── */
.cmp-canvas-size-row {
  display: flex;
  align-items: center;
  gap: 5px;
}
.cmp-canvas-size-row input[type="number"] {
  width: 70px;
  padding: 4px 6px;
  font-size: 12px;
  font-family: monospace;
  border: 1px solid var(--block-border-color, #334155);
  border-radius: 5px;
  background: var(--block-background-fill, #1e293b);
  color: var(--body-text-color, #e2e8f0);
  text-align: center;
}
.cmp-canvas-size-row input[type="number"]:focus {
  border-color: #38bdf8;
  outline: none;
  box-shadow: 0 0 0 1px #38bdf833;
}
.cmp-canvas-size-row .cmp-size-sep {
  color: #475569;
  font-size: 14px;
  font-weight: 700;
  user-select: none;
}
.cmp-canvas-size-row .cmp-sm-btn {
  flex: 1;
}
.cmp-canvas-size-presets {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 3px;
  margin-top: 4px;
}
.cmp-preset-chip {
  font-size: 10px;
  padding: 3px 4px;
  border: 1px solid #334155;
  border-radius: 4px;
  background: #0f172a;
  color: #64748b;
  cursor: pointer;
  text-align: center;
  transition: background .12s, border-color .12s, color .12s;
  white-space: nowrap;
}
.cmp-preset-chip:hover { background: #1e3a5f; border-color: #38bdf8; color: #cbd5e1; }

/* ── Status bar ─────────────────────────────── */
#composer_status_text {
  font-size: 11px;
  color: #475569;
  padding: 5px 9px;
  border: 1px solid #1e293b;
  border-radius: 6px;
  background: rgba(15,23,42,.5);
  line-height: 1.45;
  min-height: 26px;
}

/* ── Assets ─────────────────────────────────── */
#composer_assets { max-height: 220px; overflow: auto; display: grid; gap: 8px; }
.composer-asset-item { border: 1px solid #475569; border-radius: 6px; padding: 6px; display: grid; grid-template-columns: 48px 1fr; gap: 8px; align-items: center; }
.composer-asset-item img { width: 48px; height: 48px; object-fit: cover; border-radius: 4px; border: 1px solid #334155; }
.composer-asset-meta { display: grid; gap: 4px; min-width: 0; }
.composer-asset-name { color: #e2e8f0; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.composer-asset-actions { display: flex; gap: 6px; }
.composer-asset-actions button { font-size: 11px; padding: 2px 6px; }

/* ── Canvas ─────────────────────────────────── */
#composer_canvas_wrap { border: 1px solid var(--block-border-color); border-radius: 8px; padding: 8px; background: #0f172a; overflow: hidden; cursor: grab; }
#composer_canvas_wrap.panning { cursor: grabbing; }
#composer_canvas { width: 100%; height: 70vh; min-height: 420px; display: block; background:
linear-gradient(45deg,#1e293b 25%,transparent 25%),
linear-gradient(-45deg,#1e293b 25%,transparent 25%),
linear-gradient(45deg,transparent 75%,#1e293b 75%),
linear-gradient(-45deg,transparent 75%,#1e293b 75%);
background-size: 24px 24px; background-position: 0 0,0 12px,12px -12px,-12px 0;
}
</style>

<div id="composer_root">
  <!-- ═══ LEFT PANEL ════════════════════════════ -->
  <div id="composer_left">

    <!-- ─ LAYERS ──────────────────────────────── -->
    <div class="composer-box">
      <div class="cmp-box-header">Layers</div>
      <div class="cmp-box-body">
        <div id="composer_layers"></div>

        <div class="cmp-section-label">Layer Controls</div>
        <div class="cmp-icon-grid">
          <button id="composer_layer_up_btn" type="button" class="cmp-icon-btn"
                  title="Move layer up (toward front)">
            <span class="cmp-isym">&#9650;</span><span class="cmp-ilbl">Up</span>
          </button>
          <button id="composer_layer_down_btn" type="button" class="cmp-icon-btn"
                  title="Move layer down (toward back)">
            <span class="cmp-isym">&#9660;</span><span class="cmp-ilbl">Down</span>
          </button>
          <button id="composer_mirror_btn" type="button" class="cmp-icon-btn"
                  title="Flip selected layer horizontally">
            <span class="cmp-isym">&#8596;</span><span class="cmp-ilbl">Mirror</span>
          </button>
          <button id="composer_delete_btn" type="button" class="cmp-icon-btn cmp-icon-btn--danger"
                  title="Delete selected layer">
            <span class="cmp-isym">&#x2715;</span><span class="cmp-ilbl">Delete</span>
          </button>
        </div>

        <div class="cmp-section-label">Edit Mode</div>
        <div class="cmp-toggle-group">
          <button id="composer_lock_mode_btn" type="button" class="cmp-toggle-btn"
                  title="When enabled, canvas edits only affect the selected layer">Lock to Selected: OFF</button>
          <button id="composer_bg_lock_btn"   type="button" class="cmp-toggle-btn"
                  title="When enabled, edits target only the background layer">Edit BG Only: OFF</button>
          <button id="composer_use_lctrl_zoom_btn" type="button" class="cmp-toggle-btn"
                  title="When enabled, hold Left Ctrl to zoom the canvas">Use LCtrl To Zoom: OFF</button>
        </div>
      </div>
    </div>

    <!-- ─ TOOLS ───────────────────────────────── -->
    <div class="composer-box">
      <div class="cmp-box-header">Tools</div>
      <div class="cmp-box-body">
        <div class="cmp-tool-grid">
          <button id="composer_tool_move_btn"   type="button" class="cmp-tool-btn active"
                  title="Move, resize, and rotate layers">
            <span class="cmp-tool-icon">&#10010;</span>Move
          </button>
          <button id="composer_tool_brush_btn"  type="button" class="cmp-tool-btn"
                  title="Paint on a full-canvas overlay layer">
            <span class="cmp-tool-icon">&#9997;</span>Brush
          </button>
          <button id="composer_tool_line_btn"   type="button" class="cmp-tool-btn"
                  title="Draw a straight line on the overlay layer">
            <span class="cmp-tool-icon">&#9135;</span>Line
          </button>
          <button id="composer_tool_picker_btn" type="button" class="cmp-tool-btn"
                  title="Pick a color from the canvas">
            <span class="cmp-tool-icon">&#11835;</span>Pick
          </button>
          <button id="composer_tool_crop_btn"   type="button" class="cmp-tool-btn"
                  title="Drag a crop region on the selected layer">
            <span class="cmp-tool-icon">&#8984;</span>Crop
          </button>
        </div>

        <div class="cmp-paint-panel">
          <div class="cmp-paint-row">
            <span class="cmp-flabel">Color</span>
            <input id="composer_draw_color" type="color" value="#ff3366" title="Brush and line color" />
            <span class="cmp-flabel" style="margin-left:6px;">Size</span>
            <span id="composer_brush_size_value" class="cmp-fval">18 px</span>
          </div>
          <input id="composer_brush_size" type="range" min="1" max="96" step="1" value="18"
                 title="Brush / line width" />
                                <div style="margin-top:8px;">
                                        <button id="composer_flatten_paint_btn" type="button" class="cmp-sm-btn"
                                                                        title="Convert the current Top Paint Layer into a normal image layer">Flatten Paint Layer</button>
                                </div>
        </div>

        <div class="cmp-crop-row">
          <button id="composer_crop_apply_btn"  type="button" class="cmp-sm-btn"
                  title="Apply the current crop selection to the selected layer">&#10003; Apply Crop</button>
          <button id="composer_crop_cancel_btn" type="button" class="cmp-sm-btn"
                  title="Cancel the current crop selection">&#10005; Cancel</button>
        </div>
      </div>
    </div>

    <!-- ─ BACKGROUND ──────────────────────────── -->
    <div class="composer-box">
      <div class="cmp-box-header">Background</div>
      <div class="cmp-box-body">
        <button id="composer_restore_bg_btn" type="button" class="cmp-full-btn"
                title="Reset background position, scale, rotation and mirror to default">
          &#8635; Restore BG Transform
        </button>
        <div class="cmp-section-label">Color Fill</div>
        <div class="cmp-bg-color-row">
          <input id="composer_bg_color" type="color" value="#1e293b" title="Pure color background" />
          <button id="composer_bg_color_apply"  type="button" title="Set canvas background to this color">Use Color</button>
          <button id="composer_bg_color_random" type="button" title="Random background color">&#127922; Random</button>
        </div>
      </div>
    </div>

    <!-- ─ CANVAS SIZE ─────────────────────────── -->
    <div class="composer-box">
      <div class="cmp-box-header">Canvas Size</div>
      <div class="cmp-box-body">
        <div class="cmp-canvas-size-row">
          <input id="composer_canvas_width" type="number" min="64" max="8192" step="64" value="1280"
                 title="Canvas width in pixels" />
          <span class="cmp-size-sep">&times;</span>
          <input id="composer_canvas_height" type="number" min="64" max="8192" step="64" value="768"
                 title="Canvas height in pixels" />
          <button id="composer_canvas_size_apply" type="button" class="cmp-sm-btn"
                  title="Resize canvas to the specified dimensions">Apply</button>
        </div>
        <div class="cmp-canvas-size-presets">
          <button type="button" class="cmp-preset-chip" data-w="512"  data-h="512">512&sup2;</button>
          <button type="button" class="cmp-preset-chip" data-w="768"  data-h="768">768&sup2;</button>
          <button type="button" class="cmp-preset-chip" data-w="1024" data-h="1024">1024&sup2;</button>
          <button type="button" class="cmp-preset-chip" data-w="1280" data-h="768">1280&times;768</button>
          <button type="button" class="cmp-preset-chip" data-w="1360" data-h="768">1360&times;768</button>
          <button type="button" class="cmp-preset-chip" data-w="1280" data-h="1024">1280&times;1024</button>
          <button type="button" class="cmp-preset-chip" data-w="1920" data-h="1080">1920&times;1080</button>
          <button type="button" class="cmp-preset-chip" data-w="1024" data-h="576">1024&times;576</button>
        </div>
      </div>
    </div>

    <!-- ─ STATUS ──────────────────────────────── -->
    <div id="composer_status_text">Ready. Select a tool and add images to begin.</div>

    <!-- ─ STAGED IMAGES ───────────────────────── -->
    <div class="composer-box">
      <div class="cmp-box-header">Staged Images</div>
      <div class="cmp-box-body">
        <div id="composer_assets"></div>
      </div>
    </div>

  </div>
  <!-- ═══ CANVAS ═══════════════════════════════ -->
  <div id="composer_canvas_wrap">
    <canvas id="composer_canvas" width="1280" height="768"></canvas>
  </div>
</div>
<input id="composer_config_file_input" type="file" accept=".json" style="display:none" />
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

                # Paste the RGBA image into a transparent stage without using
                # the image as a mask. Using the image as the mask blends the
                # RGB channels against transparent black first, which causes
                # the layer alpha to be effectively applied twice when
                # alpha_composite() is run afterward, producing dark fringes.
                stage = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
                stage.paste(layer_img, (paste_x, paste_y))
                canvas = Image.alpha_composite(canvas, stage)

        saved_path = _save_composite_png(canvas)
        _save_composer_config_sidecar(saved_path, payload_json)
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


def _save_composer_config_sidecar(png_path: str, payload_json: str) -> str:
        """Save a .composerstate.json sidecar alongside the PNG."""
        base = os.path.splitext(png_path)[0]
        config_path = base + ".composerstate.json"
        with open(config_path, "w", encoding="utf-8") as f:
                f.write(payload_json)
        return config_path


def save_composite(image):
        if image is None:
                return "No composite image to save."

        outpath = _save_composite_png(image)
        return f"Saved: {outpath}"


def save_composer_config_only(payload_json):
        """Save the current composer state as a .composerstate.json without composing."""
        if not payload_json or not payload_json.strip() or payload_json.strip() == "null":
                return "No composer state to save. Add images first."

        try:
                json.loads(payload_json)
        except Exception:
                return "Invalid composer state (JSON parse error)."

        outdir = _composer_output_dir()
        os.makedirs(outdir, exist_ok=True)
        ts = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
        outpath = os.path.join(outdir, f"composition-{ts}.composerstate.json")
        with open(outpath, "w", encoding="utf-8") as f:
                f.write(payload_json)
        return f"Config saved: {outpath}"


# ── Caption generation helpers ─────────────────────────────────────────────

def _hex_to_rgb(hex_color: str) -> tuple:
        c = hex_color.strip().lstrip("#")
        if len(c) == 6:
                return int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16)
        return (128, 128, 128)


def _describe_color(r: int, g: int, b: int) -> str:
        """Return a rough human-readable color name for (r,g,b)."""
        brightness = (r * 299 + g * 587 + b * 114) / 1000
        saturation = max(r, g, b) - min(r, g, b)

        if saturation < 30:
                if brightness < 40:   return "near-black"
                if brightness > 215:  return "near-white"
                return "gray"

        if r > g and r > b:
                return "red" if g < 100 and b < 100 else ("orange" if g > 100 else "pink")
        if g > r and g > b:
                return "green" if r < 100 else "yellow-green"
        if b > r and b > g:
                return "blue" if r < 100 and g < 100 else ("cyan" if g > 150 else "purple")
        if r > 180 and g > 180 and b < 100:
                return "yellow"
        if r > 180 and b > 180 and g < 100:
                return "magenta"
        if g > 180 and b > 180 and r < 100:
                return "cyan"
        return f"mixed (r={r},g={g},b={b})"


def _pos_zone(x: float, y: float, w: int, h: int) -> str:
        """Return a human-readable position zone, e.g. 'top-left', 'center'."""
        col = "left"  if x < w * 0.35 else ("right" if x > w * 0.65 else "center")
        row = "top"   if y < h * 0.35 else ("bottom" if y > h * 0.65 else "middle")
        if row == "middle" and col == "center":
                return "center"
        return f"{row}-{col}"


def _size_label(scaled_w: float, scaled_h: float, canvas_w: int, canvas_h: int) -> str:
        pct = (scaled_w * scaled_h) / max(1, canvas_w * canvas_h) * 100
        if pct < 8:    return f"small ({pct:.0f}% of canvas)"
        if pct < 35:   return f"medium ({pct:.0f}% of canvas)"
        return f"large ({pct:.0f}% of canvas)"


def _extract_prompt_from_image(img: Image.Image) -> str | None:
        """Try to read the A1111 generation prompt embedded in PNG metadata."""
        try:
                from modules import images as _images
                params, _ = _images.read_info_from_image(img)
                if params:
                        # Keep only the positive prompt (before Negative prompt / Steps line)
                        for sep in ("\nNegative prompt:", "\nSteps:", "\nSampler:"):
                                if sep in params:
                                        params = params.split(sep)[0]
                        params = params.strip()
                        if params:
                                return params
        except Exception:
                pass
        return None


def _auto_tag_image(img: Image.Image) -> str | None:
        """Run DeepDanbooru on a PIL image; returns comma-separated top tags or None."""
        try:
                from modules import deepbooru
                tags_dict = deepbooru.model.tag_raw(img.convert("RGB"))
                if tags_dict:
                        top = sorted(tags_dict.items(), key=lambda x: x[1], reverse=True)[:25]
                        return ", ".join(t.replace("_", " ") for t, _ in top)
        except Exception:
                pass
        return None


def generate_composition_caption(payload_json: str) -> str:
        """Build a structured text description of the current composition."""
        if not payload_json or payload_json.strip() in ("", "null"):
                return "No composition data. Add layers first then try again."

        try:
                payload = json.loads(payload_json)
        except Exception:
                return "Could not parse composition data."

        canvas_w = int(payload.get("width", 1024))
        canvas_h = int(payload.get("height", 768))
        bg_color_hex = (payload.get("background_color") or "").strip()
        layers = payload.get("layers", [])

        bg_layers    = [l for l in layers if l.get("is_background")]
        fg_layers    = [l for l in layers if not l.get("is_background") and not l.get("is_paint_overlay")]
        paint_layers = [l for l in layers if l.get("is_paint_overlay")]

        lines = []
        lines.append(f"Canvas size: {canvas_w} × {canvas_h} px")
        lines.append("")

        # ── Background ──────────────────────────────────────────────────────
        lines.append("[ Background ]")
        if bg_layers:
                bl = bg_layers[0]
                img = _image_from_data_url(bl.get("src", ""))
                x   = float(bl.get("x",  canvas_w / 2))
                y   = float(bl.get("y",  canvas_h / 2))
                sc  = float(bl.get("scale", 1.0))
                rot = float(bl.get("rot_deg", 0.0))
                mir = bool(bl.get("mirror", False))
                pos = _pos_zone(x, y, canvas_w, canvas_h)
                spatial_parts = [f"anchored at {pos}"]
                if img:
                        sw = img.width  * sc
                        sh = img.height * sc
                        spatial_parts.append(_size_label(sw, sh, canvas_w, canvas_h))
                if abs(rot) > 0.5:
                        spatial_parts.append(f"rotated {rot:.1f}°")
                if mir:
                        spatial_parts.append("mirrored")
                lines.append("  Type: image layer  |  " + ",  ".join(spatial_parts))
                if img:
                        prompt = _extract_prompt_from_image(img)
                        if prompt:
                                lines.append(f"  Prompt (from metadata): {prompt}")
                        else:
                                tags = _auto_tag_image(img)
                                if tags:
                                        lines.append(f"  Auto-tags: {tags}")
                                else:
                                        lines.append("  (no prompt metadata or tags available)")
                if bg_color_hex:
                        r, g, b = _hex_to_rgb(bg_color_hex)
                        lines.append(f"  Color tint: {bg_color_hex} ({_describe_color(r, g, b)})")
        elif bg_color_hex:
                r, g, b = _hex_to_rgb(bg_color_hex)
                lines.append(f"  Type: solid color fill")
                lines.append(f"  Color: {bg_color_hex}  ({_describe_color(r, g, b)})  RGB({r}, {g}, {b})")
        else:
                lines.append("  Type: transparent / no background")

        lines.append("")

        # ── Foreground layers ────────────────────────────────────────────────
        if fg_layers:
                lines.append(f"[ Foreground — {len(fg_layers)} element(s) ]")
                for idx, layer in enumerate(fg_layers, 1):
                        name = layer.get("name") or f"Layer {idx}"
                        x    = float(layer.get("x",   canvas_w / 2))
                        y    = float(layer.get("y",   canvas_h / 2))
                        sc   = float(layer.get("scale",   1.0))
                        rot  = float(layer.get("rot_deg", 0.0))
                        mir  = bool(layer.get("mirror", False))
                        op   = float(layer.get("opacity", 1.0))
                        pos  = _pos_zone(x, y, canvas_w, canvas_h)

                        img = _image_from_data_url(layer.get("src", ""))
                        spatial_parts = [f"positioned at {pos}"]
                        if img:
                                sw = img.width  * sc
                                sh = img.height * sc
                                spatial_parts.append(_size_label(sw, sh, canvas_w, canvas_h))
                        if abs(rot) > 0.5:
                                spatial_parts.append(f"rotated {rot:.1f}°")
                        if mir:
                                spatial_parts.append("mirrored")
                        if op < 0.99:
                                spatial_parts.append(f"opacity {op*100:.0f}%")

                        lines.append(f"\n  ({idx}) {name}")
                        lines.append("       " + ",  ".join(spatial_parts))
                        if img:
                                prompt = _extract_prompt_from_image(img)
                                if prompt:
                                        lines.append(f"       Prompt (from metadata): {prompt}")
                                else:
                                        tags = _auto_tag_image(img)
                                        if tags:
                                                lines.append(f"       Auto-tags: {tags}")
                                        else:
                                                lines.append("       (no prompt metadata or tags available)")
        else:
                lines.append("[ Foreground — none ]")

        lines.append("")

        # ── Paint overlay ────────────────────────────────────────────────────
        if paint_layers:
                lines.append("[ Paint Overlay ]")
                lines.append("  A hand-drawn paint layer is present on top of the composition.")
                lines.append("")

        # ── LLM prompt scaffold ──────────────────────────────────────────────
        lines.append("─" * 60)
        lines.append("Paste the above into a LLM with a message such as:")
        lines.append(
                "\"Based on this composition description, write a Stable Diffusion XL "
                "img2img prompt that faithfully reproduces the scene, placing each "
                "subject in the described position with matching style and mood.\""
        )

        return "\n".join(lines)


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
                        save_config_btn = gr.Button("Save Config", elem_id="composer_save_config")
                        load_config_btn = gr.Button("Load Config…", elem_id="composer_load_config_btn")
                        caption_btn = gr.Button("Generate Caption", elem_id="composer_caption_btn")
                        send_to_img2img = gr.Button("Send Output to img2img", elem_id="composer_send_to_img2img")
                        send_to_extras = gr.Button("Send Output to Extras", elem_id="composer_send_to_extras")

                output_image = gr.Image(label="Composite Output", type="pil", image_mode="RGBA", interactive=False, elem_id="composer_output")
                status = gr.Markdown("Ready.")
                caption_output = gr.Textbox(
                        label="Composition Caption",
                        lines=12,
                        interactive=True,
                        elem_id="composer_caption_output",
                        placeholder="Click 'Generate Caption' to build a structured description of the current composition for use with an LLM.",
                )

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

                save_config_btn.click(
                        fn=save_composer_config_only,
                        _js="composer_export_payload",
                        inputs=[payload_state],
                        outputs=[status],
                        show_progress=False,
                )

                caption_btn.click(
                        fn=generate_composition_caption,
                        _js="composer_export_payload",
                        inputs=[payload_state],
                        outputs=[caption_output],
                        show_progress=True,
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
