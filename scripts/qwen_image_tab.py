"""Qwen-Image 2.1 tab: a native prompt panel (txt2img/img2img-style editing) plus
the sd-server controls and the embedded web UI.

Generation goes through ``modules.mobile_lite.run_qwen_job`` - the same engine the
SD Lite Qwen screen uses (queue lock, SDXL unload, sd-server start, auto-save to
outputs/qwen/).  The prompt fields carry the ``qwen_prompt`` / ``qwen_neg_prompt``
elem ids so the shared prompt editor (javascript/promptEditor.js) attaches there.
"""
import base64
import io

import gradio as gr
from PIL import Image

from modules import mobile_lite, qwen_image_manager, script_callbacks

# Native panel limits (mirror the SD Lite Qwen screen).
QWEN_REF_LIMIT = 10
QWEN_REF_MAX_SIDE = 1600  # bigger references are downscaled before upload
QWEN_SIZES = [
    ("1K 1:1", 1024, 1024),
    ("1K 2:3", 1024, 1536),
    ("1K 3:2", 1536, 1024),
    ("2K 1:1", 2048, 2048),
    ("2K 2:3", 1696, 2528),
    ("2K 3:2", 2528, 1696),
]


def _encode_reference(path: str) -> str:
    """Read an uploaded reference image into a data URL.

    Small PNGs and JPEG/WebP files pass through untouched; everything else is
    downscaled to QWEN_REF_MAX_SIDE and re-encoded as JPEG (same policy as the
    SD Lite client, so both UIs upload comparable payloads).  Returns "" when
    the file cannot be read.
    """
    try:
        with open(path, "rb") as handle:
            raw = handle.read()
        with Image.open(io.BytesIO(raw)) as parsed:
            image_format = (parsed.format or "").upper()
            width, height = parsed.size
            long_side = max(width, height)
            passthrough = long_side <= QWEN_REF_MAX_SIDE and (
                (image_format == "PNG" and len(raw) <= 1024 * 1024)
                or image_format in ("JPEG", "WEBP")
            )
            if passthrough:
                mime = {"PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp"}.get(image_format, "image/png")
                return f"data:{mime};base64,{base64.b64encode(raw).decode('ascii')}"

            scale = min(1.0, QWEN_REF_MAX_SIDE / max(1, long_side))
            target = (max(1, round(width * scale)), max(1, round(height * scale)))
            resized = parsed.convert("RGBA").resize(target, Image.LANCZOS)
            background = Image.new("RGB", target, (255, 255, 255))
            background.paste(resized, mask=resized.split()[-1])
        buffer = io.BytesIO()
        background.save(buffer, format="JPEG", quality=92)
        return "data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")
    except Exception:
        return ""


def _file_path(item) -> str:
    """Extract the on-disk path from whatever gradio hands the callback.

    gradio 3.41 ``Files.preprocess`` returns ``tempfile._TemporaryFileWrapper``
    objects (the path lives on ``.name``); other shapes seen in the wild are
    dicts and plain strings.
    """
    if item is None:
        return ""
    if isinstance(item, str):
        return item
    if isinstance(item, dict):
        return str(item.get("name") or item.get("path") or "")
    path = getattr(item, "name", None)
    if isinstance(path, str):
        return path
    return str(item)


def _collect_references(ref_files):
    """Encode the uploaded files into data URLs; (refs, skipped, over_limit)."""
    items = ref_files if isinstance(ref_files, list) else ([ref_files] if ref_files else [])
    paths = []
    for item in items:
        path = _file_path(item)
        if path and path not in paths:
            paths.append(path)
    encoded = []
    skipped = 0
    for path in paths[:QWEN_REF_LIMIT]:
        data_url = _encode_reference(path)
        if data_url:
            encoded.append(data_url)
        else:
            skipped += 1
    return encoded, skipped, max(0, len(paths) - QWEN_REF_LIMIT)


def _preset_callback(preset_width: int, preset_height: int):
    def _apply_preset():
        return gr.update(value=preset_width), gr.update(value=preset_height)

    return _apply_preset


def run_qwen_generation(prompt_text, negative_text, ref_files, steps, cfg, width, height, batch, seed_value, random_seed):
    """Generate (or reference-edit) with Qwen-Image 2.1 via the shared bridge."""
    from modules.processing import strip_prompt_comments

    prompt_text = str(prompt_text or "")
    if not strip_prompt_comments(prompt_text).strip():
        return gr.update(), gr.update(), "⚠️ **Prompt is empty** — type what to generate (or what to change when references are added).", ""

    refs, skipped, extra = _collect_references(ref_files)
    payload = {
        "prompt": prompt_text,
        "negative_prompt": str(negative_text or ""),
        "steps": int(steps),
        "cfg": float(cfg),
        "width": int(width),
        "height": int(height),
        "batch": int(batch),
        "seed": -1 if random_seed else int(seed_value if seed_value is not None else -1),
        "refs": refs,
    }

    try:
        result = mobile_lite.run_qwen_job(payload)
    except Exception as error:
        detail = getattr(error, "detail", None) or str(error)
        return gr.update(), gr.update(), f"⚠️ **Generation failed:** {detail}", ""

    images = result.get("images") or []
    if not images:
        return gr.update(), gr.update(), "⚠️ The server returned no images.", ""

    gallery = []
    for entry in images:
        with open(entry["path"], "rb") as handle:
            picture = Image.open(io.BytesIO(handle.read()))
        picture.load()
        caption = f"seed {entry['seed']}" if entry.get("seed") is not None else ""
        gallery.append((picture, caption))

    first_seed = images[0].get("seed")
    elapsed = float(result.get("elapsed") or 0.0)
    notes = []
    if skipped:
        notes.append(f"{skipped} unreadable reference(s) skipped")
    if extra:
        notes.append(f"{extra} reference(s) over the {QWEN_REF_LIMIT} limit ignored")
    status = (
        f"✅ **{len(images)} image(s)** · {elapsed:.1f}s · {int(width)}×{int(height)} · {len(refs)} reference(s)"
        + (f" · seed {first_seed}" if first_seed is not None else "")
        + ("\n\n" + " · ".join(notes) if notes else "")
        + "\n\nSaved to `outputs/qwen/` (PNG + `.txt` sidecar)."
    )
    seed_update = gr.update(value=int(first_seed)) if first_seed is not None else gr.update()
    return gr.update(value=gallery), seed_update, status, ""


def cancel_qwen_generation():
    """Cancel the active qwen job (the sd-server cancels queued jobs only)."""
    result = mobile_lite.cancel_qwen_job()
    if result.get("ok"):
        return "🛑 **Cancel requested** — the sd-server cancels queued jobs; a job already sampling finishes its current image."
    return "Nothing to cancel — no qwen job is queued right now."


def clear_references():
    return gr.update(value=[])


QWEN_IMAGE_TAB_HTML = """
<style>
#qwen_image_embed_root {
    display: grid;
    gap: 12px;
}

#qwen_image_embed_toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
    padding: 10px 12px;
    border: 1px solid var(--block-border-color);
    border-radius: 8px;
    background: var(--block-background-fill, transparent);
}

#qwen_image_embed_status {
    font-size: 12px;
    color: var(--body-text-color-subdued, #94a3b8);
    min-width: 180px;
}

#qwen_image_embed_presets {
    font-size: 12px;
    color: var(--body-text-color-subdued, #94a3b8);
    padding: 8px 12px;
    border: 1px solid var(--block-border-color);
    border-radius: 8px;
    background: var(--block-background-fill, transparent);
}

#qwen_image_embed_url {
    min-width: 280px;
    max-width: 480px;
    width: min(100%, 480px);
    padding: 8px 10px;
    border-radius: 8px;
    border: 1px solid var(--block-border-color);
    background: var(--input-background-fill);
    color: var(--body-text-color);
}

#qwen_image_embed_reload,
#qwen_image_embed_open {
    padding: 8px 12px;
    border-radius: 8px;
    border: 1px solid var(--block-border-color);
    background: var(--button-secondary-background-fill, transparent);
    color: var(--body-text-color);
    cursor: pointer;
    text-decoration: none;
}

#qwen_image_embed_reload:hover,
#qwen_image_embed_open:hover {
    border-color: var(--color-accent);
}

#qwen_image_embed_frame_wrap {
    position: relative;
    border: 1px solid var(--block-border-color);
    border-radius: 10px;
    overflow: hidden;
    background: var(--block-background-fill, transparent);
    min-height: 70vh;
}

#qwen_image_embed_frame {
    display: block;
    width: 100%;
    height: 70vh;
    border: 0;
    background: #0b0f14;
}

#qwen_image_embed_overlay {
    position: absolute;
    inset: 0;
    display: none;
    align-items: center;
    justify-content: center;
    background: rgba(2, 6, 23, 0.72);
    backdrop-filter: blur(2px);
}

#qwen_image_embed_overlay.show {
    display: flex;
}

#qwen_image_embed_overlay_card {
    max-width: 520px;
    padding: 18px 22px;
    border-radius: 12px;
    border: 1px solid var(--block-border-color);
    background: var(--block-background-fill, #0f172a);
    color: var(--body-text-color);
    text-align: center;
}

#qwen_image_embed_overlay_card h3 {
    margin: 0 0 8px 0;
}

#qwen_image_embed_overlay_card p {
    margin: 6px 0;
    font-size: 13px;
    color: var(--body-text-color-subdued, #94a3b8);
}

#qwen_image_embed_overlay_card code {
    color: var(--color-accent);
}

@media (max-width: 768px) {
    #qwen_image_embed_url {
        min-width: 100%;
        max-width: 100%;
    }

    #qwen_image_embed_frame_wrap,
    #qwen_image_embed_frame {
        min-height: 70vh;
        height: 70vh;
    }
}
</style>

<div id="qwen_image_embed_root">
    <div id="qwen_image_embed_toolbar">
        <input id="qwen_image_embed_url" type="text" value="__QWEN_IMAGE_URL__" spellcheck="false" />
        <button id="qwen_image_embed_reload" type="button">Reload UI</button>
        <a id="qwen_image_embed_open" href="__QWEN_IMAGE_URL__" target="_blank" rel="noopener noreferrer">Open in New Tab</a>
    </div>

    <div id="qwen_image_embed_presets">
        <b>Resolution presets</b> (width x height, divisible by 32):
        1K — 1:1 <code>1024x1024</code> · 2:3 <code>1024x1536</code> · 3:2 <code>1536x1024</code>
        &nbsp;|&nbsp;
        2K — 1:1 <code>2048x2048</code> · 2:3 <code>1696x2528</code> · 3:2 <code>2528x1696</code>
        &nbsp;|&nbsp; CLI: <code>qwen_image_txt2img.bat "prompt" 1k:2:3</code>
        &nbsp;|&nbsp; Generated images auto-save to <code>outputs/qwen/&lt;date&gt;/&lt;hh-mm-ss&gt;/&lt;n&gt;.jpg</code>
    </div>

    <div id="qwen_image_embed_frame_wrap">
        <iframe id="qwen_image_embed_frame" title="Qwen-Image 2.1" src="__QWEN_IMAGE_URL__"></iframe>
        <div id="qwen_image_embed_overlay" class="show">
            <div id="qwen_image_embed_overlay_card">
                <h3>Qwen-Image 2.1 server is not reachable</h3>
                <p>Start it with <b>Start Server</b> above (or run <code>qwen_image_server.bat</code>), then click <b>Reload UI</b>.</p>
                <p>Expected address: <code>__QWEN_IMAGE_URL__</code></p>
                <p>First start loads ~10GB of weights and can take a while.</p>
                <p>20-step times on RTX 5070 Ti: 1K ~51-83s, 2K ~5.2-5.5 min.</p>
            </div>
        </div>
    </div>
</div>
"""


def _render_html():
    return QWEN_IMAGE_TAB_HTML.replace("__QWEN_IMAGE_URL__", qwen_image_manager.get_server_url())


def _status_outputs(status: dict):
    return (
        qwen_image_manager.format_status_markdown(status),
        qwen_image_manager.status_payload(status),
    )


def get_server_status():
    return _status_outputs(qwen_image_manager.get_status())


def start_qwen_server():
    return _status_outputs(qwen_image_manager.start_server())


def stop_qwen_server():
    return _status_outputs(qwen_image_manager.stop_server())


def restart_qwen_server():
    return _status_outputs(qwen_image_manager.restart_server())


def on_ui_tabs():
    with gr.Blocks(analytics_enabled=False) as qwen_ui:
        with gr.Row():
            start_btn = gr.Button("Start Server", variant="primary")
            stop_btn = gr.Button("Stop Server")
            restart_btn = gr.Button("Restart Server")
            refresh_btn = gr.Button("Refresh Status")

        status_md = gr.Markdown(qwen_image_manager.format_status_markdown(qwen_image_manager.get_status()), elem_id="qwen_image_embed_status")
        status_signal = gr.Textbox(value=qwen_image_manager.status_payload(qwen_image_manager.get_status()), visible=False, elem_id="qwen_image_embed_signal")

        gr.Markdown(
            "The prompt fields below behave like the txt2img/img2img prompts (chip editor; `#` comment lines "
            "and `#(...)` disabled keywords are stripped when generating).  \n"
            "Add up to **10 references** to turn the prompt into an edit instruction.  \n"
            "Generating frees the SDXL checkpoint (single 16GB GPU) and starts the sd-server automatically — "
            "the first start loads ~10GB of weights."
        )

        with gr.Row():
            with gr.Column(scale=3):
                prompt = gr.Textbox(label="Prompt", lines=6, placeholder="Describe the picture — or what to change when references are added…", elem_id="qwen_prompt")
                negative = gr.Textbox(label="Negative prompt", lines=2, placeholder="things to avoid (optional)", elem_id="qwen_neg_prompt")

                with gr.Row():
                    preset_buttons = [
                        gr.Button(label, size="sm", elem_id=f"qwen_size_{preset_width}x{preset_height}")
                        for label, preset_width, preset_height in QWEN_SIZES
                    ]

                with gr.Row():
                    width = gr.Slider(minimum=64, maximum=4096, step=32, value=1024, label="Width", elem_id="qwen_width")
                    height = gr.Slider(minimum=64, maximum=4096, step=32, value=1024, label="Height", elem_id="qwen_height")

                with gr.Row():
                    steps = gr.Slider(minimum=1, maximum=80, step=1, value=20, label="Steps", elem_id="qwen_steps")
                    cfg = gr.Slider(minimum=1.0, maximum=20.0, step=0.5, value=6.0, label="CFG scale", elem_id="qwen_cfg")
                    batch = gr.Slider(minimum=1, maximum=4, step=1, value=1, label="Images", elem_id="qwen_batch")

                with gr.Row():
                    seed = gr.Number(value=-1, precision=0, label="Seed", elem_id="qwen_seed")
                    random_seed = gr.Checkbox(value=True, label="Random seed", elem_id="qwen_random_seed")

                refs = gr.Files(label="References (up to 10) — with references the prompt edits them", file_count="multiple", elem_id="qwen_refs")

                with gr.Row():
                    generate_btn = gr.Button("✨ Generate / Edit", variant="primary", elem_id="qwen_generate_btn")
                    cancel_btn = gr.Button("⏹ Cancel", elem_id="qwen_cancel_btn")
                    clear_refs_btn = gr.Button("🧹 Clear references", elem_id="qwen_clear_refs_btn")

                task_status = gr.HTML("", elem_id="qwen_task_status")
                result_status = gr.Markdown("_Ready._", elem_id="qwen_result_status")

            with gr.Column(scale=2):
                results = gr.Gallery(label="Results (last run)", elem_id="qwen_results", columns=2)
                gr.Markdown("Files are saved to `outputs/qwen/<date>/<time>/` (PNG + `.txt` sidecar) and show up in the SD Lite gallery (Qwen view).", elem_id="qwen_results_hint")

        with gr.Accordion("sd-server web UI & manual controls (advanced)", open=False):
            gr.HTML(_render_html())

        start_btn.click(fn=start_qwen_server, inputs=[], outputs=[status_md, status_signal], show_progress=False)
        stop_btn.click(fn=stop_qwen_server, inputs=[], outputs=[status_md, status_signal], show_progress=False)
        restart_btn.click(fn=restart_qwen_server, inputs=[], outputs=[status_md, status_signal], show_progress=False)
        refresh_btn.click(fn=get_server_status, inputs=[], outputs=[status_md, status_signal], show_progress=False)

        for button, (_label, preset_width, preset_height) in zip(preset_buttons, QWEN_SIZES):
            button.click(fn=_preset_callback(preset_width, preset_height), inputs=[], outputs=[width, height], show_progress=False)

        generate_btn.click(
            fn=run_qwen_generation,
            inputs=[prompt, negative, refs, steps, cfg, width, height, batch, seed, random_seed],
            outputs=[results, seed, result_status, task_status],
        )
        cancel_btn.click(fn=cancel_qwen_generation, inputs=[], outputs=[result_status], show_progress=False)
        clear_refs_btn.click(fn=clear_references, inputs=[], outputs=[refs], show_progress=False)

    return [(qwen_ui, "Qwen-Image 2.1", "qwen_image_embed_tab")]


script_callbacks.on_ui_tabs(on_ui_tabs)
