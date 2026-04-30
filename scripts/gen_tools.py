"""
gen_tools.py – Generation Tools tab
Provides:
  • Drop-file param loader  – drop an image or .txt to auto-fill generation params
  • Generation history panel – keeps the last N entries and lets you restore them
"""
import base64
import datetime
import io
import json
import os

import gradio as gr
from PIL import Image

from modules import script_callbacks, shared, infotext_utils
from modules import images as images_module

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_ROOT_DIR   = os.path.dirname(_SCRIPT_DIR)
HISTORY_FILE = os.path.join(_ROOT_DIR, "log", "gen_history.json")

# ---------------------------------------------------------------------------
# HTML / CSS for the panel
# ---------------------------------------------------------------------------
GEN_TOOLS_HTML = """
<style>
#gen_tools_history_grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
    gap: 8px;
    max-height: 500px;
    overflow-y: auto;
    padding: 4px;
}
.gentools-card {
    border: 2px solid var(--block-border-color, #334155);
    border-radius: 8px;
    cursor: pointer;
    overflow: hidden;
    background: var(--block-background-fill, #1e293b);
    transition: border-color 0.15s;
    user-select: none;
}
.gentools-card:hover  { border-color: #38bdf8; }
.gentools-card.active { border-color: #22d3ee; box-shadow: 0 0 0 2px #22d3ee44 inset; }
.gentools-card img {
    width: 100%; aspect-ratio: 1; object-fit: cover; display: block;
}
.gentools-card .gt-no-thumb {
    width: 100%; aspect-ratio: 1; background: #1e293b;
    display: flex; align-items: center; justify-content: center;
    color: #475569; font-size: 11px;
}
.gentools-card .gt-meta {
    padding: 3px 6px; font-size: 10px; color: #94a3b8;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.gentools-card .gt-prompt {
    padding: 0 6px 4px; font-size: 10px; color: #64748b;
    overflow: hidden; display: -webkit-box;
    -webkit-line-clamp: 2; -webkit-box-orient: vertical;
}
#gen_tools_diff_compare {
    margin-top: 12px;
    border: 1px solid var(--block-border-color, #334155);
    border-radius: 8px;
    padding: 10px;
}
#gen_tools_diff_dropzone {
    border: 2px dashed #38bdf8;
    border-radius: 8px;
    padding: 10px;
    margin-bottom: 8px;
    color: #94a3b8;
    font-size: 12px;
}
#gen_tools_diff_dropzone.drag-over {
    background: #0c4a6e22;
    border-color: #22d3ee;
}
#gen_tools_diff_summary {
    color: #94a3b8;
    font-size: 12px;
    margin-bottom: 6px;
}
#gen_tools_diff_output {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    font-size: 12px;
    white-space: pre-wrap;
    max-height: 240px;
    overflow-y: auto;
    border: 1px solid #334155;
    border-radius: 6px;
    padding: 8px;
    color: #cbd5e1;
}
</style>
<div id="gen_tools_history_grid"></div>
<div id="gen_tools_diff_compare">
    <div id="gen_tools_diff_dropzone">Drop an image or .txt here to diff against current extracted params (no auto-overwrite).</div>
    <div id="gen_tools_diff_summary">Diff compare is idle.</div>
    <div id="gen_tools_diff_output">Waiting for drop...</div>
</div>
"""

# ---------------------------------------------------------------------------
# History persistence
# ---------------------------------------------------------------------------

def _load_history():
    if os.path.exists(HISTORY_FILE):
        try:
            with open(HISTORY_FILE, "r", encoding="utf8") as f:
                return json.load(f)
        except Exception:
            pass
    return []


def _save_history(entries):
    os.makedirs(os.path.dirname(HISTORY_FILE), exist_ok=True)
    with open(HISTORY_FILE, "w", encoding="utf8") as f:
        json.dump(entries, f, ensure_ascii=False, indent=2)


def on_image_saved(params):
    """Record each saved image into the generation history."""
    infotext = None
    if params.pnginfo:
        infotext = params.pnginfo.get("parameters", None)
    if not infotext:
        return

    max_history = int(getattr(shared.opts, 'gen_history_max', 100))
    entries = _load_history()

    thumb = ""
    try:
        img_copy = params.image.copy()
        img_copy.thumbnail((128, 128))
        buf = io.BytesIO()
        img_copy.save(buf, format="PNG")
        thumb = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
    except Exception:
        pass

    # Derive a short prompt preview (first line of infotext)
    prompt_preview = infotext.split("\n")[0][:120]

    entries.insert(0, {
        "ts": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "infotext": infotext,
        "prompt_preview": prompt_preview,
        "thumb": thumb,
    })
    _save_history(entries[:max_history])


# ---------------------------------------------------------------------------
# File-drop param extraction
# ---------------------------------------------------------------------------

def _resolve_orig_name(file_obj):
    """Return the original filename from a Gradio File object (best-effort)."""
    if file_obj is None:
        return None
    if hasattr(file_obj, 'orig_name') and file_obj.orig_name:
        return file_obj.orig_name
    if isinstance(file_obj, dict):
        return file_obj.get('orig_name') or file_obj.get('name', '')
    return getattr(file_obj, 'name', str(file_obj))


def parse_params_from_file(file_obj):
    """
    Given a Gradio File upload (image or .txt), return:
      (display_text: str, infotext_for_apply: str)
    """
    if file_obj is None:
        return "Drop an image or .txt file above.", ""

    # Resolve temp path and original name
    if isinstance(file_obj, dict):
        temp_path  = file_obj.get('name', '')
        orig_name  = file_obj.get('orig_name', temp_path)
    else:
        temp_path  = getattr(file_obj, 'name', str(file_obj))
        orig_name  = getattr(file_obj, 'orig_name', None) or temp_path

    orig_name_lower = orig_name.lower() if orig_name else temp_path.lower()
    infotext = None

    if orig_name_lower.endswith(".txt"):
        # Read the txt directly
        try:
            with open(temp_path, "r", encoding="utf8") as f:
                infotext = f.read().strip()
        except Exception as e:
            return f"Error reading file: {e}", ""
    else:
        # Image path: look for sidecar .txt
        base_no_ext = os.path.splitext(temp_path)[0]
        orig_stem   = os.path.splitext(os.path.basename(orig_name))[0]

        candidates = [
            base_no_ext + ".txt",   # sidecar next to temp file (rare but possible)
        ]
        outdir_txt = getattr(shared.opts, 'outdir_txt', '').strip()
        if outdir_txt and orig_stem:
            candidates.append(os.path.join(outdir_txt, orig_stem + ".txt"))
        # Also check original image directory if same-dir saving was used and path is accessible
        orig_dir = os.path.dirname(orig_name)
        if orig_dir and os.path.isdir(orig_dir):
            candidates.append(os.path.join(orig_dir, orig_stem + ".txt"))

        for cand in candidates:
            if os.path.exists(cand):
                try:
                    with open(cand, "r", encoding="utf8") as f:
                        infotext = f.read().strip()
                    break
                except Exception:
                    continue

        if not infotext:
            # Fall back to embedded PNG metadata
            try:
                img = Image.open(temp_path)
                infotext, _ = images_module.read_info_from_image(img)
            except Exception:
                pass

    if not infotext:
        return "No generation parameters found in this file.", ""

    return infotext, infotext


# ---------------------------------------------------------------------------
# History retrieval
# ---------------------------------------------------------------------------

def get_history_json():
    entries = _load_history()
    return json.dumps(entries, ensure_ascii=False)


# ---------------------------------------------------------------------------
# UI tab
# ---------------------------------------------------------------------------

def on_ui_tabs():
    with gr.Blocks(analytics_enabled=False) as gen_tools_ui:

        gr.HTML(GEN_TOOLS_HTML)

        # Hidden textbox that holds the infotext to be applied via paste buttons
        infotext_for_apply = gr.Textbox(
            value="",
            visible=False,
            elem_id="gen_tools_infotext_for_apply",
        )

        with gr.Row(equal_height=False):
            # ---- Left column: file drop --------------------------------
            with gr.Column(scale=1, min_width=300):
                gr.Markdown("### Drop File → Extract Params")
                drop_file = gr.File(
                    label="Drop an image or .txt here",
                    file_types=["image", ".txt"],
                    elem_id="gen_tools_drop_file",
                )
                drop_result = gr.Textbox(
                    label="Extracted parameters",
                    lines=6,
                    interactive=False,
                    elem_id="gen_tools_drop_result",
                )
                with gr.Row():
                    send_to_txt2img_btn = gr.Button(
                        "▶ Send to txt2img",
                        elem_id="gen_tools_send_txt2img",
                        size="sm",
                    )
                    send_to_img2img_btn = gr.Button(
                        "▶ Send to img2img",
                        elem_id="gen_tools_send_img2img",
                        size="sm",
                    )

            # ---- Right column: history ---------------------------------
            with gr.Column(scale=2):
                gr.Markdown("### Generation History")
                with gr.Row():
                    refresh_btn = gr.Button(
                        "⟳ Refresh",
                        elem_id="gen_tools_refresh",
                        size="sm",
                    )
                    apply_hist_txt2img_btn = gr.Button(
                        "▶ Apply → txt2img",
                        elem_id="gen_tools_apply_hist_txt2img",
                        size="sm",
                    )
                    apply_hist_img2img_btn = gr.Button(
                        "▶ Apply → img2img",
                        elem_id="gen_tools_apply_hist_img2img",
                        size="sm",
                    )
                # Hidden textbox receives the JSON history payload
                history_json_state = gr.Textbox(
                    value="",
                    visible=False,
                    elem_id="gen_tools_history_json_state",
                )

        # ---- Events ----------------------------------------------------

        drop_file.change(
            fn=parse_params_from_file,
            inputs=[drop_file],
            outputs=[drop_result, infotext_for_apply],
        )

        refresh_btn.click(
            fn=get_history_json,
            inputs=[],
            outputs=[history_json_state],
        )

        # Register paste-param bindings.  connect_paste_params_buttons()
        # (called after all tabs are built) will wire these up so that when
        # the button is clicked, infotext_for_apply is parsed and all matching
        # fields in the target tab are filled.
        for btn, tabname in [
            (send_to_txt2img_btn,      'txt2img'),
            (send_to_img2img_btn,      'img2img'),
            (apply_hist_txt2img_btn,   'txt2img'),
            (apply_hist_img2img_btn,   'img2img'),
        ]:
            infotext_utils.register_paste_params_button(
                infotext_utils.ParamBinding(
                    paste_button=btn,
                    tabname=tabname,
                    source_text_component=infotext_for_apply,
                )
            )

    return [(gen_tools_ui, "Gen Tools", "gen_tools")]


script_callbacks.on_ui_tabs(on_ui_tabs)
script_callbacks.on_image_saved(on_image_saved)
