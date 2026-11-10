"""Video tab: short anime clips (GIF/MP4) from AnimateDiff, CogVideoX, SVD or LTX-Video.

Generation goes through ``modules.video_manager`` - the same engine the SD Lite
video screen uses.  That module owns the queue lock, the VRAM hand-over and the
output folder (``outputs/video/<date>/<time>-<engine>-<seed>/``).

The prompt fields carry the ``video_prompt`` / ``video_neg_prompt`` elem ids so
the shared prompt editor (javascript/promptEditor.js) attaches there.
"""

from __future__ import annotations

import html
import time
from urllib.parse import quote

import gradio as gr

from modules import script_callbacks, shared, video_manager

SIZES = {
    "animatediff": [("512 square", 512, 512), ("512x768 portrait", 512, 768), ("768x512 landscape", 768, 512), ("384 draft", 384, 384)],
    "cogvideox": [("720x480", 720, 480), ("480x720", 480, 720), ("384x576", 384, 576)],
    "svd": [("1024x576", 1024, 576), ("576x1024", 576, 1024)],
    "ltx": [("512x768 portrait", 512, 768), ("768x512 landscape", 768, 512), ("512 square", 512, 512), ("384x576 draft", 384, 576)],
}

ENGINE_TITLES = [video_manager.ENGINE_INFO[engine]["title"] for engine in video_manager.ENGINE_IDS]
TITLE_TO_ID = {video_manager.ENGINE_INFO[engine]["title"]: engine for engine in video_manager.ENGINE_IDS}


def _engine_id(title: str) -> str:
    return TITLE_TO_ID.get(title, title if title in video_manager.ENGINE_IDS else "animatediff")


def _status_html() -> str:
    from modules import vram

    info = video_manager.status()
    rows = []
    for engine in info["engines"]:
        state = "ready" if engine["installed"] else "missing files"
        css = "ok" if engine["installed"] else "err"
        rows.append(
            f"<div class='video-engine {css}'><b>{html.escape(engine['title'])}</b>"
            f"<span>{html.escape(state)}</span>"
            f"<small>{html.escape(engine['blurb'])}</small></div>"
        )
    loaded = info["loaded"] or "nothing"
    return (
        "<div class='video-engines'>" + "".join(rows) + "</div>"
        + f"<p class='video-vram'>{html.escape(vram.describe())} | loaded video engine: <b>{html.escape(loaded)}</b></p>"
    )


def _progress_html(job: dict) -> str:
    step = int(job.get("step") or 0)
    steps = int(job.get("steps") or 0)
    pct = int(round(100 * step / steps)) if steps else 0
    phase = job.get("phase") or "idle"
    if phase in ("loading", "generating", "saving"):
        el = time.time() - float(job.get("started") or time.time())
        label = f"{phase} · {job.get('detail') or ''} · {el:.0f}s"
        return (
            "<div class='video-progress'>"
            f"<div class='video-progress-bar'><div style='width:{max(4, pct)}%'></div></div>"
            f"<span>{html.escape(label)}</span></div>"
        )
    if phase == "failed":
        return f"<p class='video-error'>{html.escape(str(job.get('error') or 'failed'))}</p>"
    if phase == "cancelled":
        return "<p class='video-error'>cancelled</p>"
    if phase == "done":
        return f"<p class='video-done'>done in {job.get('seconds') or 0:.1f}s</p>"
    return "<p class='muted'>Ready.</p>"


def _result_view(result: dict) -> tuple:
    if not result or not result.get("ok"):
        message = (result or {}).get("error") or ""
        return "<p class='muted'>No clip yet.</p>", None, f"**Failed:** {message}" if message else "_Ready._"
    gif = result.get("gif") or ""
    mp4 = result.get("mp4") or None
    preview = ""
    if gif:
        src = "/file=" + quote(gif.replace("\\", "/"))
        preview = (
            f"<div class='video-result'><img src='{src}' alt='generated clip'>"
            f"<div class='video-links'><a href='{src}' download>GIF</a>"
            + (f"<a href='/file={quote(mp4.replace(chr(92), '/'))}' download>MP4</a>" if mp4 else "")
            + "</div></div>"
        )
    info = result.get("info") or {}
    summary = (
        f"**{info.get('frames')} frames** · {info.get('width')}x{info.get('height')} · "
        f"{info.get('fps')} fps · seed `{info.get('seed')}` · {info.get('seconds')}s"
    )
    if not mp4:
        summary += " · MP4 encode unavailable (GIF only)"
    return preview, mp4, summary


def _engine_update(engine_title: str):
    engine = _engine_id(engine_title)
    defaults = dict(video_manager.DEFAULTS[engine])
    if engine == "cogvideox":
        defaults.update({"width": 720, "height": 480, "frames": 49, "steps": 50, "guidance": 6.0})
    info = video_manager.status()
    lightning = info["lightning"]
    bases = info["bases"]
    base_choices = [base["title"] for base in bases]
    base_value = base_choices[0] if base_choices else None
    placeholder = (
        "Describe the motion or mood you want — this prompt nudges the init image when "
        "'Prompt guidance' is above 0 (SVD itself is image-only)."
        if engine == "svd"
        else "anime girl on a rooftop, wind in her hair, night city…"
    )
    if engine == "ltx":
        placeholder = "anime girl turns toward the camera, hair drifting, rain-slick rooftop, slow push-in…"
    takes_image = engine in ("svd", "ltx")
    init_label = (
        "Init image (SVD animates this still)"
        if engine != "ltx"
        else "Init image (optional — LTX animates this still with the prompt)"
    )
    return (
        gr.update(visible=engine == "animatediff", choices=base_choices, value=base_value),
        gr.update(visible=engine == "animatediff", choices=lightning, value="4step" if "4step" in lightning else (lightning[0] if lightning else None)),
        gr.update(visible=takes_image, label=init_label),
        gr.update(visible=engine == "svd", value=0.25),
        gr.update(visible=engine == "svd", value=video_manager.SVD_MOTION_BUCKET),
        gr.update(visible=engine == "svd", value=0.02),
        gr.update(placeholder=placeholder),
        defaults["width"],
        defaults["height"],
        defaults["frames"],
        defaults["fps"],
        defaults["steps"],
        defaults["guidance"],
        _status_html(),
        _progress_html(video_manager.job_status()),
    )


def _preset_updates(engine_title: str, count: int):
    """Button updates for the size presets.  Buttons take their caption in
    ``value`` - ``label`` is not a Button keyword and gradio rejects it."""
    engine_id = _engine_id(engine_title)
    sizes = SIZES.get(engine_id) or SIZES["animatediff"]
    updates = []
    for index in range(count):
        if index < len(sizes):
            updates.append(gr.update(value=sizes[index][0], visible=True))
        else:
            updates.append(gr.update(visible=False))
    return updates, engine_id


def _collect(
    engine_title, prompt, negative, base_title, lightning, init_image,
    width, height, frames, fps, steps, guidance, seed, random_seed,
    offload, refine, motion_bucket_id, noise_aug_strength, pingpong, save_mp4,
):
    engine = _engine_id(engine_title)
    info = video_manager.status()
    base = ""
    for entry in info["bases"]:
        if entry["title"] == base_title:
            base = entry["path"]
            break
    return {
        "engine": engine,
        "prompt": prompt,
        "negative_prompt": negative,
        "base": base,
        "lightning": lightning,
        "init_image": init_image or "",
        "width": width,
        "height": height,
        "frames": frames,
        "fps": fps,
        "steps": steps,
        "guidance": guidance,
        "seed": -1 if random_seed else seed,
        "offload": offload,
        "refine": refine,
        "motion_bucket_id": motion_bucket_id,
        "noise_aug_strength": noise_aug_strength,
        "pingpong": pingpong,
        "save_mp4": save_mp4,
    }


def _run(*job_args):
    """Run one clip. gradio's generator streaming needs the queue (this fork runs
    with --no-gradio-queue), so the callback blocks and javascript/videoTab.js
    polls /mlite/api/video/job to draw the live progress line."""
    payload = _collect(*job_args)
    try:
        request = video_manager.parse_request(payload)
    except Exception as error:
        return "<p class='muted'>No clip yet.</p>", None, f"**Cannot start:** {error}", payload.get("seed", -1), _progress_html({"phase": "failed", "error": str(error)})

    try:
        result = video_manager.generate(request)
    except Exception as error:
        result = {"ok": False, "error": str(error)}

    preview, mp4, summary = _result_view(result)
    seed = result.get("seed", payload.get("seed", -1))
    return preview, mp4, summary, seed, _progress_html(video_manager.job_status())


def _cancel():
    return video_manager.cancel().get("message", "")


def _unload():
    video_manager.unload_engine(reason="unload button")
    try:
        from modules import devices

        devices.torch_gc()
    except Exception:
        pass
    return _status_html(), _progress_html(video_manager.job_status())


def _refresh():
    return _status_html()


def on_ui_tabs():
    with gr.Blocks(analytics_enabled=False) as video_ui:
        default_engine = getattr(shared.opts, "video_default_engine", "animatediff")
        if default_engine not in video_manager.ENGINE_IDS:
            default_engine = "animatediff"

        gr.Markdown(
            "Short local clips, aimed at anime: AnimateDiff (4-step Lightning on an SD1.5 anime base), "
            "CogVideoX-2B and Stable Video Diffusion (image → video).  \n"
            "Everything runs on this machine — **no safety checker and no prompt filter** are applied; "
            "you are responsible for the content and for each checkpoint's licence.  \n"
            "Starting a job unloads the SDXL/T2I checkpoint and stops any sd-server sidecar so the video "
            "engine gets the GPU; the video weights are dropped again after the clip unless you turn that off in Settings."
        )

        with gr.Row():
            engine = gr.Dropdown(
                label="Engine",
                choices=ENGINE_TITLES,
                value=video_manager.ENGINE_INFO[default_engine]["title"],
                elem_id="video_engine",
            )
            unload_btn = gr.Button("⏏ Unload video models", elem_id="video_unload_btn")
            refresh_btn = gr.Button("↻ Refresh status", elem_id="video_refresh_btn")

        engines_html = gr.HTML(_status_html(), elem_id="video_engine_status")

        with gr.Row():
            with gr.Column(scale=3):
                prompt = gr.Textbox(label="Prompt", lines=4, placeholder="anime girl on a rooftop, wind in her hair, night city…", elem_id="video_prompt")
                negative = gr.Textbox(label="Negative prompt (CFG > 1 only)", lines=2, placeholder="blurry, extra limbs, watermark…", elem_id="video_neg_prompt")

                with gr.Row():
                    preset_buttons = [
                        gr.Button(label, size="sm", elem_id=f"video_size_{w}x{h}")
                        for label, w, h in SIZES["animatediff"]
                    ]

                with gr.Row():
                    width = gr.Slider(minimum=256, maximum=1024, step=8, value=512, label="Width", elem_id="video_width")
                    height = gr.Slider(minimum=256, maximum=1024, step=8, value=512, label="Height", elem_id="video_height")

                with gr.Row():
                    frames = gr.Slider(minimum=9, maximum=49, step=1, value=16, label="Frames", elem_id="video_frames")
                    fps = gr.Slider(minimum=1, maximum=30, step=1, value=8, label="FPS (playback)", info="Playback speed only - LTX always samples at 25 fps.", elem_id="video_fps")
                    steps = gr.Slider(minimum=1, maximum=60, step=1, value=4, label="Steps", elem_id="video_steps")

                with gr.Row():
                    guidance = gr.Slider(minimum=1.0, maximum=20.0, step=0.5, value=1.5, label="CFG", elem_id="video_cfg")
                    seed = gr.Number(value=-1, precision=0, label="Seed", elem_id="video_seed")
                    random_seed = gr.Checkbox(value=True, label="Random seed", elem_id="video_random_seed")

                with gr.Row():
                    base = gr.Dropdown(label="AnimateDiff base (SD1.5)", choices=[b["title"] for b in video_manager.list_bases()], value=None, elem_id="video_base")
                    lightning = gr.Dropdown(label="Lightning", choices=video_manager.lightning_choices(), value=("4step" if "4step" in video_manager.lightning_choices() else (video_manager.lightning_choices()[0] if video_manager.lightning_choices() else None)), elem_id="video_lightning")

                init_image = gr.Image(label="Init image (SVD / LTX)", type="filepath", visible=False, elem_id="video_init_image")

                with gr.Row():
                    refine = gr.Slider(minimum=0.0, maximum=0.8, step=0.05, value=0.25, label="Prompt guidance (SVD img2img refine)", visible=False, elem_id="video_refine")
                    motion_bucket = gr.Slider(minimum=1, maximum=255, step=1, value=video_manager.SVD_MOTION_BUCKET, label="Motion bucket (SVD)", visible=False, elem_id="video_motion")
                    noise_aug = gr.Slider(minimum=0.0, maximum=1.0, step=0.01, value=0.02, label="Noise augment (SVD)", visible=False, elem_id="video_noise")

                with gr.Row():
                    offload = gr.Dropdown(label="VRAM policy", choices=["auto", "on", "off"], value=getattr(shared.opts, "video_offload", "auto"), elem_id="video_offload")
                    pingpong = gr.Checkbox(value=False, label="Ping-pong loop", elem_id="video_pingpong")
                    save_mp4 = gr.Checkbox(value=True, label="Also write MP4", elem_id="video_save_mp4")

                with gr.Row():
                    generate_btn = gr.Button("🎬 Generate clip", variant="primary", elem_id="video_generate_btn")
                    cancel_btn = gr.Button("⏹ Cancel", elem_id="video_cancel_btn")

                progress_html = gr.HTML(_progress_html(video_manager.job_status()), elem_id="video_progress")

            with gr.Column(scale=2):
                preview_html = gr.HTML("<p class='muted'>No clip yet.</p>", elem_id="video_preview")
                video_player = gr.Video(label="MP4 (when available)", elem_id="video_player", interactive=False)
                result_status = gr.Markdown("_Ready._", elem_id="video_result_status")
                gr.Markdown(
                    "Clips are saved to `outputs/video/<date>/<time>-<engine>-<seed>/` as GIF + MP4 + `.txt`. "
                    "Models live under `models/Video/` (bases in `models/Video/bases/`); see "
                    "`scripts/download_video_models.py`.",
                    elem_id="video_results_hint",
                )

        engine.change(
            fn=_engine_update,
            inputs=[engine],
            outputs=[base, lightning, init_image, refine, motion_bucket, noise_aug, prompt, width, height, frames, fps, steps, guidance, engines_html, progress_html],
            show_progress=False,
        )

        generate_btn.click(
            fn=_run,
            inputs=[engine, prompt, negative, base, lightning, init_image, width, height, frames, fps, steps, guidance, seed, random_seed, offload, refine, motion_bucket, noise_aug, pingpong, save_mp4],
            outputs=[preview_html, video_player, result_status, seed, progress_html],
            show_progress=False,
        )
        cancel_btn.click(fn=_cancel, inputs=[], outputs=[progress_html], show_progress=False)
        unload_btn.click(fn=_unload, inputs=[], outputs=[engines_html, progress_html], show_progress=False)
        refresh_btn.click(fn=_refresh, inputs=[], outputs=[engines_html], show_progress=False)

        # size presets follow the active engine
        preset_state = gr.State("animatediff")

        def _sync_presets(engine_title):
            updates, engine_id = _preset_updates(engine_title, len(preset_buttons))
            return updates + [engine_id]

        engine.change(fn=_sync_presets, inputs=[engine], outputs=preset_buttons + [preset_state], show_progress=False)

        def _apply_preset(index, engine_id):
            sizes = SIZES.get(engine_id) or SIZES["animatediff"]
            _label, preset_w, preset_h = sizes[min(index, len(sizes) - 1)]
            return preset_w, preset_h

        for index, button in enumerate(preset_buttons):
            button.click(
                fn=lambda engine_id, i=index: _apply_preset(i, engine_id),
                inputs=[preset_state],
                outputs=[width, height],
                show_progress=False,
            )

    return [(video_ui, "Video", "video_tab")]


script_callbacks.on_ui_tabs(on_ui_tabs)
