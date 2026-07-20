"""SQLite persistence for generated images, endorsements, and dislikes."""

import os
import re
import shutil
import sqlite3
from datetime import datetime

_DB_ROOT = os.path.dirname(os.path.dirname(__file__))
_DB_PATH = os.path.join(_DB_ROOT, "endorsements.db")
_ENDORSED_ROOT = os.path.join(_DB_ROOT, "outputs", "endorsed")
_REMOVEBG_ROOT = os.path.join(_DB_ROOT, "outputs", "removebg")


def _get_conn():
    conn = sqlite3.connect(_DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _item_key_from_path(path: str) -> str:
    """Canonical item id: pure filename stem, case-insensitive."""
    if not path:
        return ""
    return os.path.splitext(os.path.basename(path))[0].strip().lower()


def is_grid_image_path(path: str) -> bool:
    """Return True when a path points to a grid image output."""
    if not path:
        return False

    p = path.replace("\\", "/").lower()
    name = os.path.basename(p)
    stem = os.path.splitext(name)[0]

    if "/grids/" in p or p.endswith("/grids"):
        return True

    return (
        "-grid" in stem
        or stem.startswith("grid-")
        or stem.endswith("-grid")
        or stem == "grid"
    )


def is_removebg_attachment_path(path: str) -> bool:
    if not path:
        return False

    return _is_under(path, _REMOVEBG_ROOT)


def _column_exists(conn, table: str, column: str) -> bool:
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return any(r[1] == column for r in rows)


def _ensure_item_key_columns(conn):
    for table in ("endorsements", "dislikes", "generated_images"):
        if not _column_exists(conn, table, "item_key"):
            conn.execute(f"ALTER TABLE {table} ADD COLUMN item_key TEXT")


def _ensure_endorsement_origin_column(conn):
    if not _column_exists(conn, "endorsements", "original_path"):
        conn.execute("ALTER TABLE endorsements ADD COLUMN original_path TEXT")


def _backfill_item_keys(conn):
    for table, path_col in (("endorsements", "image_path"), ("dislikes", "image_path"), ("generated_images", "path")):
        rows = conn.execute(
            f"SELECT id, {path_col}, item_key FROM {table}"
        ).fetchall()
        for row in rows:
            rid, path, key = row[0], row[1], row[2]
            if key:
                continue
            new_key = _item_key_from_path(path)
            if new_key:
                conn.execute(f"UPDATE {table} SET item_key=? WHERE id=?", (new_key, rid))


def _dedupe_table_by_item_key(conn, table: str, sort_col: str):
    """Keep newest row per item_key; delete older duplicates."""
    rows = conn.execute(
        f"SELECT id, item_key FROM {table} WHERE item_key IS NOT NULL AND item_key != '' ORDER BY {sort_col} DESC"
    ).fetchall()
    seen = set()
    delete_ids = []
    for rid, key in rows:
        if key in seen:
            delete_ids.append(rid)
        else:
            seen.add(key)

    if delete_ids:
        placeholders = ",".join(["?"] * len(delete_ids))
        conn.execute(f"DELETE FROM {table} WHERE id IN ({placeholders})", delete_ids)


def init_db():
    with _get_conn() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS endorsements (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                endorsed_at     TEXT    NOT NULL,
                image_path      TEXT,
                original_path   TEXT,
                prompt          TEXT,
                negative_prompt TEXT,
                seed            TEXT,
                steps           INTEGER,
                sampler         TEXT,
                cfg_scale       REAL,
                width           INTEGER,
                height          INTEGER,
                model_name      TEXT,
                model_hash      TEXT,
                infotext        TEXT
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS dislikes (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                disliked_at     TEXT NOT NULL,
                image_path      TEXT UNIQUE,
                prompt          TEXT,
                negative_prompt TEXT,
                seed            TEXT,
                steps           INTEGER,
                sampler         TEXT,
                cfg_scale       REAL,
                width           INTEGER,
                height          INTEGER,
                model_name      TEXT,
                model_hash      TEXT,
                infotext        TEXT
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS generated_images (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                path            TEXT UNIQUE NOT NULL,
                indexed_at      TEXT NOT NULL,
                file_mtime      REAL,
                prompt          TEXT,
                negative_prompt TEXT,
                seed            TEXT,
                steps           INTEGER,
                sampler         TEXT,
                cfg_scale       REAL,
                width           INTEGER,
                height          INTEGER,
                model_name      TEXT,
                model_hash      TEXT,
                infotext        TEXT
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_generated_mtime ON generated_images(file_mtime DESC)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_endorsements_path ON endorsements(image_path)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_dislikes_path ON dislikes(image_path)")
        _ensure_item_key_columns(conn)
        _ensure_endorsement_origin_column(conn)
        _backfill_item_keys(conn)
        _dedupe_table_by_item_key(conn, "generated_images", "file_mtime")
        _dedupe_table_by_item_key(conn, "endorsements", "endorsed_at")
        _dedupe_table_by_item_key(conn, "dislikes", "disliked_at")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_generated_item_key ON generated_images(item_key)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_endorsements_item_key ON endorsements(item_key)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_dislikes_item_key ON dislikes(item_key)")
        _ensure_image_tags_table(conn)
        _ensure_archived_table(conn)
        _ensure_staged_table(conn)
        conn.commit()


def _ensure_archived_table(conn):
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS archived (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            item_key    TEXT    NOT NULL UNIQUE,
            archived_at TEXT    NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_archived_item_key ON archived(item_key)")


def _ensure_staged_table(conn):
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS staged (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            item_key    TEXT    NOT NULL UNIQUE,
            staged_at   TEXT    NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_staged_item_key ON staged(item_key)")


def _ensure_image_tags_table(conn):
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS image_tags (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            item_key    TEXT    NOT NULL,
            tag         TEXT    NOT NULL,
            score       REAL    NOT NULL DEFAULT 0,
            label       TEXT    NOT NULL,
            tagged_at   TEXT    NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_image_tags_item_label ON image_tags(item_key, label)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_image_tags_tag_label  ON image_tags(tag, label)")


def save_image_tags(item_key: str, tags_dict: dict, label: str) -> None:
    """Save deepbooru tags for an image. Replaces any existing tags for the same item+label."""
    if not item_key or not tags_dict:
        return
    now = datetime.now().isoformat(timespec="seconds")
    with _get_conn() as conn:
        conn.execute("DELETE FROM image_tags WHERE item_key=? AND label=?", (item_key, label))
        conn.executemany(
            "INSERT INTO image_tags (item_key, tag, score, label, tagged_at) VALUES (?,?,?,?,?)",
            [(item_key, tag, float(score), label, now) for tag, score in tags_dict.items()],
        )
        conn.commit()


def get_tag_analysis(min_appearances: int = 1) -> dict:
    """
    Aggregate deepbooru tag statistics across endorsed and disliked images.

    Returns a dict with keys:
      'add'    – tags appearing more in endorsed images (sorted by net desc)
      'remove' – tags appearing more in disliked images (sorted by |net| desc)
      'neutral'– tags with equal counts
    Each entry: {tag, endorse_count, dislike_count, net, endorse_avg, dislike_avg}
    """
    sql = """
        SELECT
            tag,
            SUM(CASE WHEN label='endorse' THEN 1 ELSE 0 END) AS endorse_count,
            SUM(CASE WHEN label='dislike' THEN 1 ELSE 0 END) AS dislike_count,
            AVG(CASE WHEN label='endorse' THEN score ELSE NULL END) AS endorse_avg,
            AVG(CASE WHEN label='dislike' THEN score ELSE NULL END) AS dislike_avg,
            COUNT(*) AS total
        FROM image_tags
        GROUP BY tag
        HAVING total >= ?
    """
    with _get_conn() as conn:
        rows = conn.execute(sql, (min_appearances,)).fetchall()

    add_list, remove_list, neutral_list = [], [], []
    for row in rows:
        e = row["endorse_count"] or 0
        d = row["dislike_count"] or 0
        entry = {
            "tag": row["tag"],
            "endorse_count": e,
            "dislike_count": d,
            "net": e - d,
            "endorse_avg": round(row["endorse_avg"] or 0.0, 3),
            "dislike_avg": round(row["dislike_avg"] or 0.0, 3),
        }
        if entry["net"] > 0:
            add_list.append(entry)
        elif entry["net"] < 0:
            remove_list.append(entry)
        else:
            neutral_list.append(entry)

    add_list.sort(key=lambda x: -x["net"])
    remove_list.sort(key=lambda x: x["net"])  # Most negative first
    return {"add": add_list, "remove": remove_list, "neutral": neutral_list}


def get_all_endorsed_items(query: str = "", since_ts=None) -> list[tuple[str, str]]:
    """Return all (image_path, item_key) from endorsements matching query + date filter."""
    where_sql, params = _build_keyword_where(query, ["prompt", "negative_prompt", "model_name", "sampler"])
    where_sql, params = _append_time_filter(where_sql, params, "endorsed_at", since_ts, numeric=False)
    sql = "SELECT image_path, item_key FROM endorsements" + where_sql + " ORDER BY endorsed_at DESC"
    with _get_conn() as conn:
        rows = conn.execute(sql, params).fetchall()
    return [(r[0], r[1]) for r in rows if r[0] and r[1]]


def get_all_disliked_items(query: str = "", since_ts=None) -> list[tuple[str, str]]:
    """Return all (image_path, item_key) from dislikes matching query + date filter."""
    where_sql, params = _build_keyword_where(query, ["prompt", "negative_prompt", "model_name", "sampler"])
    where_sql, params = _append_time_filter(where_sql, params, "disliked_at", since_ts, numeric=False)
    sql = "SELECT image_path, item_key FROM dislikes" + where_sql + " ORDER BY disliked_at DESC"
    with _get_conn() as conn:
        rows = conn.execute(sql, params).fetchall()
    return [(r[0], r[1]) for r in rows if r[0] and r[1]]


def get_untagged_images() -> list[tuple[str, str]]:
    """Return list of (image_path, label) for endorsed/disliked images with no image_tags entry."""
    sql = """
        SELECT e.image_path, 'endorse' AS label, e.item_key
        FROM endorsements e
        WHERE e.item_key IS NOT NULL AND e.item_key != ''
          AND e.item_key NOT IN (
              SELECT DISTINCT item_key FROM image_tags WHERE label='endorse'
          )
        UNION ALL
        SELECT d.image_path, 'dislike' AS label, d.item_key
        FROM dislikes d
        WHERE d.item_key IS NOT NULL AND d.item_key != ''
          AND d.item_key NOT IN (
              SELECT DISTINCT item_key FROM image_tags WHERE label='dislike'
          )
    """
    with _get_conn() as conn:
        rows = conn.execute(sql).fetchall()
    return [(row[0], row[1]) for row in rows if row[0]]


def get_untagged_filtered(
    endorse_keys: set,
    dislike_keys: set,
) -> list[tuple[str, str, str]]:
    """Return (image_path, label, item_key) for items in the given key sets that have no tags yet."""
    if not endorse_keys and not dislike_keys:
        return []

    results = []
    with _get_conn() as conn:
        if endorse_keys:
            already = {
                r[0] for r in conn.execute(
                    "SELECT DISTINCT item_key FROM image_tags WHERE label='endorse'"
                ).fetchall()
            }
            for path, key in _lookup_paths_for_keys(conn, "endorsements", "image_path", endorse_keys):
                if key not in already:
                    results.append((path, "endorse", key))

        if dislike_keys:
            already = {
                r[0] for r in conn.execute(
                    "SELECT DISTINCT item_key FROM image_tags WHERE label='dislike'"
                ).fetchall()
            }
            for path, key in _lookup_paths_for_keys(conn, "dislikes", "image_path", dislike_keys):
                if key not in already:
                    results.append((path, "dislike", key))

    return results


def _lookup_paths_for_keys(conn, table: str, path_col: str, keys: set) -> list[tuple[str, str]]:
    """Fetch (path, item_key) rows from table for the given item_key set."""
    if not keys:
        return []
    placeholders = ",".join(["?"] * len(keys))
    rows = conn.execute(
        f"SELECT {path_col}, item_key FROM {table} WHERE item_key IN ({placeholders})",
        list(keys),
    ).fetchall()
    return [(r[0], r[1]) for r in rows if r[0]]


def get_tags_for_items(item_keys: list[str]) -> dict[str, list[str]]:
    """Return {item_key: [tag, ...]} sorted by score desc, for display in cards/preview.
    Only the highest-confidence label's tags are returned per item (endorse wins over dislike).
    """
    if not item_keys:
        return {}
    placeholders = ",".join(["?"] * len(item_keys))
    sql = f"""
        SELECT item_key, tag, score, label
        FROM image_tags
        WHERE item_key IN ({placeholders})
        ORDER BY item_key, score DESC
    """
    with _get_conn() as conn:
        rows = conn.execute(sql, item_keys).fetchall()

    # Collect tags per item; prefer 'endorse' label tags if both exist
    result: dict[str, dict[str, list[str]]] = {}
    for row in rows:
        key = row[0]
        tag = row[1]
        label = row[3]
        result.setdefault(key, {"endorse": [], "dislike": []})
        result[key][label].append(tag)

    out: dict[str, list[str]] = {}
    for key, by_label in result.items():
        tags = by_label["endorse"] if by_label["endorse"] else by_label["dislike"]
        out[key] = tags
    return out


def get_tag_analysis_filtered(
    endorse_keys: set,
    dislike_keys: set,
    min_appearances: int = 1,
) -> dict:
    """Like get_tag_analysis() but restricted to the given item_key sets per label."""
    if not endorse_keys and not dislike_keys:
        return {"add": [], "remove": [], "neutral": []}

    conditions = []
    params: list = []
    if endorse_keys:
        ph = ",".join(["?"] * len(endorse_keys))
        conditions.append(f"(label='endorse' AND item_key IN ({ph}))")
        params.extend(list(endorse_keys))
    if dislike_keys:
        ph = ",".join(["?"] * len(dislike_keys))
        conditions.append(f"(label='dislike' AND item_key IN ({ph}))")
        params.extend(list(dislike_keys))

    where = " WHERE (" + " OR ".join(conditions) + ")"

    sql = f"""
        SELECT
            tag,
            SUM(CASE WHEN label='endorse' THEN 1 ELSE 0 END) AS endorse_count,
            SUM(CASE WHEN label='dislike' THEN 1 ELSE 0 END) AS dislike_count,
            AVG(CASE WHEN label='endorse' THEN score ELSE NULL END) AS endorse_avg,
            AVG(CASE WHEN label='dislike' THEN score ELSE NULL END) AS dislike_avg,
            COUNT(*) AS total
        FROM image_tags
        {where}
        GROUP BY tag
        HAVING total >= ?
    """
    params.append(min_appearances)

    with _get_conn() as conn:
        rows = conn.execute(sql, params).fetchall()

    add_list, remove_list, neutral_list = [], [], []
    for row in rows:
        e = row["endorse_count"] or 0
        d = row["dislike_count"] or 0
        entry = {
            "tag": row["tag"],
            "endorse_count": e,
            "dislike_count": d,
            "net": e - d,
            "endorse_avg": round(row["endorse_avg"] or 0.0, 3),
            "dislike_avg": round(row["dislike_avg"] or 0.0, 3),
        }
        if entry["net"] > 0:
            add_list.append(entry)
        elif entry["net"] < 0:
            remove_list.append(entry)
        else:
            neutral_list.append(entry)

    add_list.sort(key=lambda x: -x["net"])
    remove_list.sort(key=lambda x: x["net"])
    return {"add": add_list, "remove": remove_list, "neutral": neutral_list}


def _build_keyword_where(query: str, fields: list[str]) -> tuple[str, list]:
    query = (query or "").strip()
    if not query:
        return "", []

    tokens = [t for t in query.replace(",", " ").split() if t]
    if not tokens:
        return "", []

    clauses = []
    params = []
    for tok in tokens:
        tok_clause = "(" + " OR ".join([f"LOWER({f}) LIKE ?" for f in fields]) + ")"
        clauses.append(tok_clause)
        params.extend([f"%{tok.lower()}%"] * len(fields))

    return " WHERE " + " AND ".join(clauses), params


def _normalize_prompt_keyword(token: str) -> str:
    text = str(token or "").strip()
    if not text:
        return ""

    # Trim common prompt wrappers and trailing numeric weights.
    text = text.strip('"\'')
    text = re.sub(r"\s*:-?\d+(?:\.\d+)?$", "", text)

    while text.startswith("(") and text.endswith(")") and len(text) > 2:
        text = text[1:-1].strip()

    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return ""
    if len(text) > 120:
        return ""
    return text


def _split_prompt_keywords(text: str) -> list[str]:
    src = str(text or "")
    if not src:
        return []

    parts = re.split(r"[,\n\r]+", src)
    out = []
    for part in parts:
        normalized = _normalize_prompt_keyword(part)
        if normalized:
            out.append(normalized)
    return out


def _ranked_terms_from_counter(counter: dict[str, int], limit: int) -> list[str]:
    if not counter:
        return []

    rows = sorted(counter.items(), key=lambda kv: (-kv[1], kv[0].lower()))
    out = []
    seen = set()
    for term, _count in rows:
        key = term.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(term)
        if len(out) >= max(1, int(limit or 1)):
            break
    return out


def get_fire_prompt_suggestions(limit_per_key: int = 160) -> dict:
    """Return queue-fire value suggestions derived from endorsed prompt/caption data."""
    prompt_counter: dict[str, int] = {}
    negative_counter: dict[str, int] = {}

    with _get_conn() as conn:
        prompt_rows = conn.execute(
            "SELECT prompt, negative_prompt FROM endorsements ORDER BY endorsed_at DESC LIMIT 5000"
        ).fetchall()
        for row in prompt_rows:
            for token in _split_prompt_keywords(row["prompt"]):
                prompt_counter[token] = prompt_counter.get(token, 0) + 1
            for token in _split_prompt_keywords(row["negative_prompt"]):
                negative_counter[token] = negative_counter.get(token, 0) + 1

        # Captions are stored as DeepDanbooru tags for endorsed items.
        tag_rows = conn.execute(
            """
            SELECT tag, COUNT(*) AS n
            FROM image_tags
            WHERE label='endorse'
            GROUP BY tag
            ORDER BY n DESC
            LIMIT ?
            """,
            (max(200, int(limit_per_key or 160) * 4),),
        ).fetchall()
        for row in tag_rows:
            token = _normalize_prompt_keyword(str(row["tag"] or "").replace("_", " "))
            if not token:
                continue
            prompt_counter[token] = prompt_counter.get(token, 0) + int(row["n"] or 1)

    return {
        "Prompt": _ranked_terms_from_counter(prompt_counter, int(limit_per_key or 160)),
        "Negative prompt": _ranked_terms_from_counter(negative_counter, int(limit_per_key or 160)),
    }


def _append_time_filter(where_sql: str, params: list, column: str, since_ts: float | None,
                        numeric: bool = False) -> tuple[str, list]:
    if since_ts is None:
        return where_sql, params

    try:
        since_ts_val = float(since_ts)
    except Exception:
        return where_sql, params

    compare_value = since_ts_val if numeric else datetime.fromtimestamp(since_ts_val).isoformat(timespec="seconds")
    clause = f"{column} >= ?"
    out_where = f"{where_sql} AND {clause}" if where_sql else f" WHERE {clause}"
    return out_where, params + [compare_value]


def _is_under(path: str, root: str) -> bool:
    """Return True if path is inside root (case-insensitive on Windows)."""
    if not path:
        return False
    try:
        # os.path.normcase lowercases on Windows, ensuring case-insensitive comparison.
        norm = os.path.normcase
        return os.path.commonpath([norm(os.path.abspath(path)), norm(os.path.abspath(root))]) == norm(os.path.abspath(root))
    except Exception:
        return False


def _unique_target_path(desired_path: str) -> str:
    if not os.path.exists(desired_path):
        return desired_path

    base, ext = os.path.splitext(desired_path)
    idx = 1
    while True:
        candidate = f"{base}_{idx}{ext}"
        if not os.path.exists(candidate):
            return candidate
        idx += 1


def _move_into_endorsed(path: str, endorsed_at: datetime) -> tuple[str, str]:
    """Copy image to endorsed folder, return (endorsed_path, original_path)."""
    if not path:
        return path, path

    abs_path = os.path.abspath(path)
    if not os.path.exists(abs_path):
        return abs_path, abs_path

    if _is_under(abs_path, _ENDORSED_ROOT):
        return abs_path, abs_path

    day_folder = endorsed_at.strftime("%Y-%m-%d")
    target_dir = os.path.join(_ENDORSED_ROOT, day_folder)
    os.makedirs(target_dir, exist_ok=True)

    target_path = _unique_target_path(os.path.join(target_dir, os.path.basename(abs_path)))
    shutil.copy2(abs_path, target_path)  # Copy instead of move
    return target_path, abs_path  # Return endorsed path and original path


def _restore_from_endorsed(current_path: str, original_path: str) -> str:
    """Delete the endorsed copy.  The original file is never touched."""
    if not current_path:
        return original_path or current_path

    cur = os.path.abspath(current_path)

    # Delete the file if it is inside the endorsed folder OR if we know
    # it is a copy (original_path is set and differs from current_path).
    is_copy = bool(
        original_path
        and os.path.normcase(os.path.abspath(original_path)) != os.path.normcase(cur)
    )
    if os.path.exists(cur) and (_is_under(cur, _ENDORSED_ROOT) or is_copy):
        try:
            os.remove(cur)
        except Exception as exc:
            print(f"[endorsed_gallery] warning: could not delete endorsed copy '{cur}': {exc}")

    return original_path if original_path else current_path


def _update_generated_path(conn, item_key: str, old_path: str, new_path: str):
    if not new_path:
        return

    mtime = None
    try:
        if os.path.exists(new_path):
            mtime = os.path.getmtime(new_path)
    except Exception:
        mtime = None

    if item_key:
        if mtime is None:
            conn.execute("UPDATE generated_images SET path=? WHERE item_key=?", (new_path, item_key))
        else:
            conn.execute("UPDATE generated_images SET path=?, file_mtime=? WHERE item_key=?", (new_path, mtime, item_key))
    elif old_path:
        if mtime is None:
            conn.execute("UPDATE generated_images SET path=? WHERE path=?", (new_path, old_path))
        else:
            conn.execute("UPDATE generated_images SET path=?, file_mtime=? WHERE path=?", (new_path, mtime, old_path))


def _restore_endorsement_row(conn, row):
    """Delete the endorsed copy when removing endorsement."""
    current_path = row["image_path"] if "image_path" in row.keys() else ""
    original_path = row["original_path"] if "original_path" in row.keys() else ""

    # Delete the endorsed copy
    _restore_from_endorsed(current_path, original_path)
    
    # No need to update paths in other tables since original path never changed


def endorse(image_path, prompt, negative_prompt, seed, steps, sampler,
            cfg_scale, width, height, model_name, model_hash, infotext):
    item_key = _item_key_from_path(image_path)
    endorsed_at = datetime.now()

    # Endorsing cancels staged status
    unstage_item(item_key)

    endorsed_copy_path, original_path = _move_into_endorsed(image_path, endorsed_at)

    with _get_conn() as conn:
        if item_key:
            # Endorse/dislike are mutually exclusive for the same item.
            conn.execute("DELETE FROM dislikes WHERE item_key=?", (item_key,))
            conn.execute("DELETE FROM endorsements WHERE item_key=?", (item_key,))
        else:
            conn.execute("DELETE FROM dislikes WHERE image_path=?", (image_path,))
            conn.execute("DELETE FROM endorsements WHERE image_path=?", (image_path,))

        conn.execute(
            """
            INSERT INTO endorsements
                (endorsed_at, image_path, original_path, prompt, negative_prompt, seed, steps,
                 sampler, cfg_scale, width, height, model_name, model_hash, infotext, item_key)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            (
                endorsed_at.isoformat(timespec="seconds"),
                endorsed_copy_path,
                original_path,
                prompt,
                negative_prompt,
                str(seed),
                int(steps or 0),
                sampler,
                float(cfg_scale or 0),
                int(width or 0),
                int(height or 0),
                model_name,
                model_hash,
                infotext,
                item_key,
            ),
        )
        conn.commit()


def delete_endorsement(eid: int):
    with _get_conn() as conn:
        row = conn.execute("SELECT * FROM endorsements WHERE id=?", (eid,)).fetchone()
        if row:
            _restore_endorsement_row(conn, row)
            conn.execute("DELETE FROM endorsements WHERE id=?", (eid,))
        conn.commit()


def delete_endorsement_by_path(path: str):
    item_key = _item_key_from_path(path)
    with _get_conn() as conn:
        row = None
        if item_key:
            row = conn.execute(
                "SELECT * FROM endorsements WHERE item_key=? ORDER BY id DESC LIMIT 1",
                (item_key,),
            ).fetchone()
            if row:
                _restore_endorsement_row(conn, row)
                conn.execute("DELETE FROM endorsements WHERE item_key=?", (item_key,))
        else:
            row = conn.execute(
                "SELECT * FROM endorsements WHERE image_path=? ORDER BY id DESC LIMIT 1",
                (path,),
            ).fetchone()
            if row:
                _restore_endorsement_row(conn, row)
            conn.execute("DELETE FROM endorsements WHERE image_path=?", (path,))
        conn.commit()


def get_endorsed_paths() -> set:
    with _get_conn() as conn:
        rows = conn.execute("SELECT image_path FROM endorsements WHERE image_path IS NOT NULL").fetchall()
        return {r[0] for r in rows}


def get_endorsed_id_by_path(path: str):
    item_key = _item_key_from_path(path)
    with _get_conn() as conn:
        if item_key:
            row = conn.execute(
                "SELECT id FROM endorsements WHERE item_key=? ORDER BY id DESC LIMIT 1",
                (item_key,),
            ).fetchone()
        else:
            row = conn.execute(
                "SELECT id FROM endorsements WHERE image_path=? ORDER BY id DESC LIMIT 1",
                (path,),
            ).fetchone()
        return row[0] if row else None


def dislike(image_path, prompt, negative_prompt, seed, steps, sampler,
            cfg_scale, width, height, model_name, model_hash, infotext):
    item_key = _item_key_from_path(image_path)

    # Disliking cancels staged status
    unstage_item(item_key)

    with _get_conn() as conn:
        if item_key:
            # Endorse/dislike are mutually exclusive for the same item.
            conn.execute("DELETE FROM endorsements WHERE item_key=?", (item_key,))
            conn.execute("DELETE FROM dislikes WHERE item_key=?", (item_key,))
        else:
            conn.execute("DELETE FROM endorsements WHERE image_path=?", (image_path,))
            conn.execute("DELETE FROM dislikes WHERE image_path=?", (image_path,))
        conn.execute(
            """
            INSERT OR REPLACE INTO dislikes
                (disliked_at, image_path, prompt, negative_prompt, seed, steps,
                 sampler, cfg_scale, width, height, model_name, model_hash, infotext, item_key)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            (
                datetime.now().isoformat(timespec="seconds"),
                image_path,
                prompt,
                negative_prompt,
                str(seed),
                int(steps or 0),
                sampler,
                float(cfg_scale or 0),
                int(width or 0),
                int(height or 0),
                model_name,
                model_hash,
                infotext,
                item_key,
            ),
        )
        conn.commit()


def delete_dislike(did: int):
    with _get_conn() as conn:
        conn.execute("DELETE FROM dislikes WHERE id=?", (did,))
        conn.commit()


def delete_dislike_by_path(path: str):
    item_key = _item_key_from_path(path)
    with _get_conn() as conn:
        if item_key:
            conn.execute("DELETE FROM dislikes WHERE item_key=?", (item_key,))
        else:
            conn.execute("DELETE FROM dislikes WHERE image_path=?", (path,))
        conn.commit()


def get_disliked_paths() -> set:
    with _get_conn() as conn:
        rows = conn.execute("SELECT image_path FROM dislikes WHERE image_path IS NOT NULL").fetchall()
        return {r[0] for r in rows}


def get_disliked_id_by_path(path: str):
    item_key = _item_key_from_path(path)
    with _get_conn() as conn:
        if item_key:
            row = conn.execute(
                "SELECT id FROM dislikes WHERE item_key=? ORDER BY id DESC LIMIT 1",
                (item_key,),
            ).fetchone()
        else:
            row = conn.execute(
                "SELECT id FROM dislikes WHERE image_path=? ORDER BY id DESC LIMIT 1",
                (path,),
            ).fetchone()
        return row[0] if row else None


def count_endorsements(query: str = "", exclude_disliked: bool = True, since_ts: float | None = None) -> int:
    where_sql, params = _build_keyword_where(query, ["prompt", "negative_prompt", "model_name", "sampler"])
    where_sql, params = _append_time_filter(where_sql, params, "endorsed_at", since_ts, numeric=False)
    with _get_conn() as conn:
        base_sql = "SELECT COUNT(*) FROM endorsements"
        if exclude_disliked:
            if where_sql:
                sql = (
                    base_sql + where_sql +
                    " AND item_key NOT IN (SELECT item_key FROM dislikes WHERE item_key IS NOT NULL AND item_key != '')"
                )
            else:
                sql = (
                    base_sql +
                    " WHERE item_key NOT IN (SELECT item_key FROM dislikes WHERE item_key IS NOT NULL AND item_key != '')"
                )
        else:
            sql = base_sql + where_sql
        return conn.execute(sql, params).fetchone()[0]


def search_endorsements(query: str = "", limit: int = 60, offset: int = 0,
                        exclude_disliked: bool = True, since_ts: float | None = None) -> list:
    where_sql, params = _build_keyword_where(query, ["prompt", "negative_prompt", "model_name", "sampler"])
    where_sql, params = _append_time_filter(where_sql, params, "endorsed_at", since_ts, numeric=False)
    sql = "SELECT * FROM endorsements"
    if exclude_disliked:
        if where_sql:
            sql += where_sql + " AND item_key NOT IN (SELECT item_key FROM dislikes WHERE item_key IS NOT NULL AND item_key != '')"
        else:
            sql += " WHERE item_key NOT IN (SELECT item_key FROM dislikes WHERE item_key IS NOT NULL AND item_key != '')"
    else:
        sql += where_sql
    sql += " ORDER BY endorsed_at DESC LIMIT ? OFFSET ?"
    with _get_conn() as conn:
        rows = conn.execute(sql, params + [int(limit), int(offset)]).fetchall()
        return [dict(r) for r in rows]


def count_disliked(query: str = "", since_ts: float | None = None) -> int:
    where_sql, params = _build_keyword_where(query, ["prompt", "negative_prompt", "model_name", "sampler"])
    where_sql, params = _append_time_filter(where_sql, params, "disliked_at", since_ts, numeric=False)
    with _get_conn() as conn:
        sql = "SELECT COUNT(*) FROM dislikes" + where_sql
        return conn.execute(sql, params).fetchone()[0]


def search_disliked(query: str = "", limit: int = 60, offset: int = 0,
                    since_ts: float | None = None) -> list:
    where_sql, params = _build_keyword_where(query, ["prompt", "negative_prompt", "model_name", "sampler"])
    where_sql, params = _append_time_filter(where_sql, params, "disliked_at", since_ts, numeric=False)
    sql = "SELECT * FROM dislikes" + where_sql + " ORDER BY disliked_at DESC LIMIT ? OFFSET ?"
    with _get_conn() as conn:
        rows = conn.execute(sql, params + [int(limit), int(offset)]).fetchall()
        return [dict(r) for r in rows]


def count_unrated(query: str = "", since_ts: float | None = None) -> int:
    where_sql, params = _build_keyword_where(query, ["prompt", "negative_prompt", "model_name", "sampler"])
    where_sql, params = _append_time_filter(where_sql, params, "file_mtime", since_ts, numeric=True)
    rated_filter = (
        " AND item_key NOT IN (SELECT item_key FROM endorsements WHERE item_key IS NOT NULL AND item_key != '')"
        " AND item_key NOT IN (SELECT item_key FROM dislikes WHERE item_key IS NOT NULL AND item_key != '')"
        " AND item_key NOT IN (SELECT item_key FROM archived WHERE item_key IS NOT NULL AND item_key != '')"
        " AND item_key NOT IN (SELECT item_key FROM staged WHERE item_key IS NOT NULL AND item_key != '')"
    )
    sql = "SELECT COUNT(*) FROM generated_images" + (where_sql if where_sql else " WHERE 1=1") + rated_filter
    with _get_conn() as conn:
        return conn.execute(sql, params).fetchone()[0]


def search_unrated(query: str = "", limit: int = 48, offset: int = 0,
                   since_ts: float | None = None) -> list:
    where_sql, params = _build_keyword_where(query, ["prompt", "negative_prompt", "model_name", "sampler"])
    where_sql, params = _append_time_filter(where_sql, params, "file_mtime", since_ts, numeric=True)
    rated_filter = (
        " AND item_key NOT IN (SELECT item_key FROM endorsements WHERE item_key IS NOT NULL AND item_key != '')"
        " AND item_key NOT IN (SELECT item_key FROM dislikes WHERE item_key IS NOT NULL AND item_key != '')"
        " AND item_key NOT IN (SELECT item_key FROM archived WHERE item_key IS NOT NULL AND item_key != '')"
        " AND item_key NOT IN (SELECT item_key FROM staged WHERE item_key IS NOT NULL AND item_key != '')"
    )
    sql = ("SELECT * FROM generated_images"
           + (where_sql if where_sql else " WHERE 1=1")
           + rated_filter
           + " ORDER BY file_mtime DESC LIMIT ? OFFSET ?")
    with _get_conn() as conn:
        rows = conn.execute(sql, params + [int(limit), int(offset)]).fetchall()
        return [dict(r) for r in rows]


def is_archived(item_key: str) -> bool:
    if not item_key:
        return False
    with _get_conn() as conn:
        row = conn.execute("SELECT id FROM archived WHERE item_key=?", (item_key,)).fetchone()
    return row is not None


def archive_item(item_key: str) -> None:
    if not item_key:
        return

    # Archiving cancels staged status
    unstage_item(item_key)

    now = datetime.now().isoformat(timespec="seconds")
    with _get_conn() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO archived (item_key, archived_at) VALUES (?,?)",
            (item_key, now),
        )
        conn.commit()


def unarchive_item(item_key: str) -> None:
    if not item_key:
        return
    with _get_conn() as conn:
        conn.execute("DELETE FROM archived WHERE item_key=?", (item_key,))
        conn.commit()


def archive_all_unrated() -> int:
    """Archive all generated images not yet endorsed, disliked, or archived. Returns count added."""
    now = datetime.now().isoformat(timespec="seconds")
    sql = """
        INSERT OR IGNORE INTO archived (item_key, archived_at)
        SELECT item_key, ?
        FROM generated_images
        WHERE item_key IS NOT NULL AND item_key != ''
          AND item_key NOT IN (SELECT item_key FROM endorsements WHERE item_key IS NOT NULL AND item_key != '')
          AND item_key NOT IN (SELECT item_key FROM dislikes WHERE item_key IS NOT NULL AND item_key != '')
          AND item_key NOT IN (SELECT item_key FROM archived WHERE item_key IS NOT NULL AND item_key != '')
    """
    with _get_conn() as conn:
        cur = conn.execute(sql, (now,))
        conn.commit()
        return cur.rowcount


def get_archived_item_keys(item_keys: list[str]) -> set:
    """Return subset of item_keys that are archived."""
    if not item_keys:
        return set()
    placeholders = ",".join(["?"] * len(item_keys))
    with _get_conn() as conn:
        rows = conn.execute(
            f"SELECT item_key FROM archived WHERE item_key IN ({placeholders})",
            item_keys,
        ).fetchall()
    return {r[0] for r in rows}


def count_archived(query: str = "", since_ts: float | None = None) -> int:
    where_sql, params = _build_keyword_where(query, ["g.prompt", "g.negative_prompt", "g.model_name", "g.sampler"])
    where_sql, params = _append_time_filter(where_sql, params, "g.file_mtime", since_ts, numeric=True)
    base = """
        SELECT COUNT(*)
        FROM archived a
        JOIN generated_images g ON g.item_key = a.item_key
    """
    with _get_conn() as conn:
        return conn.execute(base + where_sql, params).fetchone()[0]


def search_archived(query: str = "", limit: int = 48, offset: int = 0,
                    since_ts: float | None = None) -> list:
    where_sql, params = _build_keyword_where(query, ["g.prompt", "g.negative_prompt", "g.model_name", "g.sampler"])
    where_sql, params = _append_time_filter(where_sql, params, "g.file_mtime", since_ts, numeric=True)
    sql = (
        "SELECT g.* FROM archived a JOIN generated_images g ON g.item_key = a.item_key"
        + where_sql
        + " ORDER BY a.archived_at DESC LIMIT ? OFFSET ?"
    )
    with _get_conn() as conn:
        rows = conn.execute(sql, params + [int(limit), int(offset)]).fetchall()
        return [dict(r) for r in rows]


# ── Staged (picked) ──────────────────────────────────────────────────────────

def is_staged(item_key: str) -> bool:
    if not item_key:
        return False
    with _get_conn() as conn:
        row = conn.execute("SELECT id FROM staged WHERE item_key=?", (item_key,)).fetchone()
    return row is not None


def stage_item(item_key: str) -> None:
    """Mark an image as staged (picked). Does nothing if already endorsed or disliked."""
    if not item_key:
        return
    now = datetime.now().isoformat(timespec="seconds")
    with _get_conn() as conn:
        # Don't stage if already endorsed or disliked
        e = conn.execute("SELECT id FROM endorsements WHERE item_key=?", (item_key,)).fetchone()
        d = conn.execute("SELECT id FROM dislikes WHERE item_key=?", (item_key,)).fetchone()
        if e or d:
            return
        conn.execute(
            "INSERT OR IGNORE INTO staged (item_key, staged_at) VALUES (?,?)",
            (item_key, now),
        )
        conn.commit()


def unstage_item(item_key: str) -> None:
    """Remove the staged flag from an image."""
    if not item_key:
        return
    with _get_conn() as conn:
        conn.execute("DELETE FROM staged WHERE item_key=?", (item_key,))
        conn.commit()


def get_staged_item_keys(item_keys: list[str]) -> set:
    """Return subset of item_keys that are staged."""
    if not item_keys:
        return set()
    placeholders = ",".join(["?"] * len(item_keys))
    with _get_conn() as conn:
        rows = conn.execute(
            f"SELECT item_key FROM staged WHERE item_key IN ({placeholders})",
            item_keys,
        ).fetchall()
    return {r[0] for r in rows}


def count_staged(query: str = "", since_ts: float | None = None) -> int:
    where_sql, params = _build_keyword_where(query, ["g.prompt", "g.negative_prompt", "g.model_name", "g.sampler"])
    where_sql, params = _append_time_filter(where_sql, params, "g.file_mtime", since_ts, numeric=True)
    base = """
        SELECT COUNT(*)
        FROM staged s
        JOIN generated_images g ON g.item_key = s.item_key
    """
    with _get_conn() as conn:
        return conn.execute(base + where_sql, params).fetchone()[0]


def search_staged(query: str = "", limit: int = 48, offset: int = 0,
                  since_ts: float | None = None) -> list:
    where_sql, params = _build_keyword_where(query, ["g.prompt", "g.negative_prompt", "g.model_name", "g.sampler"])
    where_sql, params = _append_time_filter(where_sql, params, "g.file_mtime", since_ts, numeric=True)
    sql = (
        "SELECT g.* FROM staged s JOIN generated_images g ON g.item_key = s.item_key"
        + where_sql
        + " ORDER BY s.staged_at DESC LIMIT ? OFFSET ?"
    )
    with _get_conn() as conn:
        rows = conn.execute(sql, params + [int(limit), int(offset)]).fetchall()
        return [dict(r) for r in rows]


def index_image(path: str, file_mtime: float, prompt: str, negative_prompt: str,
                seed: str, steps: int, sampler: str, cfg_scale: float,
                width: int, height: int, model_name: str, model_hash: str,
                infotext: str):
    if is_removebg_attachment_path(path):
        return

    item_key = _item_key_from_path(path)
    with _get_conn() as conn:
        if item_key:
            conn.execute("DELETE FROM generated_images WHERE item_key=?", (item_key,))
        conn.execute(
            """
            INSERT OR REPLACE INTO generated_images
                (path, indexed_at, file_mtime, prompt, negative_prompt, seed, steps,
                 sampler, cfg_scale, width, height, model_name, model_hash, infotext, item_key)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            (
                path,
                datetime.now().isoformat(timespec="seconds"),
                file_mtime,
                prompt,
                negative_prompt,
                str(seed),
                int(steps or 0),
                sampler,
                float(cfg_scale or 0),
                int(width or 0),
                int(height or 0),
                model_name,
                model_hash,
                infotext,
                item_key,
            ),
        )
        conn.commit()


def get_indexed_path_mtimes() -> dict:
    with _get_conn() as conn:
        rows = conn.execute("SELECT path, file_mtime FROM generated_images").fetchall()
        return {r[0]: r[1] for r in rows}


def get_file_mtime_by_path(path: str) -> float | None:
    """Return the stored file_mtime for a path from generated_images, or None."""
    if not path:
        return None
    with _get_conn() as conn:
        row = conn.execute(
            "SELECT file_mtime FROM generated_images WHERE path=? LIMIT 1",
            (path,),
        ).fetchone()
    return row[0] if row else None


def count_generated_filtered(query: str = "", exclude_disliked: bool = True,
                            since_ts: float | None = None) -> int:
    where_sql, params = _build_keyword_where(query, ["prompt", "negative_prompt", "model_name", "sampler"])
    where_sql, params = _append_time_filter(where_sql, params, "file_mtime", since_ts, numeric=True)
    with _get_conn() as conn:
        base_sql = "SELECT COUNT(*) FROM generated_images"
        if exclude_disliked:
            if where_sql:
                sql = (
                    base_sql + where_sql +
                    " AND item_key NOT IN (SELECT item_key FROM dislikes WHERE item_key IS NOT NULL AND item_key != '')"
                )
            else:
                sql = (
                    base_sql +
                    " WHERE item_key NOT IN (SELECT item_key FROM dislikes WHERE item_key IS NOT NULL AND item_key != '')"
                )
        else:
            sql = base_sql + where_sql
        return conn.execute(sql, params).fetchone()[0]


def search_generated(query: str = "", limit: int = 60, offset: int = 0,
                     exclude_disliked: bool = True, since_ts: float | None = None) -> list:
    where_sql, params = _build_keyword_where(query, ["prompt", "negative_prompt", "model_name", "sampler"])
    where_sql, params = _append_time_filter(where_sql, params, "file_mtime", since_ts, numeric=True)
    sql = "SELECT * FROM generated_images"
    if exclude_disliked:
        if where_sql:
            sql += where_sql + " AND item_key NOT IN (SELECT item_key FROM dislikes WHERE item_key IS NOT NULL AND item_key != '')"
        else:
            sql += " WHERE item_key NOT IN (SELECT item_key FROM dislikes WHERE item_key IS NOT NULL AND item_key != '')"
    else:
        sql += where_sql
    sql += " ORDER BY file_mtime DESC LIMIT ? OFFSET ?"
    with _get_conn() as conn:
        rows = conn.execute(sql, params + [int(limit), int(offset)]).fetchall()
        return [dict(r) for r in rows]


def count_generated() -> int:
    with _get_conn() as conn:
        return conn.execute("SELECT COUNT(*) FROM generated_images").fetchone()[0]


def sync_output_dirs(output_dirs: list, progress_cb=None) -> dict:
    from PIL import Image
    import modules.images as images_module
    import modules.infotext_utils as infotext_utils

    all_pngs = []
    for d in output_dirs:
        if not os.path.isdir(d):
            continue
        for root, _, files in os.walk(d):
            for f in files:
                if f.lower().endswith(".png"):
                    full = os.path.join(root, f)
                    if is_grid_image_path(full):
                        continue
                    if is_removebg_attachment_path(full):
                        continue
                    try:
                        all_pngs.append((os.path.getmtime(full), full))
                    except Exception:
                        pass
    all_pngs.sort(reverse=True)

    known = get_indexed_path_mtimes()
    total = len(all_pngs)
    added = 0
    updated = 0
    skipped = 0
    errors = 0

    for idx, (mtime, path) in enumerate(all_pngs):
        if progress_cb:
            progress_cb(idx + 1, total, path)

        existing_mtime = known.get(path)
        if existing_mtime is not None and abs(existing_mtime - mtime) < 0.5:
            skipped += 1
            continue

        try:
            img = Image.open(path)
            infotext_raw, _ = images_module.read_info_from_image(img)
            infotext = infotext_raw or ""
            params = infotext_utils.parse_generation_parameters(infotext, []) if infotext else {}

            index_image(
                path=path,
                file_mtime=mtime,
                prompt=params.get("Prompt", ""),
                negative_prompt=params.get("Negative prompt", ""),
                seed=params.get("Seed", ""),
                steps=int(params.get("Steps", 0) or 0),
                sampler=params.get("Sampler", ""),
                cfg_scale=float(params.get("CFG scale", 0) or 0),
                width=int(params.get("Size-1", 0) or 0),
                height=int(params.get("Size-2", 0) or 0),
                model_name=params.get("Model", ""),
                model_hash=params.get("Model hash", ""),
                infotext=infotext,
            )
            if existing_mtime is None:
                added += 1
            else:
                updated += 1
        except Exception:
            errors += 1

    return {
        "added": added,
        "updated": updated,
        "skipped": skipped,
        "errors": errors,
        "total": total,
    }


def delete_archived_originals() -> dict:
    """Delete original image files for all archived items, keeping thumbnails/preview caches.

    Returns dict with:
      - deleted: number of files successfully deleted
      - skipped: files already gone or not found
      - errors: files that could not be deleted (permission, etc.)
      - freed_bytes: total bytes freed
    """
    deleted = 0
    skipped = 0
    errors = 0
    freed_bytes = 0

    with _get_conn() as conn:
        rows = conn.execute(
            """
            SELECT DISTINCT g.path
            FROM archived a
            JOIN generated_images g ON g.item_key = a.item_key
            WHERE g.path IS NOT NULL AND g.path != ''
            """
        ).fetchall()

    for row in rows:
        path = row[0]
        if not path or not os.path.isfile(path):
            skipped += 1
            continue

        try:
            file_size = os.path.getsize(path)
            os.remove(path)
            deleted += 1
            freed_bytes += file_size
        except OSError:
            errors += 1

    if deleted > 0 or errors > 0:
        freed_mb = freed_bytes / (1024 * 1024)
        print(f"[Gallery] Deleted {deleted} archived original(s), freed {freed_mb:.1f} MB" + (f", {errors} error(s)" if errors else "") + (f", {skipped} already gone" if skipped else ""))

    return {
        "deleted": deleted,
        "skipped": skipped,
        "errors": errors,
        "freed_bytes": freed_bytes,
    }


def delete_disliked_originals() -> dict:
    """Delete original image files for all disliked items, keeping thumbnails/preview caches.

    Returns dict with:
      - deleted: number of files successfully deleted
      - skipped: files already gone or not found
      - errors: files that could not be deleted (permission, etc.)
      - freed_bytes: total bytes freed
    """
    deleted = 0
    skipped = 0
    errors = 0
    freed_bytes = 0

    with _get_conn() as conn:
        rows = conn.execute(
            """
            SELECT DISTINCT g.path
            FROM dislikes d
            JOIN generated_images g ON g.item_key = d.item_key
            WHERE g.path IS NOT NULL AND g.path != ''
            """
        ).fetchall()

    for row in rows:
        path = row[0]
        if not path or not os.path.isfile(path):
            skipped += 1
            continue

        try:
            file_size = os.path.getsize(path)
            os.remove(path)
            deleted += 1
            freed_bytes += file_size
        except OSError:
            errors += 1

    if deleted > 0 or errors > 0:
        freed_mb = freed_bytes / (1024 * 1024)
        print(f"[Gallery] Deleted {deleted} disliked original(s), freed {freed_mb:.1f} MB" + (f", {errors} error(s)" if errors else "") + (f", {skipped} already gone" if skipped else ""))

    return {
        "deleted": deleted,
        "skipped": skipped,
        "errors": errors,
        "freed_bytes": freed_bytes,
    }
