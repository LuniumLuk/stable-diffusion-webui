"""Bandwidth-friendly image serving for non-LAN clients.

Gradio's ``/file=`` endpoint (and the extra-networks thumbnail endpoint) hand
out the raw file exactly as stored on disk.  Generation outputs are usually
multi-megabyte PNGs, so a phone connecting over a remote/tunneled link streams
full-resolution, original-format data for every gallery thumbnail, lightbox
preview and card preview.

This module adds an opt-in policy layer on top:

* ``BandwidthMiddleware`` answers GET/HEAD ``/file=...`` image requests with an
  on-the-fly downscaled WebP (or JPEG) variant when the client is not on the
  local network (or when the policy is set to *Always*),
* the same helper is reused by ``modules/ui_extra_networks.py`` so checkpoint /
  LoRA / embedding card previews are downscaled too,
* ``GET /sd_net/image?path=...&px=...&q=...`` always optimizes on request, and
  ``?px=``/``?q=``/``?orig=1`` query parameters can be appended to any
  ``/file=`` URL to force or disable optimization for that single request.

Variants are cached under ``cache/net_cache`` and keyed by source path + mtime,
so repeated requests are served from disk without re-encoding.

Safety: only same-origin browser image loads are touched (``Sec-Fetch-Dest:
image`` / an ``Accept`` header that explicitly asks for images), only files
inside the webui directory are optimized, and any error falls back to the
original file.  Programmatic ``fetch()`` calls (Accept ``*/*``) keep receiving
the original bytes, which is what the JS upload/copy flows rely on.
"""

from __future__ import annotations

import hashlib
import ipaddress
import os
import threading
import time
from urllib.parse import parse_qs

_WEBUI_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_CACHE_DIR = os.path.join(_WEBUI_ROOT, "cache", "net_cache")

# gif is intentionally absent: animated files must not be flattened.
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}

MODE_OFF = "Off"
MODE_AUTO = "Auto (non-LAN only)"
MODE_ALWAYS = "Always"

_DEFAULTS = {
    "mode": MODE_AUTO,
    "max_px": 2048,
    "quality": 78,
    "min_kb": 96,
    "card_px": 512,
    "local_ips": "",
    "remote_ips": "",
}

_CLEANUP_INTERVAL = 600.0
_CACHE_MAX_FILES = 2000
_CACHE_KEEP_FILES = 1500

_locks_guard = threading.Lock()
_locks: dict[str, threading.Lock] = {}
_last_cleanup = 0.0


# --------------------------------------------------------------------------- settings


def _load_settings() -> dict:
    """Read the live options, falling back to defaults when shared isn't available."""
    settings = dict(_DEFAULTS)

    def _get(name, fallback):
        try:
            from modules import shared

            return getattr(shared.opts, name, fallback)
        except Exception:
            return fallback

    def _int(name, fallback):
        try:
            return int(_get(name, fallback))
        except Exception:
            return fallback

    settings["mode"] = str(_get("remote_img_opt_mode", _DEFAULTS["mode"]) or _DEFAULTS["mode"])
    settings["max_px"] = _int("remote_img_opt_max_px", _DEFAULTS["max_px"])
    settings["quality"] = _int("remote_img_opt_quality", _DEFAULTS["quality"])
    settings["min_kb"] = _int("remote_img_opt_min_kb", _DEFAULTS["min_kb"])
    settings["card_px"] = _int("remote_img_opt_card_px", _DEFAULTS["card_px"])
    settings["local_ips"] = str(_get("remote_img_opt_local_ips", _DEFAULTS["local_ips"]) or "")
    settings["remote_ips"] = str(_get("remote_img_opt_remote_ips", _DEFAULTS["remote_ips"]) or "")
    return settings


def optimization_mode() -> str:
    mode = _load_settings()["mode"]
    if mode not in (MODE_OFF, MODE_AUTO, MODE_ALWAYS):
        return MODE_AUTO
    return mode


# --------------------------------------------------------------------------- client ip


def _normalize_ip(ip: str):
    try:
        addr = ipaddress.ip_address(str(ip).strip())
    except ValueError:
        return None
    if addr.version == 6:
        mapped = getattr(addr, "ipv4_mapped", None)
        if mapped is not None:
            return mapped
    return addr


def _parse_networks(text: str) -> list:
    networks = []
    for chunk in str(text or "").replace(";", ",").split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        try:
            networks.append(ipaddress.ip_network(chunk, strict=False))
        except ValueError:
            continue
    return networks


def _networks_contain(networks, addr) -> bool:
    for net in networks:
        try:
            if addr.version == net.version and addr in net:
                return True
        except Exception:
            continue
    return False


def client_is_remote(ip) -> bool:
    """Return True when the client address is not on the local machine/LAN."""
    if not ip:
        return False

    addr = _normalize_ip(ip)
    if addr is None:
        return False

    settings = _load_settings()
    if _networks_contain(_parse_networks(settings.get("remote_ips")), addr):
        return True
    if _networks_contain(_parse_networks(settings.get("local_ips")), addr):
        return False

    if addr.is_loopback or addr.is_link_local:
        return False
    # RFC1918 / ULA
    if addr.is_private:
        return False
    return True


def request_client_ip(headers, client) -> str:
    """Mirror the access gateway logic: prefer tunnel/proxy forwarded addresses."""
    for name in ("cf-connecting-ip", "x-real-ip", "x-forwarded-for"):
        value = ""
        try:
            value = (headers.get(name, "") or "").strip()
        except Exception:
            value = ""
        if value:
            first = value.split(",", 1)[0].strip()
            if first:
                return first

    try:
        if client and getattr(client, "host", None):
            return str(client.host)
    except Exception:
        pass
    return ""


def _host_is_local(host_header: str) -> bool:
    host = (host_header or "").strip().lower()
    if not host:
        return True
    if host.startswith("["):
        name = host[1 : host.find("]")] if "]" in host else host
    else:
        name = host.split(":")[0]
    if name in ("localhost", "localhost.localdomain"):
        return True
    addr = _normalize_ip(name)
    if addr is None:
        return False
    return bool(addr.is_loopback or addr.is_private or addr.is_link_local)


def request_is_remote(request) -> bool:
    """True when the request should be treated as a non-LAN (slow) client."""
    headers = getattr(request, "headers", {}) or {}
    ip = request_client_ip(headers, getattr(request, "client", None))
    if client_is_remote(ip):
        return True

    addr = _normalize_ip(ip)
    if addr is not None and addr.is_loopback:
        try:
            host = headers.get("host", "") or ""
        except Exception:
            host = ""
        # Loopback client + non-local Host header: the request came through a
        # local tunnel (frp, cloudflared, ...) that hides the real client IP.
        if host and not _host_is_local(host):
            return True
    return False


# --------------------------------------------------------------------------- variants


def ensure_cache_dir() -> str:
    os.makedirs(_CACHE_DIR, exist_ok=True)
    return _CACHE_DIR


def _cache_key(src: str, mtime: float, max_px: int, quality: int, fmt: str) -> str:
    raw = f"{os.path.normcase(os.path.abspath(src))}|{mtime:.6f}|{max_px}|{quality}|{fmt}"
    return hashlib.sha1(raw.encode("utf-8", errors="ignore")).hexdigest()


def _lock_for(key: str) -> threading.Lock:
    with _locks_guard:
        lock = _locks.get(key)
        if lock is None:
            lock = _locks[key] = threading.Lock()
        return lock


def cleanup_cache(keep: int = _CACHE_KEEP_FILES) -> None:
    """Trim the variant cache. Cheap enough to run inline every few minutes."""
    global _last_cleanup
    now = time.time()
    if now - _last_cleanup < _CLEANUP_INTERVAL:
        return
    _last_cleanup = now

    try:
        entries = []
        for name in os.listdir(_CACHE_DIR):
            path = os.path.join(_CACHE_DIR, name)
            try:
                st = os.stat(path)
            except OSError:
                continue
            if name.startswith(".") or ".tmp" in name:
                if now - st.st_mtime > 3600:
                    try:
                        os.remove(path)
                    except OSError:
                        pass
                continue
            entries.append((st.st_mtime, path))

        if len(entries) <= keep:
            return
        entries.sort()
        for _, path in entries[: len(entries) - keep]:
            try:
                os.remove(path)
            except OSError:
                pass
    except OSError:
        pass


def _save_variant(im, dest: str, fmt: str, quality: int) -> bool:
    from PIL import Image

    tmp = f"{dest}.tmp{os.getpid()}_{threading.get_ident()}"
    try:
        if fmt == "webp":
            im.save(tmp, format="WEBP", quality=quality, method=4)
        else:
            if im.mode in ("RGBA", "LA", "P"):
                rgba = im.convert("RGBA")
                background = Image.new("RGB", rgba.size, (255, 255, 255))
                background.paste(rgba, mask=rgba.getchannel("A"))
                im = background
            elif im.mode not in ("RGB", "L"):
                im = im.convert("RGB")
            im.save(tmp, format="JPEG", quality=quality, optimize=True, progressive=True)
        os.replace(tmp, dest)
        return True
    except Exception:
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except OSError:
            pass
        return False


def create_variant(src: str, max_px: int, quality: int, fmt: str):
    """Build (or reuse) an optimized variant of ``src``.

    Returns the path to serve: the cached variant, or ``src`` itself when no
    smaller variant could be produced.  ``None`` means "leave the original
    request alone" (non-image / animated / unreadable file).
    """
    ext = os.path.splitext(src)[1].lower()
    if ext not in IMAGE_EXTS:
        return None

    try:
        st = os.stat(src)
    except OSError:
        return None

    if max_px is None or max_px < 0:
        max_px = 0
    quality = max(20, min(95, int(quality or _DEFAULTS["quality"])))
    fmt = "jpeg" if fmt == "jpeg" else "webp"

    ensure_cache_dir()
    key = _cache_key(src, st.st_mtime, max_px, quality, fmt)
    dest = os.path.join(_CACHE_DIR, f"{key}.{'webp' if fmt == 'webp' else 'jpg'}")

    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        return dest

    cleanup_cache()

    from PIL import Image, ImageOps

    lock = _lock_for(key)
    with lock:
        if os.path.exists(dest) and os.path.getsize(dest) > 0:
            return dest
        try:
            with Image.open(src) as im:
                if getattr(im, "n_frames", 1) > 1:
                    return None
                if im.format == "JPEG" and max_px:
                    try:
                        im.draft("RGB", (max_px, max_px))
                    except Exception:
                        pass
                im = ImageOps.exif_transpose(im)
                width, height = im.size
                if width <= 0 or height <= 0:
                    return None

                if max_px and max(width, height) > max_px:
                    ratio = max_px / float(max(width, height))
                    target = (max(1, int(round(width * ratio))), max(1, int(round(height * ratio))))
                    im = im.resize(target, Image.Resampling.LANCZOS)

                if not _save_variant(im, dest, fmt, quality):
                    return None
        except Image.DecompressionBombError:
            return None
        except Exception:
            return None

    try:
        if not os.path.exists(dest):
            return None
        if os.path.getsize(dest) >= os.path.getsize(src):
            # Never serve something larger than the original (e.g. sources that
            # are already heavily compressed) - the original is the faster one.
            return src
    except OSError:
        return None
    return dest


# --------------------------------------------------------------------------- policy


def pick_format(accept: str) -> str:
    """Choose an output format the client accepts (webp preferred)."""
    accept = (accept or "").lower()
    if "image/webp" in accept:
        return "webp"
    if "image/jpeg" in accept or "image/*" in accept:
        return "jpeg"
    return "webp"


def file_is_optimizable(path: str) -> bool:
    if not path:
        return False
    try:
        if any(part.startswith(".") for part in os.path.abspath(path).split(os.sep)):
            return False
    except Exception:
        return False
    if os.path.splitext(path)[1].lower() not in IMAGE_EXTS:
        return False
    return os.path.isfile(path)


def path_in_webui_root(path: str) -> bool:
    try:
        return os.path.commonpath([os.path.abspath(path), _WEBUI_ROOT]) == _WEBUI_ROOT
    except Exception:
        return False


def serve_variant(request, src: str, *, max_px=None, quality=None, fmt=None, explicit=False, kind: str = "default"):
    """Return a downscaled/re-encoded Response for ``src``, or None to leave it alone.

    ``kind="card"`` uses the (smaller) extra-networks card size limit.
    """
    settings = _load_settings()
    if settings["mode"] == MODE_OFF:
        return None

    if not explicit:
        if settings["mode"] != MODE_ALWAYS:
            if not request_is_remote(request):
                return None

    headers = getattr(request, "headers", {})
    accept = headers.get("accept", "") if headers else ""

    if fmt is None:
        fmt = pick_format(accept)
    if max_px is None:
        max_px = settings["card_px"] if kind == "card" else settings["max_px"]
    if quality is None:
        quality = settings["quality"]

    if not explicit:
        try:
            if os.path.getsize(src) < max(0, settings["min_kb"]) * 1024:
                return None
        except OSError:
            return None

    variant = create_variant(src, max_px, quality, fmt)
    if not variant or os.path.abspath(variant) == os.path.abspath(src):
        return None

    from starlette.responses import FileResponse

    media_type = "image/webp" if fmt == "webp" else "image/jpeg"
    return FileResponse(
        variant,
        media_type=media_type,
        headers={
            "Cache-Control": "private, max-age=3600",
            "Vary": "Accept",
            # already-compressed bytes: skip the global GZipMiddleware
            "Content-Encoding": "identity",
            "X-Bandwidth-Optimized": "1",
        },
    )


# --------------------------------------------------------------------------- middleware


class BandwidthMiddleware:
    """ASGI middleware: serve optimized variants for ``/file=`` image requests."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http" or scope.get("method") not in ("GET", "HEAD"):
            await self.app(scope, receive, send)
            return

        try:
            served = await self._maybe_serve(scope, receive, send)
        except Exception:
            served = False
        if not served:
            await self.app(scope, receive, send)

    async def _maybe_serve(self, scope, receive, send) -> bool:
        path = scope.get("path") or ""
        if not (path.startswith("/file=") or path.startswith("/file/")):
            return False

        target = path[6:].split("?", 1)[0]
        if not target:
            return False

        query = parse_qs((scope.get("query_string") or b"").decode("latin-1", errors="ignore"))
        if _truthy(query.get("orig")) or _zero(query.get("px")):
            return False

        headers = _Headers(scope.get("headers") or [])
        if headers.get("range"):
            return False

        explicit = "px" in query or "q" in query or "fmt" in query
        if not explicit:
            dest = (headers.get("sec-fetch-dest") or "").strip().lower()
            accept = (headers.get("accept") or "").lower()
            if dest and dest not in ("image", "empty"):
                return False
            if not dest and "image/" not in accept:
                return False
            # CSS background images arrive as sec-fetch-dest=empty; only treat
            # them as images when the extension says so (checked below).
            if dest == "empty" and "image/" not in accept:
                return False

        target_path = os.path.abspath(target)
        if not file_is_optimizable(target_path) or not path_in_webui_root(target_path):
            return False

        from starlette.requests import Request

        request = Request(scope, receive)
        max_px = _int_or_none(query.get("px"))
        quality = _int_or_none(query.get("q"))
        fmt = (query.get("fmt") or [None])[0]

        response = await _run_sync(
            serve_variant,
            request,
            target_path,
            max_px=max_px,
            quality=quality,
            fmt=fmt,
            explicit=explicit,
        )
        if response is None:
            return False

        await response(scope, receive, send)
        return True


class _Headers:
    """Tiny case-insensitive header view for raw ASGI scopes."""

    def __init__(self, raw_pairs):
        self._values = {}
        for key, value in raw_pairs:
            try:
                self._values[key.decode("latin-1").lower()] = value.decode("latin-1")
            except Exception:
                continue

    def get(self, name, default=""):
        return self._values.get(name.lower(), default)


def _truthy(values) -> bool:
    if not values:
        return False
    return str(values[0]).strip().lower() in ("1", "true", "yes", "on")


def _zero(values) -> bool:
    if not values:
        return False
    try:
        return int(values[0]) == 0
    except (TypeError, ValueError):
        return False


def _int_or_none(values):
    if not values:
        return None
    try:
        return int(values[0])
    except (TypeError, ValueError):
        return None


async def _run_sync(func, *args, **kwargs):
    import asyncio

    return await asyncio.to_thread(func, *args, **kwargs)


class NoCacheHtmlMiddleware:
    """ASGI middleware: never let the browser reuse the UI shell from its cache.

    gradio stamps ``style.css`` / ``javascript/*.js`` with an ``?<mtime>`` query, but those
    stamps live inside the index HTML. A phone that holds a cached copy of the page keeps
    requesting the old asset URLs, so CSS/JS changes look like they never landed ("the fix
    did nothing") until the user manually clears the cache. HTML is cheap to re-render, so
    it is served with ``no-store``; hashed/static assets keep their normal caching.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        async def send_wrapper(message):
            if message.get("type") == "http.response.start":
                headers = message.setdefault("headers", [])
                ctype = b""
                for key, value in headers:
                    if key.lower() == b"content-type":
                        ctype = value.lower()
                        break
                if ctype.startswith(b"text/html"):
                    headers[:] = [(k, v) for (k, v) in headers if k.lower() not in (b"cache-control", b"pragma", b"expires")]
                    headers.append((b"cache-control", b"no-store, must-revalidate"))
                    headers.append((b"pragma", b"no-cache"))
            await send(message)

        await self.app(scope, receive, send_wrapper)


def build_middleware():
    """Return starlette middleware entries to pass via ``app_kwargs``."""
    from starlette.middleware import Middleware

    return [Middleware(BandwidthMiddleware), Middleware(NoCacheHtmlMiddleware)]


# --------------------------------------------------------------------------- explicit route


def register_routes(app):
    """Explicit endpoint for the frontend/gallery: always optimizes."""

    from fastapi import HTTPException
    from starlette.responses import FileResponse

    @app.get("/sd_net/image")
    async def sd_net_image(path: str, px: int = 0, q: int = 0, fmt: str = ""):
        settings = _load_settings()
        if settings["mode"] == MODE_OFF:
            raise HTTPException(status_code=409, detail="Image optimization is disabled")
        if not file_is_optimizable(path) or not path_in_webui_root(path):
            raise HTTPException(status_code=404, detail="Not an optimizable image")

        max_px = px if px and px > 0 else settings["max_px"]
        quality = q if q and q > 0 else settings["quality"]
        fmt = fmt if fmt in ("webp", "jpeg") else "webp"

        variant = await _run_sync(create_variant, os.path.abspath(path), max_px, quality, fmt)
        if not variant:
            raise HTTPException(status_code=404, detail="Not an optimizable image")

        media_type = "image/webp" if fmt == "webp" else "image/jpeg"
        return FileResponse(
            variant,
            media_type=media_type,
            headers={"Cache-Control": "private, max-age=3600", "Content-Encoding": "identity"},
        )
