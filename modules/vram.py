"""Single-GPU VRAM ownership for the engines this fork can run.

Four things can hold device memory at the same time on paper, and none of them
coexist on a 16 GB card:

* the A1111 checkpoint (SDXL / SD1.5) loaded inside the WebUI process,
* the Qwen-Image 2.1 sd-server sidecar (``modules.qwen_image_manager``),
* the Krea 2 sd-server sidecar (``modules.krea2_image_manager``),
* the Anima DiT sd-server sidecar (``modules.backends.sdcpp_server``),
* a diffusers video pipeline (``modules.video_manager``).

Before this module every hand-over was written out by hand at each call site, so
a path that forgot one of them (Video -> SDXL, for instance) left the previous
engine holding VRAM until the next allocation failed.  Here each engine
registers a releaser and a cheap "do you hold VRAM?" probe; ``claim()`` releases
every other holder first.

Everything is best-effort: a failing releaser is reported and skipped, never
propagated, because the caller is about to load a different model anyway.
"""

from __future__ import annotations

import threading
import time

from modules import devices, shared

# Engine ids are shared with the mobile API and the video job runner.
SDXL = "sdxl"
QWEN = "qwen"
KREA2 = "krea2"
ANIMA = "anima"
VIDEO = "video"

OWNER_TITLES = {
    SDXL: "SD checkpoint",
    QWEN: "Qwen-Image 2.1 sidecar",
    KREA2: "Krea 2 sidecar",
    ANIMA: "Anima DiT sidecar",
    VIDEO: "Video engine",
}

_lock = threading.RLock()
_active = SDXL
_last_release = None  # (owner, seconds, reason)
_events = []  # small ring buffer for the Settings/Video status panels


# --------------------------------------------------------------------- probes
def _sd_holds() -> bool:
    # read model_data directly: shared.sd_model is a property that *loads* a
    # checkpoint on demand, and a status probe must never do that
    from modules import sd_models

    model = sd_models.model_data.sd_model
    if model is None:
        return False
    try:
        parameter = next(model.parameters())
    except (StopIteration, AttributeError):
        return False
    return parameter.device.type != "cpu"


def _qwen_holds() -> bool:
    try:
        from modules import qwen_image_manager

        return qwen_image_manager.is_managed()
    except Exception:
        return False


def _krea2_holds() -> bool:
    try:
        from modules import krea2_image_manager

        return krea2_image_manager.is_managed()
    except Exception:
        return False


def _anima_holds() -> bool:
    try:
        from modules.backends import sdcpp_server

        return sdcpp_server.server.is_alive()
    except Exception:
        return False


def _video_holds() -> bool:
    try:
        from modules import video_manager

        return video_manager.loaded_engine() is not None
    except Exception:
        return False


# ------------------------------------------------------------------- releasers
def _release_sd(reason: str) -> None:
    from modules import sd_models

    sd_models.send_model_to_cpu(sd_models.model_data.sd_model)


def _release_qwen(reason: str) -> None:
    from modules import qwen_image_manager

    if qwen_image_manager.is_managed():
        qwen_image_manager.stop_server()


def _release_krea2(reason: str) -> None:
    from modules import krea2_image_manager

    if krea2_image_manager.is_managed():
        krea2_image_manager.stop_server()


def _release_anima(reason: str) -> None:
    from modules.backends import sdcpp_server

    sdcpp_server.server.stop()


def _release_video(reason: str) -> None:
    from modules import video_manager

    video_manager.unload_engine(reason=reason)


_PROBES = {SDXL: _sd_holds, QWEN: _qwen_holds, KREA2: _krea2_holds, ANIMA: _anima_holds, VIDEO: _video_holds}
_RELEASERS = {SDXL: _release_sd, QWEN: _release_qwen, KREA2: _release_krea2, ANIMA: _release_anima, VIDEO: _release_video}


# ----------------------------------------------------------------------- state
def auto_release() -> bool:
    return bool(getattr(shared.opts, "vram_auto_release", True))


def holders() -> dict[str, bool]:
    result = {}
    for owner, probe in _PROBES.items():
        try:
            result[owner] = bool(probe())
        except Exception:
            result[owner] = False
    return result


def active() -> str:
    with _lock:
        return _active


def free_total() -> tuple[int, int]:
    """(free, total) device bytes; (0, 0) when there is no CUDA device."""
    try:
        import torch

        if not torch.cuda.is_available():
            return 0, 0
        return torch.cuda.mem_get_info(devices.get_cuda_device_id())
    except Exception:
        return 0, 0


def status() -> dict:
    free, total = free_total()
    try:
        from modules import video_manager

        video = video_manager.status()
    except Exception:
        video = {}
    return {
        "active": active(),
        "auto_release": auto_release(),
        "holders": holders(),
        "free_mb": round(free / (1024 * 1024)) if free else 0,
        "total_mb": round(total / (1024 * 1024)) if total else 0,
        "last_release": {"owner": _last_release[0], "seconds": round(_last_release[1], 2), "reason": _last_release[2]} if _last_release else None,
        "events": list(_events[-12:]),
        "video": video,
    }


def _note(owner: str, seconds: float, reason: str) -> None:
    global _last_release
    _last_release = (owner, seconds, reason)
    _events.append({"owner": owner, "seconds": round(seconds, 2), "reason": reason, "at": time.time()})
    del _events[:-24]


# --------------------------------------------------------------------- actions
def release(owner: str, reason: str = "") -> bool:
    """Release one engine; True when it was holding something."""
    releaser = _RELEASERS.get(owner)
    if releaser is None:
        return False
    with _lock:
        try:
            holding = bool(_PROBES[owner]())
        except Exception:
            holding = True
        if not holding:
            return False
        started = time.perf_counter()
        try:
            releaser(reason or f"release {owner}")
        except Exception as error:  # a broken releaser must not block a model switch
            print(f"vram: releasing {OWNER_TITLES.get(owner, owner)} failed: {error}")
            return False
        _note(owner, time.perf_counter() - started, reason or f"release {owner}")
    devices.torch_gc()
    return True


def release_all(reason: str = "release all engines", keep: str | None = None) -> list[str]:
    released = []
    for owner in _RELEASERS:
        if owner == keep:
            continue
        if release(owner, reason):
            released.append(owner)
    with _lock:
        global _active
        if keep is None:
            _active = None
        else:
            _active = keep
    return released


def claim(owner: str, reason: str = "") -> list[str]:
    """Make *owner* the only GPU tenant, releasing the others when configured to."""
    global _active
    released: list[str] = []
    with _lock:
        previous = _active
        _active = owner
    if not auto_release():
        return released

    for other in _RELEASERS:
        if other == owner:
            continue
        # Skip engines that are idle even if they were the previous owner: probing is
        # cheap and it keeps externally started sidecars out of our business.
        if release(other, reason or f"switch {previous or 'idle'} -> {owner}"):
            released.append(other)
    if released:
        devices.torch_gc()
    return released


def ensure_sd(reason: str = "switch to an SD checkpoint") -> None:
    """Called before every A1111 job: give the checkpoint its VRAM back."""
    from modules import sd_models

    claim(SDXL, reason=reason)
    sd_models.ensure_model_on_device()
    devices.torch_gc()


def describe() -> str:
    info = status()
    holding = ", ".join(OWNER_TITLES[key] for key, value in info["holders"].items() if value) or "nothing"
    free = f"{info['free_mb'] / 1024:.1f} GB" if info["free_mb"] else "?"
    total = f"{info['total_mb'] / 1024:.1f} GB" if info["total_mb"] else "?"
    return f"Engine: {OWNER_TITLES.get(info['active'], info['active'] or 'none')} | holding VRAM: {holding} | free {free} / {total}"
