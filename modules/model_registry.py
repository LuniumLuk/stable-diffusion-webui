"""Registry of non-SD (DiT) checkpoints served by the fork's sidecar backends.

DiT models live outside the A1111 checkpoint loader. Today the only family is
Anima (Nova Anime AM and friends), whose files follow the stable-diffusion.cpp
category layout:

    models/Anima/diffusion_models/<model>.safetensors|gguf
    models/Anima/text_encoders/<qwen3>.safetensors|gguf
    models/Anima/vae/<qwen-image-vae>.safetensors

The text-adapter width decides whether stable-diffusion.cpp can load a file: the
Anima 2B line uses a 1024-wide adapter, the 2.9B expansion uses 2048 and is
rejected by the server, so those files are labelled as unsupported instead of
silently failing at generation time.
"""

from __future__ import annotations

import json
import os
import struct
from dataclasses import dataclass

from modules.paths_internal import models_path

ANIMA_DIR = os.path.join(models_path, "Anima")
SUBDIRS = {
    "models": "diffusion_models",
    "text_encoders": "text_encoders",
    "vae": "vae",
}
MODEL_EXTS = (".safetensors", ".gguf", ".ckpt")
TITLE_PREFIX = "[Anima] "
UNSUPPORTED_VARIANTS = {"2.9b": "Anima 2.9B is not supported by stable-diffusion.cpp yet"}

_cache: dict[str, tuple[float, list[str]]] = {}
_variant_cache: dict[tuple[str, int, int], str | None] = {}


@dataclass(frozen=True)
class DitModel:
    path: str
    title: str
    family: str = "anima"
    variant: str | None = None

    @property
    def name(self) -> str:
        """Model name without the list-title decoration (used in infotext)."""
        return self.title[len(TITLE_PREFIX):] if self.title.startswith(TITLE_PREFIX) else self.title

    @property
    def unsupported_reason(self) -> str | None:
        return UNSUPPORTED_VARIANTS.get(self.variant or "")

    @property
    def label(self) -> str:
        """Dropdown label; unsupported files carry a short marker inline."""
        if self.unsupported_reason:
            return f"{self.title} (unsupported: {self.variant.upper()})"
        return self.title

    @property
    def exists(self) -> bool:
        return os.path.isfile(self.path)


# --------------------------------------------------------------------- file scan
def _folder(kind: str) -> str:
    return os.path.join(ANIMA_DIR, SUBDIRS[kind])


def _list_files(kind: str) -> list[str]:
    folder = _folder(kind)
    try:
        mtime = os.path.getmtime(folder)
    except OSError:
        return []

    cached = _cache.get(kind)
    if cached and cached[0] == mtime:
        return list(cached[1])

    try:
        names = sorted(
            name
            for name in os.listdir(folder)
            if name.lower().endswith(MODEL_EXTS) and os.path.isfile(os.path.join(folder, name))
        )
    except OSError:
        names = []

    _cache[kind] = (mtime, names)
    return list(names)


def invalidate_cache() -> None:
    _cache.clear()
    _variant_cache.clear()


# --------------------------------------------------------------- variant detection
def _safetensors_shapes(path: str) -> dict[str, list[int]]:
    with open(path, "rb") as handle:
        header_size = struct.unpack("<Q", handle.read(8))[0]
        if header_size > 200 * 1024 * 1024:
            return {}
        header = json.loads(handle.read(header_size).decode("utf-8", "replace"))

    return {
        name: info.get("shape") or []
        for name, info in header.items()
        if isinstance(info, dict) and "shape" in info
    }


def _gguf_shapes(path: str) -> dict[str, list[int]]:
    """Read the tensor table of a GGUF file (metadata section is skipped)."""
    value_sizes = {0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8}

    with open(path, "rb") as handle:
        if handle.read(4) != b"GGUF":
            return {}
        struct.unpack("<I", handle.read(4))  # version
        tensor_count = struct.unpack("<Q", handle.read(8))[0]
        kv_count = struct.unpack("<Q", handle.read(8))[0]

        def read_string() -> bytes:
            length = struct.unpack("<Q", handle.read(8))[0]
            return handle.read(length)

        def skip_value(value_type: int) -> None:
            if value_type == 8:
                read_string()
            elif value_type == 9:
                item_type = struct.unpack("<I", handle.read(4))[0]
                count = struct.unpack("<Q", handle.read(8))[0]
                for _ in range(count):
                    skip_value(item_type)
            else:
                handle.seek(value_sizes.get(value_type, 4), os.SEEK_CUR)

        for _ in range(kv_count):
            read_string()
            skip_value(struct.unpack("<I", handle.read(4))[0])

        shapes = {}
        for _ in range(tensor_count):
            name = read_string().decode("utf-8", "replace")
            dims = struct.unpack("<I", handle.read(4))[0]
            shapes[name] = list(struct.unpack("<" + "Q" * dims, handle.read(8 * dims)))
            handle.seek(12, os.SEEK_CUR)  # type + offset

    return shapes


def _adapter_width(shapes: dict[str, list[int]]) -> int | None:
    for name, shape in shapes.items():
        if "llm_adapter" in name and name.endswith("self_attn.k_proj.weight"):
            return max(shape) if shape else None
    return None


def detect_variant(path: str) -> str | None:
    """'2b', '2.9b' or None when the architecture cannot be read."""
    try:
        stat = os.stat(path)
    except OSError:
        return None

    key = (path, stat.st_size, int(stat.st_mtime))
    if key in _variant_cache:
        return _variant_cache[key]

    variant = None
    try:
        shapes = _gguf_shapes(path) if path.lower().endswith(".gguf") else _safetensors_shapes(path)
        width = _adapter_width(shapes)
        if width is not None:
            variant = "2.9b" if width >= 2048 else "2b"
    except Exception:
        variant = None

    _variant_cache[key] = variant
    return variant


# ------------------------------------------------------------------------ public
def list_text_encoders() -> list[str]:
    return _list_files("text_encoders")


def list_vaes() -> list[str]:
    return _list_files("vae")


def list_models() -> list[DitModel]:
    models = []
    for name in _list_files("models"):
        path = os.path.join(_folder("models"), name)
        models.append(
            DitModel(
                path=path,
                title=TITLE_PREFIX + os.path.splitext(name)[0],
                variant=detect_variant(path),
            )
        )
    return models


def checkpoint_tiles() -> list[str]:
    return [model.label for model in list_models()]


def is_dit_title(value) -> bool:
    return isinstance(value, str) and value.startswith(TITLE_PREFIX)


def resolve_title(value) -> DitModel | None:
    """Match a dropdown label, API value or bare file name to a DiT model."""
    if not isinstance(value, str) or not value:
        return None

    models = list_models()
    if not models:
        return None

    for model in models:
        if value in (model.label, model.title):
            return model

    bare = value[len(TITLE_PREFIX):] if is_dit_title(value) else value
    bare = bare.strip()
    matches = [
        model
        for model in models
        if model.name == bare
        or os.path.splitext(os.path.basename(model.path))[0] == bare
        or bare.startswith(model.name)
    ]
    if len(matches) == 1:
        return matches[0]
    return None


def resolve_component(kind: str, value) -> str | None:
    """Resolve a text encoder / VAE setting to an absolute path."""
    names = _list_files(kind)
    if not names:
        return None
    if not value:
        return os.path.join(_folder(kind), names[0])
    for name in names:
        if name == value:
            return os.path.join(_folder(kind), name)
    if os.path.isabs(value) and os.path.isfile(value):
        return value
    return os.path.join(_folder(kind), names[0])


def missing_components() -> list[str]:
    missing = []
    if not _list_files("models"):
        missing.append(_folder("models"))
    if not _list_files("text_encoders"):
        missing.append(_folder("text_encoders"))
    if not _list_files("vae"):
        missing.append(_folder("vae"))
    return missing
