"""Background DeepDanbooru tagging triggered by gallery endorse/dislike actions.

When a user endorses or dislikes an image in the Gallery tab, call queue_tag()
to schedule tag extraction. A daemon thread processes the queue, runs
deepbooru.model.tag_raw(), and persists results to endorsement_db.image_tags.
"""

import os
import queue
import threading

_tag_queue: queue.Queue = queue.Queue(maxsize=200)
_thread: threading.Thread | None = None
_thread_lock = threading.Lock()


def queue_tag(image_path: str, label: str) -> None:
    """Schedule an image for DeepDanbooru tagging. label must be 'endorse' or 'dislike'."""
    if label not in ("endorse", "dislike"):
        return
    if not image_path:
        return
    # Resolve endorsed-copy path: if the original path no longer exists,
    # the tagger will try the path as-is (may be the endorsed copy).
    _ensure_worker()
    try:
        _tag_queue.put_nowait((image_path, label))
    except queue.Full:
        pass  # Non-critical; drop silently when queue is saturated


def _ensure_worker() -> None:
    global _thread
    with _thread_lock:
        if _thread is None or not _thread.is_alive():
            _thread = threading.Thread(
                target=_worker,
                name="gallery-tagger",
                daemon=True,
            )
            _thread.start()


def _worker() -> None:
    while True:
        try:
            item = _tag_queue.get(timeout=10)
        except queue.Empty:
            continue
        try:
            _do_tag(*item)
        except Exception:
            pass
        finally:
            _tag_queue.task_done()


def _do_tag(image_path: str, label: str) -> None:
    """Open image, run deepbooru tag_raw, persist to DB."""
    from PIL import Image
    from modules import deepbooru, endorsement_db

    item_key = endorsement_db._item_key_from_path(image_path)
    if not item_key:
        return

    # Try the given path; fall back to endorsed-copy location if original moved
    resolved = image_path
    if not os.path.exists(resolved):
        return

    try:
        with Image.open(resolved) as img:
            pil_image = img.copy().convert("RGB")
    except Exception:
        return

    try:
        tags_dict = deepbooru.model.tag_raw(pil_image)
    except Exception:
        return

    if tags_dict:
        endorsement_db.save_image_tags(item_key, tags_dict, label)


def tag_untagged_images() -> tuple[int, int]:
    """Synchronously tag every endorsed/disliked image not yet in image_tags.

    Returns (tagged_count, skipped_count).
    Skipped means the file no longer exists on disk.
    """
    from PIL import Image
    from modules import deepbooru, endorsement_db

    pending = endorsement_db.get_untagged_images()
    return _run_batch(pending)


def tag_untagged_filtered(
    endorse_items: list[tuple[str, str]],
    dislike_items: list[tuple[str, str]],
) -> tuple[int, int]:
    """Synchronously tag images from the filtered sets that have no tags yet.

    endorse_items / dislike_items: [(image_path, item_key), ...]
    Returns (tagged_count, skipped_count).
    """
    from modules import endorsement_db

    endorse_keys = {k for _, k in endorse_items if k}
    dislike_keys = {k for _, k in dislike_items if k}
    pending_full = endorsement_db.get_untagged_filtered(endorse_keys, dislike_keys)
    pending = [(path, label) for path, label, _ in pending_full]
    tagged, skipped = 0, 0
    for _ in _iter_batch(pending):
        tagged += 1
    return tagged, skipped


def iter_tag_untagged_filtered(
    endorse_items: list[tuple[str, str]],
    dislike_items: list[tuple[str, str]],
):
    """Generator version: yields (done, total, tagged, skipped) after each image.

    Callers iterate this to get live progress, then collect final counts.
    """
    from modules import endorsement_db

    endorse_keys = {k for _, k in endorse_items if k}
    dislike_keys = {k for _, k in dislike_items if k}
    pending_full = endorsement_db.get_untagged_filtered(endorse_keys, dislike_keys)
    pending = [(path, label) for path, label, _ in pending_full]

    total = len(pending)
    tagged = 0
    skipped = 0

    if total == 0:
        yield 0, 0, 0, 0
        return

    for ok in _iter_batch(pending):
        if ok:
            tagged += 1
        else:
            skipped += 1
        yield tagged + skipped, total, tagged, skipped

    # Unload model to free VRAM after batch run
    try:
        from modules import deepbooru
        deepbooru.model.stop()
    except Exception:
        pass


def _iter_batch(pending: list[tuple[str, str]]):
    """Yield True/False (success) per image. Side-effect: writes tags to DB."""
    from PIL import Image
    from modules import deepbooru, endorsement_db

    for image_path, label in pending:
        if not image_path or not os.path.exists(image_path):
            yield False
            continue
        item_key = endorsement_db._item_key_from_path(image_path)
        if not item_key:
            yield False
            continue
        try:
            with Image.open(image_path) as img:
                pil_image = img.copy().convert("RGB")
            tags_dict = deepbooru.model.tag_raw(pil_image)
            if tags_dict:
                endorsement_db.save_image_tags(item_key, tags_dict, label)
                yield True
            else:
                yield False
        except Exception:
            yield False
