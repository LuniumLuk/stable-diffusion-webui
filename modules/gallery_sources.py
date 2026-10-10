"""Gallery v2 source registry: scan + parse + index every output family.

Each source is a row in gallery.db(sources) with a parser name and config
(root dir). Indexing walks the root, parses metadata (A1111 infotext, txt
sidecar, composer JSON) and upserts items - so every gallery view becomes a
plain DB query (no more per-view filesystem scans).

Adding a future source = 1 sources row + (optionally) a parser reuse; see the
SANA worked example in GALLERY_V2_REFACTOR_PLAN.html section 4.1.
"""

import json
import os
import re

from modules import gallery_db

ROOT = gallery_db._ROOT

IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp")
A1111_SOURCE_IDS = {"txt2img", "img2img", "inpaint", "comic_maker", "sana"}

# Curated combined filters: one chip that expands into a FilterSet fragment
# (fine-grained chips remain available below for custom combinations).
FILTER_GROUPS = (
    {"id": "sdxl", "label": "SDXL", "filter": {"sources": ["txt2img", "img2img", "inpaint"]}},
    {"id": "nonesdxl", "label": "None SDXL", "filter": {"sources": ["qwen", "krea2"]}},
    {"id": "composed", "label": "Composed", "filter": {"sources": ["composition"]}},
    {"id": "imagemaker", "label": "Image Maker", "filter": {"sources": ["image_maker"]}},
    {"id": "otherengines", "label": "Other engines",
     "filter": {"sources": ["removebg", "nano_banana", "comic_maker", "sana"]}},
    {"id": "endorsed", "label": "Endorsed", "filter": {"rating": "endorsed"}},
    {"id": "disliked", "label": "Disliked", "filter": {"rating": "disliked"}},
    {"id": "unrated", "label": "Unrated", "filter": {"rating": "none"}},
)


def filter_groups() -> list:
    """Deep-copied group definitions (callers may mutate their copies)."""
    return [{"id": g["id"], "label": g["label"], "filter": dict(g["filter"])} for g in FILTER_GROUPS]


def _rel(path: str) -> str:
    try:
        rel = os.path.relpath(path, ROOT)
    except ValueError:
        rel = path
    return str(rel).replace("\\", "/")


def source_for_path(path: str) -> str | None:
    """Best-effort source id for a file path (used by the facade dual-write)."""
    if not path:
        return None
    rel = _rel(path).lower()
    if "/grids/" in "/" + rel:
        return None
    for src in gallery_db.get_sources():
        try:
            config = json.loads(src.get("config_json") or "{}")
        except Exception:
            config = {}
        root = str(config.get("root") or "").lower().strip("/")
        if root and (rel == root or rel.startswith(root + "/")):
            return src["id"]
    return None


def is_grid_path(path: str) -> bool:
    p = str(path or "").replace("\\", "/").lower()
    if "/grids/" in p:
        return True
    stem = os.path.splitext(os.path.basename(p))[0]
    return ("-grid" in stem) or stem.startswith("grid-") or stem.endswith("-grid") or stem == "grid"


# ---------------------------------------------------------------------------
# metadata parsing (dependency-free so migrators/standalone tools can use it)
# ---------------------------------------------------------------------------

_PARAM_SPLIT = re.compile(r"\nSteps:\s*\d+")


def split_infotext(text: str) -> tuple[str, str, str]:
    """Split a webui infotext into (prompt, negative_prompt, params_line)."""
    text = str(text or "").strip()
    if not text:
        return "", "", ""
    match = _PARAM_SPLIT.search("\n" + text)
    if match:
        cut = match.start()
    else:
        cut = len(text)
    head = text[:cut]
    params = text[cut:].strip()
    prompt, negative = head, ""
    neg_match = re.search(r"\nNegative prompt:\s*", head)
    if neg_match:
        prompt = head[: neg_match.start()]
        negative = head[neg_match.end():]
    return prompt.strip(), negative.strip(), params


def parse_params_line(params: str) -> dict:
    """Parse the 'Steps: 20, Sampler: ..., CFG scale: ...' tail into a dict."""
    out = {}
    if not params:
        return out
    for part in re.split(r",\s*(?=[A-Z][A-Za-z0-9 _\-/]*:)", params):
        if ":" not in part:
            continue
        key, _, value = part.partition(":")
        key = key.strip()
        value = value.strip()
        if key and value and key not in out:
            out[key] = value
    return out


def _meta_from_params(params: dict) -> dict:
    """Compact parsed parameters into the meta_json shape (plan section 4.3)."""
    meta = {}
    simple = {
        "Seed": "seed", "Sampler": "sampler", "Schedule type": "schedule",
        "Steps": "steps", "CFG scale": "cfg", "Denoising strength": "denoise",
        "Model": "model", "Model hash": "model_hash", "VAE": "vae",
        "VAE hash": "vae_hash", "Clip skip": "clip_skip", "ENSD": "ensd",
    }
    for src_key, dst_key in simple.items():
        if src_key in params:
            meta[dst_key] = params[src_key]
    hires = {}
    for key, short in (
        ("Hires upscale", "scale"), ("Hires upscaler", "upscaler"),
        ("Hires steps", "steps"), ("Hires resize-1", "resize_w"),
        ("Hires resize-2", "resize_h"), ("First pass size-1", "first_w"),
        ("First pass size-2", "first_h"),
    ):
        if key in params:
            hires[short] = params[key]
    if hires:
        meta["hires"] = hires
    mask = {}
    for key, short in (
        ("Mask blur", "blur"), ("Masked content", "content"),
        ("Inpaint area", "area"), ("Only masked padding, pixels", "padding"),
    ):
        if key in params:
            mask[short] = params[key]
    if mask:
        meta["mask"] = mask
    for key in ("TI hashes", "Lora hashes", "Version", "SDCPP"):
        if key in params:
            meta.setdefault("extra", {})[key] = params[key]
    return meta


def read_png_parameters(path: str) -> str:
    """Read the A1111 'parameters' text chunk from a PNG (no full decode)."""
    try:
        from PIL import Image
        with Image.open(path) as img:
            text = getattr(img, "text", None) or {}
            return str(text.get("parameters") or "")
    except Exception:
        return ""


def read_sidecar_txt(path: str) -> str:
    """Read the <stem>.txt sidecar next to a file, if present."""
    if not path:
        return ""
    txt_path = os.path.splitext(path)[0] + ".txt"
    try:
        with open(txt_path, "r", encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return ""


def parse_metadata(path: str, parser: str) -> dict:
    """Return {'prompt', 'negative', 'infotext', 'meta'} for one file."""
    result = {"prompt": "", "negative": "", "infotext": "", "meta": {}}
    if parser == "none":
        return result

    infotext = ""
    if parser == "sidecar_txt":
        infotext = read_sidecar_txt(path) or read_png_parameters(path)
    elif parser == "a1111":
        infotext = read_png_parameters(path) or read_sidecar_txt(path)
    elif parser == "sidecar_json":
        json_path = os.path.splitext(path)[0] + ".composerstate.json"
        try:
            with open(json_path, "r", encoding="utf-8", errors="replace") as f:
                data = json.load(f)
            layers = data.get("layers") or []
            result["meta"] = {"composer": {"layers": len(layers), "width": data.get("width"),
                                           "height": data.get("height")}}
        except Exception:
            result["meta"] = {}
        return result

    if not infotext:
        return result
    prompt, negative, params = split_infotext(infotext)
    result["prompt"] = prompt
    result["negative"] = negative
    result["infotext"] = infotext
    result["meta"] = _meta_from_params(parse_params_line(params))
    return result


def image_size(path: str) -> tuple[int, int]:
    try:
        from PIL import Image
        with Image.open(path) as img:
            return int(img.width), int(img.height)
    except Exception:
        return 0, 0


# ---------------------------------------------------------------------------
# scanning + indexing
# ---------------------------------------------------------------------------

def scan_files(root: str, recursive: bool = True) -> list:
    """List candidate image files under a root (skips grids and hidden dirs)."""
    found = []
    if not os.path.isdir(root):
        return found
    if recursive:
        for dirpath, dirnames, fnames in os.walk(root):
            dirnames[:] = [d for d in dirnames if not d.startswith(".")]
            for fname in fnames:
                if fname.startswith(".") or not fname.lower().endswith(IMAGE_EXTS):
                    continue
                full = os.path.join(dirpath, fname)
                if is_grid_path(full):
                    continue
                found.append(full)
    else:
        for fname in os.listdir(root):
            if fname.startswith(".") or not fname.lower().endswith(IMAGE_EXTS):
                continue
            full = os.path.join(root, fname)
            if is_grid_path(full):
                continue
            found.append(full)
    return found


def _removebg_parent_stem(path: str) -> str | None:
    """Parent filename stem for a removebg output (suffix -rembg / -removebg)."""
    stem = os.path.splitext(os.path.basename(path))[0]
    for suffix in ("-removebg", "-rembg"):
        if stem.lower().endswith(suffix):
            return stem[: -len(suffix)].lower()
    return None


def index_item(path: str, source: str, parser: str) -> int | None:
    """Parse + upsert one file. Returns the item id (or None on failure)."""
    try:
        stat = os.stat(path)
    except OSError:
        return None
    rel = _rel(path)
    meta = parse_metadata(path, parser)
    width, height = image_size(path)
    fields = dict(
        path=path,
        rel_path=rel,
        mtime=stat.st_mtime,
        file_size=stat.st_size,
        width=width,
        height=height,
        prompt=meta["prompt"],
        negative_prompt=meta["negative"],
        infotext=meta["infotext"],
        meta=meta["meta"],
    )
    item_id = gallery_db.upsert_item(uid=gallery_db.make_uid(source, rel), source=source, **fields)
    # legacy key compatibility (filename stem convention used by the old DB/UI)
    stem_key = os.path.splitext(os.path.basename(path))[0].strip().lower()
    if stem_key:
        gallery_db.map_legacy_key(stem_key, item_id)
    if source == "qwen" or source == "krea2":
        # canonical archive key used by the desktop gallery + SD Lite:
        # <engine>-outputs-<engine>-<date>-<time>-<stem>
        parts = [p for p in rel.split("/") if p]
        if len(parts) >= 3:
            arc_parts = list(parts)
            arc_parts[-1] = os.path.splitext(arc_parts[-1])[0]
            gallery_db.map_legacy_key(source + "-" + "-".join(p.lower() for p in arc_parts), item_id)
        # older v2 mapping (engine-<rest without outputs>) kept resolving
        rel_engine = rel.split("/", 1)[1] if "/" in rel else rel
        rest = [p for p in rel_engine.split("/") if p]
        if rest:
            rest[-1] = os.path.splitext(rest[-1])[0]
            gallery_db.map_legacy_key(source + "-" + "-".join(p.lower() for p in rest), item_id)
    if source == "removebg":
        parent_stem = _removebg_parent_stem(path)
        if parent_stem:
            parent_id = gallery_db.resolve_item_id(parent_stem)
            if parent_id:
                with gallery_db.get_conn() as conn:
                    conn.execute(
                        "UPDATE items SET parent_id=?, variant=? WHERE id=?",
                        (parent_id, "removebg", item_id),
                    )
                    conn.commit()
    return item_id


def index_source(source_id: str, progress_cb=None) -> dict:
    """Index one registered source; returns {scanned, added, updated, errors}."""
    source_row = None
    for src in gallery_db.get_sources():
        if src["id"] == source_id:
            source_row = src
            break
    if not source_row:
        return {"scanned": 0, "added": 0, "updated": 0, "errors": 0}
    try:
        config = json.loads(source_row.get("config_json") or "{}")
    except Exception:
        config = {}
    root = os.path.join(ROOT, str(config.get("root") or "").replace("/", os.sep))
    parser = source_row.get("parser") or "a1111"
    recursive = source_id in ("image_maker", "comic_maker", "nano_banana", "sana", "qwen", "krea2", "removebg")

    known = {}
    with gallery_db.get_conn() as conn:
        for row in conn.execute(
            "SELECT id, path, mtime FROM items WHERE source=?", (source_id,)
        ).fetchall():
            if row[1]:
                known[str(row[1]).lower()] = (int(row[0]), float(row[2] or 0))

    scanned = added = updated = errors = 0
    for path in scan_files(root, recursive=recursive):
        scanned += 1
        if progress_cb:
            progress_cb(scanned, 0, path)
        try:
            mtime = os.path.getmtime(path)
        except OSError:
            errors += 1
            continue
        prior = known.get(path.lower())
        if prior and abs(prior[1] - mtime) < 0.5:
            continue
        try:
            item_id = index_item(path, source_id, parser)
            if item_id is None:
                errors += 1
            elif prior:
                updated += 1
            else:
                added += 1
        except Exception:
            errors += 1
    return {"scanned": scanned, "added": added, "updated": updated, "errors": errors}


def index_all(progress_cb=None) -> dict:
    """Index every registered source. Sources are independent - resumable."""
    totals = {"scanned": 0, "added": 0, "updated": 0, "errors": 0}
    for src in gallery_db.get_sources():
        if src["id"] == "removebg":
            continue  # variants are indexed with the main pass but need parents first
        stats = index_source(src["id"], progress_cb=progress_cb)
        for key in totals:
            totals[key] += stats.get(key, 0)
    stats = index_source("removebg", progress_cb=progress_cb)
    for key in totals:
        totals[key] += stats.get(key, 0)
    return totals


def backfill_tags_text() -> int:
    """Rebuild FTS rows / tags_text for every item (used after tag imports)."""
    count = 0
    with gallery_db.get_conn() as conn:
        rows = conn.execute("SELECT id FROM items").fetchall()
        for row in rows:
            gallery_db._refresh_fts(conn, int(row[0]))
            count += 1
        conn.commit()
    return count
