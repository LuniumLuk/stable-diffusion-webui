"""Fill in LoRA thumbnails that were never generated.

The 2026-10-18 backfill gave every LoRA the first image of its training dataset, but it
was a one-off script in ``tmp/`` - LoRAs trained afterwards (or copied in later) render
as blank cards.  This module keeps the same mapping and runs lazily from the Lora
extra-networks page, so a card whose preview would be empty gets one on the spot.

Mapping uses the kohya metadata a LoRA carries: ``ss_output_name`` names the training
set and ``ss_dataset_dirs`` lists the dataset folders.  Resolution order:

1. ``data/train_data/<output>/<dataset dir>`` (exact folder, then best name match)
2. any subfolder of ``data/train_data/<output>``, then the folder itself
3. ``training_data/lora_<output>`` / ``training_data/<output>``
4. any dataset folder whose name contains the output name, then any dataset folder
"""

from __future__ import annotations

import json
import os
import threading

from PIL import Image

from modules import paths

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}
LORA_EXTENSIONS = {".safetensors", ".pt", ".ckpt"}
PREVIEW_SIZE = 640

_lock = threading.Lock()
_attempted: dict[tuple[str, float], str | None] = {}


def preview_path(lora_path: str) -> str:
    return os.path.splitext(lora_path)[0] + ".preview.png"


def reset_attempts() -> None:
    """Forget negative lookups so a manual page refresh retries them."""
    with _lock:
        _attempted.clear()


def training_roots() -> list[str]:
    """Primary ``data/train_data`` first, then the legacy ``training_data`` folders."""
    ordered: list[str] = []
    for base in (paths.data_path, paths.script_path):
        for name in (os.path.join("data", "train_data"), "training_data"):
            path = os.path.join(base, name)
            if path not in ordered:
                ordered.append(path)
    return ordered


def _first_image(folder: str) -> str | None:
    best = None
    best_key = None
    for dirpath, _dirnames, filenames in os.walk(folder):
        for name in filenames:
            if os.path.splitext(name)[1].lower() not in IMAGE_EXTENSIONS:
                continue
            file = os.path.join(dirpath, name)
            key = os.path.relpath(file, folder).lower()
            if best_key is None or key < best_key:
                best, best_key = file, key
    return best


def _has_images(folder: str) -> bool:
    return _first_image(folder) is not None


def _global_dataset_dirs() -> dict[str, list[str]]:
    result: dict[str, list[str]] = {}
    for root in training_roots():
        if not os.path.isdir(root):
            continue
        for top in sorted(os.listdir(root), key=str.lower):
            top_path = os.path.join(root, top)
            if not os.path.isdir(top_path):
                continue
            for sub in sorted(os.listdir(top_path), key=str.lower):
                sub_path = os.path.join(top_path, sub)
                if os.path.isdir(sub_path):
                    result.setdefault(sub.lower(), []).append(sub_path)
    return result


def metadata_dataset_dirs(metadata) -> list[str]:
    raw = (metadata or {}).get("ss_dataset_dirs")
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            raw = None
    return list(raw.keys()) if isinstance(raw, dict) else []


def choose_dataset_dir(output: str, dataset_dirs: list[str]) -> str | None:
    root = training_roots()[0]
    top = os.path.join(root, output)
    if os.path.isdir(top):
        exact = [(os.path.join(top, name), name) for name in dataset_dirs if os.path.isdir(os.path.join(top, name))]
        if exact:
            for path, name in exact:
                if output.lower() in name.lower():
                    return path
            return exact[0][0]
        subfolders = [os.path.join(top, name) for name in os.listdir(top) if os.path.isdir(os.path.join(top, name))]
        if subfolders:
            return sorted(subfolders, key=str.lower)[0]
        if _has_images(top):
            return top

    for folder_root in training_roots()[1:]:
        for name in (f"lora_{output}", output):
            candidate = os.path.join(folder_root, name)
            if os.path.isdir(candidate) and _has_images(candidate):
                return candidate

    known = _global_dataset_dirs()
    for name in dataset_dirs:
        if output.lower() in name.lower():
            candidates = known.get(name.lower(), [])
            if candidates:
                return candidates[0]
    for name in dataset_dirs:
        candidates = known.get(name.lower(), [])
        if candidates:
            return candidates[0]
    return None


def _create_preview(lora_path: str, metadata) -> str | None:
    target = preview_path(lora_path)
    if os.path.isfile(target):
        return target

    output = str((metadata or {}).get("ss_output_name") or os.path.splitext(os.path.basename(lora_path))[0])
    dataset = choose_dataset_dir(output, metadata_dataset_dirs(metadata))
    if not dataset:
        return None

    source = _first_image(dataset)
    if not source:
        return None

    image = Image.open(source)
    image.load()
    image = image.convert("RGB")
    image.thumbnail((PREVIEW_SIZE, PREVIEW_SIZE), Image.LANCZOS)
    temp_target = target + ".tmp"
    image.save(temp_target, format="PNG", optimize=True)
    os.replace(temp_target, target)
    print(f"lora preview: {os.path.basename(lora_path)} <- {source}")
    return target


def ensure_preview(lora_path: str, metadata=None) -> str | None:
    """Create ``<lora>.preview.png`` when the LoRA has none; returns the path or None.

    Only a missing training dataset makes this return None, and that answer is cached
    per (file, mtime) so a card without any usable data does not rescan on every refresh.
    """
    target = preview_path(lora_path)
    if os.path.isfile(target):
        return target

    try:
        key = (os.path.abspath(lora_path).lower(), os.path.getmtime(lora_path))
    except OSError:
        return None

    with _lock:
        if key in _attempted:
            return _attempted[key]

        created = None
        try:
            created = _create_preview(lora_path, metadata)
        except Exception as error:
            print(f"lora preview: {os.path.basename(lora_path)} failed: {error}")
        _attempted[key] = created
        return created


def read_metadata(filename: str) -> dict:
    """Read the safetensors ``__metadata__`` header without importing torch."""
    try:
        with open(filename, "rb") as file:
            header_len = int.from_bytes(file.read(8), "little")
            if header_len <= 2:
                return {}
            header = file.read(header_len)
        data = json.loads(header.decode("utf8"))
        metadata = dict(data.get("__metadata__") or {})
        for key, value in list(metadata.items()):
            if isinstance(value, str) and value.startswith("{"):
                try:
                    metadata[key] = json.loads(value)
                except ValueError:
                    pass
        return metadata
    except Exception:
        return {}


def _iter_lora_files(folder: str):
    for dirpath, _dirnames, filenames in os.walk(folder):
        for name in sorted(filenames, key=str.lower):
            if os.path.splitext(name)[1].lower() in LORA_EXTENSIONS:
                yield os.path.join(dirpath, name)


def backfill(lora_dir: str) -> list[str]:
    """Create previews for every LoRA under *lora_dir* that has none; returns new paths."""
    created = []
    for filename in _iter_lora_files(lora_dir):
        if os.path.isfile(preview_path(filename)):
            continue
        metadata = read_metadata(filename) if filename.lower().endswith(".safetensors") else {}
        preview = ensure_preview(filename, metadata)
        if preview:
            created.append(preview)
    return created
