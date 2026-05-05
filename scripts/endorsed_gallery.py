"""Paged gallery with endorsements, dislikes, and cached thumbnails."""

import base64
import datetime
import hashlib
import html as _html
import io
import json
import os
import time

import gradio as gr
from PIL import Image

from modules import endorsement_db
from modules import infotext_utils
from modules import script_callbacks
from modules import shared

endorsement_db.init_db()

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_ROOT_DIR = os.path.dirname(_SCRIPT_DIR)

THUMB_PX = 192
PAGE_SIZE_DEFAULT = 48

_thumb_cache: dict = {}
_THUMB_CACHE_DIR = os.path.join(_ROOT_DIR, "cache", "gallery_thumbs")


def _ensure_thumb_cache_dir():
    os.makedirs(_THUMB_CACHE_DIR, exist_ok=True)


def _thumb_file(path: str, mtime: float) -> str:
    key = hashlib.sha1(f"{path}|{mtime:.6f}".encode("utf-8", errors="ignore")).hexdigest()
    return os.path.join(_THUMB_CACHE_DIR, f"{key}.webp")


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

        with open(thumb_path, "rb") as f:
            b64 = "data:image/webp;base64," + base64.b64encode(f.read()).decode("ascii")

        _thumb_cache[cache_key] = b64
        return b64
    except Exception:
        return ""


def _b64(s: str) -> str:
    return base64.b64encode((s or "").encode("utf-8", errors="ignore")).decode("ascii")


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


def _card_html(record: dict, endorsed_id=None, disliked_id=None) -> str:
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
    orig_url = f'/file={path.replace(chr(92), "/")}' if path else ""

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

    infotext = record.get("infotext", "")
    infotext_b64 = _b64(infotext)
    path_b64 = _b64(path)

    thumb_html = (
        f'<img src="{thumb}" alt="generated image" loading="lazy" '
        f'data-orig="{orig_url}" '
        f'data-endorse-action="{endorse_action_b64}" '
        f'data-dislike-action="{dislike_action_b64}" '
        f'data-endorse-label="{endorse_label}" '
        f'data-dislike-label="{dislike_label}" '
        f'onclick="endorsedGallery.previewImage(this.dataset.orig || this.src)" />'
    ) if thumb else '<div class="endgal-nothumb">No preview</div>'

    return f"""
<div class="endgal-card {'endorsed' if endorsed_id else ''} {'disliked' if disliked_id else ''}">
  <div class="endgal-thumb">{thumb_html}</div>
  <div class="endgal-body">
    <div class="endgal-prompt">{_html.escape(prompt[:220])}</div>
    <div class="endgal-meta">seed { _html.escape(seed) } · { _html.escape(sampler) } · { _html.escape(model) }</div>
    <div class="endgal-date">{_html.escape(date)}</div>
    <details class="endgal-details">
      <summary>Params</summary>
      <pre class="endgal-infotext">{_html.escape(infotext)}</pre>
    </details>
  </div>
  <div class="endgal-actions">
        <button class="{endorse_class}" title="toggle endorse" onclick="endorsedGallery.action('{endorse_action_b64}')">{endorse_label}</button>
    <button class="endgal-btn-send2img" title="send to txt2img" onclick="endorsedGallery.sendTo('{infotext_b64}', 'txt2img')">txt2img</button>
    <button class="endgal-btn-send2img" title="send to img2img" onclick="endorsedGallery.sendTo('{infotext_b64}', 'img2img', '{path_b64}')">img2img</button>
    <button class="endgal-btn-send2img" title="send to extras" onclick="endorsedGallery.sendToExtras('{path_b64}')">extras</button>
        <button class="{dislike_class}" title="toggle dislike" onclick="endorsedGallery.action('{dislike_action_b64}')">{dislike_label}</button>
  </div>
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
    elif mode == "⬜ Unrated":
        if hasattr(endorsement_db, "count_unrated") and hasattr(endorsement_db, "search_unrated"):
            total = _call_db("count_unrated", query, since_ts=since_ts)
            rows = _call_db("search_unrated", query, limit=page_size, offset=offset, since_ts=since_ts)
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


def render_gallery(mode: str, query: str, page: int, page_size: int, date_filter: str):
    total, rows = _fetch_mode_records(mode, query, page, page_size, date_filter)
    pages = max(1, (total + int(page_size) - 1) // int(page_size))
    page = max(1, min(int(page), pages))

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

    cards = []
    for rec in rows:
        path = rec.get("path") or rec.get("image_path", "")
        eid = endorsement_db.get_endorsed_id_by_path(path)
        did = endorsement_db.get_disliked_id_by_path(path)
        cards.append(_card_html(rec, endorsed_id=eid, disliked_id=did))

    header = f'<div class="endgal-count">{total} items</div>'
    grid = '<div class="endgal-grid" data-is-last-page="{str(is_last_page).lower()}">' + "".join(cards) + "</div>"
    page_info = f"{total} items · page {page}/{pages}"
    return header + grid, page_info, page, is_last_page


def _reset_to_first_page(mode, query, page_size, date_filter):
    html, info, page, is_last = render_gallery(mode, query, 1, int(page_size or PAGE_SIZE_DEFAULT), date_filter)
    return html, info, info, page


def _goto_prev_page(mode, query, page, page_size, date_filter):
    new_page = max(1, int(page or 1) - 1)
    html, info, page, is_last = render_gallery(mode, query, new_page, int(page_size or PAGE_SIZE_DEFAULT), date_filter)
    return html, info, info, page


def _goto_next_page(mode, query, page, page_size, date_filter):
    current_page = int(page or 1)
    page_size_int = int(page_size or PAGE_SIZE_DEFAULT)
    
    # Get current page info to check if already at last page
    total, rows = _fetch_mode_records(mode, query, current_page, page_size_int, date_filter)
    pages = max(1, (total + page_size_int - 1) // page_size_int)
    
    # If already on last page, don't go further but signal end-of-gallery
    if current_page >= pages:
        html, info, page, is_last = render_gallery(mode, query, current_page, page_size_int, date_filter)
        # Add end-of-gallery hint to info
        hint_html = '<div id="endgal_end_hint" class="endgal-sync-result">All images are over.</div>'
        html_with_hint = html + hint_html
        return html_with_hint, info, info, page
    
    new_page = current_page + 1
    html, info, page, is_last = render_gallery(mode, query, new_page, page_size_int, date_filter)
    return html, info, info, page


def handle_gallery_action(action_json: str, mode: str, query: str, page: int, page_size: int, date_filter: str):
    try:
        data = json.loads(action_json) if action_json.strip() else {}
    except Exception:
        data = {}

    t = data.get("type", "")
    if t == "endorse":
        endorsement_db.endorse(
            data.get("path", ""),
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
    elif t == "remove_dislike":
        did = int(data.get("id", 0) or 0)
        if did > 0:
            endorsement_db.delete_dislike(did)
        else:
            path = data.get("path", "")
            if path:
                endorsement_db.delete_dislike_by_path(path)

    html, info, page, is_last = render_gallery(mode, query, page, page_size, date_filter)
    
    # If gallery became empty after action (e.g., endorsed last image and filter changed), show hint
    if '<div class="endgal-empty">' in html:
        hint_html = '<div id="endgal_end_hint" class="endgal-sync-result">All images are over.</div>'
        html = html + hint_html
    # If still on last page with content, show hint
    elif is_last:
        hint_html = '<div id="endgal_end_hint" class="endgal-sync-result">All images are over.</div>'
        html = html + hint_html
    
    return html, info, info, page


def on_ui_tabs():
    with gr.Blocks(analytics_enabled=False) as gallery_ui:
        with gr.Row(elem_id="endgal_controls_row"):
            mode_radio = gr.Radio(
                choices=["⭐ Endorsed", "🖼 All Generated", "⬜ Unrated", "👎 Disliked"],
                value="⭐ Endorsed",
                label="",
                elem_id="endgal_mode_radio",
            )
            search_box = gr.Textbox(
                value="",
                placeholder="",
                label="",
                elem_id="endgal_search_box",
                scale=2,
            )
            page_size = gr.Dropdown(
                choices=["24", "48", "96"],
                value=str(PAGE_SIZE_DEFAULT),
                label="Page Size",
                elem_id="endgal_page_size",
                scale=1,
            )
            date_filter = gr.Dropdown(
                choices=["All time", "1 day", "2 days", "1 week"],
                value="1 day",
                label="Date",
                elem_id="endgal_date_filter",
                scale=1,
            )
            refresh_btn = gr.Button("Refresh", elem_id="endgal_refresh_btn", size="sm")
            sync_btn = gr.Button("Sync All", elem_id="endgal_sync_btn", size="sm")

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

        def do_sync(mode, query, pg, size, date_filter):
            msg = sync_all_to_db()
            html, info, page, is_last = render_gallery(mode, query, pg, int(size), date_filter)
            return f'<div class="endgal-sync-result">{_html.escape(msg)}</div>', html, info, info, page

        refresh_btn.click(
            fn=_reset_to_first_page,
            inputs=[mode_radio, search_box, page_size, date_filter],
            outputs=[gallery_html, page_info, page_info_bottom, page_state],
        )
        mode_radio.change(
            fn=_reset_to_first_page,
            inputs=[mode_radio, search_box, page_size, date_filter],
            outputs=[gallery_html, page_info, page_info_bottom, page_state],
        )
        search_box.submit(
            fn=_reset_to_first_page,
            inputs=[mode_radio, search_box, page_size, date_filter],
            outputs=[gallery_html, page_info, page_info_bottom, page_state],
        )
        page_size.change(
            fn=_reset_to_first_page,
            inputs=[mode_radio, search_box, page_size, date_filter],
            outputs=[gallery_html, page_info, page_info_bottom, page_state],
        )
        date_filter.change(
            fn=_reset_to_first_page,
            inputs=[mode_radio, search_box, page_size, date_filter],
            outputs=[gallery_html, page_info, page_info_bottom, page_state],
        )

        prev_btn.click(
            fn=_goto_prev_page,
            inputs=[mode_radio, search_box, page_state, page_size, date_filter],
            outputs=[gallery_html, page_info, page_info_bottom, page_state],
        )
        next_btn.click(
            fn=_goto_next_page,
            inputs=[mode_radio, search_box, page_state, page_size, date_filter],
            outputs=[gallery_html, page_info, page_info_bottom, page_state],
        )

        prev_btn_bottom.click(
            fn=_goto_prev_page,
            inputs=[mode_radio, search_box, page_state, page_size, date_filter],
            outputs=[gallery_html, page_info, page_info_bottom, page_state],
        )
        next_btn_bottom.click(
            fn=_goto_next_page,
            inputs=[mode_radio, search_box, page_state, page_size, date_filter],
            outputs=[gallery_html, page_info, page_info_bottom, page_state],
        )

        sync_btn.click(
            fn=do_sync,
            inputs=[mode_radio, search_box, page_state, page_size, date_filter],
            outputs=[sync_status, gallery_html, page_info, page_info_bottom, page_state],
        )

        action_btn.click(
            fn=handle_gallery_action,
            inputs=[action_input, mode_radio, search_box, page_state, page_size, date_filter],
            outputs=[gallery_html, page_info, page_info_bottom, page_state],
        )

    return [(gallery_ui, "Gallery", "endorsed_gallery")]


def on_image_saved(params):
    try:
        path = params.filename
        if not path or not path.lower().endswith(".png"):
            return
        if endorsement_db.is_grid_image_path(path):
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


script_callbacks.on_ui_tabs(on_ui_tabs)
script_callbacks.on_image_saved(on_image_saved)
