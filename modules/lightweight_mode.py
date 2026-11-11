"""Lightweight mode: keep the WebUI free of model memory and refuse generation.

Enabled with Settings -> System -> "Lightweight mode". Turning it on releases every
engine that can hold VRAM or RAM (the SD checkpoint, the Qwen / Krea 2 / Anima
sidecars, the video pipeline, the local LLM and the auxiliary taggers) and drops the
loaded checkpoint instead of parking it on the CPU. While it is on, model loaders
refuse to load and every generation entry point reports ``MESSAGE`` instead of
running inference, so the UI stays explorable on a machine with no GPU budget.
"""

from __future__ import annotations

import gc
import threading

from modules import shared

MESSAGE = (
    "Lightweight mode is on: models are unloaded and generation is disabled. "
    "Turn it off in Settings -> System -> Lightweight mode to generate again."
)

_lock = threading.Lock()
_pending_release = False


class LightweightModeBlocked(RuntimeError):
    """Raised by generation entry points while lightweight mode is on."""


def enabled() -> bool:
    try:
        return bool(getattr(shared.opts, "lightweight_mode", False))
    except Exception:
        return False


def require() -> None:
    if enabled():
        raise LightweightModeBlocked(MESSAGE)


def _release_engines() -> None:
    from modules import vram

    vram.release_all(reason="lightweight mode")

    try:
        from modules import local_llm_manager

        local_llm_manager.stop_server()
    except Exception as error:
        print(f"lightweight mode: stopping the local LLM failed: {error}")


def _unload_checkpoint() -> None:
    from modules import sd_hijack, sd_models, sd_unet, sd_vae

    model = sd_models.model_data.sd_model
    if model is not None:
        if sd_unet.current_unet is not None:
            try:
                sd_unet.apply_unet("None")
            except Exception as error:
                print(f"lightweight mode: deactivating the SD unet failed: {error}")

        try:
            sd_hijack.model_hijack.undo_hijack(model)
        except Exception as error:
            print(f"lightweight mode: undoing the model hijack failed: {error}")

        try:
            sd_models.send_model_to_cpu(model)
        except Exception as error:
            print(f"lightweight mode: dropping the checkpoint from the GPU failed: {error}")

    sd_models.model_data.sd_model = None
    sd_models.model_data.loaded_sd_models.clear()
    sd_models.model_data.was_loaded_at_least_once = False

    sd_vae.checkpoints_loaded.clear()
    sd_vae.base_vae = None
    sd_vae.clear_loaded_vae()


def _unload_aux_models() -> None:
    shared.loaded_hypernetworks.clear()

    try:
        from modules import sd_hijack

        sd_hijack.model_hijack.embedding_db.word_embeddings.clear()
    except Exception as error:
        print(f"lightweight mode: dropping the textual inversion embeddings failed: {error}")

    for restorer in shared.face_restorers:
        try:
            restorer.net = None
        except Exception:
            pass

    try:
        from modules import deepbooru

        if deepbooru.model is not None:
            deepbooru.model.model = None
    except Exception as error:
        print(f"lightweight mode: dropping the deepbooru model failed: {error}")

    if shared.interrogator is not None:
        try:
            shared.interrogator.unload()
        except Exception:
            pass
        shared.interrogator.clip_model = None
        shared.interrogator.blip_model = None
        shared.interrogator.clip_preprocess = None


def _release() -> None:
    from modules import devices

    for step in (_release_engines, _unload_checkpoint, _unload_aux_models):
        try:
            step()
        except Exception as error:
            print(f"lightweight mode: release failed: {error}")

    try:
        gc.collect()
        devices.torch_gc()
    except Exception as error:
        print(f"lightweight mode: freeing torch memory failed: {error}")


def _busy() -> bool:
    try:
        return bool(getattr(shared.state, "job_count", 0))
    except Exception:
        return False


def activate() -> None:
    """Unload everything now, or once the running job finishes."""
    global _pending_release

    if not enabled():
        return

    with _lock:
        if _busy():
            _pending_release = True
            print("lightweight mode: a job is running; models are unloaded when it finishes")
            return
        _pending_release = False
        _release()

    print("lightweight mode: models unloaded, generation disabled")


def deactivate() -> None:
    """Let the next model access load a checkpoint again."""
    global _pending_release

    with _lock:
        _pending_release = False

    from modules import sd_models

    sd_models.model_data.was_loaded_at_least_once = False


def release_if_pending() -> None:
    """Called when a GPU job finishes so a deferred activation can unload."""
    global _pending_release

    with _lock:
        if not _pending_release or not enabled():
            _pending_release = False
            return
        _pending_release = False
        _release()

    print("lightweight mode: models unloaded, generation disabled")


def sync() -> None:
    """Settings onchange target: apply the option value that was just stored."""
    if enabled():
        activate()
    else:
        deactivate()
