"""Gallery v2 query engine: FilterSet -> SQL over gallery.db.

Core filter dimensions (user principles 2026-10-10):
  time - source - state - tags (per category) - resolution - prompt - negative
Sorts: time (desc/asc) - resolution - size - random (+ name).
Search grammar: -exclude, "quoted phrase", tag:, rating:, source:, prompt:,
negative:; plain terms hit the FTS index (prompt/negative/infotext/tags).

Meta fields (seed/model/steps/...) are deliberately not filterable; promote
one later with a generated column + index (plan section 4.3).
"""

import json
import re
import time

from modules import gallery_db

SORT_KEYS = ("time_desc", "time_asc", "resolution", "size", "random", "name")

_TIME_PRESETS = {
    "all": None,
    "1h": 3600,
    "1d": 86400,
    "3d": 3 * 86400,
    "7d": 7 * 86400,
    "30d": 30 * 86400,
    "1y": 365 * 86400,
}


def parse_filters(raw) -> dict:
    """Normalise a JSON string / dict into a FilterSet dict."""
    if not raw:
        return {}
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except Exception:
            return {"q": raw}
    if not isinstance(raw, dict):
        return {}
    fs = {}
    fs["q"] = str(raw.get("q") or "").strip()
    if raw.get("preset"):
        fs["preset"] = str(raw["preset"])
    for key in ("since", "until"):
        if raw.get(key) not in (None, ""):
            try:
                fs[key] = float(raw[key])
            except (TypeError, ValueError):
                pass
    sources = raw.get("sources") or []
    fs["sources"] = [str(s).lower() for s in sources if str(s).strip()]
    albums = raw.get("albums") or []
    fs["albums"] = []
    for entry in albums:
        text = str(entry).strip().lower()
        if text == "none":
            fs["albums"].append("none")
        elif text.lstrip("-").isdigit():
            fs["albums"].append(int(text))
    fs["show_albumed"] = bool(raw.get("show_albumed"))
    states = raw.get("states") or []
    fs["states"] = [str(s).lower() for s in states if str(s).strip() in gallery_db.VALID_STATES]
    rating = raw.get("rating")
    fs["rating"] = str(rating).lower() if rating else None
    tags = raw.get("tags") or {}
    if isinstance(tags, dict):
        fs["tags"] = {str(k): [str(v) for v in (vals or []) if str(v).strip()] for k, vals in tags.items()
                      if vals}
    else:
        fs["tags"] = {}
    fs["tag_mode"] = str(raw.get("tag_mode") or "any")
    for key in ("min_width", "max_width", "min_height", "max_height"):
        if raw.get(key) not in (None, ""):
            try:
                fs[key] = int(raw[key])
            except (TypeError, ValueError):
                pass
    if raw.get("aspect") in ("landscape", "portrait", "square"):
        fs["aspect"] = raw["aspect"]
    fs["has_composer"] = bool(raw.get("has_composer"))
    fs["has_variants"] = bool(raw.get("has_variants"))
    fs["path"] = str(raw.get("path") or "").strip()
    fs["kind"] = str(raw.get("kind") or "").strip() or None
    return fs


def _since_from_preset(fs: dict) -> float | None:
    if "since" in fs:
        return fs["since"]
    preset = fs.get("preset")
    if preset and preset in _TIME_PRESETS:
        delta = _TIME_PRESETS[preset]
        return (time.time() - delta) if delta else None
    return None


_SEARCH_TOKEN_RE = re.compile(
    r'(-?)(?:(\w+):"([^"]*)"|(\w+):(\S+)|"([^"]*)"|(\S+))'
)


def _parse_search(q: str) -> dict:
    """Parse the search grammar into structured constraints + FTS terms."""
    out = {
        "fts_include": [], "fts_exclude": [],
        "tags": [], "ratings": [], "sources": [],
        "prompt": [], "negative": [], "plain": [],
    }
    if not q:
        return out
    for match in _SEARCH_TOKEN_RE.finditer(q):
        negate = bool(match.group(1))
        if match.group(2) is not None:
            key, value, phrase = match.group(2), match.group(3), True
        elif match.group(4) is not None:
            key, value, phrase = match.group(4), match.group(5), False
        elif match.group(6) is not None:
            key, value, phrase = None, match.group(6), True
        else:
            key, value, phrase = None, match.group(7), False
        value = (value or "").strip()
        if not value:
            continue
        key_low = (key or "").lower()
        if key_low == "tag":
            out["tags"].append(value)
        elif key_low == "rating":
            out["ratings"].append(value.lower())
        elif key_low == "source":
            out["sources"].append(value.lower())
        elif key_low == "prompt":
            if negate:
                out["fts_exclude"].append(f'"{value}"*')
            else:
                out["prompt"].append(value)
        elif key_low == "negative":
            if negate:
                out["fts_exclude"].append(f'"{value}"*')
            else:
                out["negative"].append(value)
        elif key_low:
            out["plain"].append(f"{key}:{value}")
            term = f'"{key}:{value}"*'
            (out["fts_exclude"] if negate else out["fts_include"]).append(term)
        elif phrase:
            out["plain"].append(value)
            (out["fts_exclude"] if negate else out["fts_include"]).append(f'"{value}"')
        else:
            out["plain"].append(value)
            (out["fts_exclude"] if negate else out["fts_include"]).append(f'"{value}"*')
    return out


def _fts_expr(parsed: dict) -> str:
    parts = list(parsed["fts_include"])
    for exc in parsed["fts_exclude"]:
        parts.append(f"NOT {exc}")
    return " ".join(parts)


def build_where(fs: dict, parsed: dict | None = None) -> tuple[str, list]:
    """Build WHERE fragment + params (without the WHERE keyword)."""
    parsed = parsed if parsed is not None else _parse_search(fs.get("q") or "")
    clauses = []
    params = []

    since = _since_from_preset(fs)
    if since:
        clauses.append("i.mtime >= ?")
        params.append(float(since))
    if fs.get("until"):
        clauses.append("i.mtime <= ?")
        params.append(float(fs["until"]))

    states = fs.get("states") or []
    if states:
        ph = ",".join("?" * len(states))
        clauses.append(f"i.state IN ({ph})")
        params += states
    else:
        clauses.append("i.state != 'trashed'")

    sources = list(fs.get("sources") or []) + list(parsed.get("sources") or [])
    if sources:
        ph = ",".join("?" * len(sources))
        clauses.append(f"i.source IN ({ph})")
        params += sources

    albums = fs.get("albums") or []
    if albums:
        album_ids = [int(a) for a in albums if isinstance(a, int)]
        parts = []
        if album_ids:
            ph = ",".join("?" * len(album_ids))
            parts.append(f"i.album_id IN ({ph})")
            params += album_ids
        if "none" in albums:
            parts.append("i.album_id IS NULL")
        if parts:
            clauses.append("(" + " OR ".join(parts) + ")")
    elif fs.get("show_albumed") or "trashed" in states:
        pass  # albumed items visible on request / in the trash view
    else:
        # default: items that belong to an album stay inside the album view
        clauses.append("i.album_id IS NULL")

    ratings = [fs["rating"]] if fs.get("rating") else []
    ratings += parsed.get("ratings") or []
    for rating in ratings:
        if rating == "none":
            clauses.append(
                "NOT EXISTS (SELECT 1 FROM item_tags it WHERE it.item_id=i.id AND it.category_id='rating')"
            )
        else:
            clauses.append(
                "EXISTS (SELECT 1 FROM item_tags it JOIN tags t ON t.id=it.tag_id "
                "WHERE it.item_id=i.id AND it.category_id='rating' AND t.name=? COLLATE NOCASE)"
            )
            params.append(rating)

    tags = {k: list(v) for k, v in (fs.get("tags") or {}).items()}
    for name in parsed.get("tags") or []:
        tags.setdefault("_any", []).append(name)
    if tags:
        tag_mode = fs.get("tag_mode") or "any"
        exists_parts = []
        for category, names in tags.items():
            names = [str(n) for n in names if str(n).strip()]
            if not names:
                continue
            per_name = []
            for name in names:
                if category == "_any":
                    per_name.append(("t.name=? COLLATE NOCASE", [name]))
                else:
                    per_name.append(("(t.name=? COLLATE NOCASE AND it.category_id=?)", [name, category]))
            if tag_mode == "all" or category == "_any":
                for cond, cond_params in per_name:
                    exists_parts.append(
                        "EXISTS (SELECT 1 FROM item_tags it JOIN tags t ON t.id=it.tag_id "
                        f"WHERE it.item_id=i.id AND {cond})"
                    )
                    params += cond_params
            else:
                inner = " OR ".join(cond for cond, _ in per_name)
                for _, cond_params in per_name:
                    params += cond_params
                exists_parts.append(
                    "EXISTS (SELECT 1 FROM item_tags it JOIN tags t ON t.id=it.tag_id "
                    f"WHERE it.item_id=i.id AND ({inner}))"
                )
        if exists_parts:
            clauses.append("(" + " AND ".join(exists_parts) + ")")

    for key, op in (("min_width", ">="), ("max_width", "<="), ("min_height", ">="), ("max_height", "<=")):
        if fs.get(key) is not None:
            clauses.append(f"i.width {op} ?")
            params.append(int(fs[key]))
    aspect = fs.get("aspect")
    if aspect == "landscape":
        clauses.append("i.width > i.height")
    elif aspect == "portrait":
        clauses.append("i.width < i.height")
    elif aspect == "square":
        clauses.append("i.width = i.height")

    if fs.get("has_composer"):
        clauses.append("EXISTS (SELECT 1 FROM composer_states cs WHERE cs.item_id=i.id)")
    if fs.get("has_variants"):
        clauses.append("EXISTS (SELECT 1 FROM items c WHERE c.parent_id=i.id)")
    if fs.get("path"):
        clauses.append("i.path LIKE ? ESCAPE '\\'")
        params.append("%" + _like_escape(fs["path"]) + "%")
    if fs.get("kind"):
        clauses.append("i.kind = ?")
        params.append(fs["kind"])

    for term in parsed.get("prompt") or []:
        clauses.append("(i.prompt LIKE ? ESCAPE '\\' OR i.infotext LIKE ? ESCAPE '\\')")
        pat = "%" + _like_escape(term) + "%"
        params += [pat, pat]
    for term in parsed.get("negative") or []:
        clauses.append("i.negative_prompt LIKE ? ESCAPE '\\'")
        params.append("%" + _like_escape(term) + "%")

    fts = _fts_expr(parsed)
    if fts:
        clauses.append("i.id IN (SELECT rowid FROM items_fts WHERE items_fts MATCH ?)")
        params.append(fts)

    return (" AND ".join(clauses) if clauses else "1=1"), params


def _like_escape(text: str) -> str:
    return str(text).replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def query(fs: dict | None, sort: str = "time_desc", limit: int = 60, offset: int = 0,
          with_tags: bool = True, with_meta: bool = True) -> dict:
    """Run a FilterSet query. Returns {total, rows, sort, filters}."""
    fs = fs or {}
    parsed = _parse_search(fs.get("q") or "")
    where, params = build_where(fs, parsed)
    order = {
        "time_desc": "i.mtime DESC, i.id DESC",
        "time_asc": "i.mtime ASC, i.id ASC",
        "resolution": "(COALESCE(i.width,0) * COALESCE(i.height,0)) DESC, i.mtime DESC",
        "size": "COALESCE(i.file_size,0) DESC, i.mtime DESC",
        "random": "RANDOM()",
        "name": "i.uid ASC",
    }.get(sort if sort in SORT_KEYS else "time_desc", "i.mtime DESC")

    limit = max(0, int(limit or 0))
    offset = max(0, int(offset or 0))

    with gallery_db.get_conn() as conn:
        try:
            total = conn.execute(
                f"SELECT COUNT(*) FROM items i WHERE {where}", params
            ).fetchone()[0]
        except Exception:
            # FTS grammar blow-up: retry without the MATCH clause
            parsed_safe = dict(parsed)
            parsed_safe["fts_include"] = []
            parsed_safe["fts_exclude"] = []
            where, params = build_where(fs, parsed_safe)
            total = conn.execute(
                f"SELECT COUNT(*) FROM items i WHERE {where}", params
            ).fetchone()[0]
        sql = f"SELECT i.* FROM items i WHERE {where} ORDER BY {order}"
        if limit:
            sql += " LIMIT ? OFFSET ?"
            params = params + [limit, offset]
        rows = [dict(r) for r in conn.execute(sql, params).fetchall()]

    ids = [int(r["id"]) for r in rows]
    tags_map = gallery_db.get_tags(ids) if (with_tags and ids) else {}
    for r in rows:
        r["tags"] = tags_map.get(int(r["id"]), [])
        if with_meta:
            try:
                r["meta"] = json.loads(r.get("meta_json") or "{}")
            except Exception:
                r["meta"] = {}
        r.pop("meta_json", None)
    return {"total": int(total), "rows": rows, "sort": sort, "filters": fs}


def state_totals(fs: dict | None = None) -> dict:
    """Count per state under the current filters (state filter removed)."""
    fs = dict(fs or {})
    fs.pop("states", None)
    parsed = _parse_search(fs.get("q") or "")
    where, params = build_where(fs, parsed)
    with gallery_db.get_conn() as conn:
        rows = conn.execute(
            f"SELECT i.state, COUNT(*) FROM items i WHERE {where} GROUP BY i.state", params
        ).fetchall()
    return {r[0]: int(r[1]) for r in rows}


def similar(item_id: int, limit: int = 24) -> list:
    """Cheap find-similar: same seed (meta), then prompt-token overlap."""
    item = gallery_db.get_item(item_id)
    if not item:
        return []
    meta = gallery_db.get_item_meta(item_id)
    seed = str(meta.get("seed") or "")
    rows = []
    with gallery_db.get_conn() as conn:
        if seed:
            rows = conn.execute(
                "SELECT * FROM items WHERE id!=? AND source=? AND meta_json LIKE ? "
                "ORDER BY mtime DESC LIMIT ?",
                (item_id, item["source"], f'%"seed":"{seed}"%', int(limit)),
            ).fetchall()
        seen = {int(r["id"]) for r in rows}
        if len(rows) < limit:
            words = [w for w in re.split(r"[\s,]+", (item.get("prompt") or "").lower()) if len(w) > 3][:6]
            for word in words:
                for r in conn.execute(
                    "SELECT * FROM items WHERE id!=? AND prompt LIKE ? ORDER BY mtime DESC LIMIT ?",
                    (item_id, f"%{_like_escape(word)}%", int(limit)),
                ).fetchall():
                    if int(r["id"]) not in seen:
                        seen.add(int(r["id"]))
                        rows.append(r)
                    if len(rows) >= limit:
                        break
                if len(rows) >= limit:
                    break
    return [dict(r) for r in rows[:limit]]


def facets() -> dict:
    """Everything the UI needs to build filter chips."""
    from modules import gallery_sources

    states = gallery_db.state_counts()
    source_counts = {row["source"]: row for row in gallery_db.source_counts()}
    sources = []
    for src in gallery_db.get_sources():
        counts = source_counts.get(src["id"], {})
        sources.append({
            "id": src["id"], "label": src["label"], "parser": src["parser"],
            "count": int(counts.get("count") or 0), "bytes": int(counts.get("bytes") or 0),
        })

    groups = []
    for group in gallery_sources.filter_groups():
        try:
            total = query(dict(group["filter"]), "time_desc", 0, 0,
                          with_tags=False, with_meta=False)["total"]
        except Exception:
            total = 0
        groups.append({"id": group["id"], "label": group["label"],
                       "filter": group["filter"], "count": int(total)})

    albums = []
    for album in gallery_db.list_albums():
        albums.append({
            "id": int(album["id"]), "name": album["name"],
            "count": int(album.get("count") or 0),
            "bundled": bool(album.get("bundled_at")),
            "bundle_size": int(album.get("bundle_size") or 0),
            "created_at": album.get("created_at") or "",
        })

    return {
        "sources": sources,
        "groups": groups,
        "albums": albums,
        "states": states,
        "state_total": sum(states.values()),
        "categories": gallery_db.get_categories(),
        "workflow_tags": gallery_db.top_tags(gallery_db.WORKFLOW_CATEGORY, limit=60),
        "caption_tags": gallery_db.category_tag_count(gallery_db.CAPTIONS_CATEGORY),
        "time_presets": list(_TIME_PRESETS.keys()),
        "sorts": list(SORT_KEYS),
    }
