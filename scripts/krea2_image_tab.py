"""Krea 2 tab: a native prompt panel (like txt2img) plus the sd-server controls
and the embedded server web UI.

Generation goes through ``modules.mobile_lite.run_krea2_job`` - the same engine
bridging layer that powers the SD Lite endpoints (queue lock, SDXL unload,
sd-server start, auto-save to outputs/krea2/).  The prompt fields carry the
``krea2_prompt`` / ``krea2_neg_prompt`` elem ids so the shared prompt editor
(javascript/promptEditor.js) and comment highlighter attach there.

Krea 2 uses the Wan 2.1 VAE and a Qwen3-VL-4B text encoder, so it cannot run
through the regular A1111 checkpoint loader - the sd-server sidecar does the
generation.  Krea 2 Turbo is distilled: 8 steps at CFG 1.0 are the defaults.
"""
import io

import gradio as gr
from PIL import Image

from modules import krea2_image_manager, mobile_lite, script_callbacks

KREA2_SIZES = [
    ("384 1:1", 384, 384),
    ("512 1:1", 512, 512),
    ("512 2:3", 512, 768),
    ("512 3:2", 768, 512),
    ("384 3:4", 384, 512),
    ("512 4:3", 512, 384),
    ("1K 1:1", 1024, 1024),
    ("1K 2:3", 1024, 1536),
    ("1K 3:2", 1536, 1024),
    ("1.5K 4:5", 1152, 1440),
    ("1.5K 5:4", 1440, 1152),
]
# The low-res group renders on its own row (the strip wraps badly past ~6 buttons).
KREA2_LOW_RES_COUNT = 6

# Reference-image editing (community edit LoRAs): 1 reference recommended,
# a few allowed for composition; bigger references are downscaled before upload
# (mirrors the Qwen tab so both UIs send comparable payloads).
KREA2_REF_LIMIT = 4
KREA2_REF_MAX_SIDE = 1600


def _encode_reference(path: str) -> str:
    """Read an uploaded reference image into a data URL ("" on failure)."""
    import base64

    try:
        with open(path, "rb") as handle:
            raw = handle.read()
        with Image.open(io.BytesIO(raw)) as parsed:
            image_format = (parsed.format or "").upper()
            width, height = parsed.size
            long_side = max(width, height)
            passthrough = long_side <= KREA2_REF_MAX_SIDE and (
                (image_format == "PNG" and len(raw) <= 1024 * 1024)
                or image_format in ("JPEG", "WEBP")
            )
            if passthrough:
                mime = {"PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp"}.get(image_format, "image/png")
                return f"data:{mime};base64,{base64.b64encode(raw).decode('ascii')}"

            scale = min(1.0, KREA2_REF_MAX_SIDE / max(1, long_side))
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
    for path in paths[:KREA2_REF_LIMIT]:
        data_url = _encode_reference(path)
        if data_url:
            encoded.append(data_url)
        else:
            skipped += 1
    return encoded, skipped, max(0, len(paths) - KREA2_REF_LIMIT)


def _preset_callback(preset_width: int, preset_height: int):
    def _apply_preset():
        return gr.update(value=preset_width), gr.update(value=preset_height)

    return _apply_preset


def run_krea2_generation(prompt_text, negative_text, ref_files, steps, cfg, width, height, batch, seed_value, random_seed):
    """Generate (or reference-edit) with Krea 2 through the shared sidecar bridge."""
    from modules.processing import strip_prompt_comments

    prompt_text = str(prompt_text or "")
    if not strip_prompt_comments(prompt_text).strip():
        return gr.update(), gr.update(), "Warning: **prompt is empty** - type what to generate (or what to change when references are added).", ""

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
        result = mobile_lite.run_krea2_job(payload)
    except Exception as error:
        detail = getattr(error, "detail", None) or str(error)
        return gr.update(), gr.update(), f"**Generation failed:** {detail}", ""

    images = result.get("images") or []
    if not images:
        return gr.update(), gr.update(), "The server returned no images.", ""

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
        notes.append(f"{extra} reference(s) over the {KREA2_REF_LIMIT} limit ignored")
    status = (
        f"**{len(images)} image(s)** - {elapsed:.1f}s - {int(width)}x{int(height)}"
        + (f" - {len(refs)} reference(s)" if refs else "")
        + (f" - seed {first_seed}" if first_seed is not None else "")
        + ("\n\n" + " - ".join(notes) if notes else "")
        + f"\n\nModel `{krea2_image_manager.get_model_name()}` - saved to `outputs/krea2/` (PNG + `.txt` sidecar)."
    )
    seed_update = gr.update(value=int(first_seed)) if first_seed is not None else gr.update()
    return gr.update(value=gallery), seed_update, status, ""


def clear_references():
    return gr.update(value=[])


def cancel_krea2_generation():
    """Cancel the active krea2 job (the sd-server cancels queued jobs only)."""
    result = mobile_lite.cancel_krea2_job()
    if result.get("ok"):
        return "**Cancel requested** - the sd-server cancels queued jobs; a job already sampling finishes its current image."
    return "Nothing to cancel - no krea2 job is queued right now."


KREA2_IMAGE_TAB_HTML = """
<style>
#krea2_image_embed_root {
    display: grid;
    gap: 12px;
}

#krea2_image_embed_toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
    padding: 10px 12px;
    border: 1px solid var(--block-border-color);
    border-radius: 8px;
    background: var(--block-background-fill, transparent);
}

#krea2_image_embed_status {
    font-size: 12px;
    color: var(--body-text-color-subdued, #94a3b8);
    min-width: 180px;
}

#krea2_image_embed_presets {
    font-size: 12px;
    color: var(--body-text-color-subdued, #94a3b8);
    padding: 8px 12px;
    border: 1px solid var(--block-border-color);
    border-radius: 8px;
    background: var(--block-background-fill, transparent);
}

#krea2_image_embed_url {
    min-width: 280px;
    max-width: 480px;
    width: min(100%, 480px);
    padding: 8px 10px;
    border-radius: 8px;
    border: 1px solid var(--block-border-color);
    background: var(--input-background-fill);
    color: var(--body-text-color);
}

#krea2_image_embed_reload,
#krea2_image_embed_open {
    padding: 8px 12px;
    border-radius: 8px;
    border: 1px solid var(--block-border-color);
    background: var(--button-secondary-background-fill, transparent);
    color: var(--body-text-color);
    cursor: pointer;
    text-decoration: none;
}

#krea2_image_embed_reload:hover,
#krea2_image_embed_open:hover {
    border-color: var(--color-accent);
}

#krea2_image_embed_frame_wrap {
    position: relative;
    border: 1px solid var(--block-border-color);
    border-radius: 10px;
    overflow: hidden;
    background: var(--block-background-fill, transparent);
    min-height: 70vh;
}

#krea2_image_embed_frame {
    display: block;
    width: 100%;
    height: 70vh;
    border: 0;
    background: #0b0f14;
}

#krea2_image_embed_overlay {
    position: absolute;
    inset: 0;
    display: none;
    align-items: center;
    justify-content: center;
    background: rgba(2, 6, 23, 0.72);
    backdrop-filter: blur(2px);
}

#krea2_image_embed_overlay.show {
    display: flex;
}

#krea2_image_embed_overlay_card {
    max-width: 520px;
    padding: 18px 22px;
    border-radius: 12px;
    border: 1px solid var(--block-border-color);
    background: var(--block-background-fill, #0f172a);
    color: var(--body-text-color);
    text-align: center;
}

#krea2_image_embed_overlay_card h3 {
    margin: 0 0 8px 0;
}

#krea2_image_embed_overlay_card p {
    margin: 6px 0;
    font-size: 13px;
    color: var(--body-text-color-subdued, #94a3b8);
}

#krea2_image_embed_overlay_card code {
    color: var(--color-accent);
}

@media (max-width: 768px) {
    #krea2_image_embed_url {
        min-width: 100%;
        max-width: 100%;
    }

    #krea2_image_embed_frame_wrap,
    #krea2_image_embed_frame {
        min-height: 70vh;
        height: 70vh;
    }
}
</style>

<div id="krea2_image_embed_root">
    <div id="krea2_image_embed_toolbar">
        <input id="krea2_image_embed_url" type="text" value="__KREA2_IMAGE_URL__" spellcheck="false" />
        <button id="krea2_image_embed_reload" type="button">Reload UI</button>
        <a id="krea2_image_embed_open" href="__KREA2_IMAGE_URL__" target="_blank" rel="noopener noreferrer">Open in New Tab</a>
    </div>

    <div id="krea2_image_embed_presets">
        <b>Resolution presets</b> (width x height, divisible by 32):
        1K: 1:1 <code>1024x1024</code> - 2:3 <code>1024x1536</code> - 3:2 <code>1536x1024</code>
        &nbsp;|&nbsp;
        1.5K: 4:5 <code>1152x1440</code> - 5:4 <code>1440x1152</code>
        &nbsp;|&nbsp; CLI: <code>krea2_txt2img.bat "prompt" 1k:2:3</code>
        &nbsp;|&nbsp; Krea 2 Turbo: 8 steps, CFG 1.0
    </div>

    <div id="krea2_image_embed_frame_wrap">
        <iframe id="krea2_image_embed_frame" title="Krea 2" src="__KREA2_IMAGE_URL__"></iframe>
        <div id="krea2_image_embed_overlay" class="show">
            <div id="krea2_image_embed_overlay_card">
                <h3>Krea 2 server is not reachable</h3>
                <p>Start it with <b>Start Server</b> above (or run <code>krea2_server.bat</code>), then click <b>Reload UI</b>.</p>
                <p>Expected address: <code>__KREA2_IMAGE_URL__</code></p>
                <p>First start loads ~10GB of weights and can take a while.</p>
                <p>The embedded UI does not auto-save; use the <b>Generate</b> button above for `outputs/krea2/` copies.</p>
            </div>
        </div>
    </div>
</div>
"""


def _render_html():
    return KREA2_IMAGE_TAB_HTML.replace("__KREA2_IMAGE_URL__", krea2_image_manager.get_server_url())


def _status_outputs(status: dict):
    return (
        krea2_image_manager.format_status_markdown(status),
        krea2_image_manager.status_payload(status),
    )


def get_server_status():
    return _status_outputs(krea2_image_manager.get_status())


def start_krea2_server():
    return _status_outputs(krea2_image_manager.start_server())


def stop_krea2_server():
    return _status_outputs(krea2_image_manager.stop_server())


def restart_krea2_server():
    return _status_outputs(krea2_image_manager.restart_server())


def on_ui_tabs():
    with gr.Blocks(analytics_enabled=False) as krea2_ui:
        with gr.Row():
            start_btn = gr.Button("Start Server", variant="primary")
            stop_btn = gr.Button("Stop Server")
            restart_btn = gr.Button("Restart Server")
            refresh_btn = gr.Button("Refresh Status")

        status_md = gr.Markdown(krea2_image_manager.format_status_markdown(krea2_image_manager.get_status()), elem_id="krea2_image_embed_status")
        status_signal = gr.Textbox(value=krea2_image_manager.status_payload(krea2_image_manager.get_status()), visible=False, elem_id="krea2_image_embed_signal")

        gr.Markdown(
            "Krea 2 (12B MMDiT, Wan 2.1 VAE + Qwen3-VL-4B text encoder) runs on the stable-diffusion.cpp "
            "sidecar - not through the regular checkpoint loader.  \n"
            "The prompt fields below behave like the txt2img/img2img prompts (chip editor; `#` comment lines "
            "and `#(...)` disabled keywords are stripped when generating).  \n"
            "Default weights: **Krea 2 Turbo Edit v1.1 uncensored** (Q4_K_M GGUF; refusal-reduction NSFW LoRAs baked in; "
            "Q6_K = max quality, official Krea-2-Turbo Q6_K = fallback).  \n"
            "**Reference images**: upload up to 4 (1 recommended) and the prompt becomes an edit instruction "
            "(e.g. `Edit this picture. Change her hair to blue. Keep her face and everything else the same.`).  \n"
            "Generating frees the SDXL checkpoint (single 16GB GPU) and starts the sd-server automatically - "
            "the first start loads ~10GB of weights."
        )

        with gr.Row():
            with gr.Column(scale=3):
                prompt = gr.Textbox(label="Prompt", lines=6, placeholder="Describe the picture...", elem_id="krea2_prompt")
                negative = gr.Textbox(label="Negative prompt", lines=2, placeholder="things to avoid (optional)", elem_id="krea2_neg_prompt")

                with gr.Row():
                    preset_buttons_low = [
                        gr.Button(label, size="sm", elem_id=f"krea2_size_{preset_width}x{preset_height}")
                        for label, preset_width, preset_height in KREA2_SIZES[:KREA2_LOW_RES_COUNT]
                    ]
                with gr.Row():
                    preset_buttons_high = [
                        gr.Button(label, size="sm", elem_id=f"krea2_size_{preset_width}x{preset_height}")
                        for label, preset_width, preset_height in KREA2_SIZES[KREA2_LOW_RES_COUNT:]
                    ]
                preset_buttons = preset_buttons_low + preset_buttons_high

                with gr.Row():
                    width = gr.Slider(minimum=64, maximum=2048, step=32, value=1024, label="Width", elem_id="krea2_width")
                    height = gr.Slider(minimum=64, maximum=2048, step=32, value=1024, label="Height", elem_id="krea2_height")

                with gr.Row():
                    steps = gr.Slider(minimum=1, maximum=40, step=1, value=8, label="Steps (Turbo: 8)", elem_id="krea2_steps")
                    cfg = gr.Slider(minimum=0.0, maximum=10.0, step=0.1, value=1.0, label="CFG scale (Turbo: 1.0)", elem_id="krea2_cfg")
                    batch = gr.Slider(minimum=1, maximum=4, step=1, value=1, label="Images", elem_id="krea2_batch")

                with gr.Row():
                    seed = gr.Number(value=-1, precision=0, label="Seed", elem_id="krea2_seed")
                    random_seed = gr.Checkbox(value=True, label="Random seed", elem_id="krea2_random_seed")

                refs = gr.Files(
                    label="References (up to 4, 1 recommended) - with references the prompt edits them",
                    file_count="multiple",
                    elem_id="krea2_refs",
                )

                with gr.Row():
                    generate_btn = gr.Button("Generate", variant="primary", elem_id="krea2_generate_btn")
                    cancel_btn = gr.Button("Cancel", elem_id="krea2_cancel_btn")
                    clear_refs_btn = gr.Button("Clear references", elem_id="krea2_clear_refs_btn")

                task_status = gr.HTML("", elem_id="krea2_task_status")
                result_status = gr.Markdown("_Ready._", elem_id="krea2_result_status")

            with gr.Column(scale=2):
                results = gr.Gallery(label="Results (last run)", elem_id="krea2_results", columns=2)
                gr.Markdown("Files are saved to `outputs/krea2/<date>/<time>/` (PNG + `.txt` sidecar).", elem_id="krea2_results_hint")

        with gr.Accordion("sd-server web UI & manual controls (advanced)", open=False):
            gr.HTML(_render_html())

        start_btn.click(fn=start_krea2_server, inputs=[], outputs=[status_md, status_signal], show_progress=False)
        stop_btn.click(fn=stop_krea2_server, inputs=[], outputs=[status_md, status_signal], show_progress=False)
        restart_btn.click(fn=restart_krea2_server, inputs=[], outputs=[status_md, status_signal], show_progress=False)
        refresh_btn.click(fn=get_server_status, inputs=[], outputs=[status_md, status_signal], show_progress=False)

        for button, (_label, preset_width, preset_height) in zip(preset_buttons, KREA2_SIZES):
            button.click(fn=_preset_callback(preset_width, preset_height), inputs=[], outputs=[width, height], show_progress=False)

        generate_btn.click(
            fn=run_krea2_generation,
            inputs=[prompt, negative, refs, steps, cfg, width, height, batch, seed, random_seed],
            outputs=[results, seed, result_status, task_status],
        )
        cancel_btn.click(fn=cancel_krea2_generation, inputs=[], outputs=[result_status], show_progress=False)
        clear_refs_btn.click(fn=clear_references, inputs=[], outputs=[refs], show_progress=False)

    return [(krea2_ui, "Krea 2", "krea2_image_tab")]


script_callbacks.on_ui_tabs(on_ui_tabs)
