"""Gallery v2 HTTP API: query / action / blob / facets / maintenance.

Registered from webui.py next to the other feature routes. All data comes from
gallery.db (and the blob store); mutations route through the legacy facade
(endorsement_db) wherever the old gallery must stay in sync during the soak.
"""

import json
import os


def register_routes(app):
    from fastapi import Body, HTTPException, Request
    from starlette.responses import Response as StarletteResponse

    # ------------------------------------------------------------------ read

    @app.get("/gallery/api/facets")
    def gallery_facets():
        from modules import gallery_db, gallery_query
        facet = gallery_query.facets()
        facet["stats"] = gallery_db.stats()
        try:
            from modules import gallery_blobs
            facet["blob_stats"] = gallery_blobs.get_store().stats()
        except Exception:
            facet["blob_stats"] = {}
        return facet

    @app.post("/gallery/api/query")
    def gallery_query_route(payload: dict = Body(default={})):
        from modules import gallery_query
        filters = gallery_query.parse_filters(payload.get("filters") or payload)
        sort = str(payload.get("sort") or "time_desc")
        limit = int(payload.get("limit") or 60)
        offset = int(payload.get("offset") or 0)
        result = gallery_query.query(filters, sort=sort, limit=limit, offset=offset)
        result["state_totals"] = gallery_query.state_totals(filters)
        return result

    # ----------------------------------------------------- saved views (filters)

    @app.get("/gallery/api/views")
    def gallery_views_list():
        from modules import gallery_db
        return {"views": _serialize_views(gallery_db.list_views())}

    @app.post("/gallery/api/views")
    def gallery_views_save(payload: dict = Body(default={})):
        from modules import gallery_db, gallery_query
        name = str(payload.get("name") or "").strip()[:60]
        if not name:
            raise HTTPException(status_code=400, detail="name required")
        filters = gallery_query.parse_filters(payload.get("filters") or {})
        sort = str(payload.get("sort") or "time_desc")
        gallery_db.save_view(name, json.dumps(filters, ensure_ascii=False), sort)
        return {"ok": True, "views": _serialize_views(gallery_db.list_views())}

    @app.post("/gallery/api/views/delete")
    def gallery_views_delete(payload: dict = Body(default={})):
        from modules import gallery_db
        name = str(payload.get("name") or "").strip()
        if not name:
            raise HTTPException(status_code=400, detail="name required")
        gallery_db.delete_view(name)
        return {"ok": True, "views": _serialize_views(gallery_db.list_views())}

    # ------------------------------------------------------------------ albums

    @app.get("/gallery/api/albums")
    def gallery_albums_list():
        from modules import gallery_db
        return {"albums": _serialize_albums(gallery_db.list_albums())}

    @app.post("/gallery/api/albums")
    def gallery_albums_create(payload: dict = Body(default={})):
        from modules import gallery_db
        try:
            gallery_db.create_album(str(payload.get("name") or ""))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        return {"ok": True, "albums": _serialize_albums(gallery_db.list_albums())}

    @app.post("/gallery/api/albums/rename")
    def gallery_albums_rename(payload: dict = Body(default={})):
        from modules import gallery_db
        album = _album_from_payload(payload)
        if not album:
            raise HTTPException(status_code=404, detail="album not found")
        try:
            gallery_db.rename_album(album["id"], str(payload.get("new_name") or ""))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        return {"ok": True, "albums": _serialize_albums(gallery_db.list_albums())}

    @app.post("/gallery/api/albums/delete")
    def gallery_albums_delete(payload: dict = Body(default={})):
        from modules import gallery_db
        album = _album_from_payload(payload)
        if not album:
            raise HTTPException(status_code=404, detail="album not found")
        if album.get("bundled_at"):
            raise HTTPException(status_code=400, detail="album is bundled; unbundle first")
        gallery_db.delete_album(album["id"])
        return {"ok": True, "albums": _serialize_albums(gallery_db.list_albums())}

    @app.post("/gallery/api/albums/items")
    def gallery_albums_items(payload: dict = Body(default={})):
        from modules import gallery_db
        album = _album_from_payload(payload, create_name=payload.get("new_name"))
        if not album:
            raise HTTPException(status_code=404, detail="album not found")
        names = {int(a["id"]): a["name"] for a in gallery_db.list_albums()}
        result = {"ok": True, "album": {"id": int(album["id"]), "name": album["name"]},
                  "added": 0, "moved": [], "removed": 0, "errors": []}

        add_keys = payload.get("add") or ([payload["key"]] if payload.get("key") else [])
        for key in add_keys:
            item_id = gallery_db.resolve_item_id(key)
            item = gallery_db.get_item(item_id) if item_id else None
            if not item:
                result["errors"].append({"key": str(key), "error": "not_found"})
                continue
            if item.get("album_id") == int(album["id"]):
                continue
            if item.get("album_id"):
                result["moved"].append({
                    "key": str(key),
                    "from": names.get(int(item["album_id"]), "album %s" % item["album_id"]),
                })
            gallery_db.set_item_album(item_id, int(album["id"]))
            result["added"] += 1

        remove_keys = payload.get("remove") or []
        for key in remove_keys:
            item_id = gallery_db.resolve_item_id(key)
            item = gallery_db.get_item(item_id) if item_id else None
            if not item:
                result["errors"].append({"key": str(key), "error": "not_found"})
                continue
            if item.get("album_id") == int(album["id"]):
                gallery_db.set_item_album(item_id, None)
                result["removed"] += 1

        result["albums"] = _serialize_albums(gallery_db.list_albums())
        return result

    @app.post("/gallery/api/albums/cover")
    def gallery_albums_cover(payload: dict = Body(default={})):
        from modules import gallery_db
        album = _album_from_payload(payload)
        if not album:
            raise HTTPException(status_code=404, detail="album not found")
        key = str(payload.get("key") or "")
        item_id = gallery_db.resolve_item_id(key) if key else None
        item = gallery_db.get_item(item_id) if item_id else None
        if not item:
            raise HTTPException(status_code=404, detail="item not found")
        if item.get("album_id") != int(album["id"]):
            raise HTTPException(status_code=400, detail="item is not in this album")
        gallery_db.set_album_cover(int(album["id"]), item["uid"])
        return {"ok": True, "albums": _serialize_albums(gallery_db.list_albums())}

    @app.post("/gallery/api/albums/bundle")
    def gallery_albums_bundle(payload: dict = Body(default={})):
        from modules import gallery_albums, gallery_db
        album = _album_from_payload(payload)
        if not album:
            raise HTTPException(status_code=404, detail="album not found")
        result = gallery_albums.bundle_album(album["id"])
        if not result.get("ok"):
            raise HTTPException(status_code=400, detail=result.get("error") or "bundle failed")
        result["albums"] = _serialize_albums(gallery_db.list_albums())
        return result

    @app.post("/gallery/api/albums/unbundle")
    def gallery_albums_unbundle(payload: dict = Body(default={})):
        from modules import gallery_albums, gallery_db
        album = _album_from_payload(payload)
        if not album:
            raise HTTPException(status_code=404, detail="album not found")
        result = gallery_albums.unbundle_album(album["id"])
        if not result.get("ok"):
            raise HTTPException(status_code=400, detail=result.get("error") or "unbundle failed")
        result["albums"] = _serialize_albums(gallery_db.list_albums())
        return result

    @app.get("/gallery/api/item")
    def gallery_item(id: str = ""):
        from modules import gallery_db, gallery_query
        item_id = gallery_db.resolve_item_id(id)
        if not item_id:
            raise HTTPException(status_code=404, detail="item not found")
        item = gallery_db.get_item(item_id)
        item["meta"] = gallery_db.get_item_meta(item_id)
        item.pop("meta_json", None)
        item["tags"] = gallery_db.get_tags([item_id]).get(item_id, [])
        item["events"] = gallery_db.get_state_events(item_id, limit=20)
        item["has_composer"] = bool(gallery_db.get_composer_state(item_id))
        item["similar"] = [r["id"] for r in gallery_query.similar(item_id, limit=12)]
        return item

    @app.get("/gallery/api/composer")
    def gallery_composer(id: str = ""):
        from modules import gallery_db
        item_id = gallery_db.resolve_item_id(id)
        if not item_id:
            raise HTTPException(status_code=404, detail="item not found")
        raw = gallery_db.get_composer_state(item_id)
        if not raw:
            raise HTTPException(status_code=404, detail="no composer state")
        return {"ok": True, "state": raw}

    @app.get("/gallery/api/blob")
    def gallery_blob(request: Request, id: str = "", kind: str = "thumb"):
        from modules import gallery_blobs, gallery_db
        if kind not in ("thumb", "preview"):
            raise HTTPException(status_code=400, detail="kind must be thumb|preview")
        item_id = gallery_db.resolve_item_id(id)
        if not item_id:
            raise HTTPException(status_code=404, detail="item not found")
        item = gallery_db.get_item(item_id)
        state = (item or {}).get("state") or "active"
        if state == "trashed":
            raise HTTPException(status_code=404, detail="trashed items hold no media")
        if state == "archived" and kind == "preview":
            raise HTTPException(status_code=404, detail="archived items keep thumb only")

        store = gallery_blobs.get_store()
        row = store.get_row(item_id, kind)
        if not row:
            path = item.get("path") or ""
            data = gallery_blobs.ensure_blob(item_id, kind, path)
            if not data:
                alias = item.get("alias_path") or ""
                data = gallery_blobs.ensure_blob(item_id, kind, alias) if alias else None
            if not data:
                raise HTTPException(status_code=404, detail="no media")
            row = store.get_row(item_id, kind)

        etag = f'"{int(row["crc32"] or 0):x}-{int(row["size"] or 0):x}"'
        headers = {
            "ETag": etag,
            "Cache-Control": "private, max-age=86400",
            "X-Content-Type-Options": "nosniff",
        }
        if request.headers.get("if-none-match") == etag:
            return StarletteResponse(status_code=304, headers=headers)
        return StarletteResponse(
            content=bytes(row["data"]),
            media_type=f'image/{row["format"] or "webp"}',
            headers=headers,
        )

    # ---------------------------------------------------------------- action

    @app.post("/gallery/api/action")
    def gallery_action(payload: dict = Body(default={})):
        return _handle_action(payload)

    @app.post("/gallery/api/similar")
    def gallery_similar(payload: dict = Body(default={})):
        from modules import gallery_db, gallery_query
        item_id = gallery_db.resolve_item_id(payload.get("id") or payload.get("key"))
        if not item_id:
            raise HTTPException(status_code=404, detail="item not found")
        rows = gallery_query.similar(item_id, limit=int(payload.get("limit") or 24))
        ids = [int(r["id"]) for r in rows]
        tags = gallery_db.get_tags(ids)
        for row in rows:
            row["tags"] = tags.get(int(row["id"]), [])
            row.pop("meta_json", None)
        return {"rows": rows}

    @app.post("/gallery/api/maintenance")
    def gallery_maintenance(payload: dict = Body(default={})):
        op = str(payload.get("op") or "")
        dry_run = bool(payload.get("dry_run"))
        from modules import gallery_db, gallery_lifecycle, gallery_query
        if op == "sweep":
            return gallery_lifecycle.sweep()
        if op == "empty_trash":
            if dry_run:
                return {"ok": True, "dry_run": True, "count": _maintenance_count({"states": ["trashed"]})}
            count = gallery_lifecycle.empty_trash()
            _legacy_empty_trash()
            return {"ok": True, "removed": count}
        if op in ("trash_disliked", "trash_archived"):
            from modules import endorsement_db
            filters = {"rating": "disliked"} if op == "trash_disliked" else {"states": ["archived"]}
            if dry_run:
                return {"ok": True, "dry_run": True, "count": _maintenance_count(filters)}
            trashed = 0
            failed = []
            for _pass in range(500):
                page = gallery_query.query(dict(filters), "time_desc", 200, 0,
                                           with_tags=False, with_meta=False)
                rows = page.get("rows") or []
                if not rows:
                    break
                before = trashed
                for item in rows:
                    try:
                        outcome = endorsement_db.trash_item_by_key(_item_legacy_key(item))
                    except Exception as exc:
                        outcome = {"error": str(exc)}
                    if outcome.get("error"):
                        failed.append({"key": item.get("uid") or "", "error": outcome["error"]})
                    else:
                        trashed += 1
                # trashed items drop out of the result set; stop when nothing moved
                if len(rows) < 200 or trashed == before:
                    break
            return {"ok": True, "removed": trashed, "failed": failed[:20]}
        if op in ("archive_unrated", "archive_filtered"):
            from modules import endorsement_db
            filters = _archive_filterset(op, payload)
            if not filters.get("states"):
                if dry_run:
                    return {"ok": True, "dry_run": True, "count": 0}
                return {"ok": True, "archived": 0, "failed": []}
            if dry_run:
                return {"ok": True, "dry_run": True, "count": _maintenance_count(filters)}
            archived = 0
            failed = []
            for _pass in range(500):
                page = gallery_query.query(dict(filters), "time_desc", 200, 0,
                                           with_tags=False, with_meta=False)
                rows = page.get("rows") or []
                if not rows:
                    break
                before = archived
                for item in rows:
                    try:
                        outcome = endorsement_db.archive_item(_item_legacy_key(item))
                    except Exception as exc:
                        outcome = {"error": str(exc)}
                    if isinstance(outcome, dict) and outcome.get("error"):
                        failed.append({"key": item.get("uid") or "", "error": outcome["error"]})
                    else:
                        archived += 1
                # archived items drop out of the active/staged set; stop when nothing moved
                if len(rows) < 200 or archived == before:
                    break
            return {"ok": True, "archived": archived, "failed": failed[:20]}
        if op == "enforce_trash_media":
            return gallery_lifecycle.enforce_trash_media()
        if op == "blob_sweep":
            from modules import gallery_blobs
            states = {}
            with gallery_db.get_conn() as conn:
                for row in conn.execute("SELECT id, state FROM items").fetchall():
                    states[int(row[0])] = row[1]
            return {"ok": True, "removed": gallery_blobs.get_store().sweep(states)}
        if op == "reindex":
            from modules import gallery_sources
            return {"ok": True, "stats": gallery_sources.index_all()}
        if op == "stats":
            from modules import gallery_blobs
            return {
                "items": gallery_db.stats(),
                "states": gallery_db.state_counts(),
                "sources": gallery_db.source_counts(),
                "blobs": gallery_blobs.get_store().stats(),
            }
        raise HTTPException(status_code=400, detail=f"unknown op: {op}")


def _serialize_views(rows: list) -> list:
    """Normalise saved_views rows into API shapes (filters parsed, sort defaulted)."""
    out = []
    for row in rows or []:
        try:
            filters = json.loads(row.get("filter_json") or "{}")
        except Exception:
            filters = {}
        out.append({
            "name": row.get("name") or "",
            "filters": filters if isinstance(filters, dict) else {},
            "sort": row.get("sort_json") or "time_desc",
            "created_at": row.get("created_at") or "",
        })
    return out


def _album_cover_uid(album_id: int, preferred: str = "") -> str:
    """Album cover uid: the pinned cover when it still exists, else the newest non-trashed member."""
    from modules import gallery_db
    if not album_id:
        return ""
    try:
        with gallery_db.get_conn() as conn:
            if preferred:
                row = conn.execute(
                    "SELECT uid FROM items WHERE uid=? AND state!='trashed' AND album_id=?",
                    (str(preferred), int(album_id)),
                ).fetchone()
                if row:
                    return str(row[0])
            row = conn.execute(
                "SELECT uid FROM items WHERE album_id=? AND state!='trashed' "
                "ORDER BY mtime DESC, id DESC LIMIT 1",
                (int(album_id),),
            ).fetchone()
        return str(row[0]) if row else ""
    except Exception:
        return ""


def _serialize_albums(rows: list) -> list:
    """Normalise album rows into API shapes (bundled flag + sizes + cover)."""
    out = []
    for row in rows or []:
        album_id = int(row.get("id") or 0)
        out.append({
            "id": album_id,
            "name": row.get("name") or "",
            "count": int(row.get("count") or 0),
            "bundled": bool(row.get("bundled_at")),
            "bundled_at": row.get("bundled_at") or "",
            "bundle_size": int(row.get("bundle_size") or 0),
            "bundle_count": int(row.get("bundle_count") or 0),
            "created_at": row.get("created_at") or "",
            "cover": _album_cover_uid(album_id, row.get("cover_uid") or ""),
        })
    return out


def _album_from_payload(payload: dict, create_name=None):
    """Resolve payload['album'] (id or name) into an album row; option to create."""
    from modules import gallery_db
    ref = payload.get("album")
    album = None
    if ref is not None and str(ref).strip() != "":
        text = str(ref).strip()
        album = gallery_db.get_album(album_id=int(text)) if text.lstrip("-").isdigit() \
            else gallery_db.get_album(name=text)
    if not album and create_name:
        try:
            album_id = gallery_db.create_album(str(create_name))
        except ValueError:
            album_id = None
            album = gallery_db.get_album(name=str(create_name))
        if album_id and not album:
            album = gallery_db.get_album(album_id=album_id)
    return album


# Sources whose files are indexed by the legacy DB, where the filename stem IS
# the historic item_key. Every other source has no legacy rows, and its stems
# repeat across runs (image_maker's image_v01.png, comic_maker's page_01.png,
# engine folders named 000.png, ...), so the canonical uid is the only safe key.
LEGACY_STEM_SOURCES = ("txt2img", "img2img", "inpaint")


def _item_legacy_key(item) -> str:
    """Key used for legacy-facade action round-trips (stem or canonical handle)."""
    source = item.get("source") or ""
    rel = (item.get("rel_path") or "").replace("\\", "/")
    if source in ("qwen", "krea2"):
        # canonical engine key (byte-identical to the desktop gallery + SD Lite):
        # <engine>-outputs-<engine>-<date>-<time>-<stem>
        parts = [p for p in rel.split("/") if p]
        if len(parts) >= 3:
            parts[-1] = os.path.splitext(parts[-1])[0]
            return source + "-" + "-".join(p.lower() for p in parts)
    if source and source not in LEGACY_STEM_SOURCES:
        uid = str(item.get("uid") or "").strip()
        if uid:
            return uid
    path = item.get("path") or item.get("alias_path") or ""
    return os.path.splitext(os.path.basename(path))[0].strip().lower()


def _legacy_empty_trash():
    try:
        from modules import endorsement_db
        with endorsement_db._get_conn() as conn:
            conn.execute("DELETE FROM trash")
            conn.commit()
    except Exception:
        pass


def _maintenance_count(fs: dict) -> int:
    """Item count for a maintenance dry-run preview (raw filters dict)."""
    from modules import gallery_query
    return int(gallery_query.query(dict(fs), "time_desc", 1, 0, with_tags=False, with_meta=False)["total"])


def _archive_filterset(op: str, payload: dict) -> dict:
    """FilterSet for bulk archive. Only active/staged items can be archived; an empty
    state intersection means nothing matches (never fall back to all states)."""
    from modules import gallery_query
    if op == "archive_unrated":
        fs = gallery_query.parse_filters({"rating": "none"})
        # global maintenance: album membership never excludes items (matches the legacy
        # desktop + mobile "Archive Unrated" which have no album concept)
        fs["show_albumed"] = True
    else:
        fs = gallery_query.parse_filters(payload.get("filters") or payload)
    states = fs.get("states") or []
    fs["states"] = [s for s in states if s in ("active", "staged")] if states else ["active", "staged"]
    return fs


def _handle_action(payload: dict) -> dict:
    from modules import gallery_db, gallery_lifecycle

    action = str(payload.get("action") or "")
    keys = payload.get("keys") or ([payload.get("key")] if payload.get("key") else [])
    params = payload.get("params") or {}
    results = []
    errors = []

    for key in keys:
        try:
            item_id = gallery_db.resolve_item_id(key)
            if not item_id:
                errors.append({"key": key, "error": "not_found"})
                continue
            item = gallery_db.get_item(item_id)
            item_key = _item_legacy_key(item)
            outcome = _apply_action(action, item_id, item, item_key, params)
            if outcome.get("error"):
                errors.append({"key": key, "error": outcome["error"]})
                continue
            fresh = gallery_db.get_item(item_id)
            rating = gallery_db.get_rating(item_id)
            results.append({
                "key": str(key),
                "id": item_id,
                "state": (fresh or {}).get("state"),
                "rating": rating,
                "archive_expires_at": (fresh or {}).get("archive_expires_at"),
            })
        except Exception as exc:
            errors.append({"key": key, "error": str(exc)})

    return {"ok": not errors, "changed": results, "errors": errors, "action": action}


def _apply_action(action: str, item_id: int, item: dict, item_key: str, params: dict) -> dict:
    from modules import endorsement_db, gallery_db, gallery_lifecycle

    if action in ("endorse", "unendorse", "dislike", "undislike"):
        return _rating_action(action, item_id, item, item_key, params)
    if action == "archive":
        endorsement_db.archive_item(item_key)
        return {}
    if action == "unarchive":
        endorsement_db.unarchive_item(item_key)
        return {}
    if action == "stage":
        if gallery_db.get_rating(item_id):
            return {"error": "rated items (endorse/dislike) cannot be staged"}
        endorsement_db.stage_item(item_key)
        return {}
    if action == "unstage":
        endorsement_db.unstage_item(item_key)
        return {}
    if action == "trash":
        return endorsement_db.trash_item_by_key(item_key)
    if action == "restore":
        result = gallery_lifecycle.restore_from_trash(item_id)
        if not result.get("ok"):
            return {"error": result.get("reason", "cannot restore")}
        endorsement_db.remove_trash_row(item_key)
        return {}
    if action == "purge":
        endorsement_db.remove_trash_row(item_key)
        gallery_db.delete_item(item_id)
        return {}
    if action == "add_tag":
        category = str(params.get("category") or gallery_db.WORKFLOW_CATEGORY)
        name = str(params.get("tag") or "").strip()
        if not name:
            return {"error": "empty tag"}
        gallery_db.add_tag(item_id, category, name)
        return {}
    if action == "remove_tag":
        category = str(params.get("category") or gallery_db.WORKFLOW_CATEGORY)
        name = str(params.get("tag") or "").strip()
        gallery_db.remove_tag(item_id, category, name)
        return {}
    return {"error": f"unknown action: {action}"}


def _rating_action(action: str, item_id: int, item: dict, item_key: str, params: dict) -> dict:
    """Ratings go through the legacy facade so both stores stay consistent."""
    from modules import endorsement_db, gallery_bridge, gallery_db

    if action == "unendorse":
        endorsement_db.delete_endorsement_by_key(item_key)
        return {}
    if action == "undislike":
        endorsement_db.delete_dislike_by_key(item_key)
        return {}

    path = item.get("path") or item.get("alias_path") or ""
    if not path or not os.path.isfile(path):
        return {"error": "original file missing"}
    meta = gallery_db.get_item_meta(item_id)

    def _num(value, default=0):
        try:
            return float(str(value).split(",")[0])
        except (TypeError, ValueError):
            return default

    if action == "endorse":
        endorsement_db.endorse(
            path,
            item.get("prompt") or "", item.get("negative_prompt") or "",
            str(meta.get("seed") or ""), int(_num(meta.get("steps"))),
            str(meta.get("sampler") or ""), _num(meta.get("cfg")),
            int(item.get("width") or 0), int(item.get("height") or 0),
            str(meta.get("model") or ""), str(meta.get("model_hash") or ""),
            item.get("infotext") or "", item_key=item_key,
        )
        return {}
    if action == "dislike":
        endorsement_db.dislike(
            path,
            item.get("prompt") or "", item.get("negative_prompt") or "",
            str(meta.get("seed") or ""), int(_num(meta.get("steps"))),
            str(meta.get("sampler") or ""), _num(meta.get("cfg")),
            int(item.get("width") or 0), int(item.get("height") or 0),
            str(meta.get("model") or ""), str(meta.get("model_hash") or ""),
            item.get("infotext") or "", item_key=item_key,
        )
        return {}
    return {"error": f"unknown rating action: {action}"}
