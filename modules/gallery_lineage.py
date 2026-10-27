"""Image lineage: which asset an image was derived from.

Only ``txt2img``, ``qwen`` and ``krea2`` generate an image from nothing; every
other output (img2img, inpaint, pose inpaint, hires fix, composer, remove bg,
...) is a transform of an upstream asset.  The upstream asset is captured when
it is sent to a transform ("pin"), then bound to the saved image by pixel
signature - or directly by the uid a client carries in the generation request.

``op`` describes how a file was produced (see ``OP_LABELS``); the *origin* of a
chain is the op of its root, normally one of ``ORIGIN_OPS``.

Everything here is defensive: a lineage failure must never break generation.
"""

import hashlib
import os
import time

from modules import gallery_db

PIN_TTL_SECONDS = 6 * 3600
PIN_MAX_ROWS = 32
PENDING_AUDIT_SECONDS = 24 * 3600
MAX_DHASH_DISTANCE = 4
ASPECT_TOLERANCE = 0.02
MAX_ORIGIN_DEPTH = 32

ORIGIN_OPS = ("txt2img", "qwen", "krea2")

# values that are storage buckets / "we don't know", never a generation step
NON_OPS = ("", "unknown", "endorsed")

SOURCE_OPS = {
    "txt2img": "txt2img",
    "img2img": "img2img",
    "inpaint": "inpaint",
    "composition": "compose",
    "image_maker": "image-maker",
    "nano_banana": "nano-banana",
    "comic_maker": "comic",
    "lora_data_maker": "lora-data",
    "removebg": "removebg",
    "qwen": "qwen",
    "krea2": "krea2",
    "sana": "sana",
}

OP_LABELS = {
    "txt2img": "txt2img",
    "hires-fix": "hires-fix",
    "img2img": "img2img",
    "inpaint": "inpaint",
    "pose-inpaint": "pose inpaint",
    "compose": "composer",
    "removebg": "remove bg",
    "image-maker": "image maker",
    "nano-banana": "nano banana",
    "comic": "comic",
    "lora-data": "lora data",
    "qwen": "qwen",
    "krea2": "krea2",
    "sana": "sana",
    "endorsed": "endorsed",
}

# infotext markers written by the pipeline / scripts
_POSE_MARKER = "Pose inpaint:"
_HIRES_MARKER = "Hires upscale:"
_INPAINT_MARKERS = ("Mask blur:", "Inpaint area:", "Masked content:", "Mask mode:")


def op_label(op) -> str:
    op = str(op or "")
    return OP_LABELS.get(op, op)


# ---------------------------------------------------------------------------
# signatures
# ---------------------------------------------------------------------------

def signature_of_image(image) -> tuple[str, str, int, int, str]:
    """(pixel_sha256, dhash64, width, height, mean color) for a PIL image.

    The pixel hash matches only a byte-identical decode; the 8x8 difference
    hash survives the downscaling/re-encoding SD Lite does before uploading.
    The mean colour guards the dHash against flat images, whose difference
    hash is all zeros whatever their colour.
    """
    from PIL import Image

    rgb = image.convert("RGB")
    width, height = int(rgb.width), int(rgb.height)
    digest = hashlib.sha256(f"{width}x{height}:".encode("ascii") + rgb.tobytes()).hexdigest()
    small = rgb.convert("L").resize((9, 8), Image.LANCZOS)
    pixels = small.tobytes()
    value = 0
    for row in range(8):
        offset = row * 9
        for col in range(8):
            value = (value << 1) | (1 if pixels[offset + col] > pixels[offset + col + 1] else 0)
    mean = rgb.resize((1, 1), Image.LANCZOS).getpixel((0, 0))
    color = ",".join(str(int(channel)) for channel in mean[:3])
    return digest, f"{value:016x}", width, height, color


def signature_of_file(path: str):
    if not path or not os.path.isfile(path):
        return None
    try:
        from PIL import Image

        with Image.open(path) as image:
            image.load()
            return signature_of_image(image)
    except Exception:
        return None


def _hamming(left: str, right: str) -> int:
    try:
        return bin(int(left, 16) ^ int(right, 16)).count("1")
    except (TypeError, ValueError):
        return 64


def _aspect_close(width_a, height_a, width_b, height_b) -> bool:
    try:
        a = float(width_a) / float(height_a or 1)
        b = float(width_b) / float(height_b or 1)
    except (TypeError, ValueError, ZeroDivisionError):
        return False
    return abs(a - b) <= ASPECT_TOLERANCE * max(0.01, a)


def _color_close(left: str, right: str, tolerance: int = 18) -> bool:
    try:
        a = [int(part) for part in str(left).split(",")[:3]]
        b = [int(part) for part in str(right).split(",")[:3]]
    except (TypeError, ValueError):
        return False
    if len(a) != 3 or len(b) != 3:
        return False
    return all(abs(x - y) <= tolerance for x, y in zip(a, b))


# ---------------------------------------------------------------------------
# op derivation
# ---------------------------------------------------------------------------

def op_from_infotext(source: str, infotext: str) -> str:
    """Best-effort op for a file we did not generate ourselves (index/backfill).

    Returns "" when the file has no generation step we can name: ``endorsed``
    is a storage bucket (a copy of an original), not a way of making an image.
    """
    text = str(infotext or "")
    source = str(source or "")
    if _POSE_MARKER in text:
        return "pose-inpaint"
    if any(marker in text for marker in _INPAINT_MARKERS):
        return "inpaint"
    if source == "img2img":
        return "img2img"
    if source == "txt2img":
        return "hires-fix" if _HIRES_MARKER in text else "txt2img"
    if source in NON_OPS:
        # an endorsed copy (or an unregistered path) carries the original's
        # infotext, which is enough to recover the family it came from
        if _HIRES_MARKER in text:
            return "hires-fix"
        if "Denoising strength:" in text:
            return "img2img"
        if "Steps:" in text:
            return "txt2img"
        return ""
    return SOURCE_OPS.get(source, source)


def display_op(item: dict | None) -> str:
    """Generation op to show on a card, derived when the row predates the column."""
    if not item:
        return ""
    op = item.get("op")
    if not op:
        op = op_from_infotext(item.get("source"), item.get("infotext"))
    return "" if op in NON_OPS else op_label(op)


def display_op_from_op(op) -> str:
    return "" if op in NON_OPS else op_label(op)


def op_for_p(p):
    """Authoritative op of the live generation object, or None."""
    if p is None:
        return None
    params = getattr(p, "extra_generation_params", None) or {}
    if "Pose inpaint" in params:
        return "pose-inpaint"
    name = type(p).__name__
    if "Img2Img" in name:
        return "inpaint" if getattr(p, "image_mask", None) is not None else "img2img"
    if "Txt2Img" in name:
        return "hires-fix" if getattr(p, "enable_hr", False) else "txt2img"
    return None


def _source_for_path(path: str) -> str:
    try:
        from modules import gallery_sources

        return gallery_sources.source_for_path(path) or ""
    except Exception:
        return ""


# cheap prefix -> op table for rows whose item row is not available (yet)
_PATH_OPS = (
    ("/outputs/txt2img-images/", "txt2img"),
    ("/outputs/img2img-images/", "img2img"),
    ("/outputs/qwen/", "qwen"),
    ("/outputs/krea2/", "krea2"),
    ("/outputs/composition/", "compose"),
    ("/outputs/image_maker/", "image-maker"),
    ("/outputs/nano-banana/", "nano-banana"),
    ("/outputs/removebg/", "removebg"),
    ("/outputs/comic_maker/", "comic"),
    ("/outputs/lora_data_maker/", "lora-data"),
    ("/outputs/sana/", "sana"),
)


def op_for_path(path: str) -> str:
    """Cheap op guess from the output family a path belongs to."""
    normalized = "/" + str(path or "").replace("\\", "/").lower().lstrip("/")
    for marker, op in _PATH_OPS:
        if marker in normalized:
            return op
    return ""


def describe(p, path: str, infotext: str = "", source: str | None = None) -> dict:
    """Lineage fields for the image being saved."""
    source = source if source is not None else _source_for_path(path)
    op = op_for_p(p) or op_from_infotext(source or _source_for_path(path), infotext)
    lineage = {"op": op}
    parent_uid = getattr(p, "lineage_parent_uid", None)
    parent_op = getattr(p, "lineage_parent_op", None)
    if parent_uid:
        lineage["parent_uid"] = str(parent_uid)
        if not parent_op:
            parent = _item_by_key(parent_uid)
            parent_op = (parent or {}).get("op") or (parent or {}).get("source")
        if parent_op:
            lineage["parent_op"] = str(parent_op)
    return lineage


# ---------------------------------------------------------------------------
# pins
# ---------------------------------------------------------------------------

def prune_pins(conn=None) -> int:
    now = time.time()
    own = conn is None
    conn = conn or gallery_db.get_conn()
    try:
        cur = conn.execute(
            "DELETE FROM lineage_pins WHERE pinned_at < ? OR "
            "(consumed_at IS NOT NULL AND consumed_at < ?)",
            (now - PIN_TTL_SECONDS, now - PENDING_AUDIT_SECONDS),
        )
        removed = int(cur.rowcount or 0)
        excess = conn.execute("SELECT COUNT(*) FROM lineage_pins").fetchone()[0] - PIN_MAX_ROWS
        if excess > 0:
            conn.execute(
                "DELETE FROM lineage_pins WHERE id IN "
                "(SELECT id FROM lineage_pins ORDER BY pinned_at ASC LIMIT ?)",
                (int(excess),),
            )
        conn.commit()
    except Exception:
        removed = 0
    finally:
        if own:
            conn.close()
    return removed


def _item_by_key(key):
    try:
        item_id = gallery_db.resolve_item_id(key)
        return gallery_db.get_item(item_id) if item_id else None
    except Exception:
        return None


def _item_by_path(path):
    try:
        return gallery_db.get_item_by_path(path)
    except Exception:
        return None


def pin_item(uid=None, path=None, origin: str = "api") -> dict | None:
    """Cache a reference of the asset that is being sent to a transform."""
    item = _item_by_key(uid) if uid else None
    if item is None and path:
        item = _item_by_path(path)
    if item is None:
        return None
    item_uid = str(item.get("uid") or "")
    item_path = str(item.get("path") or item.get("alias_path") or path or "")
    if not item_uid:
        return None

    signature = signature_of_file(item_path)
    now = time.time()
    with gallery_db.get_conn() as conn:
        conn.execute(
            "INSERT INTO lineage_pins(uid, path, pixel_sha, dhash, color, width, height, origin, pinned_at) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            (
                item_uid,
                item_path,
                signature[0] if signature else "",
                signature[1] if signature else "",
                signature[4] if signature else "",
                signature[2] if signature else int(item.get("width") or 0),
                signature[3] if signature else int(item.get("height") or 0),
                str(origin or "api")[:32],
                now,
            ),
        )
        conn.commit()
    prune_pins()
    return {
        "uid": item_uid,
        "op": item.get("op") or item.get("source") or "",
        "width": signature[2] if signature else int(item.get("width") or 0),
        "height": signature[3] if signature else int(item.get("height") or 0),
    }


def live_pins() -> list:
    cutoff = time.time() - PIN_TTL_SECONDS
    with gallery_db.get_conn() as conn:
        rows = conn.execute(
            "SELECT id, uid, path, pixel_sha, dhash, color, width, height, pinned_at, consumed_at "
            "FROM lineage_pins WHERE pinned_at >= ? ORDER BY pinned_at DESC",
            (cutoff,),
        ).fetchall()
    return [dict(row) for row in rows]


def _consume_pin(pin_id: int) -> None:
    try:
        with gallery_db.get_conn() as conn:
            conn.execute(
                "UPDATE lineage_pins SET consumed_at=? WHERE id=?",
                (time.time(), int(pin_id)),
            )
            conn.commit()
    except Exception:
        pass


def _match(sig, pins: list):
    best = None
    for pin in pins:
        distance = None
        if pin.get("pixel_sha") and pin["pixel_sha"] == sig[0]:
            distance = 0
        elif (pin.get("dhash") and _aspect_close(pin.get("width"), pin.get("height"), sig[2], sig[3])
              and _color_close(pin.get("color"), sig[4])):
            distance = _hamming(pin["dhash"], sig[1])
            if distance > MAX_DHASH_DISTANCE:
                distance = None
        if distance is None:
            continue
        if best is None or distance < best[0]:
            best = (distance, pin)
    return best


def _bind(p, uid: str, op: str, kind: str, distance=None) -> None:
    p.lineage_parent_uid = str(uid)
    p.lineage_parent_op = str(op or "")
    p.lineage_match = {"kind": kind, "distance": distance}


def attach(p) -> None:
    """Resolve the upstream asset of a generation and stash it on `p`."""
    if p is None:
        return
    if getattr(p, "lineage_parent_uid", None):
        return

    source_path = getattr(p, "lineage_parent_path", None)
    if source_path:
        item = _item_by_path(source_path)
        if item and item.get("uid"):
            _bind(p, item["uid"], item.get("op") or item.get("source"), "path")
            return

    init_images = getattr(p, "init_images", None) or []
    if not init_images:
        return
    try:
        sig = signature_of_image(init_images[0])
    except Exception:
        return

    pins = live_pins()
    if not pins:
        return

    match = _match(sig, pins)
    if match is not None:
        distance, pin = match
        if pin.get("uid"):
            _bind(p, pin["uid"], "", "pin", distance)
            _consume_pin(pin["id"])
        return

    # Conservative fallback: one untouched pin of the same shape, sent minutes ago.
    pending = [pin for pin in pins if not pin.get("consumed_at")]
    if len(pending) == 1 and time.time() - float(pending[0].get("pinned_at") or 0) <= 900:
        pin = pending[0]
        if (_aspect_close(pin.get("width"), pin.get("height"), sig[2], sig[3])
                and _color_close(pin.get("color"), sig[4])):
            _bind(p, pin["uid"], "", "single-pin")
            _consume_pin(pin["id"])


def fill_parent_op(p) -> None:
    """Resolve the parent op lazily so the 2nd capsule never needs a join."""
    uid = getattr(p, "lineage_parent_uid", None)
    if not uid or getattr(p, "lineage_parent_op", None):
        return
    item = _item_by_key(uid)
    if item:
        p.lineage_parent_op = str(item.get("op") or item.get("source") or "")


# ---------------------------------------------------------------------------
# reading lineage
# ---------------------------------------------------------------------------

def resolve_parent(item: dict | None) -> dict | None:
    """Describe the parent of an item for the UI (jump button state)."""
    if not item:
        return None
    parent_uid = item.get("parent_uid") or ""
    if not parent_uid:
        return None
    record = _item_by_key(parent_uid)
    if record is None:
        return {"uid": parent_uid, "op": item.get("parent_op") or "",
                "op_label": op_label(item.get("parent_op")), "state": "",
                "exists": False, "reason": "deleted"}
    state = str(record.get("state") or "active")
    candidates = [p for p in (record.get("path"), record.get("alias_path")) if p]
    if state == "trashed":
        return {"uid": parent_uid, "op": record.get("op") or "",
                "op_label": op_label(record.get("op")), "state": state,
                "exists": False, "reason": "trashed"}
    if candidates and not any(os.path.isfile(candidate) for candidate in candidates):
        return {"uid": parent_uid, "op": record.get("op") or "",
                "op_label": op_label(record.get("op")), "state": state,
                "exists": False, "reason": "missing"}
    return {"uid": parent_uid, "op": record.get("op") or "",
            "op_label": op_label(record.get("op")), "state": state,
            "exists": True, "reason": ""}


def origin_of(item: dict | None) -> str:
    """Follow the parent chain to its root and return that op ('' if unknown)."""
    if not item:
        return ""
    current = item
    seen = set()
    while len(seen) < MAX_ORIGIN_DEPTH:
        uid = current.get("parent_uid") or ""
        if not uid or uid in seen:
            break
        seen.add(uid)
        parent = _item_by_key(uid)
        if not parent:
            break
        current = parent
    op = current.get("op") or op_from_infotext(current.get("source"), current.get("infotext"))
    return "" if op in NON_OPS else op


def decorate_items(items: list) -> list:
    """Fill op/parent fields on mobile gallery rows (legacy item_key based)."""
    if not items:
        return items
    keys = []
    for item in items:
        key = str(item.get("key") or "")
        if key:
            keys.append(key.lower())
            stem = os.path.splitext(key)[0].lower()
            if stem and stem != key.lower():
                keys.append(stem)
    rows = _items_for_keys(keys)
    parent_uids = sorted({str(row.get("parent_uid")) for row in rows.values() if row.get("parent_uid")})
    parents = _items_for_uids(parent_uids)

    for item in items:
        key = str(item.get("key") or "").lower()
        row = rows.get(key) or rows.get(os.path.splitext(key)[0]) or {}
        if not item.get("uid"):
            item["uid"] = row.get("uid") or item.get("uid") or ""
        op = (item.get("op") or row.get("op")
              or op_from_infotext(row.get("source"), row.get("infotext"))
              or op_for_path(item.get("path")) or "")
        item["op"] = op if op not in NON_OPS else ""
        item["op_label"] = op_label(item["op"]) if item["op"] else ""
        parent_uid = item.get("parent_uid") or row.get("parent_uid") or ""
        if not parent_uid:
            continue
        parent_op = item.get("parent_op") or row.get("parent_op") or ""
        parent_op = "" if parent_op in NON_OPS else parent_op
        item["parent_uid"] = parent_uid
        item["parent_op"] = parent_op
        item["parent_label"] = op_label(parent_op) if parent_op else ""
        state = str((parents.get(parent_uid) or {}).get("state") or "")
        item["parent_state"] = state
        parent_paths = [
            candidate for candidate in (
                (parents.get(parent_uid) or {}).get("path"),
                (parents.get(parent_uid) or {}).get("alias_path"),
            ) if candidate
        ]
        item["parent_exists"] = bool(state) and state != "trashed" and (
            not parent_paths or any(os.path.isfile(candidate) for candidate in parent_paths)
        )
    return items


def _items_for_keys(keys: list) -> dict:
    if not keys:
        return {}
    found = {}
    unique = sorted({key for key in keys if key})
    with gallery_db.get_conn() as conn:
        for start in range(0, len(unique), 400):
            chunk = unique[start:start + 400]
            placeholders = ",".join("?" * len(chunk))
            for row in conn.execute(
                "SELECT l.legacy_key AS k, i.uid AS uid, i.source AS source, i.op AS op, "
                "i.infotext AS infotext, i.parent_uid AS parent_uid, i.parent_op AS parent_op "
                f"FROM legacy_keys l JOIN items i ON i.id = l.item_id "
                f"WHERE l.legacy_key IN ({placeholders})",
                chunk,
            ).fetchall():
                found[str(row["k"]).lower()] = dict(row)
            for row in conn.execute(
                "SELECT uid, source, op, infotext, parent_uid, parent_op FROM items "
                f"WHERE uid IN ({placeholders})",
                chunk,
            ).fetchall():
                found.setdefault(str(row["uid"]).lower(), dict(row))
    return found


def _items_for_uids(uids: list) -> dict:
    if not uids:
        return {}
    found = {}
    with gallery_db.get_conn() as conn:
        for start in range(0, len(uids), 400):
            chunk = uids[start:start + 400]
            placeholders = ",".join("?" * len(chunk))
            for row in conn.execute(
                f"SELECT uid, state, path, alias_path FROM items WHERE uid IN ({placeholders})", chunk
            ).fetchall():
                found[str(row["uid"])] = dict(row)
    return found


# ---------------------------------------------------------------------------
# backfill
# ---------------------------------------------------------------------------

def backfill(progress_cb=None) -> dict:
    """Derive op (and the removebg parent links) for rows indexed before this."""
    stats = {"scanned": 0, "ops": 0, "parents": 0, "errors": 0}
    updates = []
    with gallery_db.get_conn() as conn:
        rows = conn.execute(
            "SELECT id, source, infotext, op, parent_id, parent_uid FROM items "
            "ORDER BY id"
        ).fetchall()
        by_id = {}
        for row in rows:
            stats["scanned"] += 1
            record = dict(row)
            by_id[int(record["id"])] = record
            if record.get("op") is None:
                op = op_from_infotext(record.get("source"), record.get("infotext"))
                # "" = no generation step we can name; still written so the
                # startup guard does not rescan the whole table every time
                updates.append(("op", op or "", int(record["id"])))
                if op:
                    stats["ops"] += 1
            if progress_cb and stats["scanned"] % 500 == 0:
                progress_cb(stats["scanned"], len(rows))

        parent_updates = []
        for item_id, record in by_id.items():
            if record.get("parent_uid") or not record.get("parent_id"):
                continue
            parent = by_id.get(int(record["parent_id"]))
            if not parent or not parent.get("uid"):
                continue
            parent_op = parent.get("op") or op_from_infotext(parent.get("source"), parent.get("infotext"))
            parent_updates.append((parent["uid"], parent_op, item_id))
            stats["parents"] += 1

        for column, value, item_id in updates:
            try:
                conn.execute(f"UPDATE items SET {column}=? WHERE id=?", (value, item_id))
            except Exception:
                stats["errors"] += 1
        for parent_uid, parent_op, item_id in parent_updates:
            try:
                conn.execute(
                    "UPDATE items SET parent_uid=?, parent_op=? WHERE id=?",
                    (parent_uid, parent_op or "", item_id),
                )
            except Exception:
                stats["errors"] += 1
        conn.commit()
    return stats
