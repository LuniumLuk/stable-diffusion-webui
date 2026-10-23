"""Gallery v2 migration: old endorsements.db -> gallery.db + blob store.

Phases (online, resumable - cursors live in gallery_meta):
  M0 snapshot   copy endorsements.db to backups/gallery_migration/<ts>/
  M1 schema     create gallery.db schema, FTS smoke test
  M2 rows       import endorsements / dislikes / generated_images / archived /
                staged / trash / image_tags (caption rows, batched)
  M3 files      index scan sources, import cache webps into the blob store,
                absorb .txt sidecars + composer JSON, convert endorsed copies
                to hardlinks (sha256-verified), sweep orphans
  G1/G2 gates   parity + coverage/disk reports

Run:  python -m modules.gallery_migrate all
      python -m modules.gallery_migrate m2   (resumes where it stopped)
"""

import hashlib
import json
import os
import shutil
import sqlite3
import sys
import time
from datetime import datetime

from modules import gallery_blobs, gallery_db, gallery_sources

ROOT = gallery_db._ROOT
OLD_DB_PATH = os.path.join(ROOT, "endorsements.db")
BACKUP_ROOT = os.path.join(ROOT, "backups", "gallery_migration")
ABSORB_ROOT = os.path.join(ROOT, "tmp", "gallery_absorbed")
THUMB_DIR = os.path.join(ROOT, "cache", "gallery_thumbs")
PREVIEW_DIR = os.path.join(ROOT, "cache", "gallery_previews")

BATCH = 5000


def _log(msg: str) -> None:
    print(f"[gallery-migrate] {msg}")


def _real_dims(paths, legacy_w, legacy_h):
    """Prefer actual file dimensions over legacy metadata values.

    Legacy width/height come from generation params: for inpaint that is the
    mask-area size and for hires fix only the first-pass size, so they can
    differ from the real file.
    """
    for p in paths:
        if p and os.path.isfile(p):
            w, h = gallery_sources.image_size(p)
            if w and h:
                return w, h
    return int(legacy_w or 0), int(legacy_h or 0)


def _meta_get(key: str, default: str = "") -> str:
    with gallery_db.get_conn() as conn:
        row = conn.execute("SELECT value FROM gallery_meta WHERE key=?", (key,)).fetchone()
        return row[0] if row else default


def _meta_set(key: str, value) -> None:
    with gallery_db.get_conn() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO gallery_meta(key, value) VALUES (?,?)", (key, str(value))
        )
        conn.commit()


def _old_conn() -> sqlite3.Connection | None:
    if not os.path.isfile(OLD_DB_PATH):
        return None
    conn = sqlite3.connect(OLD_DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    return conn


def _rel_of(path: str) -> str:
    try:
        rel = os.path.relpath(path, ROOT)
    except ValueError:
        rel = path
    rel = str(rel).replace("\\", "/")
    if rel.startswith(".."):
        rel = os.path.basename(path)
    return rel


def _stem(path: str) -> str:
    return os.path.splitext(os.path.basename(path or ""))[0].strip().lower()


def _legacy_cache_key(path: str, mtime: float, preview: bool = False) -> str:
    suffix = "|preview" if preview else ""
    return hashlib.sha1(f"{path}|{mtime:.6f}{suffix}".encode("utf-8", errors="ignore")).hexdigest()


def _meta_from_row(row) -> dict:
    meta = {}
    for src_key, dst_key in (
        ("seed", "seed"), ("steps", "steps"), ("sampler", "sampler"),
        ("cfg_scale", "cfg"), ("model_name", "model"), ("model_hash", "model_hash"),
    ):
        try:
            value = row[src_key]
        except (IndexError, KeyError):
            value = None
        if value not in (None, ""):
            meta[dst_key] = str(value)
    return meta


def _ensure_source(src_id: str) -> None:
    with gallery_db.get_conn() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO sources(id, label, parser, schema_version, config_json, created_at) "
            "VALUES (?,?,?,1,'{}',?)",
            (src_id, src_id, "none", datetime.now().isoformat(timespec="seconds")),
        )
        conn.commit()


def _source_for(path: str) -> str:
    src = gallery_sources.source_for_path(path)
    if src:
        return src
    _ensure_source("endorsed")
    return "endorsed"


# ---------------------------------------------------------------------------
# M0 - snapshot
# ---------------------------------------------------------------------------

def m0_snapshot() -> dict:
    gallery_db.init_db()
    if not os.path.isfile(OLD_DB_PATH):
        _log("M0: no endorsements.db found - nothing to snapshot")
        return {"snapshot": None}
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    dest_dir = os.path.join(BACKUP_ROOT, stamp)
    os.makedirs(dest_dir, exist_ok=True)
    dest = os.path.join(dest_dir, "endorsements.db")
    shutil.copy2(OLD_DB_PATH, dest)

    inventory = {"taken_at": stamp, "source_db": OLD_DB_PATH, "tables": {}}
    conn = _old_conn()
    if conn:
        for table in ("endorsements", "dislikes", "generated_images", "archived", "staged", "trash", "image_tags"):
            try:
                inventory["tables"][table] = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            except sqlite3.Error:
                inventory["tables"][table] = None
        conn.close()
    with open(os.path.join(dest_dir, "inventory.json"), "w", encoding="utf-8") as f:
        json.dump(inventory, f, indent=2)
    free = shutil.disk_usage(ROOT).free
    inventory["disk_free_gb"] = round(free / 1024 ** 3, 1)
    inventory["snapshot"] = dest
    _meta_set("m0.snapshot", dest)
    _meta_set("m0.at", stamp)
    _log(f"M0: snapshot -> {dest} (disk free {inventory['disk_free_gb']} GB)")
    if free < 5 * 1024 ** 3:
        _log("M0 WARNING: less than 5 GB free - hardlink conversion needs no extra space but keep margin")
    return inventory


# ---------------------------------------------------------------------------
# M1 - schema
# ---------------------------------------------------------------------------

def m1_schema() -> dict:
    gallery_db.init_db()
    gallery_blobs.get_store().init()
    # FTS smoke test
    with gallery_db.get_conn() as conn:
        try:
            conn.execute("SELECT * FROM items_fts WHERE items_fts MATCH 'smoke' LIMIT 1").fetchall()
            fts_ok = True
        except sqlite3.Error as exc:
            fts_ok = False
            _log(f"M1: FTS smoke test FAILED: {exc}")
    _meta_set("m1.done", "1")
    _log(f"M1: schema ready (fts5 {'ok' if fts_ok else 'BROKEN'})")
    return {"fts5": fts_ok}


# ---------------------------------------------------------------------------
# M2 - import rows
# ---------------------------------------------------------------------------

def _batch_iter(conn, table, order_col, where="", params=()):
    """Yield rows in id order for the table, skipping already-migrated ids."""
    cursor_key = f"m2.cursor.{table}"
    last = int(_meta_get(cursor_key, "0") or 0)
    sql = f"SELECT * FROM {table} WHERE id > ?"
    if where:
        sql += f" AND {where}"
    sql += f" ORDER BY id LIMIT ?"
    while True:
        started = time.time()
        rows = conn.execute(sql, (last,) + tuple(params) + (BATCH,)).fetchall()
        if not rows:
            break
        yield rows
        last = int(rows[-1]["id"])
        _meta_set(cursor_key, last)
        rate = len(rows) / max(0.001, time.time() - started)
        if rate < 150:
            _log(f"{table}: batch to id {last} ({rate:.0f} rows/s)")


def _row_get(row, key, default=None):
    try:
        return row[key]
    except (IndexError, KeyError):
        return default


def m2_rows() -> dict:
    conn = _old_conn()
    if not conn:
        _log("M2: no endorsements.db - skipping")
        return {}
    gallery_db.init_db()
    gallery_db.set_fast_sync(True)
    gallery_blobs.set_fast_sync(True)
    stats = {"endorsements": 0, "dislikes": 0, "generated": 0, "archived": 0, "staged": 0,
             "trash": 0, "tags": 0, "conflicts": 0}

    # --- endorsements ------------------------------------------------------
    for rows in _batch_iter(conn, "endorsements", "id"):
        for row in rows:
            item_key = _row_get(row, "item_key") or _stem(_row_get(row, "image_path"))
            img_path = _row_get(row, "image_path") or ""
            orig = _row_get(row, "original_path") or ""
            canon = orig if (orig and os.path.isfile(orig)) else img_path
            alias = img_path if (img_path and os.path.normcase(img_path) != os.path.normcase(canon)) else None
            source = _source_for(canon or img_path)
            rel = _rel_of(canon or img_path)
            real_w, real_h = _real_dims((canon, img_path), _row_get(row, "width"), _row_get(row, "height"))
            fields = dict(
                path=canon, rel_path=rel,
                prompt=_row_get(row, "prompt") or "",
                negative_prompt=_row_get(row, "negative_prompt") or "",
                compiled_prompt=_row_get(row, "compiled_prompt") or "",
                compiled_negative_prompt=_row_get(row, "compiled_negative_prompt") or "",
                infotext=_row_get(row, "infotext") or "",
                width=real_w,
                height=real_h,
                meta=_meta_from_row(row),
            )
            if alias:
                fields["alias_path"] = alias
            if canon and os.path.isfile(canon):
                try:
                    st = os.stat(canon)
                    fields["mtime"] = st.st_mtime
                    fields["file_size"] = st.st_size
                except OSError:
                    pass
            item_id = gallery_db.upsert_item(uid=gallery_db.make_uid(source, rel), source=source, **fields)
            if not gallery_db.get_rating(item_id):
                gallery_db.set_rating(item_id, "endorsed")
            if item_key:
                gallery_db.map_legacy_key(item_key, item_id)
            gallery_db.map_legacy_key(_stem(img_path), item_id)
            if orig:
                gallery_db.map_legacy_key(_stem(orig), item_id)
            stats["endorsements"] += 1
        _log(f"M2 endorsements: {stats['endorsements']}")

    # --- dislikes ----------------------------------------------------------
    for rows in _batch_iter(conn, "dislikes", "id"):
        for row in rows:
            item_key = _row_get(row, "item_key") or _stem(_row_get(row, "image_path"))
            path = _row_get(row, "image_path") or ""
            source = _source_for(path)
            rel = _rel_of(path)
            real_w, real_h = _real_dims((path,), _row_get(row, "width"), _row_get(row, "height"))
            fields = dict(
                path=path, rel_path=rel,
                prompt=_row_get(row, "prompt") or "",
                negative_prompt=_row_get(row, "negative_prompt") or "",
                compiled_prompt=_row_get(row, "compiled_prompt") or "",
                compiled_negative_prompt=_row_get(row, "compiled_negative_prompt") or "",
                infotext=_row_get(row, "infotext") or "",
                width=real_w,
                height=real_h,
                meta=_meta_from_row(row),
            )
            if path and os.path.isfile(path):
                try:
                    st = os.stat(path)
                    fields["mtime"] = st.st_mtime
                    fields["file_size"] = st.st_size
                except OSError:
                    pass
            item_id = gallery_db.upsert_item(uid=gallery_db.make_uid(source, rel), source=source, **fields)
            if not gallery_db.get_rating(item_id):
                gallery_db.set_rating(item_id, "disliked")
            else:
                stats["conflicts"] += 1
            if item_key:
                gallery_db.map_legacy_key(item_key, item_id)
            stats["dislikes"] += 1
        _log(f"M2 dislikes: {stats['dislikes']}")

    # --- generated_images --------------------------------------------------
    for rows in _batch_iter(conn, "generated_images", "id"):
        for row in rows:
            path = _row_get(row, "path") or ""
            item_key = _row_get(row, "item_key") or _stem(path)
            source = _source_for(path)
            rel = _rel_of(path)
            real_w, real_h = _real_dims((path,), _row_get(row, "width"), _row_get(row, "height"))
            fields = dict(
                path=path, rel_path=rel,
                prompt=_row_get(row, "prompt") or "",
                negative_prompt=_row_get(row, "negative_prompt") or "",
                compiled_prompt=_row_get(row, "compiled_prompt") or "",
                compiled_negative_prompt=_row_get(row, "compiled_negative_prompt") or "",
                infotext=_row_get(row, "infotext") or "",
                width=real_w,
                height=real_h,
                mtime=float(_row_get(row, "file_mtime") or 0) or None,
                meta=_meta_from_row(row),
            )
            if path and os.path.isfile(path):
                try:
                    fields["file_size"] = os.path.getsize(path)
                except OSError:
                    pass
            item_id = gallery_db.upsert_item(uid=gallery_db.make_uid(source, rel), source=source, **fields)
            if item_key:
                gallery_db.map_legacy_key(item_key, item_id)
            stats["generated"] += 1
        _log(f"M2 generated: {stats['generated']}")

    # --- archived / staged (state upgrades, grace TTL for archived) --------
    now = time.time()
    for rows in _batch_iter(conn, "archived", "id"):
        for row in rows:
            item_key = _row_get(row, "item_key")
            item_id = gallery_db.resolve_item_id(item_key)
            if not item_id:
                stats["archived"] += 1
                continue
            archived_at = 0.0
            try:
                archived_at = datetime.fromisoformat(str(_row_get(row, "archived_at"))).timestamp()
            except Exception:
                pass
            ttl_deadline = max(archived_at + 24 * 3600, now + 24 * 3600)
            with gallery_db.get_conn() as c:
                c.execute(
                    "UPDATE items SET state='archived', archive_expires_at=?, updated_at=? WHERE id=?",
                    (ttl_deadline, datetime.now().isoformat(timespec="seconds"), item_id),
                )
                c.commit()
            gallery_db.add_state_event(item_id, "archive", {"migrated": True})
            stats["archived"] += 1
        _log(f"M2 archived: {stats['archived']}")

    for rows in _batch_iter(conn, "staged", "id"):
        for row in rows:
            item_id = gallery_db.resolve_item_id(_row_get(row, "item_key"))
            if item_id:
                with gallery_db.get_conn() as c:
                    c.execute("UPDATE items SET state='staged' WHERE id=? AND state='active'", (item_id,))
                    c.commit()
                gallery_db.add_state_event(item_id, "stage", {"migrated": True})
                stats["staged"] += 1

    # --- trash (metadata only, no media) -----------------------------------
    _debug = os.environ.get("GALLERY_MIGRATE_DEBUG") == "1"
    _timing = {"source": 0.0, "resolve": 0.0, "upsert": 0.0, "state": 0.0, "legacy": 0.0, "rows": 0}
    for rows in _batch_iter(conn, "trash", "id"):
        for row in rows:
            item_key = _row_get(row, "item_key") or ""
            path = _row_get(row, "path") or ""
            t_mark = time.time() if _debug else 0
            source = _source_for(path) if path else "endorsed"
            if not path:
                _ensure_source("endorsed")
            rel = _rel_of(path or item_key)
            uid = gallery_db.make_uid(source, rel) if rel else f"{source}:trash-{row['id']}"
            if _debug:
                t_next = time.time(); _timing["source"] += t_next - t_mark; t_mark = t_next
            existing = gallery_db.resolve_item_id(item_key) if item_key else None
            if _debug:
                t_next = time.time(); _timing["resolve"] += t_next - t_mark; t_mark = t_next
            if existing:
                stats["conflicts"] += 1
                _timing["rows"] += 1
                continue
            real_w, real_h = _real_dims((path,), _row_get(row, "width"), _row_get(row, "height"))
            fields = dict(
                path=path or None, rel_path=rel or None,
                prompt=_row_get(row, "prompt") or "",
                negative_prompt=_row_get(row, "negative_prompt") or "",
                compiled_prompt=_row_get(row, "compiled_prompt") or "",
                compiled_negative_prompt=_row_get(row, "compiled_negative_prompt") or "",
                infotext=_row_get(row, "infotext") or "",
                width=real_w,
                height=real_h,
                mtime=float(_row_get(row, "file_mtime") or 0) or None,
                meta=_meta_from_row(row),
            )
            try:
                item_id = gallery_db.upsert_item(uid=uid, source=source, **fields)
            except sqlite3.IntegrityError:
                uid = f"{uid}#{row['id']}"
                item_id = gallery_db.upsert_item(uid=uid, source=source, **fields)
            if _debug:
                t_next = time.time(); _timing["upsert"] += t_next - t_mark; t_mark = t_next
            with gallery_db.get_conn() as c:
                c.execute(
                    "UPDATE items SET state='trashed', archive_expires_at=NULL WHERE id=?", (item_id,)
                )
                c.commit()
            if _debug:
                t_next = time.time(); _timing["state"] += t_next - t_mark; t_mark = t_next
            if item_key:
                gallery_db.map_legacy_key(item_key, item_id)
            if _debug:
                t_next = time.time(); _timing["legacy"] += t_next - t_mark
                _timing["rows"] += 1
                if _timing["rows"] % 500 == 0:
                    _log(f"M2 trash timing after {_timing['rows']} rows: " + json.dumps(_timing))
            stats["trash"] += 1
        _log(f"M2 trash: {stats['trash']}")

    # --- image_tags -> captions -------------------------------------------
    for rows in _batch_iter(conn, "image_tags", "id"):
        pairs = {}
        for row in rows:
            item_id = gallery_db.resolve_item_id(_row_get(row, "item_key"))
            if not item_id:
                continue
            tag = str(_row_get(row, "tag") or "").strip()
            if not tag:
                continue
            pairs.setdefault(item_id, {})[tag] = float(_row_get(row, "score") or 0)
        if pairs:
            gallery_db.save_captions_many(list(pairs.items()), source="deepbooru")
            stats["tags"] += sum(len(v) for v in pairs.values())
        _log(f"M2 tags: {stats['tags']}")

    conn.close()
    _meta_set("m2.done", "1")
    _log(f"M2 done: {stats}")
    return stats


# ---------------------------------------------------------------------------
# M3 - files & blobs
# ---------------------------------------------------------------------------

def _all_items():
    """Materialised item list.

    Must NOT be a lazy generator: callers write to the same DB while iterating,
    and an open read cursor blocks commits (fatal with the migration's memory
    journal; 10 s busy-timeout stalls per row).
    """
    with gallery_db.get_conn() as conn:
        return [dict(row) for row in conn.execute("SELECT * FROM items").fetchall()]


def _quarantine(path: str, reason: str) -> None:
    rel = _rel_of(path)
    dest = os.path.join(ABSORB_ROOT, reason, rel)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    try:
        shutil.move(path, dest)
    except (OSError, shutil.Error):
        pass


def _merge_sidecar_text(item_id: int, text: str) -> None:
    """Merge a sidecar infotext into an item without overwriting richer data."""
    meta = {}
    if text:
        prompt, negative, params = gallery_sources.split_infotext(text)
        meta = {"prompt": prompt, "negative": negative, "infotext": text,
                "meta": gallery_sources._meta_from_params(gallery_sources.parse_params_line(params))}
    merged = gallery_db.get_item_meta(item_id)
    for key, value in (meta.get("meta") or {}).items():
        if value not in (None, "", {}) and key not in merged:
            merged[key] = value
    with gallery_db.get_conn() as conn:
        conn.execute(
            "UPDATE items SET meta_json=?, infotext=COALESCE(NULLIF(infotext,''), ?), "
            "prompt=COALESCE(NULLIF(prompt,''), ?), negative_prompt=COALESCE(NULLIF(negative_prompt,''), ?), "
            "updated_at=? WHERE id=?",
            (json.dumps(merged, ensure_ascii=False, separators=(",", ":")),
             meta.get("infotext") or "", meta.get("prompt") or "", meta.get("negative") or "",
             datetime.now().isoformat(timespec="seconds"), int(item_id)),
        )
        conn.commit()


def _absorb_sidecars(stats: dict) -> None:
    absorbed = 0
    failed = 0
    for item in _all_items():
        path = item.get("path") or ""
        if not path or not os.path.isfile(path):
            continue
        txt_path = os.path.splitext(path)[0] + ".txt"
        if not os.path.isfile(txt_path):
            continue
        try:
            with open(txt_path, "r", encoding="utf-8", errors="replace") as f:
                text = f.read()
            _merge_sidecar_text(item["id"], text)
            os.remove(txt_path)
            absorbed += 1
        except Exception:
            failed += 1
            _quarantine(txt_path, "sidecar_failed")
    stats["sidecars_absorbed"] = absorbed
    stats["sidecars_failed"] = failed
    _log(f"M3 sidecars: absorbed {absorbed}, failed {failed}")


def _absorb_txt_archive(stats: dict) -> None:
    """Absorb outputs/txt-info/*.txt (the fork's save_txt archive, outdir_txt).

    Matching is by filename stem through legacy_keys; unmatched files are
    quarantined (their images are long gone - the archive has no siblings by
    design, so the sibling rule cannot be used here).
    """
    base = os.path.join(ROOT, "outputs", "txt-info")
    if not os.path.isdir(base):
        stats["txtinfo_absorbed"] = 0
        return
    absorbed = 0
    orphaned = 0
    failed = 0
    for fname in os.listdir(base):
        if not fname.lower().endswith(".txt"):
            continue
        path = os.path.join(base, fname)
        stem = fname[: -len(".txt")]
        item_id = gallery_db.resolve_item_id(stem)
        if not item_id:
            _quarantine(path, "txt-info_orphans")
            orphaned += 1
            continue
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                text = f.read()
            _merge_sidecar_text(item_id, text)
            os.remove(path)
            absorbed += 1
        except Exception:
            failed += 1
            _quarantine(path, "txt-info_failed")
    stats["txtinfo_absorbed"] = absorbed
    stats["txtinfo_orphaned"] = orphaned
    stats["txtinfo_failed"] = failed
    _log(f"M3 txt-info archive: absorbed {absorbed}, quarantined {orphaned}, failed {failed}")


def _sweep_orphan_sidecars(stats: dict) -> None:
    """Quarantine .txt / composer .json whose image no longer exists."""
    orphans = 0
    known_images = set()
    for item in _all_items():
        path = item.get("path") or ""
        if path:
            known_images.add(os.path.normcase(path))
    for sub in ("txt2img-images", "img2img-images", "composition", "qwen", "krea2",
                "image_maker", "removebg", "nano-banana", "comic_maker", "sana", "endorsed"):
        base = os.path.join(ROOT, "outputs", sub)
        if not os.path.isdir(base):
            continue
        for dirpath, _dirs, fnames in os.walk(base):
            for fname in fnames:
                low = fname.lower()
                if not (low.endswith(".txt") or low.endswith(".composerstate.json")):
                    continue
                full = os.path.join(dirpath, fname)
                stem = full
                while stem.lower().endswith(".composerstate.json"):
                    stem = stem[: -len(".composerstate.json")]
                if low.endswith(".txt"):
                    stem = full[: -len(".txt")]
                if os.path.normcase(stem) in known_images:
                    continue
                if os.path.exists(stem):
                    continue
                _quarantine(full, "orphans")
                orphans += 1
    stats["orphan_sidecars"] = orphans
    _log(f"M3 orphan sidecars quarantined: {orphans}")


def _absorb_composer(stats: dict) -> None:
    absorbed = 0
    failed = 0
    for item in _all_items():
        path = item.get("path") or ""
        if not path:
            continue
        json_path = os.path.splitext(path)[0] + ".composerstate.json"
        if not os.path.isfile(json_path):
            continue
        try:
            with open(json_path, "r", encoding="utf-8", errors="replace") as f:
                raw = f.read()
            json.loads(raw)
            gallery_db.put_composer_state(item["id"], raw)
            absorbed += 1
        except Exception:
            failed += 1
    stats["composer_absorbed"] = absorbed
    stats["composer_failed"] = failed
    _log(f"M3 composer states absorbed: {absorbed} (files kept until M6), failed {failed}")


def _import_cache_blobs(stats: dict) -> None:
    store = gallery_blobs.get_store()
    imported_thumb = 0
    imported_preview = 0
    items = list(_all_items())
    for item in items:
        state = item.get("state") or "active"
        if state == "trashed":
            continue  # media policy: trash holds no media
        allow_preview = state != "archived"
        path = item.get("path") or ""
        alias = item.get("alias_path") or ""
        candidates = []
        for candidate in (path, alias):
            if not candidate:
                continue
            if os.path.isfile(candidate):
                try:
                    candidates.append((candidate, os.path.getmtime(candidate)))
                except OSError:
                    pass
            if item.get("mtime"):
                candidates.append((candidate, float(item["mtime"])))
        seen = set()
        for candidate, mtime in candidates:
            for casing in {candidate, candidate.lower(), candidate.replace("\\", "/"), candidate.replace("/", "\\")}:
                key = _legacy_cache_key(casing, mtime)
                preview_key = _legacy_cache_key(casing, mtime, preview=True)
                if key in seen:
                    continue
                seen.add(key)
                thumb_file = os.path.join(THUMB_DIR, key + ".webp")
                if os.path.isfile(thumb_file) and not store.has(item["id"], "thumb"):
                    if gallery_blobs.import_legacy_file(item["id"], "thumb", thumb_file):
                        imported_thumb += 1
                preview_file = os.path.join(PREVIEW_DIR, preview_key + ".webp")
                if allow_preview and os.path.isfile(preview_file) and not store.has(item["id"], "preview"):
                    if gallery_blobs.import_legacy_file(item["id"], "preview", preview_file):
                        imported_preview += 1
    stats["blobs_thumb_imported"] = imported_thumb
    stats["blobs_preview_imported"] = imported_preview
    _log(f"M3 blobs imported: {imported_thumb} thumbs, {imported_preview} previews")


def _remaining_cache_files() -> tuple[int, int]:
    thumbs = len([f for f in os.listdir(THUMB_DIR) if f.endswith(".webp")]) if os.path.isdir(THUMB_DIR) else 0
    previews = len([f for f in os.listdir(PREVIEW_DIR) if f.endswith(".webp")]) if os.path.isdir(PREVIEW_DIR) else 0
    return thumbs, previews


def _regen_missing_thumbs(stats: dict, limit: int = 6000) -> None:
    """Regenerate thumbs for items whose cached thumb did not import (G2 tail)."""
    store = gallery_blobs.get_store()
    made = 0
    skipped = 0
    for item in _all_items():
        if made >= limit:
            break
        state = item.get("state") or "active"
        if state == "trashed":
            continue
        if store.has(item["id"], "thumb"):
            continue
        src = item.get("path") or ""
        if not src or not os.path.isfile(src):
            src = item.get("alias_path") or ""
            if not src or not os.path.isfile(src):
                skipped += 1
                continue
        if gallery_blobs.ensure_blob(item["id"], "thumb", src):
            made += 1
        else:
            skipped += 1
    stats["thumbs_regenerated"] = made
    stats["thumbs_unavailable"] = skipped
    _log(f"M3 thumb regen: {made} generated, {skipped} without a readable original")


def _convert_endorsed_hardlinks(stats: dict) -> None:
    """Replace verified byte-identical endorsed copies with hardlinks (0 B)."""
    converted = 0
    skipped_same = 0
    mismatch = 0
    missing = 0
    freed = 0
    for item in _all_items():
        path = item.get("path") or ""
        alias = item.get("alias_path") or ""
        if not path or not alias:
            continue
        if not (os.path.isfile(path) and os.path.isfile(alias)):
            missing += 1
            continue
        try:
            st_path = os.stat(path)
            st_alias = os.stat(alias)
        except OSError:
            missing += 1
            continue
        if getattr(st_alias, "st_ino", None) and getattr(st_path, "st_ino", None) \
                and st_alias.st_ino == st_path.st_ino:
            skipped_same += 1
            continue
        if st_path.st_size != st_alias.st_size:
            mismatch += 1
            continue
        try:
            with open(path, "rb") as f1, open(alias, "rb") as f2:
                same = _sha256_stream(f1) == _sha256_stream(f2)
        except OSError:
            mismatch += 1
            continue
        if not same:
            mismatch += 1
            continue
        tmp_link = alias + ".gv2link"
        try:
            if os.path.exists(tmp_link):
                os.remove(tmp_link)
            os.link(path, tmp_link)
            os.replace(tmp_link, alias)
            converted += 1
            freed += st_alias.st_size
        except OSError:
            try:
                if os.path.exists(tmp_link):
                    os.remove(tmp_link)
            except OSError:
                pass
            mismatch += 1
    stats.update({
        "hardlinks_converted": converted,
        "hardlinks_already": skipped_same,
        "hardlinks_mismatch": mismatch,
        "hardlinks_missing": missing,
        "hardlinks_freed_bytes": freed,
    })
    _log(f"M3 hardlinks: converted {converted}, already linked {skipped_same}, "
         f"mismatch {mismatch}, missing {missing}, freed {freed / 1024 ** 3:.2f} GB")


def _sha256_stream(handle) -> str:
    hasher = hashlib.sha256()
    while True:
        chunk = handle.read(1024 * 1024)
        if not chunk:
            break
        hasher.update(chunk)
    return hasher.hexdigest()


def m3_files() -> dict:
    gallery_db.init_db()
    gallery_db.set_fast_sync(True)
    gallery_blobs.set_fast_sync(True)
    stats = {}
    # 1. Register current files for every scan source (qwen/krea2/composition/...)
    scan_stats = {"scanned": 0, "added": 0, "updated": 0, "errors": 0}
    for src in gallery_db.get_sources():
        if src["id"] in ("txt2img", "img2img", "inpaint"):
            continue
        result = gallery_sources.index_source(src["id"])
        for key in scan_stats:
            scan_stats[key] += result.get(key, 0)
    stats["scanned_new_sources"] = scan_stats
    _log(f"M3 index scan: {scan_stats}")

    # 2. Import cache webps into the blob store
    _import_cache_blobs(stats)

    # 3. Absorb sidecars + composer states
    _absorb_sidecars(stats)
    _absorb_txt_archive(stats)
    _absorb_composer(stats)

    # 4. Sweep orphans (quarantine, never delete in-place)
    _sweep_orphan_sidecars(stats)
    thumbs, previews = _remaining_cache_files()
    stats["cache_files_remaining"] = {"thumbs": thumbs, "previews": previews}
    _log(f"M3 cache files remaining: {thumbs} thumbs / {previews} previews (tolerated)")

    # 5. Fill thumb gaps left by key drifts (G2 tail)
    _regen_missing_thumbs(stats)

    # 6. Endorsed copies -> hardlinks
    _convert_endorsed_hardlinks(stats)

    # 7. removebg variants already linked by the indexer; re-run after parents exist
    gallery_sources.index_source("removebg")
    _meta_set("m3.done", "1")
    _log(f"M3 done: {stats}")
    return stats


# ---------------------------------------------------------------------------
# gates
# ---------------------------------------------------------------------------

def g1_parity() -> dict:
    """Per-table row parity + spot-check metadata on a sample."""
    conn = _old_conn()
    if not conn:
        return {"error": "no old db"}
    report = {"tables": {}, "spot_checks": 0, "spot_mismatch": 0}
    trashed = 0
    with gallery_db.get_conn() as c:
        trashed = c.execute("SELECT COUNT(*) FROM items WHERE state='trashed'").fetchone()[0]
    for table, new_count in (
        ("endorsements", None), ("dislikes", None), ("generated_images", None),
        ("trash", trashed),
    ):
        try:
            old_count = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        except sqlite3.Error:
            old_count = None
        if new_count is None:
            new_count = None
        report["tables"][table] = {"old": old_count, "new": new_count}

    sample = conn.execute(
        "SELECT * FROM endorsements ORDER BY RANDOM() LIMIT 200"
    ).fetchall()
    for row in sample:
        item_id = gallery_db.resolve_item_id(_row_get(row, "item_key"))
        if not item_id:
            report["spot_mismatch"] += 1
            continue
        item = gallery_db.get_item(item_id)
        if (item.get("prompt") or "") != (_row_get(row, "prompt") or ""):
            report["spot_mismatch"] += 1
            continue
        if str(item.get("width") or 0) != str(int(_row_get(row, "width") or 0)):
            report["spot_mismatch"] += 1
            continue
        report["spot_checks"] += 1
    conn.close()
    _log(f"G1: {report['spot_checks']} spot checks, {report['spot_mismatch']} mismatches, {report['tables']}")
    return report


def g2_coverage() -> dict:
    """Blob coverage, disk reclaim, orphan reports."""
    store = gallery_blobs.get_store()
    with gallery_db.get_conn() as conn:
        active = conn.execute("SELECT COUNT(*) FROM items WHERE state IN ('active','staged')").fetchone()[0]
        archived = conn.execute("SELECT COUNT(*) FROM items WHERE state='archived'").fetchone()[0]
        with_path = conn.execute(
            "SELECT COUNT(*) FROM items WHERE state IN ('active','staged','archived') AND path IS NOT NULL"
        ).fetchone()[0]
        ids = [int(r[0]) for r in conn.execute("SELECT id FROM items").fetchall()]
    blob_rows = store.stats()
    covered = store.count_covered(ids, kind="thumb")
    report = {
        "items_active": active, "items_archived": archived, "items_with_path": with_path,
        "thumb_covered": covered,
        "coverage_pct": round(100.0 * covered / max(1, with_path), 1),
        "blob_store": blob_rows,
    }
    _log(f"G2: coverage {report['coverage_pct']}% ({covered}/{with_path})")
    return report


def gate_report() -> dict:
    report = {
        "at": datetime.now().isoformat(timespec="seconds"),
        "g1": g1_parity(),
        "g2": g2_coverage(),
        "states": gallery_db.state_counts(),
        "sources": gallery_db.source_counts(),
    }
    out_dir = os.path.join(BACKUP_ROOT, "reports")
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, f"gate-report-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)
    _log(f"report written: {path}")
    return report


# ---------------------------------------------------------------------------
# M6 - retire (call explicitly after the soak; never automatic)
# ---------------------------------------------------------------------------

def m6_retire(confirm: bool = False) -> dict:
    """Delete absorbed/quarantined files + legacy caches. Requires confirm=True."""
    if not confirm:
        _log("M6: refusing to run without confirm=True")
        return {}
    removed = {"sidecar_quarantine": 0, "composer_files": 0, "cache_thumbs": 0, "cache_previews": 0}
    for base, key in ((os.path.join(ABSORB_ROOT, "orphans"), "sidecar_quarantine"),
                      (os.path.join(ABSORB_ROOT, "sidecar_failed"), "sidecar_quarantine")):
        if os.path.isdir(base):
            for _dirpath, _dirs, fnames in os.walk(base):
                removed[key] += len(fnames)
            shutil.rmtree(base, ignore_errors=True)
    # composer state files whose blob is in the DB
    for item in _all_items():
        path = item.get("path") or ""
        if not path:
            continue
        json_path = os.path.splitext(path)[0] + ".composerstate.json"
        if os.path.isfile(json_path) and gallery_db.get_composer_state(item["id"]):
            try:
                os.remove(json_path)
                removed["composer_files"] += 1
            except OSError:
                pass
    # legacy cache dirs (blobs are the source of truth now)
    for base, key in ((THUMB_DIR, "cache_thumbs"), (PREVIEW_DIR, "cache_previews")):
        if os.path.isdir(base):
            for fname in os.listdir(base):
                if fname.endswith(".webp"):
                    try:
                        os.remove(os.path.join(base, fname))
                        removed[key] += 1
                    except OSError:
                        pass
    _log(f"M6: removed {removed}")
    return removed


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def run_all() -> dict:
    gallery_db.init_db()
    m0 = m0_snapshot()
    m1 = m1_schema()
    m2 = m2_rows()
    m3 = m3_files()
    report = gate_report()
    gallery_db.restore_journal_mode()
    gallery_blobs.restore_journal_mode()
    return {"m0": m0, "m1": m1, "m2": m2, "m3": m3, "gates": report}


if __name__ == "__main__":
    phase = (sys.argv[1] if len(sys.argv) > 1 else "all").lower()
    if phase == "m0":
        m0_snapshot()
    elif phase == "m1":
        m1_schema()
    elif phase == "m2":
        m2_rows()
    elif phase == "m3":
        m3_files()
    elif phase == "gates":
        gate_report()
    elif phase == "regen":
        gallery_db.init_db()
        gallery_db.set_fast_sync(True)
        gallery_blobs.set_fast_sync(True)
        regen_stats = {}
        _regen_missing_thumbs(regen_stats)
        print(f"[gallery-migrate] regen: {regen_stats}")
    elif phase == "txtinfo":
        gallery_db.init_db()
        gallery_db.set_fast_sync(True)
        txt_stats = {}
        _absorb_txt_archive(txt_stats)
        print(f"[gallery-migrate] txtinfo: {txt_stats}")
    elif phase == "m6":
        m6_retire(confirm="--confirm" in sys.argv)
    else:
        run_all()
    gallery_db.restore_journal_mode()
    gallery_blobs.restore_journal_mode()
