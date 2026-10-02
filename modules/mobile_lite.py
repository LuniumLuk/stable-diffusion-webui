"""Mobile Lite UI - a ground-up, mobile-first front-end for the hot-path workflows.

The stock A1111 page is desktop-shaped and heavy for phones (large Gradio bundle,
wrapped tab strips, thousands of pixels of settings before the image).  This module
serves an independent, tiny (no-framework) web app at ``/mlite/`` that talks to a
small JSON API implemented here, instead of embedding the Gradio UI.

Scope (deliberately limited - other tabs can be added later):

* **Text** - txt2img with the essential controls.
* **Image** - img2img plus an inpaint mode (paint/erase/SAM mask editor).
* **Gallery** - paged browsing of the endorsement database + quick actions.
* **Compose** - a touch layer compositor that saves into ``outputs/composition``.

Routing policy (option ``mobile_lite_mode`` in Settings -> Mobile lite):

* ``Auto (mobile devices)`` (default) - HTTP GET for ``/`` from a phone/tablet
  user agent is redirected to ``/mlite/``; desktop keeps the Gradio UI.
* ``Always`` - every browser opening ``/`` lands in the lite UI.
* ``Disabled`` - never redirect.

A ``?desktop=1`` link (the "Desktop UI" button inside the lite app) opts the
browser out via a cookie; ``?mlite=1`` opts back in.  All files are served with
``no-store`` so a stale cached page can never pin an old bundle (a recurring
problem with phone browsers and the Gradio index).

The jobs API reuses the standard processing pipeline (queue lock, scripts,
progress reporting), so generated files land in the normal output folders and
show up in the main Gallery/Queue tabs.
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import math
import os
import re
import threading
import time
import urllib.request
from collections import OrderedDict
from datetime import datetime
from urllib.parse import quote

from PIL import Image

_WEBUI_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_STATIC_DIR = os.path.join(_WEBUI_ROOT, "mobile_lite")

MODE_AUTO = "Auto (mobile devices)"
MODE_ALWAYS = "Always"
MODE_DISABLED = "Disabled"
MODE_CHOICES = [MODE_AUTO, MODE_ALWAYS, MODE_DISABLED]

COOKIE_NAME = "mlite_pref"
COOKIE_DESKTOP = "desktop"
_COOKIE_MAX_AGE = 365 * 24 * 3600

_NO_STORE = {"Cache-Control": "no-store, must-revalidate", "Pragma": "no-cache"}

_MOBILE_UA_RE = re.compile(
    r"android|iphone|ipad|ipod|iemobile|windows phone|blackberry|opera mini|mobile",
    re.IGNORECASE,
)

# Thumbnails are shared with the Gradio gallery caches (same naming scheme), so
# both UIs reuse each other's generated files. The desktop preview (1024px) stays
# untouched; the lite viewer uses its own smaller 480px variant (bandwidth).
_THUMB_PX = 192
_PREVIEW_PX = 1024
_VIEWER_PX = 480
_THUMB_CACHE_DIR = os.path.join(_WEBUI_ROOT, "cache", "gallery_thumbs")
_PREVIEW_CACHE_DIR = os.path.join(_WEBUI_ROOT, "cache", "gallery_previews")
_IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp")

_results_lock = threading.Lock()
_results = OrderedDict()  # task_id -> finished result payload
_RESULTS_KEEP = 8

_db_ready = False
_db_lock = threading.Lock()

_script_args_cache: dict = {}

# ---- Qwen-Image-2.1 sidecar state -----------------------------------------
# The GPU is 16GB; SDXL (~7GB) and the Qwen server (~10GB) cannot coexist, so the
# bridge unloads one before using the other (see _qwen_prepare_async / _run_job).
_QWEN_JOB_TIMEOUT = 1800.0  # 2K resolutions take minutes; slow prompts get room
_QWEN_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

_qwen_lock = threading.Lock()  # serialises sd-server starts (prepare thread vs job thread)
_qwen_state_lock = threading.RLock()  # guards _qwen_starting / _qwen_job (re-entrant: helpers lock it too)
_qwen_starting = False  # an engine-switch prepare is loading the server in the background
_qwen_job = {
    "task_id": None,
    "phase": None,  # preparing | queued | generating | saving | done | failed
    "started": 0.0,
    "server_job": None,
    "error": None,
}

# Fallbacks for when ui-config.json is missing; the desktop UI keeps its live
# defaults there, so the lite UI opens with the same values the Gradio UI has.
_MASKED_CONTENT = {"fill": 0, "original": 1, "latent noise": 2, "latent nothing": 3}

_FALLBACK_DEFAULTS = {
    "txt2img": {
        "steps": 20, "cfg": 7.0, "width": 512, "height": 512,
        "sampler": "Euler a", "scheduler": "Automatic", "batch": 1,
        "hr_enabled": False, "hr_upscaler": "Latent", "hr_scale": 2.0,
        "hr_steps": 0, "hr_denoise": 0.7,
    },
    "img2img": {
        "steps": 20, "cfg": 7.0, "width": 512, "height": 512,
        "sampler": "Euler a", "scheduler": "Automatic", "batch": 1,
        "denoise": 0.75, "mask_blur": 4,
        "fill": 1, "inpaint_full_res": False, "inpaint_full_res_padding": 32,
        "invert_mask": False,
        "input_resize": "off", "input_resize_scale": 1.0, "input_resize_fit": "fill",
    },
}


def _ui_defaults(tab: str) -> dict:
    """Mirror the Gradio UI open-state values from ``ui-config.json``."""
    merged = dict(_FALLBACK_DEFAULTS[tab])
    keys = {
        "steps": f"customscript/sampler.py/{tab}/Sampling steps/value",
        "sampler": f"customscript/sampler.py/{tab}/Sampling method/value",
        "scheduler": f"customscript/sampler.py/{tab}/Schedule type/value",
        "cfg": f"{tab}/CFG Scale/value",
        "width": f"{tab}/Width/value",
        "height": f"{tab}/Height/value",
        "batch": f"{tab}/Batch count/value",
        "denoise": "img2img/Denoising strength/value",
        "mask_blur": "img2img/Mask blur/value",
    }
    if tab == "txt2img":
        # Hires. fix controls (txt2img only); missing keys keep the fallbacks above.
        keys.update({
            "hr_enabled": "txt2img/Hires. fix/value",
            "hr_upscaler": "txt2img/Upscaler/value",
            "hr_scale": "txt2img/Upscale by/value",
            "hr_steps": "txt2img/Hires steps/value",
            "hr_denoise": "txt2img/Denoising strength/value",
        })
    try:
        with open(os.path.join(_WEBUI_ROOT, "ui-config.json"), "r", encoding="utf-8") as handle:
            data = json.load(handle)
        for name, key in keys.items():
            if data.get(key) is not None:
                merged[name] = data[key]
        # inpaint controls store labels, not numbers
        raw = data.get("img2img/Masked content/value")
        if isinstance(raw, str):
            merged["fill"] = _MASKED_CONTENT.get(raw.strip().lower(), merged["fill"])
        raw = data.get("img2img/Inpaint area/value")
        if isinstance(raw, str):
            merged["inpaint_full_res"] = raw.strip().lower().startswith("only")
        raw = data.get("img2img/Only masked padding, pixels/value")
        if isinstance(raw, (int, float)):
            merged["inpaint_full_res_padding"] = int(raw)
        raw = data.get("img2img/Mask mode/value")
        if isinstance(raw, str):
            merged["invert_mask"] = "not masked" in raw.strip().lower()
    except Exception:
        pass
    return merged


# --------------------------------------------------------------------------- settings


def _mode() -> str:
    try:
        from modules import shared

        mode = str(getattr(shared.opts, "mobile_lite_mode", MODE_AUTO) or MODE_AUTO)
    except Exception:
        mode = MODE_AUTO
    return mode if mode in MODE_CHOICES else MODE_AUTO


def _is_mobile_ua(user_agent: str) -> bool:
    return bool(_MOBILE_UA_RE.search(user_agent or ""))


# --------------------------------------------------------------------------- middleware


def build_middleware():
    """Return starlette middleware entries to pass via ``app_kwargs``."""
    from starlette.middleware import Middleware

    return [Middleware(_make_redirect_middleware())]


def _make_redirect_middleware():
    from starlette.middleware.base import BaseHTTPMiddleware

    class MobileLiteRedirectMiddleware(BaseHTTPMiddleware):
        """Redirect the browser entry point (``/``) to the lite UI when enabled."""

        @staticmethod
        def _lite_url(request):
            root_path = request.scope.get("root_path", "") or ""
            return f"{root_path}/mlite/"

        async def _redirect(self, request):
            from starlette.responses import RedirectResponse

            response = RedirectResponse(url=self._lite_url(request), status_code=302)
            for key, value in _NO_STORE.items():
                response.headers[key] = value
            return response

        async def dispatch(self, request, call_next):
            is_entry = request.url.path in ("/", "/index.html") and request.method in (
                "GET",
                "HEAD",
            )
            if not is_entry or "text/html" not in request.headers.get("accept", ""):
                return await call_next(request)

            query = request.query_params

            # Explicit switches work regardless of the setting: ?mlite=1 enters
            # the lite UI and clears the opt-out, ?desktop=1 opts out.
            if "mlite" in query:
                response = await self._redirect(request)
                response.delete_cookie(COOKIE_NAME)
                return response

            if "desktop" not in query and request.cookies.get(COOKIE_NAME) != COOKIE_DESKTOP:
                mode = _mode()
                redirect = mode == MODE_ALWAYS or (
                    mode == MODE_AUTO and _is_mobile_ua(request.headers.get("user-agent", ""))
                )
                if redirect:
                    return await self._redirect(request)

            response = await call_next(request)
            if "desktop" in query:
                response.set_cookie(
                    COOKIE_NAME,
                    COOKIE_DESKTOP,
                    max_age=_COOKIE_MAX_AGE,
                    httponly=False,
                    samesite="lax",
                )
            return response

    return MobileLiteRedirectMiddleware


# --------------------------------------------------------------------------- helpers


def _decode_image(payload: str) -> Image.Image:
    """Decode a data URL / bare base64 string into a PIL image."""
    data = str(payload or "")
    if data.startswith("data:"):
        _, _, data = data.partition(",")
    raw = base64.b64decode(data)
    image = Image.open(io.BytesIO(raw))
    image.load()
    if getattr(image, "is_animated", False):
        image.seek(0)
    return image.convert("RGB") if image.mode not in ("RGB", "RGBA", "L") else image


def _file_url(path: str) -> str:
    normalized = str(path or "").replace(os.sep, "/")
    return f"/file={quote(normalized, safe='')}" if normalized else ""


def _clamp_int(value, low, high, default):
    try:
        result = int(float(value))
    except (TypeError, ValueError):
        return default
    return max(low, min(high, result))


def _clamp_float(value, low, high, default):
    try:
        result = float(value)
    except (TypeError, ValueError):
        return default
    return max(low, min(high, result))


def _clamp_resolution(value, default, multiple=8):
    value = _clamp_int(value, 64, 2048, default)
    return max(64, int(round(value / multiple)) * multiple)


def _payload_number(payload: dict, key: str, low, high, default, *, cast=int):
    return cast(_clamp_float(payload.get(key, default), low, high, default))


_RESAMPLING = getattr(Image, "Resampling", Image)  # Pillow >= 9.1 namespaces the constants


def _round_grid(value: float, multiple: int = 8) -> int:
    # half-up like JS Math.round (Python's round() is half-even) so the front-end hint matches
    return max(64, min(2048, int(value / multiple + 0.5) * multiple))


def _input_resize_plan(payload: dict, defaults: dict, source_w: int, source_h: int):
    """Target of the optional init-image pre-resize; ``None`` when disabled or a no-op."""
    mode = str(payload.get("input_resize") or defaults.get("input_resize") or "off").strip().lower()
    if mode not in ("scale", "custom"):
        return None

    if mode == "scale":
        factor = _clamp_float(payload.get("input_resize_scale"), 0.1, 4.0, defaults.get("input_resize_scale", 1.0))
        width, height = _round_grid(source_w * factor), _round_grid(source_h * factor)
        fit = "fill"  # the aspect ratio is preserved anyway
    else:
        width = _clamp_resolution(payload.get("input_resize_w"), _round_grid(source_w))
        height = _clamp_resolution(payload.get("input_resize_h"), _round_grid(source_h))
        fit = str(payload.get("input_resize_fit") or defaults.get("input_resize_fit") or "fill").strip().lower()
        if fit not in ("fill", "stretch"):
            fit = "fill"

    if (width, height) == (source_w, source_h):
        return None
    return {"mode": mode, "width": width, "height": height, "fit": fit}


def _apply_input_resize(image, mask, payload: dict, defaults: dict):
    """Resize the init image (and the inpaint mask) first, before any other operation.

    The filter is chosen automatically from the actual scale factor: area averaging (BOX) for
    downscales - with a reducing pass for large factors - and Lanczos for upscales. Custom
    targets fit by 'fill' (cover the box, center-crop; aspect kept) or 'stretch' (distort to the
    exact size). The mask gets the identical geometry, so painted regions stay aligned.
    """
    plan = _input_resize_plan(payload, defaults, image.width, image.height)
    if not plan:
        return image, mask, None

    target = (plan["width"], plan["height"])
    crop = plan["mode"] == "custom" and plan["fit"] == "fill"
    if crop:
        downscale = max(target[0] / image.width, target[1] / image.height) < 1
    else:
        downscale = target[0] * target[1] < image.width * image.height
    resample = _RESAMPLING.BOX if downscale else _RESAMPLING.LANCZOS
    reducing_gap = 2.0 if downscale else None

    def resize_one(item):
        if crop:
            ratio = max(target[0] / item.width, target[1] / item.height)
            scaled = (max(1, math.ceil(item.width * ratio)), max(1, math.ceil(item.height * ratio)))
            resized = item.resize(scaled, resample, reducing_gap=reducing_gap)
            left = (resized.width - target[0]) // 2
            top = (resized.height - target[1]) // 2
            return resized.crop((left, top, left + target[0], top + target[1]))
        return item.resize(target, resample, reducing_gap=reducing_gap)

    detail = f"{image.width}x{image.height} -> {plan['width']}x{plan['height']} ({'area' if downscale else 'lanczos'}"
    if plan["mode"] == "custom":
        detail += ", aspect fill" if crop else ", stretch"
    detail += ")"

    resized_mask = resize_one(mask) if mask is not None else None
    return resize_one(image), resized_mask, detail


# --------------------------------------------------------------------------- script args


def _default_script_args(tab: str) -> tuple:
    """Default script arguments (same defaults the API uses for /sdapi jobs)."""
    if tab in _script_args_cache:
        return _script_args_cache[tab]

    args = [0]
    try:
        import gradio as gr

        from modules import scripts

        runner = scripts.scripts_txt2img if tab == "txt2img" else scripts.scripts_img2img
        last = 1
        for script in runner.scripts:
            last = max(last, script.args_to)
        args = [None] * last
        args[0] = 0

        with gr.Blocks():
            for script in runner.scripts:
                try:
                    controls = script.ui(script.is_img2img)
                except Exception:
                    controls = None
                if controls:
                    values = [elem.value for elem in controls]
                    args[script.args_from:script.args_to] = values
    except Exception:
        pass

    _script_args_cache[tab] = tuple(args)
    return _script_args_cache[tab]


def _apply_alwayson_overrides(script_args: tuple, tab: str, overrides) -> tuple:
    if not overrides:
        return script_args

    try:
        from modules import scripts

        runner = scripts.scripts_txt2img if tab == "txt2img" else scripts.scripts_img2img
        args = list(script_args)
        for name, spec in dict(overrides).items():
            script = next((s for s in runner.scripts if s.name == name), None)
            if script is None or isinstance(spec, dict) is False:
                continue
            values = spec.get("args")
            if not isinstance(values, list):
                continue
            for idx, value in enumerate(values[: max(0, script.args_to - script.args_from)]):
                args[script.args_from + idx] = value
        return tuple(args)
    except Exception:
        return script_args


# --------------------------------------------------------------------------- output scan


def _collect_saved_images(outdir: str, since_ts: float, limit: int = 48) -> list:
    """Files written into ``outdir`` after ``since_ts``.

    Callers stamp ``since_ts`` while holding the queue lock, so no other generation can be
    writing images concurrently and only this job's own files pass the filter.
    """
    found = []
    if not outdir or not os.path.isdir(outdir):
        return found

    for root, dirs, files in os.walk(outdir):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for name in files:
            if not name.lower().endswith(_IMAGE_EXTS):
                continue
            full = os.path.join(root, name)
            try:
                mtime = os.path.getmtime(full)
            except OSError:
                continue
            if mtime >= since_ts - 0.05:
                found.append((mtime, full))

    found.sort(key=lambda item: (item[0], item[1]))
    return [path for _mtime, path in found[-limit:]]


# --------------------------------------------------------------------------- jobs


def _normalize_task_id(raw) -> str:
    task_id = str(raw or "").strip()
    if re.fullmatch(r"task\([A-Za-z0-9_\-]{3,40}\)", task_id):
        return task_id
    from modules import progress

    return progress.create_task_id("mlite")


def _hr_upscaler_choices() -> list:
    """Upscaler dropdown options, same list the desktop hires. fix row offers."""
    from modules import shared

    return [*shared.latent_upscale_modes, *[item.name for item in shared.sd_upscalers]]


def _resolve_hr_upscaler(raw, defaults: dict) -> str:
    """Unknown names (stale ui-config, typo) fall back to the desktop default."""
    from modules import shared

    choices = _hr_upscaler_choices()
    chosen = str(raw or "").strip()
    if chosen in choices:
        return chosen
    fallback = str(defaults.get("hr_upscaler") or "")
    if fallback in choices:
        return fallback
    return shared.latent_upscale_default_mode


def _common_args(payload: dict, tab: str) -> dict:
    from modules import sd_samplers

    defaults = _ui_defaults(tab)
    sampler = str(payload.get("sampler") or defaults["sampler"] or "")
    scheduler = str(payload.get("scheduler") or defaults["scheduler"] or "")
    sampler_name, scheduler_label = sd_samplers.get_sampler_and_scheduler(sampler, scheduler)

    return {
        "prompt": str(payload.get("prompt") or ""),
        "negative_prompt": str(payload.get("negative_prompt") or ""),
        "steps": _payload_number(payload, "steps", 1, 150, defaults["steps"]),
        "cfg_scale": _payload_number(payload, "cfg", 1.0, 30.0, defaults["cfg"], cast=float),
        "width": _clamp_resolution(payload.get("width"), defaults["width"]),
        "height": _clamp_resolution(payload.get("height"), defaults["height"]),
        "sampler_name": sampler_name,
        "scheduler": scheduler_label,
        "seed": _clamp_int(payload.get("seed"), -1, 2 ** 31 - 1, -1),
        "subseed": -1,
        "subseed_strength": 0.0,
        "batch_size": 1,
        "n_iter": _payload_number(payload, "batch", 1, 8, defaults["batch"]),
        "restore_faces": False,
        "tiling": False,
    }


def _run_job(payload: dict, tab: str) -> dict:
    """Run a txt2img/img2img job synchronously (called in a worker thread)."""
    import modules.shared as shared
    from modules import progress as progress_module
    from modules.call_queue import queue_lock
    from modules.processing import (
        StableDiffusionProcessingImg2Img,
        StableDiffusionProcessingTxt2Img,
        process_images,
    )
    from modules import scripts

    task_id = _normalize_task_id(payload.get("task_id"))

    runner = scripts.scripts_txt2img if tab == "txt2img" else scripts.scripts_img2img
    script_args = _apply_alwayson_overrides(
        _default_script_args(tab), tab, payload.get("alwayson")
    )

    args = _common_args(payload, tab)

    if tab == "txt2img":
        defaults = _ui_defaults("txt2img")
        p = StableDiffusionProcessingTxt2Img(
            sd_model=shared.sd_model,
            do_not_save_samples=False,
            do_not_save_grid=False,
            enable_hr=bool(payload.get("enable_hr", False)),
            # denoising_strength doubles as the hires denoise for txt2img (like the desktop UI)
            denoising_strength=_payload_number(
                payload, "hr_denoise", 0.0, 1.0, defaults["hr_denoise"], cast=float
            ),
            hr_scale=_payload_number(payload, "hr_scale", 1.0, 4.0, defaults["hr_scale"], cast=float),
            hr_upscaler=_resolve_hr_upscaler(payload.get("hr_upscaler"), defaults),
            hr_second_pass_steps=_payload_number(payload, "hr_steps", 0, 150, defaults["hr_steps"]),
            # stage config is newline-oriented; accept semicolon-separated pastes like the desktop
            hr_stage_config_text=str(payload.get("hr_stage_config") or "").replace(";", "\n").strip()[:4000],
            **args,
        )
        outpath_samples = shared.opts.outdir_txt2img_samples
        outpath_grids = shared.opts.outdir_txt2img_grids
    else:
        defaults = _ui_defaults("img2img")
        init_image = _decode_image(payload.get("init_image"))
        mask = None
        if payload.get("mask"):
            mask = _decode_image(payload.get("mask")).convert("L")

        init_image, mask, input_resize_info = _apply_input_resize(init_image, mask, payload, defaults)

        p = StableDiffusionProcessingImg2Img(
            sd_model=shared.sd_model,
            do_not_save_samples=False,
            do_not_save_grid=False,
            init_images=[init_image],
            resize_mode=_payload_number(payload, "resize_mode", 0, 3, 0),
            denoising_strength=_payload_number(
                payload, "denoise", 0.0, 1.0, defaults["denoise"], cast=float
            ),
            mask=mask,
            mask_blur=_payload_number(payload, "mask_blur", 0, 64, defaults["mask_blur"]),
            inpainting_fill=_payload_number(payload, "fill", 0, 3, 1),
            inpaint_full_res=bool(payload.get("inpaint_full_res", False)),
            inpaint_full_res_padding=_payload_number(
                payload, "inpaint_full_res_padding", 0, 256, 32
            ),
            inpainting_mask_invert=1 if payload.get("invert_mask") else 0,
            **args,
        )
        if input_resize_info:
            p.extra_generation_params["Input resize"] = input_resize_info
        outpath_samples = shared.opts.outdir_img2img_samples
        outpath_grids = shared.opts.outdir_img2img_grids

    p.is_api = True
    p.scripts = runner
    p.script_args = script_args
    p.outpath_samples = outpath_samples
    p.outpath_grids = outpath_grids

    progress_module.add_task_to_queue(task_id)
    with queue_lock:
        # single GPU: the Qwen sidecar (~10GB) must release the VRAM before A1111 runs
        _qwen_stop_server()
        # ... and a preceding qwen job left the checkpoint on the CPU
        _ensure_sdxl_ready()
        progress_module.start_task(task_id)
        # Start time is stamped after the queue lock is held: a previous job may still have
        # been writing its own files while this request was waiting, and those must not be
        # attributed to this result.
        started = time.time()
        shared.state.begin(job=f"mlite_{tab}")
        try:
            processed = process_images(p)
        finally:
            shared.state.end()
            shared.total_tqdm.clear()
            progress_module.finish_task(task_id)

    saved = _collect_saved_images(outpath_samples, started)
    seeds = list(getattr(processed, "all_seeds", []) or [])
    infotexts = list(getattr(processed, "infotexts", []) or [])

    images = []
    for index, path in enumerate(saved):
        try:
            mtime = os.path.getmtime(path)
        except OSError:
            mtime = None
        entry = {
            "path": path,
            "url": _file_url(path),
            "thumb": _cached_image_url(path, mtime, "thumb"),
            "preview": _cached_image_url(path, mtime, "viewer"),
        }
        if index < len(seeds):
            entry["seed"] = seeds[index]
        if index < len(infotexts):
            entry["infotext"] = infotexts[index]
        images.append(entry)

    result = {
        "task_id": task_id,
        "images": images,
        "seeds": seeds[: len(images)],
        "infotexts": infotexts[: len(images)],
        "elapsed": round(time.time() - started, 2),
    }

    with _results_lock:
        _results[task_id] = result
        while len(_results) > _RESULTS_KEEP:
            _results.popitem(last=False)

    return result


# --------------------------------------------------------------------------- qwen bridge


def _qwen_manager():
    from modules import qwen_image_manager

    return qwen_image_manager


def _qwen_status_payload() -> dict:
    """Small status block for the UI (engine chip + availability)."""
    try:
        status = _qwen_manager().get_status()
    except Exception as error:  # pragma: no cover - defensive (import/OS errors)
        return {"available": False, "reachable": False, "managed": False, "mode": "error", "error": str(error)}
    with _qwen_state_lock:
        starting = _qwen_starting
    missing = [os.path.relpath(path, _WEBUI_ROOT) for path in status.get("missing_files") or []]
    return {
        "available": not missing,
        "missing_files": missing,
        "url": status.get("url"),
        "reachable": bool(status.get("reachable")),
        "managed": bool(status.get("managed")),
        "mode": status.get("mode") or "stopped",
        "starting": bool(starting and not status.get("reachable")),
    }


def _qwen_set_job(**fields) -> None:
    with _qwen_state_lock:
        _qwen_job.update(fields)


def _qwen_job_snapshot() -> dict:
    with _qwen_state_lock:
        return dict(_qwen_job)


def _qwen_job_active() -> bool:
    return _qwen_job_snapshot().get("phase") in ("preparing", "queued", "generating", "saving")


def _qwen_http(method: str, path: str, body=None, timeout: float = 30.0):
    """JSON call against the sd-server; localhost must bypass the (dead) system proxy."""
    url = _qwen_manager().get_server_url().rstrip("/") + path
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"Content-Type": "application/json"} if data is not None else {}
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    with _QWEN_OPENER.open(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _qwen_unload_sdxl_locked() -> bool:
    """Free the A1111 checkpoint. Must run while holding the queue lock."""
    import modules.shared as shared
    from modules import sd_models

    if shared.sd_model is None:
        return False
    sd_models.unload_model_weights()
    return True


def _ensure_sdxl_ready() -> None:
    """The qwen bridge unloads SDXL to CPU; move it back (or load it) before A1111 runs."""
    import modules.shared as shared
    from modules import devices, sd_models

    model = shared.sd_model
    if model is None:
        sd_models.reload_model_weights()
        return
    try:
        parameter = next(model.parameters())
    except (StopIteration, AttributeError):
        return
    if parameter.device.type == "cpu" and devices.device.type != "cpu":
        sd_models.send_model_to_device(model)


def _qwen_start_server() -> tuple:
    """Start the sd-server if it is not up yet; (ok, message)."""
    manager = _qwen_manager()
    if manager.get_status().get("reachable"):
        return True, "already running"
    result = manager.start_server()
    return bool(result.get("reachable")), str(result.get("message") or "")


def _qwen_stop_server() -> None:
    """Stop the managed sd-server (frees ~10GB VRAM). External servers are left alone."""
    try:
        manager = _qwen_manager()
        if manager.get_status().get("managed"):
            manager.stop_server()
    except Exception:
        pass


def _qwen_prepare_async() -> None:
    """Engine switch -> Qwen: free the SDXL model, then load sd-server in the background."""
    global _qwen_starting
    # check job activity BEFORE taking the state lock - the helper locks it itself
    if _qwen_job_active():
        return
    with _qwen_state_lock:
        if _qwen_starting:
            return
        _qwen_starting = True

    def work():
        global _qwen_starting
        try:
            from modules.call_queue import queue_lock

            with _qwen_lock:
                if _qwen_manager().get_status().get("reachable"):
                    return
                with queue_lock:  # wait out a running A1111 job, then free its VRAM
                    _qwen_unload_sdxl_locked()
                _qwen_start_server()
        except Exception:
            pass
        finally:
            with _qwen_state_lock:
                _qwen_starting = False

    threading.Thread(target=work, name="mlite-qwen-prepare", daemon=True).start()


def _clamp_qwen_size(value, default: int) -> int:
    """Qwen sizes must be divisible by 32 (sd.cpp flow schedule)."""
    number = _clamp_int(value, 64, 4096, default)
    return max(64, int((number + 16) // 32) * 32)


def _qwen_infotext(prompt: str, negative: str, steps: int, cfg: float, seed, width: int, height: int, ref_count: int) -> str:
    body = (
        f"Steps: {steps}, CFG scale: {cfg}, Seed: {seed}, Size: {width}x{height}, "
        f"Model: qwen-image-2.1-Q4_K_M, Sampler: euler"
        + (f", References: {ref_count}" if ref_count else "")
    )
    parts = [prompt, f"Negative prompt: {negative}" if negative else None, body]
    return "\n".join(part for part in parts if part)


def _store_qwen_images(
    status: dict, prompt: str, negative: str, steps: int, cfg: float, seed, width: int, height: int, ref_count: int
) -> list:
    """Decode the base64 results into outputs/qwen/<date>/<time>/<n>.png (+ .txt sidecar)."""
    entries = ((status.get("result") or {}).get("images")) or []
    if not entries:
        raise ValueError("the server returned no images")

    stamp = datetime.now()
    outdir = os.path.join(_WEBUI_ROOT, "outputs", "qwen", stamp.strftime("%Y-%m-%d"), stamp.strftime("%H-%M-%S"))
    os.makedirs(outdir, exist_ok=True)

    images = []
    for index, entry in enumerate(entries):
        raw = base64.b64decode(entry.get("b64_json") or "")
        if not raw:
            continue
        # sd.cpp embeds webui-compatible parameters in the PNG - prefer them (real seed!)
        infotext = ""
        try:
            with Image.open(io.BytesIO(raw)) as parsed:
                infotext = str((parsed.info or {}).get("parameters") or "")
        except Exception:
            infotext = ""
        image_seed = seed
        match = re.search(r"Seed:\s*(-?\d+)", infotext)
        if match:
            image_seed = int(match.group(1))
        if not infotext:
            infotext = _qwen_infotext(prompt, negative, steps, cfg, image_seed, width, height, ref_count)

        path = os.path.join(outdir, f"{index:03d}.png")
        with open(path, "wb") as handle:
            handle.write(raw)
        with open(os.path.splitext(path)[0] + ".txt", "w", encoding="utf-8") as handle:
            handle.write(infotext)

        mtime = os.path.getmtime(path)
        images.append({
            "path": path,
            "url": _file_url(path),
            "thumb": _cached_image_url(path, mtime, "thumb"),
            "preview": _cached_image_url(path, mtime, "viewer"),
            "seed": image_seed,
            "infotext": infotext,
        })
    return images


def _qwen_progress(task_id: str):
    """Progress payload for the active qwen job (None = not ours, use normal progress)."""
    job = _qwen_job_snapshot()
    if not job.get("task_id") or job["task_id"] != task_id:
        return None
    phase = job.get("phase")
    if phase in (None, "done", "failed"):
        return None
    elapsed = max(0.0, time.time() - (job.get("started") or time.time()))
    texts = {
        "preparing": f"qwen-2.1 \u00B7 loading the model\u2026 ({elapsed:.0f}s)",
        "queued": f"qwen-2.1 \u00B7 queued ({elapsed:.0f}s)",
        "generating": f"qwen-2.1 \u00B7 generating ({elapsed:.0f}s)",
        "saving": "qwen-2.1 \u00B7 saving\u2026",
    }
    return {
        "active": phase in ("generating", "saving"),
        "queued": phase in ("preparing", "queued"),
        "completed": False,
        "progress": 0.0,
        "eta": None,
        "live_preview": None,
        "id_live_preview": -1,
        "textinfo": texts.get(phase, "qwen-2.1"),
        "state": {"job": "mlite_qwen", "job_count": 1, "job_no": 0, "sampling_step": 0, "sampling_steps": 0, "skipped": False, "interrupted": False},
        "current_image": None,
        "job_count": 1,
        "job_no": 0,
    }


def _run_qwen_job(payload: dict) -> dict:
    """Run one Qwen-Image-2.1 generation through the sd-server sidecar.

    Uses the native async API (submit -> poll) because the compat layer has no job
    status; the whole job holds the A1111 queue lock so the single GPU stays serial.
    """
    from fastapi import HTTPException
    from modules.call_queue import queue_lock

    if _qwen_job_active():
        raise HTTPException(status_code=409, detail="a qwen job is already running")

    task_id = _normalize_task_id(payload.get("task_id"))
    prompt = str(payload.get("prompt") or "").strip()
    negative = str(payload.get("negative_prompt") or "")
    refs = [
        str(item)
        for item in (payload.get("refs") or [])
        if isinstance(item, str) and item.startswith("data:")
    ][:10]
    steps = _payload_number(payload, "steps", 1, 100, 20)
    cfg = _payload_number(payload, "cfg", 0.0, 30.0, 6.0, cast=float)
    width = _clamp_qwen_size(payload.get("width"), 1024)
    height = _clamp_qwen_size(payload.get("height"), 1024)
    batch = _payload_number(payload, "batch", 1, 4, 1)
    seed = _clamp_int(payload.get("seed"), -1, 2 ** 31 - 1, -1)

    body = {
        "prompt": prompt,
        "negative_prompt": negative,
        "width": width,
        "height": height,
        "batch_count": batch,
        "seed": seed,
        "output_format": "png",
        "auto_resize_ref_image": True,
        "vae_tiling_params": {"enabled": True},
        "sample_params": {
            "scheduler": "default",
            "sample_method": "euler",
            "sample_steps": steps,
            "guidance": {"txt_cfg": cfg, "distilled_guidance": 3.5},
        },
    }
    if refs:
        body["ref_images"] = refs

    started = time.time()
    _qwen_set_job(task_id=task_id, phase="preparing", started=started, server_job=None, error=None)

    server_job = None
    status = None
    failure = ""
    try:
        with queue_lock:
            _qwen_unload_sdxl_locked()
            with _qwen_lock:
                ok, message = _qwen_start_server()
            if not ok:
                failure = message or "the Qwen-Image 2.1 server could not be started"
            else:
                try:
                    submitted = _qwen_http("POST", "/sdcpp/v1/img_gen", body)
                    server_job = submitted.get("id") or submitted.get("job_id")
                except Exception as error:
                    failure = f"could not submit the job: {error}"
                _qwen_set_job(phase="queued", server_job=server_job)

                deadline = time.time() + _QWEN_JOB_TIMEOUT
                while server_job and time.time() < deadline:
                    time.sleep(1.0)
                    try:
                        status = _qwen_http("GET", f"/sdcpp/v1/jobs/{server_job}", timeout=10.0)
                    except Exception:
                        # the sd-server briefly stops answering while it encodes heavy
                        # inputs; keep polling instead of failing the job on one hiccup
                        continue
                    state_name = str(status.get("status") or "")
                    if state_name in ("completed", "failed", "cancelled"):
                        break
                    _qwen_set_job(phase="queued" if state_name in ("queued", "pending") else "generating")
                else:
                    if server_job and not failure:
                        failure = "the qwen job timed out"

            if not failure and status is not None:
                state_name = str(status.get("status") or "")
                if state_name == "cancelled":
                    failure = "cancelled"
                elif state_name == "failed":
                    failure = str(status.get("error") or "qwen generation failed")
            if failure:
                _qwen_set_job(phase="failed", error=failure)
                raise HTTPException(status_code=503, detail=failure)

            _qwen_set_job(phase="saving")
            try:
                images = _store_qwen_images(status or {}, prompt, negative, steps, cfg, seed, width, height, len(refs))
            except Exception as error:
                _qwen_set_job(phase="failed", error=str(error))
                raise HTTPException(status_code=500, detail=f"could not save the result: {error}")
    except HTTPException:
        raise
    except Exception as error:
        _qwen_set_job(phase="failed", error=str(error))
        raise HTTPException(status_code=500, detail=str(error))

    result = {
        "task_id": task_id,
        "engine": "qwen",
        "images": images,
        "seeds": [entry.get("seed") for entry in images if entry.get("seed") is not None],
        "infotexts": [entry.get("infotext") or "" for entry in images],
        "elapsed": round(time.time() - started, 2),
    }
    with _results_lock:
        _results[task_id] = result
        while len(_results) > _RESULTS_KEEP:
            _results.popitem(last=False)
    _qwen_set_job(phase="done")
    return result


# --------------------------------------------------------------------------- gallery


def _ensure_db():
    global _db_ready
    if _db_ready:
        return
    with _db_lock:
        if _db_ready:
            return
        from modules import endorsement_db

        endorsement_db.init_db()
        _db_ready = True


def _thumb_file(path: str, mtime: float) -> str:
    key = hashlib.sha1(f"{path}|{mtime:.6f}".encode("utf-8", errors="ignore")).hexdigest()
    return os.path.join(_THUMB_CACHE_DIR, f"{key}.webp")


def _preview_file(path: str, mtime: float) -> str:
    key = hashlib.sha1(f"{path}|{mtime:.6f}|preview".encode("utf-8", errors="ignore")).hexdigest()
    return os.path.join(_PREVIEW_CACHE_DIR, f"{key}.webp")


def _viewer_file(path: str, mtime: float) -> str:
    """Lite viewer variant: 480px webp (own cache key - the desktop keeps the 1024px one)."""
    key = hashlib.sha1(f"{path}|{mtime:.6f}|viewer480".encode("utf-8", errors="ignore")).hexdigest()
    return os.path.join(_PREVIEW_CACHE_DIR, f"{key}.webp")


def _cached_image_url(path: str, mtime: float, kind: str) -> str:
    """Serve (and lazily build) the shared gallery thumbnail/preview caches.

    kind: 'thumb' (192px) | 'preview' (1024px, desktop-shared) | 'viewer' (480px, lite).
    """
    from modules import endorsement_db

    try:
        if mtime is None:
            mtime = os.path.getmtime(path)
    except OSError:
        mtime = endorsement_db.get_file_mtime_by_path(path)
    if mtime is None:
        return ""

    if kind == "thumb":
        cache_file, size, quality, method = _thumb_file(path, mtime), _THUMB_PX, 72, 5
    elif kind == "viewer":
        cache_file, size, quality, method = _viewer_file(path, mtime), _VIEWER_PX, 85, 4
    else:
        cache_file, size, quality, method = _preview_file(path, mtime), _PREVIEW_PX, 88, 4
    if not os.path.exists(cache_file):
        try:
            os.makedirs(os.path.dirname(cache_file), exist_ok=True)
            img = Image.open(path)
            img.thumbnail((size, size))
            img.save(cache_file, format="WEBP", quality=quality, method=method)
        except Exception:
            return ""
    return _file_url(cache_file)


def _normalize_item(row: dict, view: str) -> dict:
    path = str(row.get("path") or row.get("image_path") or "")
    mtime = row.get("file_mtime")
    if mtime is None:
        for key in ("endorsed_at", "disliked_at", "archived_at", "staged_at", "trashed_at"):
            if row.get(key):
                try:
                    mtime = datetime.fromisoformat(str(row[key])).timestamp()
                except ValueError:
                    mtime = None
                break

    item = {
        "key": str(row.get("item_key") or ""),
        "path": path,
        "url": _file_url(path),
        "thumb": "",
        "preview": "",
        "prompt": str(row.get("prompt") or ""),
        "negative_prompt": str(row.get("negative_prompt") or ""),
        "seed": row.get("seed"),
        "steps": row.get("steps"),
        "sampler": row.get("sampler") or "",
        "cfg": row.get("cfg_scale"),
        "width": row.get("width"),
        "height": row.get("height"),
        "model": row.get("model_name") or "",
        "mtime": float(mtime or 0),
        "view": view,
        "qwen": bool(row.get("qwen")),
    }
    if path and os.path.exists(path):
        item["thumb"] = _cached_image_url(path, mtime, "thumb")
        item["preview"] = _cached_image_url(path, mtime, "viewer")
    return item


def _composed_items(query: str, limit: int, offset: int):
    """Items for the Composed view (plain directory scan, like the Gradio gallery)."""
    comp_dir = os.path.join(_WEBUI_ROOT, "outputs", "composition")
    if not os.path.isdir(comp_dir):
        return [], 0

    names = [
        name
        for name in os.listdir(comp_dir)
        if name.lower().endswith(".png") and not name.startswith(".")
    ]
    q = (query or "").strip().lower()
    if q:
        names = [name for name in names if q in name.lower()]

    def _mtime(name):
        try:
            return os.path.getmtime(os.path.join(comp_dir, name))
        except OSError:
            return 0

    names.sort(key=_mtime, reverse=True)
    rows = []
    for name in names[offset: offset + limit]:
        path = os.path.join(comp_dir, name)
        rows.append(
            {
                "item_key": name,
                "path": path,
                "file_mtime": _mtime(name),
                "prompt": "",
                "model_name": "",
            }
        )
    return rows, len(names)


_GALLERY_VIEWS = [
    ("all", "All"),
    ("endorsed", "Endorsed"),
    ("unrated", "Unrated"),
    ("disliked", "Disliked"),
    ("archived", "Archived"),
    ("staged", "Staged"),
    ("composed", "Composed"),
    ("qwen", "Qwen"),
]


def _qwen_item_key(path: str) -> str:
    """Unique archive key for a qwen output - every run uses the same 000.png file name."""
    rel = os.path.relpath(path, _WEBUI_ROOT).replace("\\", "/")
    parts = [part for part in rel.split("/") if part]
    parts[-1] = os.path.splitext(parts[-1])[0]
    return "qwen-" + "-".join(part.lower() for part in parts)


def _qwen_items(query: str, limit: int, offset: int):
    """Items for the Qwen view: a plain scan of outputs/qwen/<date>/<time>/<n>.png."""
    qwen_dir = os.path.join(_WEBUI_ROOT, "outputs", "qwen")
    if not os.path.isdir(qwen_dir):
        return [], 0

    files = []
    for dirpath, dirnames, filenames in os.walk(qwen_dir):
        dirnames[:] = [name for name in dirnames if not name.startswith(".")]
        for name in filenames:
            if name.lower().endswith(_IMAGE_EXTS) and not name.startswith("."):
                files.append(os.path.join(dirpath, name))

    q = (query or "").strip().lower()
    if q:
        files = [path for path in files if q in path.lower()]

    def _mtime(path):
        try:
            return os.path.getmtime(path)
        except OSError:
            return 0

    files.sort(key=_mtime, reverse=True)
    rows = []
    for path in files[offset: offset + limit]:
        rows.append({
            "item_key": _qwen_item_key(path),
            "path": path,
            "file_mtime": _mtime(path),
            "prompt": "",
            "model_name": "qwen-image-2.1",
            "qwen": True,
        })
    return rows, len(files)


def _gallery_page(view: str, query: str, page: int, page_size: int) -> dict:
    _ensure_db()
    from modules import endorsement_db

    view = view if view in [v for v, _label in _GALLERY_VIEWS] else "all"
    page = max(1, int(page or 1))
    page_size = max(12, min(96, int(page_size or 48)))
    offset = (page - 1) * page_size

    if view == "composed":
        rows, total = _composed_items(query, page_size, offset)
    elif view == "qwen":
        rows, total = _qwen_items(query, page_size, offset)
    elif view == "endorsed":
        total = endorsement_db.count_endorsements(query)
        rows = endorsement_db.search_endorsements(query, limit=page_size, offset=offset)
    elif view == "unrated":
        total = endorsement_db.count_unrated(query)
        rows = endorsement_db.search_unrated(query, limit=page_size, offset=offset)
    elif view == "disliked":
        total = endorsement_db.count_disliked(query)
        rows = endorsement_db.search_disliked(query, limit=page_size, offset=offset)
    elif view == "archived":
        total = endorsement_db.count_archived(query)
        rows = endorsement_db.search_archived(query, limit=page_size, offset=offset)
    elif view == "staged":
        total = endorsement_db.count_staged(query)
        rows = endorsement_db.search_staged(query, limit=page_size, offset=offset)
    else:
        total = endorsement_db.count_generated_filtered(query, exclude_disliked=True)
        rows = endorsement_db.search_generated(
            query, limit=page_size, offset=offset, exclude_disliked=True
        )

    items = [_normalize_item(dict(row), view) for row in rows]

    # Batch-annotate state flags for the page (single query per flag set).
    paths = {item["path"] for item in items if item["path"]}
    keys = [item["key"] for item in items if item["key"]]
    endorsed = endorsement_db.get_endorsed_paths() & paths
    endorsed_keys = endorsement_db.get_endorsed_item_keys() & set(keys)
    disliked = endorsement_db.get_disliked_paths() & paths
    archived = endorsement_db.get_archived_item_keys(keys)
    staged = endorsement_db.get_staged_item_keys(keys)
    for item in items:
        # endorsing copies the file into the endorsed root, so match on the item key too
        item["endorsed"] = item["path"] in endorsed or item["key"] in endorsed_keys
        item["disliked"] = item["path"] in disliked
        item["archived"] = item["key"] in archived
        item["staged"] = item["key"] in staged

    return {
        "view": view,
        "page": page,
        "size": page_size,
        "total": int(total or 0),
        "has_more": offset + len(items) < int(total or 0),
        "items": items,
    }


def _gallery_action(payload: dict) -> dict:
    _ensure_db()
    from modules import endorsement_db

    action = str(payload.get("action") or "")
    path = str(payload.get("path") or "")
    meta = dict(payload.get("meta") or {})
    item_key = str(payload.get("key") or "")
    if not item_key and path:
        try:
            item_key = endorsement_db._item_key_from_path(path)
        except Exception:
            item_key = ""

    # Qwen outputs live outside the rated database: they can only be archived by hand
    # (and the bulk "archive unrated" can never reach them - they are not generated_images rows)
    normalized_path = f"/{path.replace(chr(92), '/').lower().strip('/')}/"
    if item_key.startswith("qwen-") or "/outputs/qwen/" in normalized_path:
        if action not in ("archive", "unarchive"):
            return {"ok": False, "error": "qwen images cannot be rated - archive or unarchive only"}

    def _meta_args():
        return (
            meta.get("prompt") or "",
            meta.get("negative_prompt") or "",
            meta.get("seed") or "",
            meta.get("steps") or 0,
            meta.get("sampler") or "",
            meta.get("cfg") or 0,
            meta.get("width") or 0,
            meta.get("height") or 0,
            meta.get("model") or "",
            "",
            meta.get("infotext") or "",
        )

    if action == "endorse" and path:
        endorsement_db.endorse(path, *_meta_args(), item_key=item_key)
    elif action == "unendorse":
        # delete by the canonical key: endorsed copies carry a _N filename suffix
        if item_key:
            endorsement_db.delete_endorsement_by_key(item_key)
        elif path:
            endorsement_db.delete_endorsement_by_path(path)
    elif action == "dislike" and path:
        if item_key:
            # disliking an endorsed item drops its endorsed copy as well
            endorsement_db.delete_endorsement_by_key(item_key)
        endorsement_db.dislike(path, *_meta_args(), item_key=item_key)
    elif action == "undislike":
        if item_key:
            endorsement_db.delete_dislike_by_key(item_key)
        elif path:
            endorsement_db.delete_dislike_by_path(path)
    elif action == "archive" and item_key:
        endorsement_db.archive_item(item_key)
    elif action == "unarchive" and item_key:
        endorsement_db.unarchive_item(item_key)
    elif action == "archive-unrated":
        return {"ok": True, "archived": int(endorsement_db.archive_all_unrated() or 0)}
    elif action == "stage" and item_key:
        endorsement_db.stage_item(item_key)
    elif action == "unstage" and item_key:
        endorsement_db.unstage_item(item_key)
    else:
        return {"ok": False, "error": f"unknown action: {action}"}

    return {"ok": True}


# --------------------------------------------------------------------------- routes


def register_routes(app):
    from fastapi import Body, HTTPException
    from starlette.responses import FileResponse, RedirectResponse

    html_headers = dict(_NO_STORE)
    html_headers["Content-Type"] = "text/html; charset=utf-8"

    @app.get("/mlite")
    async def mlite_root_redirect():
        return RedirectResponse(url="mlite/", status_code=302, headers=dict(_NO_STORE))

    @app.get("/mlite/")
    async def mlite_index():
        index = os.path.join(_STATIC_DIR, "index.html")
        if not os.path.isfile(index):
            raise HTTPException(status_code=404, detail="mobile lite UI is not installed")
        return FileResponse(index, media_type="text/html", headers=dict(_NO_STORE))

    @app.get("/mlite/api/bootstrap")
    def mlite_bootstrap():
        import modules.shared as shared
        from modules import sd_models, sd_samplers, sd_schedulers

        models = [
            {"title": info.title, "name": info.model_name}
            for info in sd_models.checkpoints_list.values()
        ]
        hidden = set(shared.opts.hide_samplers or [])
        samplers = [entry[0] for entry in sd_samplers.all_samplers if entry[0] not in hidden]
        schedulers = [scheduler.label for scheduler in sd_schedulers.schedulers]
        text_defaults = _ui_defaults("txt2img")
        image_defaults = _ui_defaults("img2img")
        return {
            "version": 1,
            "mode": _mode(),
            "mode_choices": MODE_CHOICES,
            "model": str(shared.opts.sd_model_checkpoint or ""),
            "models": models,
            "samplers": samplers,
            "schedulers": schedulers,
            "upscalers": _hr_upscaler_choices(),
            "defaults": {
                "steps": text_defaults["steps"],
                "cfg": text_defaults["cfg"],
                "width": text_defaults["width"],
                "height": text_defaults["height"],
                "sampler": text_defaults["sampler"],
                "scheduler": text_defaults["scheduler"],
                "batch": text_defaults["batch"],
                "hr_enabled": bool(text_defaults.get("hr_enabled", False)),
                "hr_upscaler": text_defaults["hr_upscaler"],
                "hr_scale": text_defaults["hr_scale"],
                "hr_steps": text_defaults["hr_steps"],
                "hr_denoise": text_defaults["hr_denoise"],
                "denoise": image_defaults["denoise"],
                "mask_blur": image_defaults["mask_blur"],
                "fill": image_defaults["fill"],
                "inpaint_full_res": image_defaults["inpaint_full_res"],
                "inpaint_full_res_padding": image_defaults["inpaint_full_res_padding"],
                "invert_mask": image_defaults["invert_mask"],
                "steps_img2img": image_defaults["steps"],
                "cfg_img2img": image_defaults["cfg"],
                "sampler_img2img": image_defaults["sampler"],
            },
            "live_preview": bool(shared.opts.live_previews_enable),
            "page_size": 48,
            "qwen": _qwen_status_payload(),
        }

    @app.get("/mlite/api/status")
    def mlite_status():
        from modules import progress

        payload = progress.global_status_api()
        job = _qwen_job_snapshot()
        payload["qwen_active"] = _qwen_job_active()
        if payload["qwen_active"]:
            payload["qwen_task_id"] = job.get("task_id")
        return payload

    @app.post("/mlite/api/progress")
    def mlite_progress(payload: dict = Body(default={})):
        from modules import progress

        request = progress.ProgressRequest(
            id_task=str(payload.get("task_id") or ""),
            id_live_preview=_clamp_int(payload.get("id_live_preview", -1), -1, 2 ** 31 - 1, -1),
            live_preview=bool(payload.get("live_preview", True)),
        )
        qwen = _qwen_progress(request.id_task)
        if qwen is not None:
            return qwen
        return progress.progressapi(request)

    @app.post("/mlite/api/interrupt")
    def mlite_interrupt(payload: dict = Body(default={})):
        import modules.shared as shared

        if str(payload.get("action") or "") == "skip":
            shared.state.skip()
            return {"ok": True}

        # the sd-server can cancel queued jobs only (cancel_generating = false)
        job = _qwen_job_snapshot()
        if job.get("phase") in ("preparing", "queued", "generating") and job.get("server_job"):
            try:
                _qwen_http("POST", f"/sdcpp/v1/jobs/{job['server_job']}/cancel", timeout=10.0)
            except Exception:
                pass
            return {"ok": True, "engine": "qwen"}

        shared.state.interrupt()
        return {"ok": True}

    @app.get("/mlite/api/result")
    def mlite_result(id_task: str = ""):
        with _results_lock:
            result = _results.get(str(id_task))
        if result is None:
            return {"status": "unknown"}
        return {"status": "done", **result}

    @app.post("/mlite/api/txt2img")
    def mlite_txt2img(payload: dict = Body(default={})):
        return _run_job(payload, "txt2img")

    @app.post("/mlite/api/img2img")
    def mlite_img2img(payload: dict = Body(default={})):
        if not payload.get("init_image"):
            raise HTTPException(status_code=422, detail="init_image is required")
        return _run_job(payload, "img2img")

    @app.get("/mlite/api/qwen/status")
    def mlite_qwen_status():
        return _qwen_status_payload()

    @app.post("/mlite/api/engine")
    def mlite_engine(payload: dict = Body(default={})):
        engine = str(payload.get("engine") or "").strip().lower()
        if engine == "qwen":
            # free the SDXL model now, load the sd-server in the background
            _qwen_prepare_async()
            return {"ok": True, "engine": "qwen", "qwen": _qwen_status_payload()}
        if engine == "sdxl":
            # give the ~10GB back unless a qwen job is using the server right now
            if not _qwen_job_active():
                _qwen_stop_server()
            return {"ok": True, "engine": "sdxl", "qwen": _qwen_status_payload()}
        raise HTTPException(status_code=422, detail="engine must be 'sdxl' or 'qwen'")

    @app.post("/mlite/api/qwen")
    def mlite_qwen(payload: dict = Body(default={})):
        if not str(payload.get("prompt") or "").strip():
            raise HTTPException(status_code=422, detail="prompt is required")
        return _run_qwen_job(payload)

    @app.get("/mlite/api/gallery")
    def mlite_gallery(
        view: str = "all", q: str = "", page: int = 1, size: int = 48
    ):
        return _gallery_page(view, q, page, size)

    @app.post("/mlite/api/gallery/action")
    def mlite_gallery_action(payload: dict = Body(default={})):
        result = _gallery_action(payload)
        if not result.get("ok"):
            # never report success for a no-op: a key/path mismatch used to look like it worked
            raise HTTPException(status_code=422, detail=result.get("error") or "action failed")
        return result

    @app.get("/mlite/api/suggestions")
    def mlite_suggestions():
        _ensure_db()
        from modules import endorsement_db

        try:
            data = endorsement_db.get_fire_prompt_suggestions(limit_per_key=120)
        except Exception:
            data = {"Prompt": [], "Negative prompt": []}
        return {
            "prompt": data.get("Prompt", []),
            "negative": data.get("Negative prompt", []),
        }

    @app.post("/mlite/api/options")
    def mlite_options(payload: dict = Body(default={})):
        import modules.shared as shared
        from modules import sd_models

        applied = []
        if "mobile_lite_mode" in payload:
            mode = str(payload["mobile_lite_mode"])
            if mode in MODE_CHOICES:
                shared.opts.set("mobile_lite_mode", mode)
                applied.append("mobile_lite_mode")
        if payload.get("sd_model_checkpoint"):
            title = str(payload["sd_model_checkpoint"])
            if title not in sd_models.checkpoint_aliases:
                raise HTTPException(status_code=422, detail=f"model {title!r} not found")
            shared.opts.set("sd_model_checkpoint", title)
            applied.append("sd_model_checkpoint")
        if applied:
            shared.opts.save(shared.config_filename)
        return {"ok": True, "applied": applied, "model": str(shared.opts.sd_model_checkpoint or "")}

    @app.post("/mlite/api/save-image")
    def mlite_save_image(payload: dict = Body(default={})):
        if not payload.get("image"):
            raise HTTPException(status_code=422, detail="image is required")

        image = _decode_image(payload["image"])
        outdir = os.path.join(_WEBUI_ROOT, "outputs", "composition")
        os.makedirs(outdir, exist_ok=True)

        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        outpath = os.path.join(outdir, f"composition-{stamp}.png")
        counter = 1
        while os.path.exists(outpath):
            outpath = os.path.join(outdir, f"composition-{stamp}-{counter}.png")
            counter += 1

        image.save(outpath, format="PNG")
        if payload.get("state"):
            try:
                state_text = json.dumps(payload["state"], ensure_ascii=False)
                with open(os.path.splitext(outpath)[0] + ".composerstate.json", "w", encoding="utf-8") as handle:
                    handle.write(state_text)
            except Exception:
                pass

        return {"path": outpath, "url": _file_url(outpath)}

    # Static files are registered last so the /mlite/api/* routes win.
    @app.get("/mlite/{asset_path:path}")
    async def mlite_static(asset_path: str):
        rel = str(asset_path or "").replace("\\", "/").lstrip("/")
        if not rel or rel.startswith(".") or ".." in rel.split("/"):
            raise HTTPException(status_code=404, detail="not found")
        extension = os.path.splitext(rel)[1].lower()
        if extension not in {".js", ".css", ".svg", ".png", ".webmanifest", ".ico", ".woff2"}:
            raise HTTPException(status_code=404, detail="not found")

        full = os.path.abspath(os.path.join(_STATIC_DIR, rel))
        if not full.startswith(_STATIC_DIR + os.sep) or not os.path.isfile(full):
            raise HTTPException(status_code=404, detail="not found")

        media_types = {
            ".js": "text/javascript; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".svg": "image/svg+xml",
            ".png": "image/png",
            ".webmanifest": "application/manifest+json",
        }
        return FileResponse(
            full,
            media_type=media_types.get(extension, "application/octet-stream"),
            headers=dict(_NO_STORE),
        )
