"""DiT backends: models that cannot be loaded by A1111's Stable Diffusion pipeline.

processing.process_images() calls resolve() once per job; a non-None result means
the job belongs to a sidecar backend and the SD code path must be skipped.
"""

from __future__ import annotations

from modules import model_registry, shared

_FAMILIES = {
    "anima": ("modules.backends.runner", "process_images_via_anima"),
}


def selected_title(p):
    """Checkpoint the job asked for: API override first, then the UI setting."""
    override = (p.override_settings or {}).get("sd_model_checkpoint")
    if override:
        return override
    return getattr(shared.opts, "sd_model_checkpoint", None)


def resolve(p) -> model_registry.DitModel | None:
    """Return the DiT model this job targets, or None for the normal SD path."""
    if not getattr(shared.opts, "anima_enabled", True):
        return None

    model = model_registry.resolve_title(selected_title(p))
    if model is None or not model.exists:
        return None
    return model


def is_dit_job(p) -> bool:
    """True when the job targets a DiT backend (used to skip SD-only extensions)."""
    return resolve(p) is not None


def run(p, model: model_registry.DitModel):
    entry = _FAMILIES.get(model.family)
    if entry is None:
        raise RuntimeError(f"No backend registered for model family {model.family!r}")

    module_name, function_name = entry
    module = __import__(module_name, fromlist=[function_name])
    return getattr(module, function_name)(p, model)
