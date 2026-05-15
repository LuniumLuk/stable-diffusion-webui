"""Paged gallery with endorsements, dislikes, and cached thumbnails."""

import base64
import colorsys
import datetime
import hashlib
import html as _html
import io
import json
import os
import re
import time
import urllib.parse

import gradio as gr
from PIL import Image

from modules import endorsement_db
from modules import gallery_tagger
from modules import infotext_utils
from modules import images
from modules import rembg_utils
from modules import script_callbacks
from modules import shared

endorsement_db.init_db()

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_ROOT_DIR = os.path.dirname(_SCRIPT_DIR)

THUMB_PX = 192
PREVIEW_PX = 1024
PAGE_SIZE_DEFAULT = 48
THUMB_SIZE_PRESETS = {
    "Small": 140,
    "Medium": 220,
    "Large": 280,
}

_thumb_cache: dict = {}
_THUMB_CACHE_DIR = os.path.join(_ROOT_DIR, "cache", "gallery_thumbs")
_PREVIEW_CACHE_DIR = os.path.join(_ROOT_DIR, "cache", "gallery_previews")
_FIRE_CONFIG_FILE = os.path.join(_ROOT_DIR, "config_states", "endgal_fire_config.txt")
_FIRE_CONFIG_DEFAULT = "steps: 14"


def _normalize_fire_keyword(token: str) -> str:
    text = str(token or "").strip()
    if not text:
        return ""

    text = text.strip('"\'')
    text = re.sub(r"\s*:-?\d+(?:\.\d+)?$", "", text)
    while text.startswith("(") and text.endswith(")") and len(text) > 2:
        text = text[1:-1].strip()
    text = re.sub(r"\s+", " ", text).strip()

    if not text or len(text) > 120:
        return ""
    return text


def _split_fire_keywords(text: str) -> list[str]:
    src = str(text or "")
    if not src:
        return []
    return [
        t for t in (_normalize_fire_keyword(p) for p in re.split(r"[,\n\r]+", src))
        if t
    ]


def _rank_fire_terms(counter: dict[str, int], limit: int = 180) -> list[str]:
    rows = sorted(counter.items(), key=lambda kv: (-kv[1], kv[0].lower()))
    out = []
    seen = set()
    for term, _n in rows:
        key = term.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(term)
        if len(out) >= max(1, int(limit or 1)):
            break
    return out


def _fallback_fire_prompt_suggestions(limit_per_key: int = 180) -> dict:
    prompt_counter: dict[str, int] = {}
    neg_counter: dict[str, int] = {}

    with endorsement_db._get_conn() as conn:
        rows = conn.execute(
            "SELECT prompt, negative_prompt FROM endorsements ORDER BY endorsed_at DESC LIMIT 5000"
        ).fetchall()
        for row in rows:
            for token in _split_fire_keywords(row["prompt"]):
                prompt_counter[token] = prompt_counter.get(token, 0) + 1
            for token in _split_fire_keywords(row["negative_prompt"]):
                neg_counter[token] = neg_counter.get(token, 0) + 1

        tag_rows = conn.execute(
            """
            SELECT tag, COUNT(*) AS n
            FROM image_tags
            WHERE label='endorse'
            GROUP BY tag
            ORDER BY n DESC
            LIMIT ?
            """,
            (max(200, int(limit_per_key or 180) * 4),),
        ).fetchall()
        for row in tag_rows:
            token = _normalize_fire_keyword(str(row["tag"] or "").replace("_", " "))
            if not token:
                continue
            prompt_counter[token] = prompt_counter.get(token, 0) + int(row["n"] or 1)

    return {
        "Prompt": _rank_fire_terms(prompt_counter, int(limit_per_key or 180)),
        "Negative prompt": _rank_fire_terms(neg_counter, int(limit_per_key or 180)),
    }


def _get_fire_value_suggestions_json() -> str:
    data = None
    try:
        provider = getattr(endorsement_db, "get_fire_prompt_suggestions", None)
        if callable(provider):
            data = provider(limit_per_key=180)
    except Exception:
        data = None

    if not isinstance(data, dict):
        try:
            data = _fallback_fire_prompt_suggestions(limit_per_key=180)
        except Exception:
            data = {"Prompt": [], "Negative prompt": []}

    return json.dumps(data, ensure_ascii=False)


def _rebuild_fire_suggestion_database() -> tuple[str, str]:
    endorsed_items = endorsement_db.get_all_endorsed_items("", None)
    tagged = 0
    skipped = 0

    try:
        for _done, _total, tagged_now, skipped_now in gallery_tagger.iter_tag_untagged_filtered(endorsed_items, []):
            tagged = int(tagged_now or 0)
            skipped = int(skipped_now or 0)
    except Exception:
        # Keep rebuild resilient even if caption backfill fails for some records.
        pass

    payload = _get_fire_value_suggestions_json()
    try:
        parsed = json.loads(payload or "{}")
    except Exception:
        parsed = {}

    prompt_count = len(parsed.get("Prompt") or [])
    neg_count = len(parsed.get("Negative prompt") or [])
    msg = (
        f"Rebuilt fire suggestion DB from {len(endorsed_items)} endorsed record(s). "
        f"Caption scan: {tagged} tagged, {skipped} skipped. "
        f"Suggestions: Prompt {prompt_count}, Negative prompt {neg_count}."
    )
    status_html = f'<div class="endgal-sync-result">{_html.escape(msg)}</div>'
    return status_html, payload


def _load_fire_override_config() -> str:
    try:
        if os.path.exists(_FIRE_CONFIG_FILE):
            with open(_FIRE_CONFIG_FILE, "r", encoding="utf-8") as f:
                raw = f.read()
            return raw if raw.strip() else _FIRE_CONFIG_DEFAULT
    except Exception:
        pass
    return _FIRE_CONFIG_DEFAULT


def _save_fire_override_config(raw: str) -> str:
    try:
        os.makedirs(os.path.dirname(_FIRE_CONFIG_FILE), exist_ok=True)
        with open(_FIRE_CONFIG_FILE, "w", encoding="utf-8") as f:
            f.write(str(raw or ""))
        return "ok"
    except Exception:
        return "error"


def _ensure_thumb_cache_dir():
    os.makedirs(_THUMB_CACHE_DIR, exist_ok=True)
    os.makedirs(_PREVIEW_CACHE_DIR, exist_ok=True)


def _thumb_file(path: str, mtime: float) -> str:
    key = hashlib.sha1(f"{path}|{mtime:.6f}".encode("utf-8", errors="ignore")).hexdigest()
    return os.path.join(_THUMB_CACHE_DIR, f"{key}.webp")


def _preview_file(path: str, mtime: float) -> str:
    key = hashlib.sha1(f"{path}|{mtime:.6f}|preview".encode("utf-8", errors="ignore")).hexdigest()
    return os.path.join(_PREVIEW_CACHE_DIR, f"{key}.webp")


def _get_thumb(path: str) -> str:
    try:
        mtime = os.path.getmtime(path)
        cache_key = (path, mtime)
        cached = _thumb_cache.get(cache_key)
        if cached:
            return cached

        _ensure_thumb_cache_dir()
        thumb_path = _thumb_file(path, mtime)

        if not os.path.exists(thumb_path):
            img = Image.open(path)
            img.thumbnail((THUMB_PX, THUMB_PX))
            img.save(thumb_path, format="WEBP", quality=72, method=5)

        url = _file_url(thumb_path)
        _thumb_cache[cache_key] = url
        return url
    except Exception:
        return ""


_preview_cache: dict = {}


def _get_preview_thumb(path: str) -> str:
    """Return a URL to a ≤1024px WebP version of the image, cached on disk."""
    try:
        mtime = os.path.getmtime(path)
        cache_key = (path, mtime)
        cached = _preview_cache.get(cache_key)
        if cached:
            return cached

        _ensure_thumb_cache_dir()
        preview_path = _preview_file(path, mtime)

        if not os.path.exists(preview_path):
            img = Image.open(path)
            img.thumbnail((PREVIEW_PX, PREVIEW_PX))
            img.save(preview_path, format="WEBP", quality=88, method=4)

        url = _file_url(preview_path)
        _preview_cache[cache_key] = url
        return url
    except Exception:
        return ""


def _b64(s: str) -> str:
    return base64.b64encode((s or "").encode("utf-8", errors="ignore")).decode("ascii")


def _file_url(path: str) -> str:
    normalized = str(path or "").replace(chr(92), "/")
    return f'/file={urllib.parse.quote(normalized, safe="")}' if normalized else ""


def _get_output_dirs() -> list:
    dirs = []
    for attr in ("outdir_txt2img_samples", "outdir_img2img_samples", "outdir_save"):
        d = getattr(shared.opts, attr, "") or ""
        if d and os.path.isdir(d) and d not in dirs:
            dirs.append(d)
    for rel in ("outputs/txt2img-images", "outputs/img2img-images"):
        full = os.path.join(_ROOT_DIR, rel)
        if os.path.isdir(full) and full not in dirs:
            dirs.append(full)
    return dirs


def sync_all_to_db() -> str:
    dirs = _get_output_dirs()
    result = endorsement_db.sync_output_dirs(dirs)
    total = result["total"]
    added = result["added"]
    updated = result["updated"]
    skipped = result["skipped"]
    errors = result["errors"]
    indexed = endorsement_db.count_generated()
    return (
        f"Sync complete: scanned {total}, added {added}, updated {updated}, "
        f"unchanged {skipped}, errors {errors}. Indexed total: {indexed}."
    )


def _get_composed_dir() -> str:
    return os.path.join(_ROOT_DIR, "outputs", "composition")


def _fetch_composed_records(query: str, page: int, page_size: int):
    """Return (rows, total) for the Composed mode by scanning outputs/composition/*.png."""
    comp_dir = _get_composed_dir()
    if not os.path.isdir(comp_dir):
        return [], 0

    files = sorted(
        [f for f in os.listdir(comp_dir) if f.lower().endswith(".png")],
        key=lambda f: os.path.getmtime(os.path.join(comp_dir, f)),
        reverse=True,
    )

    q = (query or "").strip().lower()
    if q:
        files = [f for f in files if q in f.lower()]

    total = len(files)
    offset = (page - 1) * page_size
    page_files = files[offset: offset + page_size]

    rows = []
    for fname in page_files:
        fpath = os.path.join(comp_dir, fname)
        try:
            mtime = os.path.getmtime(fpath)
        except OSError:
            mtime = 0.0
        config_path = os.path.splitext(fpath)[0] + ".composerstate.json"
        rows.append({
            "path": fpath,
            "file_mtime": mtime,
            "prompt": "",
            "seed": "",
            "sampler": "",
            "model_name": "",
            "has_composer_config": os.path.exists(config_path),
            "config_path": config_path if os.path.exists(config_path) else "",
        })

    return rows, total


def _extras_details_open_attr(card_extras_mode: str) -> str:
    mode = (card_extras_mode or "Expanded").strip().lower()
    return "" if mode.startswith("f") else " open"


def _composed_card_html(record: dict, card_extras_mode: str = "Expanded") -> str:
    import datetime as _dt
    path = record.get("path", "")
    fname = os.path.basename(path)
    mtime = record.get("file_mtime")
    date = _dt.datetime.fromtimestamp(mtime).strftime("%Y-%m-%d %H:%M") if mtime else ""
    thumb = _get_thumb(path) if path else ""
    preview_url = _get_preview_thumb(path) if path else ""
    orig_url = _file_url(path)
    path_b64 = _b64(path)
    config_path = record.get("config_path", "")
    config_path_b64 = _b64(config_path)
    has_config = bool(config_path)

    thumb_html = (
        f'<img src="{thumb}" alt="composed image" loading="lazy" '
        f'data-orig="{orig_url}" '
        f'data-preview="{preview_url}" '
        f'onclick="endorsedGallery.previewImage(this.dataset.preview || this.dataset.orig || this.src)" />'
    ) if thumb else '<div class="endgal-nothumb">No preview</div>'

    config_badge = (
        '<span class="endgal-config-badge" title="Full composer state available — load to restore all layers">⚙</span>'
        if has_config else ""
    )

    composer_btn_attrs = (
        f'onclick="endorsedGallery.sendToComposer(\'{path_b64}\', \'{config_path_b64}\')"'
        if has_config
        else 'disabled title="No composer config available for this image"'
    )
    composer_btn_class = "endgal-btn-send2img endgal-btn-composer" + ("" if has_config else " endgal-btn-disabled")
    composer_btn_title = "Send to Composer and restore full state" if has_config else "No composer config available for this image"

    date_overlay = f'<div class="endgal-date endgal-date-overlay">{_html.escape(date)}</div>' if date else ""

    thumb_action_stack = (
        '<div class="endgal-thumb-actions">'
        f'<button class="{composer_btn_class} endgal-act-compose" '
        f'data-icon="🧩" '
        f'data-hint="Composer" '
        f'title="{_html.escape(composer_btn_title)}" '
        f'{composer_btn_attrs}>🧩</button>'
        f'<button class="endgal-btn-send2img endgal-act-i2i" data-icon="🖼" data-hint="Send to img2img" '
        f'title="send to img2img" '
        f'onclick="endorsedGallery.sendTo(\'\', \'img2img\', \'{path_b64}\')">🖼</button>'
        f'<button class="endgal-btn-send2img endgal-act-extras" data-icon="✨" data-hint="Send to extras" '
        f'title="send to extras" '
        f'onclick="endorsedGallery.sendToExtras(\'{path_b64}\')">✨</button>'
        '</div>'
    )

    details_open = _extras_details_open_attr(card_extras_mode)

    return f"""
<div class="endgal-card endgal-composed-card">
  <div class="endgal-thumb">{thumb_html}{date_overlay}{thumb_action_stack}</div>
    <details class="endgal-card-extra"{details_open}>
                <summary class="endgal-card-extra-summary">Details</summary>
        <div class="endgal-body">
            <div class="endgal-prompt">{_html.escape(fname)}{config_badge}</div>
            <div class="endgal-date">{_html.escape(date)}</div>
        </div>
    </details>
</div>
"""


def _action_payload(record: dict) -> dict:
    return {
        "path": record.get("path") or record.get("image_path", ""),
        "prompt": record.get("prompt", ""),
        "negative_prompt": record.get("negative_prompt", ""),
        "seed": str(record.get("seed", "")),
        "steps": int(record.get("steps", 0) or 0),
        "sampler": record.get("sampler", ""),
        "cfg_scale": float(record.get("cfg_scale", 0) or 0),
        "width": int(record.get("width", 0) or 0),
        "height": int(record.get("height", 0) or 0),
        "model_name": record.get("model_name", ""),
        "model_hash": record.get("model_hash", ""),
        "infotext": record.get("infotext", ""),
    }


def _parse_hires_info(infotext: str) -> dict:
    """Parse Hires Fix parameters from infotext. Returns dict with 'has_hires' and 'scale'."""
    result = {"has_hires": False, "scale": 1.0}
    if not infotext:
        return result

    info_lc = str(infotext or "").lower()
    hires_markers = ("hires upscale:", "hires upscaler:", "hires steps:", "first pass size:", "hires resize:")
    result["has_hires"] = any(marker in info_lc for marker in hires_markers)

    if result["has_hires"]:
        for line in (infotext or "").split(","):
            line_stripped = line.strip()
            if line_stripped.lower().startswith("hires upscale:"):
                try:
                    scale_str = line_stripped.split(":", 1)[1].strip()
                    result["scale"] = float(scale_str)
                    break
                except Exception:
                    pass

    return result


def _resolution_label(record: dict) -> str:
    try:
        w = int(record.get("width", 0) or 0)
        h = int(record.get("height", 0) or 0)
    except Exception:
        return ""

    if w <= 0 or h <= 0:
        return ""

    infotext = str(record.get("infotext", "") or "")
    hires_info = _parse_hires_info(infotext)

    if hires_info["has_hires"] and hires_info["scale"] > 1.0:
        final_w = int(w * hires_info["scale"])
        final_h = int(h * hires_info["scale"])
        return f"{final_w}x{final_h}"

    return f"{w}x{h}"


def _hires_marker_label(record: dict) -> str:
    """Return Hires Fix indicator if applicable."""
    infotext = str(record.get("infotext", "") or "")
    hires_info = _parse_hires_info(infotext)
    if hires_info["has_hires"] and hires_info["scale"] > 1.0:
        return f"🔼 Hires"
    return ""


def _generation_type_label(record: dict, path: str) -> str:
    """Infer generation type with metadata-first rules.

    Hires fix belongs to txt2img, but path-only checks can misclassify some outputs.
    """
    infotext = ""
    if isinstance(record, dict):
        infotext = str(record.get("infotext", "") or "")
    info_lc = infotext.lower()

    # Hires-fix markers are specific to txt2img and must win over path hints.
    hires_markers = (
        "hires upscale:",
        "hires upscaler:",
        "hires steps:",
        "first pass size:",
        "hires resize:",
    )
    if any(marker in info_lc for marker in hires_markers):
        return "txt2img"

    # Img2img/inpaint markers that are not normally present in plain txt2img.
    img2img_markers = (
        "init image hash:",
        "mask blur:",
        "inpaint area:",
        "inpainting mask weight:",
        "resize mode:",
    )
    if any(marker in info_lc for marker in img2img_markers):
        return "img2img"

    # Denoising strength exists in both img2img and txt2img+hires; at this point
    # there were no hires markers, so treat it as img2img.
    if "denoising strength:" in info_lc:
        return "img2img"

    candidates = [
        record.get("original_path", "") if isinstance(record, dict) else "",
        path or "",
    ]
    for candidate in candidates:
        p = str(candidate or "").replace("\\", "/").lower()
        if not p:
            continue
        if "txt2img" in p:
            return "txt2img"
        if "img2img" in p:
            return "img2img"

    return ""


def _seed_capsule_style(seed: str) -> str:
    """Color seed capsule with high separation for close/consecutive seeds."""
    raw = str(seed or "")
    digits = re.sub(r"\D", "", raw)
    if not raw:
        return ""

    # Keep only a sane amount of digits to avoid giant-int overhead.
    base_num = int(digits[-18:] or "0")

    # Golden-ratio hue progression strongly separates adjacent seeds.
    phi = 0.6180339887498949
    hue = (base_num * phi) % 1.0

    # Slight S/V variation from independent irrational strides.
    sat = 0.65 + (0.30 * ((base_num * 0.7548776662466927) % 1.0))
    val = 0.72 + (0.23 * ((base_num * 0.5698402909980532) % 1.0))

    rf, gf, bf = colorsys.hsv_to_rgb(hue, sat, val)
    r = int(rf * 255)
    g = int(gf * 255)
    bch = int(bf * 255)

    # Keep text readable against generated background.
    luminance = (0.2126 * r) + (0.7152 * g) + (0.0722 * bch)
    text_color = "#111111" if luminance > 145 else "#ffffff"

    return f' style="background: rgb({r}, {g}, {bch}); color: {text_color};"'


def _apply_removebg(path: str) -> tuple[bool, str]:
    source_path = os.path.abspath(path or "")
    if not source_path or not os.path.exists(source_path):
        return False, "Removebg failed: source image not found."

    try:
        with Image.open(source_path) as img:
            source_image = img.convert("RGBA")
            parameters, existing_pnginfo = images.read_info_from_image(img)
    except Exception as exc:
        return False, f"Removebg failed: could not open image ({exc})."

    if parameters:
        existing_pnginfo["parameters"] = parameters

    result_image, result_info = rembg_utils.remove_background_image(source_image)
    if result_image is None:
        err = result_info.get("error") or result_info.get("rembg") or "unknown error"
        return False, f"Removebg failed: {err}."

    infotext = ", ".join([
        k if k == v else f'{k}: {infotext_utils.quote(v)}'
        for k, v in result_info.items() if v is not None
    ])
    target_path = rembg_utils.build_removebg_target_path(source_path, ext=".png")
    target_dir = os.path.dirname(target_path)
    basename = os.path.splitext(os.path.basename(target_path))[0]

    fullfn, _ = images.save_image(
        result_image,
        path=target_dir,
        basename='',
        extension='png',
        info=infotext,
        short_filename=True,
        no_prompt=True,
        grid=False,
        pnginfo_section_name="removebg",
        existing_info=existing_pnginfo,
        forced_filename=basename,
        suffix='',
    )

    return True, f"Removebg saved: {_html.escape(fullfn)}"


def _card_html(record: dict, endorsed_id=None, disliked_id=None, tags: list | None = None, is_archived: bool = False, card_extras_mode: str = "Expanded") -> str:
    path = record.get("path") or record.get("image_path", "")
    prompt = record.get("prompt", "")
    seed = str(record.get("seed", ""))
    sampler = record.get("sampler", "")
    model = record.get("model_name", "")
    date = record.get("endorsed_at") or record.get("disliked_at") or ""
    if not date and record.get("file_mtime"):
        import datetime
        date = datetime.datetime.fromtimestamp(record["file_mtime"]).strftime("%Y-%m-%d %H:%M")

    thumb = _get_thumb(path) if path else ""
    preview_url = _get_preview_thumb(path) if path else ""
    orig_url = _file_url(path)
    resolution_label = _resolution_label(record)
    hires_marker = _hires_marker_label(record)
    generation_type_label = _generation_type_label(record, path)

    payload = _action_payload(record)
    endorse_action = {
        "type": "remove_endorse" if endorsed_id else "endorse",
        "id": int(endorsed_id or 0),
        "opposite_active": bool(disliked_id),
        **payload,
    }
    dislike_action = {
        "type": "remove_dislike" if disliked_id else "dislike",
        "id": int(disliked_id or 0),
        "opposite_active": bool(endorsed_id),
        **payload,
    }

    endorse_label = "⭐" if endorsed_id else "☆"
    endorse_class = "endgal-star active" if endorsed_id else "endgal-star"
    dislike_label = "👎" if disliked_id else "⬇"
    dislike_class = "endgal-dislike active" if disliked_id else "endgal-dislike"
    endorse_action_b64 = _b64(json.dumps(endorse_action))
    dislike_action_b64 = _b64(json.dumps(dislike_action))

    item_key = endorsement_db._item_key_from_path(path)
    infotext = record.get("infotext", "")
    infotext_b64 = _b64(infotext)
    path_b64 = _b64(path)
    archive_action = _b64(json.dumps({"type": "unarchive" if is_archived else "archive", "item_key": item_key, **_action_payload(record)}))
    archive_label = "📤" if is_archived else "📦"
    archive_class = "endgal-archive active" if is_archived else "endgal-archive"
    archive_title = "unarchive" if is_archived else "archive (hide from Unrated)"

    tags = tags or []
    # Top 20 tags for display; full list encoded for preview
    tags_display = tags[:20]
    tags_full_b64 = _b64(json.dumps(tags))
    tags_pills_html = "".join(
        f'<span class="endgal-tag-pill">{_html.escape(t.replace("_", " "))}</span>'
        for t in tags_display
    )

    left_badge = ""
    if resolution_label or hires_marker:
        badge_lines = []
        if resolution_label:
            badge_lines.append(_html.escape(resolution_label))
        if hires_marker:
            badge_lines.append(_html.escape(hires_marker))
        left_badge_content = "<br>".join(badge_lines)
        left_badge = f'<span class="endgal-thumb-badge endgal-thumb-badge-left">{left_badge_content}</span>'
    
    right_badge = (
        f'<span class="endgal-thumb-badge endgal-thumb-badge-right">{_html.escape(generation_type_label)}</span>'
        if generation_type_label else ""
    )
    thumb_badges = (
        f'<div class="endgal-thumb-overlay">{left_badge}{right_badge}</div>'
        if (left_badge or right_badge) else ""
    )

    thumb_html = (
        f'<img src="{thumb}" alt="generated image" loading="lazy" '
        f'data-orig="{orig_url}" '
        f'data-preview="{preview_url}" '
        f'data-infotext="{infotext_b64}" '
        f'data-endorse-action="{endorse_action_b64}" '
        f'data-dislike-action="{dislike_action_b64}" '
        f'data-endorse-label="{endorse_label}" '
        f'data-dislike-label="{dislike_label}" '
        f'data-tags="{tags_full_b64}" '
        f'onclick="endorsedGallery.previewImage(this.dataset.preview || this.dataset.orig || this.src)" />'
    ) if thumb else '<div class="endgal-nothumb">No preview</div>'
    thumb_html = thumb_html + thumb_badges

    tags_section = (
        f'<details class="endgal-details endgal-tags-details">'
        f'<summary>Caption ({len(tags_display)})</summary>'
        f'<div class="endgal-tags">{tags_pills_html}</div>'
        f'</details>'
        if tags_pills_html else ''
    )

    details_open = _extras_details_open_attr(card_extras_mode)

    def _split_infotext_sections(info_text: str, prompt_fallback: str, negative_fallback: str):
        prompt_text = (prompt_fallback or "").strip()
        negative_text = (negative_fallback or "").strip()
        settings_text = ""

        full = str(info_text or "").strip()
        if full:
            neg_match = re.search(r"(?i)\bNegative\s+prompt\s*:\s*", full)
            steps_match = re.search(r"(?i)(?:^|[\n,]\s*)(Steps\s*:)", full)

            steps_start = steps_match.start(1) if steps_match else -1

            if neg_match:
                prompt_chunk = full[:neg_match.start()].strip().rstrip(",")
                if prompt_chunk:
                    prompt_text = prompt_chunk

                neg_start = neg_match.end()
                neg_end = steps_start if steps_start >= 0 and steps_start > neg_start else len(full)
                negative_chunk = full[neg_start:neg_end].strip().rstrip(",")
                if negative_chunk:
                    negative_text = negative_chunk

                if steps_start >= 0:
                    settings_text = full[steps_start:].lstrip(", ").strip()
            else:
                if steps_start >= 0:
                    prompt_chunk = full[:steps_start].strip().rstrip(",")
                    if prompt_chunk:
                        prompt_text = prompt_chunk
                    settings_text = full[steps_start:].lstrip(", ").strip()
                else:
                    prompt_text = full

        if not settings_text:
            settings_text = str(info_text or "").strip()

        if not prompt_text:
            prompt_text = "(empty)"
        if not negative_text:
            negative_text = "(empty)"
        if not settings_text:
            settings_text = "(empty)"

        return prompt_text, negative_text, settings_text

    steps = str(record.get("steps", ""))
    cfg_scale = str(record.get("cfg_scale", ""))
    seed_short = seed[:3] + "..." + seed[-3:] if len(seed) > 8 else seed

    def infotext_param(key: str) -> str:
        pat = re.compile(
            rf'(^|,\\s*){re.escape(key)}:\\s*(?:"((?:\\\\.|[^"])+)"|([^,\\n]*))',
            re.IGNORECASE,
        )
        m = pat.search(infotext or "")
        if not m:
            return ""
        return (m.group(2) or m.group(3) or "").strip()

    hires_stage_capsules = []
    hires_stages_raw = infotext_param("Hires stages")
    if hires_stages_raw:
        for stage in [s.strip() for s in hires_stages_raw.split(",") if s.strip()]:
            hires_stage_capsules.append(
                f'<span class="endgal-capsule endgal-capsule-hires">H:{_html.escape(stage)}</span>'
            )
    else:
        hires_scale = infotext_param("Hires upscale")
        hires_steps = infotext_param("Hires steps")
        if hires_scale and hires_steps:
            hires_stage_capsules.append(
                f'<span class="endgal-capsule endgal-capsule-hires">H:{_html.escape(hires_scale)}/{_html.escape(hires_steps)}</span>'
            )

    seed_capsule_style = _seed_capsule_style(seed)

    settings_capsules = (
        f'<span class="endgal-capsule endgal-capsule-steps">Steps: {_html.escape(steps)}</span>'
        f'<span class="endgal-capsule endgal-capsule-cfg">CFG: {_html.escape(cfg_scale)}</span>'
        f'<span class="endgal-capsule endgal-capsule-seed"{seed_capsule_style}>Seed: {_html.escape(seed_short)}</span>'
        + "".join(hires_stage_capsules)
    )

    prompt_full, negative_full, settings_full = _split_infotext_sections(infotext, prompt, record.get("negative_prompt", ""))
    prompt_b64 = _b64(prompt_full)
    negative_b64 = _b64(negative_full)
    settings_b64 = _b64(settings_full)

    info_overlay = (
        f'<div class="endgal-thumb-meta-overlay">'
        f'  <div class="endgal-capsules endgal-capsules-overlay">{settings_capsules}</div>'
        f'  <div class="endgal-date endgal-date-overlay">{_html.escape(date)}</div>'
        f'</div>'
    )

    corner_action_stack = (
        '<div class="endgal-thumb-corner-actions">'
        f'<button class="{endorse_class} endgal-act-endorse" data-hint="Toggle endorse" title="toggle endorse" onclick="endorsedGallery.action(\'{endorse_action_b64}\')">{endorse_label}</button>'
        f'<button class="{archive_class} endgal-act-archive" data-hint="{_html.escape(archive_title)}" title="{archive_title}" onclick="endorsedGallery.action(\'{archive_action}\')">{archive_label}</button>'
        f'<button class="{dislike_class} endgal-act-dislike" data-hint="Toggle dislike" title="toggle dislike" onclick="endorsedGallery.action(\'{dislike_action_b64}\')">{dislike_label}</button>'
        '</div>'
    )

    thumb_action_stack = (
        '<div class="endgal-thumb-actions">'
        f'<button class="endgal-btn-send2img endgal-act-t2i" data-icon="📝" data-hint="Send to txt2img" title="send to txt2img" onclick="endorsedGallery.sendTo(\'{infotext_b64}\', \'txt2img\')">📝</button>'
        f'<button class="endgal-btn-send2img endgal-act-fire" data-icon="🔥" data-hint="Queue fire jobs" title="queue txt2img override jobs from fire config" onclick="endorsedGallery.queueTxt2ImgFire(\'{infotext_b64}\')">🔥</button>'
        f'<button class="endgal-btn-send2img endgal-act-i2i" data-icon="🖼" data-hint="Send to img2img" title="send to img2img" onclick="endorsedGallery.sendTo(\'{infotext_b64}\', \'img2img\', \'{path_b64}\')">🖼</button>'
        f'<button class="endgal-btn-send2img endgal-act-removebg" data-icon="✂" data-hint="Remove background" title="remove background" onclick="endorsedGallery.action(\'{_b64(json.dumps({"type": "removebg", **payload}))}\')">✂</button>'
        f'<button class="endgal-btn-send2img endgal-act-extras" data-icon="✨" data-hint="Send to extras" title="send to extras" onclick="endorsedGallery.sendToExtras(\'{path_b64}\')">✨</button>'
        '</div>'
    )

    return f"""
<div class="endgal-card {'endorsed' if endorsed_id else ''} {'disliked' if disliked_id else ''}">
    <div class="endgal-thumb">{thumb_html}{corner_action_stack}{info_overlay}{thumb_action_stack}</div>
    <details class="endgal-card-extra"{details_open}>
        <summary class="endgal-card-extra-summary">Details</summary>
        <div class="endgal-body">
            <div class="endgal-prompt oneline">{_html.escape(prompt)}</div>
            {tags_section}
            <details class="endgal-details">
                <summary>Prompt</summary>
                <pre class="endgal-infotext endgal-copy-text" title="Click to copy" onclick="endorsedGallery.copyTextB64('{prompt_b64}', this)">{_html.escape(prompt_full)}</pre>
            </details>
            <details class="endgal-details">
                <summary>Negative prompt</summary>
                <pre class="endgal-infotext endgal-copy-text" title="Click to copy" onclick="endorsedGallery.copyTextB64('{negative_b64}', this)">{_html.escape(negative_full)}</pre>
            </details>
            <details class="endgal-details">
                <summary>Settings</summary>
                <pre class="endgal-infotext endgal-copy-text" title="Click to copy" onclick="endorsedGallery.copyTextB64('{settings_b64}', this)">{_html.escape(settings_full)}</pre>
            </details>
        </div>
    </details>
</div>
"""


def _load_image_for_apply(path: str):
    try:
        if not path or not os.path.exists(path):
            return None
        with Image.open(path) as img:
            return img.convert("RGBA")
    except Exception:
        return None


def _date_filter_to_since_ts(date_filter: str):
    value = (date_filter or "").strip().lower()
    if value in ("", "all", "all time"):
        return None

    days_map = {
        "1 day": 1,
        "1days": 1,
        "2 days": 2,
        "2days": 2,
        "1 week": 7,
        "1week": 7,
    }
    days = days_map.get(value)
    if not days:
        return None
    return time.time() - (days * 24 * 60 * 60)


def _record_timestamp(record: dict):
    file_mtime = record.get("file_mtime")
    if file_mtime is not None:
        try:
            return float(file_mtime)
        except Exception:
            pass

    for key in ("endorsed_at", "disliked_at"):
        val = record.get(key)
        if not val:
            continue
        try:
            return datetime.datetime.fromisoformat(str(val)).timestamp()
        except Exception:
            continue

    return None


def _filter_rows_by_date(rows: list, since_ts):
    if since_ts is None:
        return rows

    filtered = []
    for row in rows:
        ts = _record_timestamp(row)
        if ts is None:
            continue
        if ts >= since_ts:
            filtered.append(row)
    return filtered


def _call_db(fn_name: str, *args, **kwargs):
    fn = getattr(endorsement_db, fn_name, None)
    if not fn:
        raise AttributeError(fn_name)

    try:
        return fn(*args, **kwargs)
    except TypeError as e:
        # Compatibility path for runtimes that still expose older DB function signatures.
        if "unexpected keyword argument" not in str(e):
            raise
        kwargs_compat = dict(kwargs)
        kwargs_compat.pop("since_ts", None)
        return fn(*args, **kwargs_compat)


def _fetch_mode_records(mode: str, query: str, page: int, page_size: int, date_filter: str):
    page = max(1, int(page or 1))
    page_size = max(12, int(page_size or PAGE_SIZE_DEFAULT))
    offset = (page - 1) * page_size
    since_ts = _date_filter_to_since_ts(date_filter)

    if mode == "⭐ Endorsed":
        if hasattr(endorsement_db, "count_endorsements") and hasattr(endorsement_db, "search_endorsements"):
            total = _call_db("count_endorsements", query, exclude_disliked=True, since_ts=since_ts)
            rows = _call_db(
                "search_endorsements",
                query,
                limit=page_size,
                offset=offset,
                exclude_disliked=True,
                since_ts=since_ts,
            )
        else:
            # Backward-compatible fallback for older endorsement_db runtime.
            rows_all = endorsement_db.search(query)
            disliked_paths = endorsement_db.get_disliked_paths() if hasattr(endorsement_db, "get_disliked_paths") else set()
            filtered = [r for r in rows_all if r.get("image_path", "") not in disliked_paths]
            filtered = _filter_rows_by_date(filtered, since_ts)
            total = len(filtered)
            rows = filtered[offset: offset + page_size]
    elif mode == "🎨 Composed":
        rows, total = _fetch_composed_records(query, page, page_size)
    elif mode == "⬜ Unrated":
        if hasattr(endorsement_db, "count_unrated") and hasattr(endorsement_db, "search_unrated"):
            total = _call_db("count_unrated", query, since_ts=since_ts)
            rows = _call_db("search_unrated", query, limit=page_size, offset=offset, since_ts=since_ts)
        else:
            total = 0
            rows = []
    elif mode == "📦 Archived":
        if hasattr(endorsement_db, "count_archived") and hasattr(endorsement_db, "search_archived"):
            total = _call_db("count_archived", query, since_ts=since_ts)
            rows = _call_db("search_archived", query, limit=page_size, offset=offset, since_ts=since_ts)
        else:
            total = 0
            rows = []
    elif mode == "👎 Disliked":
        if hasattr(endorsement_db, "count_disliked") and hasattr(endorsement_db, "search_disliked"):
            total = _call_db("count_disliked", query, since_ts=since_ts)
            rows = _call_db("search_disliked", query, limit=page_size, offset=offset, since_ts=since_ts)
        else:
            total = 0
            rows = []
    else:
        # Preferred fast path with paged SQL + dislike exclusion.
        if hasattr(endorsement_db, "count_generated_filtered"):
            total = _call_db("count_generated_filtered", query, exclude_disliked=True, since_ts=since_ts)
        else:
            # Compatibility for runtimes where the helper is not present.
            if query.strip():
                if hasattr(endorsement_db, "search_generated"):
                    try:
                        total = len(_call_db("search_generated", query, limit=0, offset=0, exclude_disliked=True, since_ts=since_ts))
                    except TypeError:
                        total = len(endorsement_db.search_generated(query, limit=0))
                else:
                    total = endorsement_db.count_generated()
            else:
                total = endorsement_db.count_generated()

        if hasattr(endorsement_db, "search_generated"):
            try:
                rows = _call_db(
                    "search_generated",
                    query,
                    limit=page_size,
                    offset=offset,
                    exclude_disliked=True,
                    since_ts=since_ts,
                )
            except TypeError:
                rows_all = endorsement_db.search_generated(query, limit=0) if query.strip() else endorsement_db.search_generated(limit=0)
                disliked_paths = endorsement_db.get_disliked_paths() if hasattr(endorsement_db, "get_disliked_paths") else set()
                filtered = [r for r in rows_all if r.get("path", "") not in disliked_paths]
                filtered = _filter_rows_by_date(filtered, since_ts)
                total = len(filtered)
                rows = filtered[offset: offset + page_size]
        else:
            rows = []

    return total, rows


def _thumb_size_css_class(thumb_size: str) -> str:
    label = (thumb_size or "Medium").strip().lower()
    if label.startswith("s"):
        return "endgal-thumb-small"
    if label.startswith("l"):
        return "endgal-thumb-large"
    return "endgal-thumb-medium"


def render_gallery(mode: str, query: str, page: int, page_size: int, date_filter: str, thumb_size: str, card_extras_mode: str):
    total, rows = _fetch_mode_records(mode, query, page, page_size, date_filter)
    pages = max(1, (total + int(page_size) - 1) // int(page_size))
    page = max(1, min(int(page), pages))
    size_class = _thumb_size_css_class(thumb_size)
    card_min = THUMB_SIZE_PRESETS.get((thumb_size or "Medium").strip().title(), THUMB_SIZE_PRESETS["Medium"])

    if page != int(page or 1):
        total, rows = _fetch_mode_records(mode, query, page, page_size, date_filter)

    # Detect if we're on the last page with content
    is_last_page = (page >= pages) and total > 0

    if mode == "🖼 All Generated" and endorsement_db.count_generated() == 0:
        hint = (
            '<div class="endgal-sync-hint">No images indexed yet. Click <b>Sync All</b> first.</div>'
        )
        return hint, f"0 items · page 1/1", 1, is_last_page

    if not rows:
        return '<div class="endgal-empty">No images found for this filter.</div>', f"0 items · page 1/1", 1, is_last_page

    # Composed mode: use a simplified card that skips DB lookups and shows a "→ Composer" button.
    if mode == "🎨 Composed":
        cards = [_composed_card_html(rec, card_extras_mode=card_extras_mode) for rec in rows]
        header = f'<div class="endgal-count">{total} composed image(s)</div>'
        grid = f'<div class="endgal-grid endgal-composed-grid {size_class}" style="--endgal-card-min:{card_min}px">' + "".join(cards) + "</div>"
        page_info = f"{total} items · page {page}/{pages}"
        return header + grid, page_info, page, is_last_page

    # Batch-fetch tags and archived status for all cards on this page
    item_keys = [
        endorsement_db._item_key_from_path(r.get("path") or r.get("image_path", ""))
        for r in rows
    ]
    valid_keys = [k for k in item_keys if k]
    tags_map = endorsement_db.get_tags_for_items(valid_keys)
    archived_keys = endorsement_db.get_archived_item_keys(valid_keys) if hasattr(endorsement_db, "get_archived_item_keys") else set()

    cards = []
    for rec, item_key in zip(rows, item_keys):
        path = rec.get("path") or rec.get("image_path", "")
        eid = endorsement_db.get_endorsed_id_by_path(path)
        did = endorsement_db.get_disliked_id_by_path(path)
        tags = tags_map.get(item_key, [])
        is_arch = item_key in archived_keys
        cards.append(_card_html(rec, endorsed_id=eid, disliked_id=did, tags=tags, is_archived=is_arch, card_extras_mode=card_extras_mode))

    header = f'<div class="endgal-count">{total} items</div>'
    grid = f'<div class="endgal-grid {size_class}" style="--endgal-card-min:{card_min}px" data-is-last-page="{str(is_last_page).lower()}">' + "".join(cards) + "</div>"
    page_info = f"{total} items · page {page}/{pages}"
    return header + grid, page_info, page, is_last_page


def _reset_to_first_page(mode, query, page_size, date_filter, thumb_size, card_extras_mode):
    html, info, page, is_last = render_gallery(mode, query, 1, int(page_size or PAGE_SIZE_DEFAULT), date_filter, thumb_size, card_extras_mode)
    return html, info, info, page


def _goto_prev_page(mode, query, page, page_size, date_filter, thumb_size, card_extras_mode):
    new_page = max(1, int(page or 1) - 1)
    html, info, page, is_last = render_gallery(mode, query, new_page, int(page_size or PAGE_SIZE_DEFAULT), date_filter, thumb_size, card_extras_mode)
    return html, info, info, page


def _goto_next_page(mode, query, page, page_size, date_filter, thumb_size, card_extras_mode):
    current_page = int(page or 1)
    page_size_int = int(page_size or PAGE_SIZE_DEFAULT)
    
    # Get current page info to check if already at last page
    total, rows = _fetch_mode_records(mode, query, current_page, page_size_int, date_filter)
    pages = max(1, (total + page_size_int - 1) // page_size_int)
    
    # If already on last page, don't go further but signal end-of-gallery
    if current_page >= pages:
        html, info, page, is_last = render_gallery(mode, query, current_page, page_size_int, date_filter, thumb_size, card_extras_mode)
        # Add end-of-gallery hint to info
        hint_html = '<div id="endgal_end_hint" class="endgal-sync-result">All images are over.</div>'
        html_with_hint = html + hint_html
        return html_with_hint, info, info, page
    
    new_page = current_page + 1
    html, info, page, is_last = render_gallery(mode, query, new_page, page_size_int, date_filter, thumb_size, card_extras_mode)
    return html, info, info, page


def handle_gallery_action(action_json: str, mode: str, query: str, page: int, page_size: int, date_filter: str, thumb_size: str, card_extras_mode: str):
    try:
        data = json.loads(action_json) if action_json.strip() else {}
    except Exception:
        data = {}

    t = data.get("type", "")
    status_message = ""
    if t == "endorse":
        _endorse_path = data.get("path", "")
        endorsement_db.endorse(
            _endorse_path,
            data.get("prompt", ""),
            data.get("negative_prompt", ""),
            str(data.get("seed", "")),
            int(data.get("steps", 0) or 0),
            data.get("sampler", ""),
            float(data.get("cfg_scale", 0) or 0),
            int(data.get("width", 0) or 0),
            int(data.get("height", 0) or 0),
            data.get("model_name", ""),
            data.get("model_hash", ""),
            data.get("infotext", ""),
        )
        gallery_tagger.queue_tag(_endorse_path, "endorse")
    elif t == "remove_endorse":
        eid = int(data.get("id", 0) or 0)
        if eid > 0:
            endorsement_db.delete_endorsement(eid)
        else:
            path = data.get("path", "")
            if path:
                endorsement_db.delete_endorsement_by_path(path)
    elif t == "dislike":
        path = data.get("path", "")
        endorsement_db.dislike(
            path,
            data.get("prompt", ""),
            data.get("negative_prompt", ""),
            str(data.get("seed", "")),
            int(data.get("steps", 0) or 0),
            data.get("sampler", ""),
            float(data.get("cfg_scale", 0) or 0),
            int(data.get("width", 0) or 0),
            int(data.get("height", 0) or 0),
            data.get("model_name", ""),
            data.get("model_hash", ""),
            data.get("infotext", ""),
        )
        endorsement_db.delete_endorsement_by_path(path)
        gallery_tagger.queue_tag(path, "dislike")
    elif t == "remove_dislike":
        did = int(data.get("id", 0) or 0)
        if did > 0:
            endorsement_db.delete_dislike(did)
        else:
            path = data.get("path", "")
            if path:
                endorsement_db.delete_dislike_by_path(path)
    elif t == "archive":
        item_key = data.get("item_key") or endorsement_db._item_key_from_path(data.get("path", ""))
        if item_key:
            endorsement_db.archive_item(item_key)
    elif t == "unarchive":
        item_key = data.get("item_key") or endorsement_db._item_key_from_path(data.get("path", ""))
        if item_key:
            endorsement_db.unarchive_item(item_key)
    elif t == "archive_all_unrated":
        count = endorsement_db.archive_all_unrated()
        status_message = f'<div class="endgal-sync-result">Archived {count} unrated image(s).</div>'
    elif t == "removebg":
        ok, status_message = _apply_removebg(data.get("path", ""))
        if not ok:
            status_message = f'<div class="endgal-sync-result">{_html.escape(status_message)}</div>'
        else:
            status_message = f'<div class="endgal-sync-result">{status_message}</div>'

    html, info, page, is_last = render_gallery(mode, query, page, page_size, date_filter, thumb_size, card_extras_mode)
    
    # If gallery became empty after action (e.g., endorsed last image and filter changed), show hint
    if '<div class="endgal-empty">' in html:
        hint_html = '<div id="endgal_end_hint" class="endgal-sync-result">All images are over.</div>'
        html = html + hint_html
    # If still on last page with content, show hint
    elif is_last:
        hint_html = '<div id="endgal_end_hint" class="endgal-sync-result">All images are over.</div>'
        html = html + hint_html
    
    return status_message, html, info, info, page


def get_keyword_insights_html(mode: str = "", query: str = "", date_filter: str = ""):
    """Generator: yields progress HTML while tagging, then yields the final analysis."""
    since_ts = _date_filter_to_since_ts(date_filter)

    # Always use both endorsed and disliked items matching the filter for comparison
    endorse_items = endorsement_db.get_all_endorsed_items(query, since_ts)
    dislike_items = endorsement_db.get_all_disliked_items(query, since_ts)

    filter_desc_parts = []
    if query.strip():
        filter_desc_parts.append(f"search: \"{_html.escape(query.strip())}\"")
    if date_filter and date_filter.lower() not in ("", "all time", "all"):
        filter_desc_parts.append(_html.escape(date_filter))
    filter_desc = " · ".join(filter_desc_parts) if filter_desc_parts else "all time"
    scope_line = f"{len(endorse_items)} endorsed, {len(dislike_items)} disliked in filter ({filter_desc})"

    # Stream progress while tagging un-captioned images
    tagged = 0
    skipped = 0
    for done, total, tagged, skipped in gallery_tagger.iter_tag_untagged_filtered(endorse_items, dislike_items):
        if total == 0:
            break
        bar_pct = int(done / total * 100)
        yield (
            f'<div class="endgal-insights-status">{scope_line}</div>'
            f'<div class="endgal-insights-progress">'
            f'  <div class="endgal-progress-label">Captioning images: {done}/{total}'
            f'  ({tagged} tagged, {skipped} skipped)</div>'
            f'  <div class="endgal-progress-bar-wrap">'
            f'    <div class="endgal-progress-bar" style="width:{bar_pct}%"></div>'
            f'  </div>'
            f'</div>'
        )

    # Build final status line
    status_parts = [scope_line]
    if tagged:
        status_parts.append(f"{tagged} newly captioned")
    if skipped:
        status_parts.append(f"{skipped} skipped (file missing)")
    status_html = f'<div class="endgal-insights-status">{" · ".join(status_parts)}</div>'

    endorse_keys = {k for _, k in endorse_items if k}
    dislike_keys = {k for _, k in dislike_items if k}
    analysis = endorsement_db.get_tag_analysis_filtered(endorse_keys, dislike_keys, min_appearances=1)
    add_tags = analysis["add"][:50]
    remove_tags = analysis["remove"][:50]

    if not add_tags and not remove_tags:
        if not endorse_items and not dislike_items:
            yield status_html + '<div class="endgal-insights-empty">No endorsed or disliked images match this filter.</div>'
            return
        yield status_html + '<div class="endgal-insights-empty">Not enough tag data yet — try endorsing or disliking more images.</div>'
        return

    def tag_rows(entries):
        rows = []
        for entry in entries:
            tag = entry["tag"].replace("_", " ")
            e = entry["endorse_count"]
            d = entry["dislike_count"]
            avg = entry["endorse_avg"] if e else entry["dislike_avg"]
            rows.append(
                f'<tr>'
                f'<td class="endgal-tag-name">{_html.escape(tag)}</td>'
                f'<td class="endgal-tag-counts">+{e}&nbsp;/&nbsp;-{d}</td>'
                f'<td class="endgal-tag-score">{avg:.2f}</td>'
                f'</tr>'
            )
        return "\n".join(rows)

    table_head = '<thead><tr><th>Tag</th><th>+liked / -disliked</th><th>Conf.</th></tr></thead>'

    add_section = (
        f'<div class="endgal-insights-col">'
        f'<div class="endgal-insights-header endgal-add-header">\u2705 Add to prompt ({len(add_tags)})</div>'
        f'<div class="endgal-insights-hint">More common in endorsed images</div>'
        f'<table class="endgal-tag-table">{table_head}<tbody>{tag_rows(add_tags)}</tbody></table>'
        f'</div>'
    ) if add_tags else ''

    remove_section = (
        f'<div class="endgal-insights-col">'
        f'<div class="endgal-insights-header endgal-remove-header">\u274c Remove from prompt ({len(remove_tags)})</div>'
        f'<div class="endgal-insights-hint">More common in disliked images</div>'
        f'<table class="endgal-tag-table">{table_head}<tbody>{tag_rows(remove_tags)}</tbody></table>'
        f'</div>'
    ) if remove_tags else ''

    yield status_html + f'<div class="endgal-insights-grid">{add_section}{remove_section}</div>'


def on_ui_tabs():
    with gr.Blocks(analytics_enabled=False) as gallery_ui:
        with gr.Row(elem_id="endgal_mode_row"):
            mode_radio = gr.Radio(
                choices=["⭐ Endorsed", "🖼 All Generated", "⬜ Unrated", "🎨 Composed", "📦 Archived", "👎 Disliked"],
                value="⭐ Endorsed",
                label="",
                elem_id="endgal_mode_radio",
            )
            with gr.Row(elem_id="endgal_primary_actions", variant="compact"):
                refresh_btn = gr.Button("Refresh", elem_id="endgal_refresh_btn", size="sm")
                archive_unrated_btn = gr.Button("📦 Archive Unrated", elem_id="endgal_archive_unrated_btn", size="sm")

        with gr.Accordion("Advanced Gallery Settings", open=False, elem_id="endgal_advanced_controls"):
            with gr.Row(elem_id="endgal_controls_row"):
                search_box = gr.Textbox(
                    value="",
                    placeholder="",
                    label="Search",
                    elem_id="endgal_search_box",
                    scale=6,
                )

            with gr.Row(elem_id="endgal_settings_row"):
                page_size = gr.Dropdown(
                    choices=["24", "48", "96"],
                    value=str(PAGE_SIZE_DEFAULT),
                    label="Page Size",
                    elem_id="endgal_page_size",
                    scale=1,
                    filterable=False,
                )
                date_filter = gr.Dropdown(
                    choices=["All time", "1 day", "2 days", "1 week"],
                    value="1 day",
                    label="Date",
                    elem_id="endgal_date_filter",
                    scale=1,
                    filterable=False,
                )
                thumb_size = gr.Dropdown(
                    choices=["Small", "Medium", "Large"],
                    value="Medium",
                    label="Thumb Size",
                    elem_id="endgal_thumb_size",
                    scale=1,
                    filterable=False,
                )
                with gr.Column(scale=2, min_width=280):
                    with gr.Row(elem_id="endgal_extras_refresh_pair", variant="compact"):
                        card_extras_mode = gr.Dropdown(
                            choices=["Expanded", "Folded"],
                            value="Folded",
                            label="Card Extras",
                            elem_id="endgal_card_extras_mode",
                            scale=1,
                            filterable=False,
                        )
                        auto_refresh_interval = gr.Dropdown(
                            choices=["Off", "10s", "20s", "30s", "60s"],
                            value="10s",
                            label="Auto Refresh",
                            elem_id="endgal_auto_refresh_interval",
                            scale=1,
                            filterable=False,
                        )
                sync_btn = gr.Button("Sync All", elem_id="endgal_sync_btn", size="sm", scale=1)

            with gr.Row(elem_id="endgal_hires_preset_row"):
                hires_override_config = gr.Textbox(
                    value=_load_fire_override_config(),
                    lines=2,
                    label="Queue Fire Config (one override set per line, comma-separated key:value)",
                    placeholder="steps: 14\nsteps: 18, cfg scale: 6.5\nhires steps: 10, denoising strength: 0.4",
                    elem_id="endgal_hires_override_config",
                    scale=8,
                )
                rebuild_fire_suggest_btn = gr.Button(
                    "Rebuild Suggest DB",
                    elem_id="endgal_rebuild_fire_suggest_btn",
                    size="sm",
                    scale=1,
                )

        with gr.Row(elem_id="endgal_pager_row"):
            prev_btn = gr.Button("Prev", elem_id="endgal_prev_btn", size="sm")
            next_btn = gr.Button("Next", elem_id="endgal_next_btn", size="sm")
            page_info = gr.HTML(value="0 items · page 1/1", elem_id="endgal_page_info")

        sync_status = gr.HTML(value="", elem_id="endgal_sync_status")
        gallery_html = gr.HTML(value="<div class='endgal-empty'>Click Refresh to load.</div>", elem_id="endgal_html")

        with gr.Row(elem_id="endgal_pager_row_bottom"):
            prev_btn_bottom = gr.Button("Prev", elem_id="endgal_prev_btn_bottom", size="sm")
            next_btn_bottom = gr.Button("Next", elem_id="endgal_next_btn_bottom", size="sm")
            page_info_bottom = gr.HTML(value="0 items · page 1/1", elem_id="endgal_page_info_bottom")

        page_state = gr.Number(value=1, precision=0, visible=False, elem_id="endgal_page_state")

        action_input = gr.Textbox(value="", visible=False, elem_id="endorsed_gallery_action_input")
        action_btn = gr.Button("", visible=False, elem_id="endorsed_gallery_action_btn")

        infotext_for_apply = gr.Textbox(value="", visible=False, elem_id="endorsed_gallery_infotext_apply")
        image_path_for_apply = gr.Textbox(value="", visible=False, elem_id="endorsed_gallery_image_path_apply")
        image_for_apply = gr.Image(value=None, visible=False, type="pil", elem_id="endorsed_gallery_image_apply")
        load_image_btn = gr.Button("", visible=False, elem_id="endorsed_gallery_load_image_btn")
        apply_txt2img_btn = gr.Button("", visible=False, elem_id="endorsed_gallery_apply_txt2img_btn")
        apply_img2img_btn = gr.Button("", visible=False, elem_id="endorsed_gallery_apply_img2img_btn")
        apply_extras_btn = gr.Button("", visible=False, elem_id="endorsed_gallery_apply_extras_btn")
        save_fire_cfg_btn = gr.Button("", visible=False, elem_id="endgal_fire_config_save_btn")
        fire_cfg_save_state = gr.Textbox(value="", visible=False, elem_id="endgal_fire_config_save_state")
        fire_value_suggestions_json = gr.Textbox(
            value=_get_fire_value_suggestions_json(),
            visible=False,
            elem_id="endgal_fire_value_suggestions_json",
        )

        for btn, tabname in [(apply_txt2img_btn, "txt2img"), (apply_img2img_btn, "img2img")]:
            infotext_utils.register_paste_params_button(
                infotext_utils.ParamBinding(
                    paste_button=btn,
                    tabname=tabname,
                    source_text_component=infotext_for_apply,
                )
            )

        infotext_utils.register_paste_params_button(
            infotext_utils.ParamBinding(
                paste_button=apply_extras_btn,
                tabname="extras",
                source_image_component=image_for_apply,
            )
        )

        load_image_btn.click(
            fn=_load_image_for_apply,
            inputs=[image_path_for_apply],
            outputs=[image_for_apply],
            show_progress=False,
        )

        save_fire_cfg_btn.click(
            fn=_save_fire_override_config,
            inputs=[hires_override_config],
            outputs=[fire_cfg_save_state],
            show_progress=False,
        )

        rebuild_fire_suggest_btn.click(
            fn=_rebuild_fire_suggestion_database,
            inputs=[],
            outputs=[sync_status, fire_value_suggestions_json],
        )

        def do_sync(mode, query, pg, size, date_filter, thumb_size, card_extras_mode):
            msg = sync_all_to_db()
            html, info, page, is_last = render_gallery(mode, query, pg, int(size), date_filter, thumb_size, card_extras_mode)
            return f'<div class="endgal-sync-result">{_html.escape(msg)}</div>', html, info, info, page

        def do_archive_unrated(mode, query, pg, size, date_filter, thumb_size, card_extras_mode):
            action_json = json.dumps({"type": "archive_all_unrated"})
            status, html, info, info2, page = handle_gallery_action(
                action_json, mode, query, pg, int(size), date_filter, thumb_size, card_extras_mode
            )
            return status, html, info, info2, page

        refresh_btn.click(
            fn=_reset_to_first_page,
            inputs=[mode_radio, search_box, page_size, date_filter, thumb_size, card_extras_mode],
            outputs=[gallery_html, page_info, page_info_bottom, page_state],
        )
        mode_radio.change(
            fn=_reset_to_first_page,
            inputs=[mode_radio, search_box, page_size, date_filter, thumb_size, card_extras_mode],
            outputs=[gallery_html, page_info, page_info_bottom, page_state],
        )
        search_box.submit(
            fn=_reset_to_first_page,
            inputs=[mode_radio, search_box, page_size, date_filter, thumb_size, card_extras_mode],
            outputs=[gallery_html, page_info, page_info_bottom, page_state],
        )
        page_size.change(
            fn=_reset_to_first_page,
            inputs=[mode_radio, search_box, page_size, date_filter, thumb_size, card_extras_mode],
            outputs=[gallery_html, page_info, page_info_bottom, page_state],
        )
        date_filter.change(
            fn=_reset_to_first_page,
            inputs=[mode_radio, search_box, page_size, date_filter, thumb_size, card_extras_mode],
            outputs=[gallery_html, page_info, page_info_bottom, page_state],
        )
        thumb_size.change(
            fn=_reset_to_first_page,
            inputs=[mode_radio, search_box, page_size, date_filter, thumb_size, card_extras_mode],
            outputs=[gallery_html, page_info, page_info_bottom, page_state],
        )
        card_extras_mode.change(
            fn=_reset_to_first_page,
            inputs=[mode_radio, search_box, page_size, date_filter, thumb_size, card_extras_mode],
            outputs=[gallery_html, page_info, page_info_bottom, page_state],
        )

        prev_btn.click(
            fn=_goto_prev_page,
            inputs=[mode_radio, search_box, page_state, page_size, date_filter, thumb_size, card_extras_mode],
            outputs=[gallery_html, page_info, page_info_bottom, page_state],
        )
        next_btn.click(
            fn=_goto_next_page,
            inputs=[mode_radio, search_box, page_state, page_size, date_filter, thumb_size, card_extras_mode],
            outputs=[gallery_html, page_info, page_info_bottom, page_state],
        )

        prev_btn_bottom.click(
            fn=_goto_prev_page,
            inputs=[mode_radio, search_box, page_state, page_size, date_filter, thumb_size, card_extras_mode],
            outputs=[gallery_html, page_info, page_info_bottom, page_state],
        )
        next_btn_bottom.click(
            fn=_goto_next_page,
            inputs=[mode_radio, search_box, page_state, page_size, date_filter, thumb_size, card_extras_mode],
            outputs=[gallery_html, page_info, page_info_bottom, page_state],
        )

        sync_btn.click(
            fn=do_sync,
            inputs=[mode_radio, search_box, page_state, page_size, date_filter, thumb_size, card_extras_mode],
            outputs=[sync_status, gallery_html, page_info, page_info_bottom, page_state],
        )

        archive_unrated_btn.click(
            fn=do_archive_unrated,
            inputs=[mode_radio, search_box, page_state, page_size, date_filter, thumb_size, card_extras_mode],
            outputs=[sync_status, gallery_html, page_info, page_info_bottom, page_state],
        )

        action_btn.click(
            fn=handle_gallery_action,
            inputs=[action_input, mode_radio, search_box, page_state, page_size, date_filter, thumb_size, card_extras_mode],
            outputs=[sync_status, gallery_html, page_info, page_info_bottom, page_state],
        )

        with gr.Accordion("🔍 Keyword Insights", open=False, elem_id="endgal_insights_accordion"):
            gr.HTML(
                value='<div class="endgal-insights-desc">'
                      'DeepDanbooru tags collected when you endorse/dislike images. '
                      'Identifies which keywords correlate with quality vs unwanted outputs.</div>'
            )
            insights_refresh_btn = gr.Button(
                "Refresh Insights", size="sm", elem_id="endgal_insights_refresh_btn"
            )
            insights_html = gr.HTML(
                value='<div class="endgal-insights-empty">Click Refresh Insights to analyse your endorsements.</div>',
                elem_id="endgal_insights_html",
            )
            insights_refresh_btn.click(
                fn=get_keyword_insights_html,
                inputs=[mode_radio, search_box, date_filter],
                outputs=[insights_html],
            )

    return [(gallery_ui, "Gallery", "endorsed_gallery")]


def on_image_saved(params):
    try:
        path = params.filename
        if not path or not path.lower().endswith(".png"):
            return
        if endorsement_db.is_grid_image_path(path):
            return
        if endorsement_db.is_removebg_attachment_path(path):
            return
        mtime = os.path.getmtime(path)
        infotext = ""
        if params.pnginfo:
            infotext = params.pnginfo.get("parameters", "") or ""
        parsed = infotext_utils.parse_generation_parameters(infotext, []) if infotext else {}
        endorsement_db.index_image(
            path=path,
            file_mtime=mtime,
            prompt=parsed.get("Prompt", ""),
            negative_prompt=parsed.get("Negative prompt", ""),
            seed=parsed.get("Seed", ""),
            steps=int(parsed.get("Steps", 0) or 0),
            sampler=parsed.get("Sampler", ""),
            cfg_scale=float(parsed.get("CFG scale", 0) or 0),
            width=int(parsed.get("Size-1", 0) or 0),
            height=int(parsed.get("Size-2", 0) or 0),
            model_name=parsed.get("Model", ""),
            model_hash=parsed.get("Model hash", ""),
            infotext=infotext,
        )
    except Exception:
        pass


def register_callbacks():
    ui_tab_name = "endorsed_gallery_tab"
    image_saved_name = "endorsed_gallery_image_saved"

    ui_tab_callbacks = script_callbacks.callback_map.get("callbacks_ui_tabs", [])
    ui_tab_registered = any(getattr(cb, "name", "") == ui_tab_name for cb in ui_tab_callbacks)
    if not ui_tab_registered:
        script_callbacks.on_ui_tabs(on_ui_tabs, name=ui_tab_name)

    image_saved_callbacks = script_callbacks.callback_map.get("callbacks_image_saved", [])
    image_saved_registered = any(getattr(cb, "name", "") == image_saved_name for cb in image_saved_callbacks)
    if not image_saved_registered:
        script_callbacks.on_image_saved(on_image_saved, name=image_saved_name)


register_callbacks()
