"""Dual-write bridge: endorsement_db (legacy) -> gallery.db (v2).

Every legacy mutation mirrors into the v2 store so both stay consistent until
gate G3 (1-week soak). All functions are best-effort: they never raise into
the legacy path, and they no-op when the gallery_v2 flag is off.

Rollback: set env GALLERY_V2=0 (webui restart) - the legacy DB and caches are
untouched by v2 reads, so the old gallery keeps working.
"""

import os

from modules import gallery_db

_ENABLED = None
_WARNED = set()


def v2_enabled() -> bool:
    global _ENABLED
    if _ENABLED is not None:
        return _ENABLED
    env = os.environ.get("GALLERY_V2")
    if env is not None:
        _ENABLED = env.strip().lower() not in ("0", "false", "off", "no")
        return _ENABLED
    try:
        from modules import shared
        value = shared.opts.data.get("gallery_v2", None) if hasattr(shared, "opts") else None
        if value is not None:
            _ENABLED = bool(value)
            return _ENABLED
    except Exception:
        pass
    _ENABLED = True
    return True


def set_enabled(value) -> None:
    """Test/rollback hook: force the bridge on or off for this process."""
    global _ENABLED
    _ENABLED = None if value is None else bool(value)


def init() -> None:
    """Ensure the v2 schema exists (called from endorsement_db.init_db)."""
    if not v2_enabled():
        return
    try:
        gallery_db.init_db()
    except Exception as exc:
        _warn("init", exc)


def _warn(where: str, exc: Exception) -> None:
    if where in _WARNED:
        return
    _WARNED.add(where)
    print(f"[gallery-bridge] {where} mirror failed (legacy DB unaffected): {exc}")


def _source_for(path: str) -> str:
    from modules import gallery_sources
    src = gallery_sources.source_for_path(path)
    if src:
        return src
    try:
        with gallery_db.get_conn() as conn:
            conn.execute(
                "INSERT OR IGNORE INTO sources(id, label, parser, schema_version, config_json, created_at) "
                "VALUES ('endorsed','Endorsed','none',1,'{}','')"
            )
            conn.commit()
    except Exception:
        pass
    return "endorsed"


def _ensure_item(key: str | None, path: str | None, fields: dict | None = None) -> int | None:
    """Resolve an existing item or create one for a legacy path/key."""
    item_id = None
    for candidate in (key, path):
        if candidate:
            item_id = gallery_db.resolve_item_id(candidate)
            if item_id:
                break
    if item_id:
        if key:
            gallery_db.map_legacy_key(key, item_id)
        return item_id
    if not path:
        return None
    source = _source_for(path)
    rel = gallery_sources_rel(path)
    fields = fields or {}
    payload = {
        "path": path, "rel_path": rel,
        "prompt": fields.get("prompt") or "",
        "negative_prompt": fields.get("negative_prompt") or "",
        "infotext": fields.get("infotext") or "",
        "width": int(fields.get("width") or 0),
        "height": int(fields.get("height") or 0),
        "meta": fields.get("meta") or {},
    }
    if path and os.path.isfile(path):
        try:
            stat = os.stat(path)
            payload["mtime"] = stat.st_mtime
            payload["file_size"] = stat.st_size
        except OSError:
            pass
        from modules import gallery_sources
        real_w, real_h = gallery_sources.image_size(path)
        if real_w and real_h:
            payload["width"] = real_w
            payload["height"] = real_h
    item_id = gallery_db.upsert_item(uid=gallery_db.make_uid(source, rel), source=source, **payload)
    if key:
        gallery_db.map_legacy_key(key, item_id)
    return item_id


def gallery_sources_rel(path: str) -> str:
    from modules import gallery_sources
    return gallery_sources._rel(path)


def _meta_fields(fields: dict) -> dict:
    meta = {}
    for src_key, dst_key in (
        ("seed", "seed"), ("steps", "steps"), ("sampler", "sampler"),
        ("cfg_scale", "cfg"), ("model_name", "model"), ("model_hash", "model_hash"),
    ):
        value = fields.get(src_key)
        if value not in (None, ""):
            meta[dst_key] = str(value)
    return meta


# ---------------------------------------------------------------------------
# mirror entry points (called from endorsement_db)
# ---------------------------------------------------------------------------

def on_index_image(path, file_mtime, prompt, negative_prompt, seed, steps, sampler,
                   cfg_scale, width, height, model_name, model_hash, infotext) -> None:
    if not v2_enabled() or not path:
        return
    try:
        source = _source_for(path)
        rel = gallery_sources_rel(path)
        uid = gallery_db.make_uid(source, rel)
        fields = dict(
            path=path, rel_path=rel,
            prompt=prompt or "", negative_prompt=negative_prompt or "",
            infotext=infotext or "",
            width=int(width or 0), height=int(height or 0),
            meta=_meta_fields({
                "seed": seed, "steps": steps, "sampler": sampler, "cfg_scale": cfg_scale,
                "model_name": model_name, "model_hash": model_hash,
            }),
        )
        if file_mtime:
            fields["mtime"] = float(file_mtime)
        if os.path.isfile(path):
            try:
                fields["file_size"] = os.path.getsize(path)
            except OSError:
                pass
            # legacy width/height come from generation params (inpaint: mask size;
            # hires fix: first-pass size) - prefer the real file dimensions
            from modules import gallery_sources
            real_w, real_h = gallery_sources.image_size(path)
            if real_w and real_h:
                fields["width"] = real_w
                fields["height"] = real_h
        item_id = gallery_db.upsert_item(uid=uid, source=source, **fields)
        legacy = os.path.splitext(os.path.basename(path))[0].strip().lower()
        if legacy:
            gallery_db.map_legacy_key(legacy, item_id)
        item = gallery_db.get_item(item_id)
        if item and item.get("state") == "trashed" and os.path.isfile(path):
            # A1111 recycles filename numbers: a regenerated image must leave the trash view
            with gallery_db.get_conn() as conn:
                conn.execute("UPDATE items SET state='active', archive_expires_at=NULL WHERE id=?", (item_id,))
                conn.commit()
            gallery_db.add_state_event(item_id, "reindex", {"reason": "filename_recycled"})
    except Exception as exc:
        _warn("index_image", exc)


def on_endorse(item_key, endorsed_copy_path, original_path, fields=None) -> None:
    if not v2_enabled():
        return
    try:
        fields = fields or {}
        canonical = original_path if (original_path and os.path.isfile(original_path)) else endorsed_copy_path
        item_id = _ensure_item(item_key, canonical or endorsed_copy_path, fields)
        if not item_id:
            return
        gallery_db.set_rating(item_id, "endorsed")
        if endorsed_copy_path and canonical and os.path.normcase(endorsed_copy_path) != os.path.normcase(canonical):
            gallery_db.set_item_alias(item_id, endorsed_copy_path)
        gallery_db.add_state_event(item_id, "endorse")
    except Exception as exc:
        _warn("endorse", exc)


def on_endorsement_removed(item_key=None, removed_path=None) -> None:
    if not v2_enabled():
        return
    try:
        item_id = gallery_db.resolve_item_id(item_key or removed_path)
        if not item_id:
            return
        if gallery_db.get_rating(item_id) == "endorsed":
            gallery_db.set_rating(item_id, None)
        item = gallery_db.get_item(item_id)
        if item and removed_path and item.get("alias_path") \
                and os.path.normcase(item["alias_path"]) == os.path.normcase(removed_path):
            gallery_db.set_item_alias(item_id, None)
        gallery_db.add_state_event(item_id, "unendorse")
    except Exception as exc:
        _warn("unendorse", exc)


def on_dislike(item_key, image_path, fields=None) -> None:
    if not v2_enabled():
        return
    try:
        item_id = _ensure_item(item_key, image_path, fields)
        if not item_id:
            return
        gallery_db.set_rating(item_id, "disliked")
        gallery_db.add_state_event(item_id, "dislike")
    except Exception as exc:
        _warn("dislike", exc)


def on_dislike_removed(item_key=None, path=None) -> None:
    if not v2_enabled():
        return
    try:
        item_id = gallery_db.resolve_item_id(item_key or path)
        if item_id and gallery_db.get_rating(item_id) == "disliked":
            gallery_db.set_rating(item_id, None)
            gallery_db.add_state_event(item_id, "undislike")
    except Exception as exc:
        _warn("undislike", exc)


def on_archive(item_key) -> None:
    _set_state_for_key(item_key, "archived", "archive", only_from=("active", "staged"))


def on_unarchive(item_key) -> None:
    _set_state_for_key(item_key, "active", "unarchive", only_from=("archived",))


def on_stage(item_key) -> None:
    _set_state_for_key(item_key, "staged", "stage", only_from=("active",))


def on_unstage(item_key) -> None:
    _set_state_for_key(item_key, "active", "unstage", only_from=("staged",))


def on_trash_keys(item_keys) -> None:
    if not v2_enabled():
        return
    for key in item_keys or []:
        try:
            item_id = gallery_db.resolve_item_id(key)
            if item_id:
                gallery_db.set_state(item_id, "trashed", event="trash", payload={"reason": "archived_and_disliked"})
        except Exception as exc:
            _warn("trash_keys", exc)


def _set_state_for_key(item_key, state, event, only_from=None) -> None:
    if not v2_enabled() or not item_key:
        return
    try:
        item_id = gallery_db.resolve_item_id(item_key)
        if not item_id:
            return
        item = gallery_db.get_item(item_id)
        if not item:
            return
        if only_from and item.get("state") not in only_from:
            return
        gallery_db.set_state(item_id, state, event=event)
    except Exception as exc:
        _warn(f"state:{state}", exc)


def on_captions(item_key, tags_dict) -> None:
    if not v2_enabled():
        return
    try:
        item_id = gallery_db.resolve_item_id(item_key)
        if item_id:
            gallery_db.save_captions(item_id, tags_dict or {})
    except Exception as exc:
        _warn("captions", exc)


def _num_int(value, default=0):
    try:
        return int(float(str(value).split(",")[0].strip()))
    except (TypeError, ValueError):
        return default


def _num_float(value, default=0.0):
    try:
        return float(str(value).split(",")[0].strip().rstrip("."))
    except (TypeError, ValueError):
        return default


def read_meta(path: str) -> dict:
    """v2 fallback for read_sidecar_metadata: served from the DB, not sidecars."""
    if not v2_enabled() or not path:
        return {}
    try:
        item = gallery_db.get_item_by_path(path)
        if not item:
            return {}
        meta = gallery_db.get_item_meta(item["id"])
        return {
            "infotext": item.get("infotext") or "",
            "prompt": item.get("prompt") or "",
            "negative_prompt": item.get("negative_prompt") or "",
            "steps": _num_int(meta.get("steps")),
            "sampler": str(meta.get("sampler") or ""),
            "cfg_scale": _num_float(str(meta.get("cfg") or "0").replace(",", ".")),
            "seed": str(meta.get("seed") or ""),
            "width": int(item.get("width") or 0),
            "height": int(item.get("height") or 0),
            "model": str(meta.get("model") or ""),
        }
    except Exception as exc:
        _warn("read_meta", exc)
        return {}
