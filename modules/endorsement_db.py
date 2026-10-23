"""SQLite persistence for generated images, endorsements, and dislikes."""

import hashlib
import os
import re
import shutil
import sqlite3
from datetime import datetime

try:
    from modules import gallery_bridge
except Exception:  # partial/stubbed module trees (test harnesses): degrade to legacy-only
    class _NullGalleryBridge:
        @staticmethod
        def v2_enabled():
            return False

        @staticmethod
        def read_meta(path):
            return {}

        def __getattr__(self, name):
            def _noop(*args, **kwargs):
                return None
            return _noop

    gallery_bridge = _NullGalleryBridge()
_DB_ROOT = os.path.dirname(os.path.dirname(__file__))
_DB_PATH = os.path.join(_DB_ROOT, "endorsements.db")
_ENDORSED_ROOT = os.path.join(_DB_ROOT, "outputs", "endorsed")
_REMOVEBG_ROOT = os.path.join(_DB_ROOT, "outputs", "removebg")
_TRASH_EXCLUDE = "item_key NOT IN (SELECT item_key FROM trash WHERE item_key IS NOT NULL AND item_key != '')"


def _append_trash_exclusion(sql: str) -> str:
    """Append a trash exclusion clause to a SELECT statement or WHERE fragment.

    If the statement already contains a WHERE clause, the exclusion is added with AND.
    Otherwise a new WHERE clause is added.
    """
    if not sql or not sql.strip():
        return f" WHERE {_TRASH_EXCLUDE}"
    if re.search(r"\bWHERE\b", sql, re.IGNORECASE):
        return f"{sql} AND {_TRASH_EXCLUDE}"
    return f"{sql} WHERE {_TRASH_EXCLUDE}"


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


def _ensure_compiled_prompt_columns(conn):
    """Compiled prompt = what the model saw (comments stripped, @PICK drawn).

    Added after the fact so existing DBs keep working: rows indexed before the
    column existed simply carry no compiled prompt.
    """
    for table in ("generated_images", "endorsements", "dislikes"):
        for column in ("compiled_prompt", "compiled_negative_prompt"):
            if not _column_exists(conn, table, column):
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} TEXT")


def _compiled_prompts_for_item(conn, item_key: str | None, image_path: str | None = None,
                              source_prompt: str | None = None) -> tuple[str, str] | None:
    """Compiled prompt recorded when the image was indexed, or None when nothing is on file.

    Endorsing / disliking copies the metadata into its own table; the compiled
    prompt lives in generated_images (written at save time), so carry it over.
    Pass `source_prompt` to only accept the row when it describes that same
    image - A1111 recycles filename sequence numbers, so a path can be reused.
    """
    row = None
    if item_key:
        row = conn.execute(
            "SELECT prompt, compiled_prompt, compiled_negative_prompt FROM generated_images WHERE item_key=? LIMIT 1",
            (item_key,),
        ).fetchone()
    if row is None and image_path:
        row = conn.execute(
            "SELECT prompt, compiled_prompt, compiled_negative_prompt FROM generated_images WHERE path=? LIMIT 1",
            (image_path,),
        ).fetchone()
    if row is None:
        return None
    if source_prompt is not None and str(row[0] or "") != str(source_prompt or ""):
        # different image reusing the same path: its compiled prompt is not ours
        return None
    return str(row[1] or ""), str(row[2] or "")


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
                compiled_prompt TEXT,
                compiled_negative_prompt TEXT,
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
        _ensure_compiled_prompt_columns(conn)
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
        _ensure_trash_table(conn)
        conn.commit()
    gallery_bridge.init()


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


def _ensure_trash_table(conn):
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS trash (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            item_key        TEXT    NOT NULL UNIQUE,
            trashed_at      TEXT    NOT NULL,
            path            TEXT,
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
    conn.execute("CREATE INDEX IF NOT EXISTS idx_trash_item_key ON trash(item_key)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_trash_trashed_at ON trash(trashed_at DESC)")


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
    gallery_bridge.on_captions(item_key, tags_dict)


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

    mode = "copy"
    try:
        if gallery_bridge.v2_enabled():
            mode = (os.environ.get("GALLERY_ENDORSE_MODE") or "link").strip().lower()
    except Exception:
        mode = "copy"
    if mode == "flag":
        # DB-flag-only endorsement: no second file anywhere.
        return abs_path, abs_path

    target_path = _unique_target_path(os.path.join(target_dir, os.path.basename(abs_path)))
    if mode == "link":
        try:
            os.link(abs_path, target_path)  # hardlink: 0 extra bytes, survives original deletion
            return target_path, abs_path
        except OSError:
            pass
    shutil.copy2(abs_path, target_path)  # fallback (cross-volume / no hardlink support)
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
            cfg_scale, width, height, model_name, model_hash, infotext, item_key=None):
    item_key = str(item_key or "") or _item_key_from_path(image_path)
    endorsed_at = datetime.now()

    # Endorsing cancels staged status
    unstage_item(item_key)

    endorsed_copy_path, original_path = _move_into_endorsed(image_path, endorsed_at)

    with _get_conn() as conn:
        compiled_prompt, compiled_negative = _compiled_prompts_for_item(conn, item_key, image_path) or ("", "")
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
                 sampler, cfg_scale, width, height, model_name, model_hash, infotext, item_key,
                 compiled_prompt, compiled_negative_prompt)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
                compiled_prompt,
                compiled_negative,
            ),
        )
        conn.commit()

    gallery_bridge.on_endorse(
        item_key, endorsed_copy_path, original_path,
        {
            "prompt": prompt, "negative_prompt": negative_prompt,
            "compiled_prompt": compiled_prompt,
            "compiled_negative_prompt": compiled_negative,
            "seed": seed, "steps": steps, "sampler": sampler, "cfg_scale": cfg_scale,
            "width": width, "height": height,
            "model_name": model_name, "model_hash": model_hash,
            "infotext": infotext,
        },
    )


def delete_endorsement(eid: int):
    removed = None
    with _get_conn() as conn:
        row = conn.execute("SELECT * FROM endorsements WHERE id=?", (eid,)).fetchone()
        if row:
            _restore_endorsement_row(conn, row)
            conn.execute("DELETE FROM endorsements WHERE id=?", (eid,))
            removed = {"item_key": row["item_key"], "path": row["image_path"]}
        conn.commit()
    if removed:
        gallery_bridge.on_endorsement_removed(removed["item_key"], removed["path"])


def delete_endorsement_by_path(path: str):
    item_key = _item_key_from_path(path)
    removed = None
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
        if row:
            removed = {"item_key": row["item_key"], "path": row["image_path"]}
    if removed:
        gallery_bridge.on_endorsement_removed(removed["item_key"] or item_key, removed["path"])


def get_endorsed_paths() -> set:
    with _get_conn() as conn:
        rows = conn.execute("SELECT image_path FROM endorsements WHERE image_path IS NOT NULL").fetchall()
        return {r[0] for r in rows}


def get_endorsed_item_keys() -> set:
    """Item keys with an endorsement row (endorsing copies the image elsewhere,
    so the original path alone cannot identify an endorsed card)."""
    with _get_conn() as conn:
        rows = conn.execute(
            "SELECT item_key FROM endorsements WHERE item_key IS NOT NULL AND item_key != ''"
        ).fetchall()
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
            cfg_scale, width, height, model_name, model_hash, infotext, item_key=None):
    item_key = str(item_key or "") or _item_key_from_path(image_path)

    # Disliking cancels staged status
    unstage_item(item_key)

    with _get_conn() as conn:
        compiled_prompt, compiled_negative = _compiled_prompts_for_item(conn, item_key, image_path) or ("", "")
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
                 sampler, cfg_scale, width, height, model_name, model_hash, infotext, item_key,
                 compiled_prompt, compiled_negative_prompt)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
                compiled_prompt,
                compiled_negative,
            ),
        )
        conn.commit()

    gallery_bridge.on_dislike(
        item_key, image_path,
        {
            "prompt": prompt, "negative_prompt": negative_prompt,
            "compiled_prompt": compiled_prompt,
            "compiled_negative_prompt": compiled_negative,
            "seed": seed, "steps": steps, "sampler": sampler, "cfg_scale": cfg_scale,
            "width": width, "height": height,
            "model_name": model_name, "model_hash": model_hash,
            "infotext": infotext,
        },
    )


def delete_dislike(did: int):
    removed = None
    with _get_conn() as conn:
        row = conn.execute("SELECT * FROM dislikes WHERE id=?", (did,)).fetchone()
        conn.execute("DELETE FROM dislikes WHERE id=?", (did,))
        conn.commit()
        if row:
            removed = {"item_key": row["item_key"], "path": row["image_path"]}
    if removed:
        gallery_bridge.on_dislike_removed(removed["item_key"], removed["path"])


def delete_dislike_by_path(path: str):
    item_key = _item_key_from_path(path)
    with _get_conn() as conn:
        if item_key:
            conn.execute("DELETE FROM dislikes WHERE item_key=?", (item_key,))
        else:
            conn.execute("DELETE FROM dislikes WHERE image_path=?", (path,))
        conn.commit()
    gallery_bridge.on_dislike_removed(item_key, path)


def delete_endorsement_by_key(item_key: str):
    """Remove an endorsement by canonical item key, deleting its endorsed copy.

    Endorsed copies get a `_N` filename suffix, so a key derived from the copy path
    would not match the stored row (silently doing nothing)."""
    key = str(item_key or "")
    if not key:
        return
    removed = []
    with _get_conn() as conn:
        rows = conn.execute("SELECT * FROM endorsements WHERE item_key=?", (key,)).fetchall()
        for row in rows:
            _restore_endorsement_row(conn, row)
            removed.append({"item_key": row["item_key"], "path": row["image_path"]})
        conn.execute("DELETE FROM endorsements WHERE item_key=?", (key,))
        conn.commit()
    for entry in removed:
        gallery_bridge.on_endorsement_removed(entry["item_key"] or key, entry["path"])


def delete_dislike_by_key(item_key: str):
    key = str(item_key or "")
    if not key:
        return
    with _get_conn() as conn:
        conn.execute("DELETE FROM dislikes WHERE item_key=?", (key,))
        conn.commit()
    gallery_bridge.on_dislike_removed(key)


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
        sql = _append_trash_exclusion(sql)
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
    sql = _append_trash_exclusion(sql)
    sql += " ORDER BY endorsed_at DESC LIMIT ? OFFSET ?"
    with _get_conn() as conn:
        rows = conn.execute(sql, params + [int(limit), int(offset)]).fetchall()
        return [dict(r) for r in rows]


def count_disliked(query: str = "", since_ts: float | None = None) -> int:
    where_sql, params = _build_keyword_where(query, ["prompt", "negative_prompt", "model_name", "sampler"])
    where_sql, params = _append_time_filter(where_sql, params, "disliked_at", since_ts, numeric=False)
    with _get_conn() as conn:
        sql = "SELECT COUNT(*) FROM dislikes" + where_sql
        sql = _append_trash_exclusion(sql)
        return conn.execute(sql, params).fetchone()[0]


def search_disliked(query: str = "", limit: int = 60, offset: int = 0,
                    since_ts: float | None = None) -> list:
    where_sql, params = _build_keyword_where(query, ["prompt", "negative_prompt", "model_name", "sampler"])
    where_sql, params = _append_time_filter(where_sql, params, "disliked_at", since_ts, numeric=False)
    sql = "SELECT * FROM dislikes" + where_sql
    sql = _append_trash_exclusion(sql)
    sql += " ORDER BY disliked_at DESC LIMIT ? OFFSET ?"
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
        " AND item_key NOT IN (SELECT item_key FROM trash WHERE item_key IS NOT NULL AND item_key != '')"
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
        " AND item_key NOT IN (SELECT item_key FROM trash WHERE item_key IS NOT NULL AND item_key != '')"
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
    gallery_bridge.on_archive(item_key)


def unarchive_item(item_key: str) -> None:
    if not item_key:
        return
    with _get_conn() as conn:
        conn.execute("DELETE FROM archived WHERE item_key=?", (item_key,))
        conn.commit()
    gallery_bridge.on_unarchive(item_key)


def archive_all_unrated() -> int:
    """Archive all generated images not yet endorsed, disliked, archived, staged, or trashed. Returns count added."""
    now = datetime.now().isoformat(timespec="seconds")
    select_sql = """
        SELECT item_key
        FROM generated_images
        WHERE item_key IS NOT NULL AND item_key != ''
          AND item_key NOT IN (SELECT item_key FROM endorsements WHERE item_key IS NOT NULL AND item_key != '')
          AND item_key NOT IN (SELECT item_key FROM dislikes WHERE item_key IS NOT NULL AND item_key != '')
          AND item_key NOT IN (SELECT item_key FROM archived WHERE item_key IS NOT NULL AND item_key != '')
          AND item_key NOT IN (SELECT item_key FROM staged WHERE item_key IS NOT NULL AND item_key != '')
          AND item_key NOT IN (SELECT item_key FROM trash WHERE item_key IS NOT NULL AND item_key != '')
    """
    with _get_conn() as conn:
        keys = [r[0] for r in conn.execute(select_sql).fetchall()]
        if keys:
            conn.executemany(
                "INSERT OR IGNORE INTO archived (item_key, archived_at) VALUES (?,?)",
                [(key, now) for key in keys],
            )
        conn.commit()
    for key in keys:
        gallery_bridge.on_archive(key)
    return len(keys)


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


# ── Trash ────────────────────────────────────────────────────────────────────

def get_trashed_item_keys(item_keys: list[str]) -> set:
    """Return subset of item_keys that are in trash."""
    if not item_keys:
        return set()
    placeholders = ",".join(["?"] * len(item_keys))
    with _get_conn() as conn:
        rows = conn.execute(
            f"SELECT item_key FROM trash WHERE item_key IN ({placeholders})",
            item_keys,
        ).fetchall()
    return {r[0] for r in rows}


def is_trashed(item_key: str) -> bool:
    """Return True if the item is in the trash."""
    if not item_key:
        return False
    with _get_conn() as conn:
        row = conn.execute("SELECT id FROM trash WHERE item_key=?", (item_key,)).fetchone()
    return row is not None


def count_trash(query: str = "", since_ts: float | None = None) -> int:
    where_sql, params = _build_keyword_where(query, ["prompt", "negative_prompt", "model_name", "sampler"])
    where_sql, params = _append_time_filter(where_sql, params, "trashed_at", since_ts, numeric=False)
    with _get_conn() as conn:
        sql = "SELECT COUNT(*) FROM trash" + where_sql
        return conn.execute(sql, params).fetchone()[0]


def search_trash(query: str = "", limit: int = 48, offset: int = 0,
                 since_ts: float | None = None) -> list:
    where_sql, params = _build_keyword_where(query, ["prompt", "negative_prompt", "model_name", "sampler"])
    where_sql, params = _append_time_filter(where_sql, params, "trashed_at", since_ts, numeric=False)
    sql = "SELECT * FROM trash" + where_sql + " ORDER BY trashed_at DESC LIMIT ? OFFSET ?"
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
    gallery_bridge.on_stage(item_key)


def unstage_item(item_key: str) -> None:
    """Remove the staged flag from an image."""
    if not item_key:
        return
    with _get_conn() as conn:
        conn.execute("DELETE FROM staged WHERE item_key=?", (item_key,))
        conn.commit()
    gallery_bridge.on_unstage(item_key)


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
                infotext: str, compiled_prompt: str | None = None,
                compiled_negative_prompt: str | None = None):
    """Index a saved image.

    `compiled_prompt` is what the model was actually conditioned on (comments
    stripped, @PICK groups drawn); `prompt` stays the source prompt. Pass None
    to keep whatever was recorded before (re-indexing a file cannot re-derive
    the draw), "" to record "none".
    """
    if is_removebg_attachment_path(path):
        return

    item_key = _item_key_from_path(path)
    with _get_conn() as conn:
        # re-indexing cannot re-derive the draw, so keep the compiled prompt recorded
        # before - the helper only returns it for the same image (A1111 recycles
        # filename sequence numbers, so a path can be reused by a new picture)
        previous = _compiled_prompts_for_item(conn, item_key, path, source_prompt=prompt)
        known = compiled_prompt is not None
        if item_key:
            conn.execute("DELETE FROM generated_images WHERE item_key=?", (item_key,))
            # A1111 recycles filename sequence numbers after originals are
            # deleted, so a regenerated image can reuse an item_key that still
            # has a stale trash row. Clear it so the new image isn't hidden by
            # the trash exclusion in gallery queries.
            conn.execute("DELETE FROM trash WHERE item_key=?", (item_key,))
        if compiled_prompt is None:
            compiled_prompt = previous[0] if previous else ""
        if compiled_negative_prompt is None:
            compiled_negative_prompt = previous[1] if previous else ""
        # nothing known about this image -> leave gallery.db's columns alone
        carried = known or bool(previous and any(previous))
        conn.execute(
            """
            INSERT OR REPLACE INTO generated_images
                (path, indexed_at, file_mtime, prompt, negative_prompt, seed, steps,
                 sampler, cfg_scale, width, height, model_name, model_hash, infotext, item_key,
                 compiled_prompt, compiled_negative_prompt)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
                compiled_prompt,
                compiled_negative_prompt,
            ),
        )
        conn.commit()
    gallery_bridge.on_index_image(
        path, file_mtime, prompt, negative_prompt, seed, steps, sampler,
        cfg_scale, width, height, model_name, model_hash, infotext,
        # None (nothing known about this image) keeps whatever gallery.db recorded
        compiled_prompt=compiled_prompt if carried else None,
        compiled_negative_prompt=compiled_negative_prompt if carried else None,
    )


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
        sql = _append_trash_exclusion(sql)
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
    sql = _append_trash_exclusion(sql)
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


def _trash_thumb_cache_path(path: str, mtime: float) -> str:
    key = hashlib.sha1(f"{path}|{mtime:.6f}".encode("utf-8", errors="ignore")).hexdigest()
    return os.path.join(_DB_ROOT, "cache", "gallery_thumbs", f"{key}.webp")


def _trash_preview_cache_path(path: str, mtime: float) -> str:
    key = hashlib.sha1(f"{path}|{mtime:.6f}|preview".encode("utf-8", errors="ignore")).hexdigest()
    return os.path.join(_DB_ROOT, "cache", "gallery_previews", f"{key}.webp")


_SIDECAR_OUTPUT_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp")


def _sidecar_output_paths_by_key() -> dict:
    """Map qwen-/krea2- item keys to their file paths.

    Those outputs live outside generated_images; the archive key embeds the
    outputs-relative path (engine prefix + lowercased parts), so scanning the two
    engines' output dirs recovers the file for a given key.
    """
    mapping = {}
    outputs_root = os.path.join(_DB_ROOT, "outputs")
    for engine in ("qwen", "krea2"):
        base = os.path.join(outputs_root, engine)
        if not os.path.isdir(base):
            continue
        for dirpath, dirnames, fnames in os.walk(base):
            dirnames[:] = [name for name in dirnames if not name.startswith(".")]
            for fname in fnames:
                if fname.startswith(".") or not fname.lower().endswith(_SIDECAR_OUTPUT_EXTS):
                    continue
                fpath = os.path.join(dirpath, fname)
                try:
                    rel = os.path.relpath(fpath, _DB_ROOT).replace("\\", "/")
                except ValueError:
                    continue
                parts = [part for part in rel.split("/") if part]
                parts[-1] = os.path.splitext(parts[-1])[0]
                mapping[engine + "-" + "-".join(part.lower() for part in parts)] = fpath
    return mapping


_SIDECAR_METADATA_CACHE = {}


def _parse_sidecar_infotext(text: str) -> dict:
    """Parse a stable-diffusion.cpp / webui-style infotext into display fields."""
    text = (text or "").strip()
    if not text:
        return {}

    prompt = text
    negative = ""
    metrics = ""
    match = re.search(r"\n(Steps: .*)\Z", text, re.S)
    if match:
        metrics = match.group(1).strip()
        head = text[: match.start()]
        neg_match = re.search(r"\nNegative prompt: (.*)\Z", head, re.S)
        if neg_match:
            prompt = head[: neg_match.start()].strip()
            negative = neg_match.group(1).strip()
        else:
            prompt = head.strip()
    else:
        neg_match = re.search(r"(?i)\bNegative prompt:\s*", text)
        if neg_match and neg_match.start() == 0:
            negative = text[neg_match.end():].strip()
            prompt = ""

    def pick(pattern: str) -> str:
        found = re.search(pattern, metrics)
        return found.group(1).strip() if found else ""

    def pick_int(pattern: str) -> int:
        try:
            return int(float(pick(pattern) or 0))
        except ValueError:
            return 0

    def pick_float(pattern: str) -> float:
        try:
            return float(pick(pattern) or 0)
        except ValueError:
            return 0.0

    size = re.search(r"Size:\s*(\d+)\s*x\s*(\d+)", metrics)
    return {
        "infotext": text,
        "prompt": prompt,
        "negative_prompt": negative,
        "steps": pick_int(r"Steps:\s*(\d+)"),
        "sampler": pick(r"Sampler:\s*([^,]+)"),
        "cfg_scale": pick_float(r"CFG scale:\s*([\d.]+)"),
        "seed": pick(r"Seed:\s*(-?\d+)"),
        "width": int(size.group(1)) if size else 0,
        "height": int(size.group(2)) if size else 0,
        "model": pick(r"Unet:\s*([^,]+)") or pick(r"Model:\s*([^,]+)"),
    }


def read_sidecar_metadata(path: str) -> dict:
    """Prompt + generation settings for a qwen/krea2 output.

    Prefers the `<stem>.txt` sidecar written next to the image (both sidecar bridges
    write one); falls back to the PNG's embedded `parameters` chunk. Returns {} when
    neither is available. Cached per (path, image mtime).
    """
    if not path:
        return {}
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        mtime = 0.0
    cache_key = (path, mtime)
    if cache_key in _SIDECAR_METADATA_CACHE:
        return _SIDECAR_METADATA_CACHE[cache_key]

    text = ""
    sidecar = os.path.splitext(path)[0] + ".txt"
    if os.path.isfile(sidecar):
        try:
            with open(sidecar, "r", encoding="utf-8", errors="replace") as handle:
                text = handle.read()
        except OSError:
            text = ""
    if not text and path.lower().endswith(".png"):
        try:
            from PIL import Image
            with Image.open(path) as img:
                text = str((img.info or {}).get("parameters") or "")
        except Exception:
            text = ""

    if text:
        parsed = _parse_sidecar_infotext(text)
        if len(_SIDECAR_METADATA_CACHE) > 4096:
            _SIDECAR_METADATA_CACHE.clear()
        _SIDECAR_METADATA_CACHE[cache_key] = parsed
        return parsed
    # No sidecar file and no PNG chunk: serve from the v2 store (post-migration).
    return gallery_bridge.read_meta(path)


def trash_archived_and_disliked() -> dict:
    """Move archived and disliked items to trash, deleting originals and thumbnails.

    Generation metadata (prompt, parameters, infotext) is preserved in the trash table.
    Original files and cached thumbnails/previews are removed from disk.
    Items are removed from archived, dislikes, endorsements, staged, and generated_images
    so they no longer appear in any gallery mode except Trash.

    Returns dict with:
      - trashed: number of items moved to trash
      - deleted: original files successfully deleted
      - skipped: original files already gone or not found
      - thumb_deleted: thumbnails deleted
      - preview_deleted: preview images deleted
      - errors: file deletion errors
      - freed_bytes: total bytes freed
    """
    trashed = 0
    deleted = 0
    skipped = 0
    thumb_deleted = 0
    preview_deleted = 0
    errors = 0
    freed_bytes = 0

    files_to_delete = []  # list of (path, mtime) tuples for originals and cache
    sidecar_paths = None  # lazily built qwen-/krea2- key -> path map
    now = datetime.now().isoformat(timespec="seconds")

    with _get_conn() as conn:
        rows = conn.execute(
            """
            SELECT item_key FROM archived WHERE item_key IS NOT NULL AND item_key != ''
            UNION
            SELECT item_key FROM dislikes WHERE item_key IS NOT NULL AND item_key != ''
            """
        ).fetchall()
        item_keys = [r[0] for r in rows]

        for item_key in item_keys:
            # Prefer generated_images for the richest metadata, then dislikes, then endorsements.
            meta_row = conn.execute(
                """
                SELECT path, file_mtime, prompt, negative_prompt, seed, steps, sampler,
                       cfg_scale, width, height, model_name, model_hash, infotext
                FROM generated_images
                WHERE item_key=? LIMIT 1
                """,
                (item_key,),
            ).fetchone()
            path, mtime = None, None

            if meta_row:
                columns = meta_row
                path, mtime = meta_row[0], meta_row[1]
            else:
                row = conn.execute(
                    """
                    SELECT image_path, prompt, negative_prompt, seed, steps, sampler,
                           cfg_scale, width, height, model_name, model_hash, infotext
                    FROM dislikes
                    WHERE item_key=? ORDER BY id DESC LIMIT 1
                    """,
                    (item_key,),
                ).fetchone()
                if row:
                    path = row[0]
                    columns = (path, None) + row[1:]
                else:
                    row = conn.execute(
                        """
                        SELECT image_path, prompt, negative_prompt, seed, steps, sampler,
                               cfg_scale, width, height, model_name, model_hash, infotext
                        FROM endorsements
                        WHERE item_key=? ORDER BY id DESC LIMIT 1
                        """,
                        (item_key,),
                    ).fetchone()
                    if row:
                        path = row[0]
                        columns = (path, None) + row[1:]
                    else:
                        columns = (None, None, "", "", "", 0, "", 0.0, 0, 0, "", "", "")

            # Qwen/Krea 2 outputs are not in generated_images: their keys embed the
            # outputs-relative path, so recover the file by scanning the output dirs.
            if path is None and (item_key.startswith("qwen-") or item_key.startswith("krea2-")):
                if sidecar_paths is None:
                    sidecar_paths = _sidecar_output_paths_by_key()
                path = sidecar_paths.get(item_key)
                if path and not os.path.isfile(path):
                    path = None  # already gone
                if path:
                    columns = (path, None) + tuple(columns[2:])

            # If the DB didn't store mtime, try to read it from the still-existing original.
            if path and mtime is None and os.path.isfile(path):
                try:
                    mtime = os.path.getmtime(path)
                except OSError:
                    pass
                if mtime is not None:
                    columns = (columns[0], mtime) + tuple(columns[2:])

            # Save metadata to trash.
            conn.execute(
                """
                INSERT OR REPLACE INTO trash
                    (item_key, trashed_at, path, file_mtime, prompt, negative_prompt, seed, steps,
                     sampler, cfg_scale, width, height, model_name, model_hash, infotext)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    item_key,
                    now,
                    columns[0],
                    columns[1],
                    columns[2],
                    columns[3],
                    str(columns[4] or ""),
                    int(columns[5] or 0),
                    columns[6],
                    float(columns[7] or 0),
                    int(columns[8] or 0),
                    int(columns[9] or 0),
                    columns[10],
                    columns[11],
                    columns[12],
                ),
            )
            trashed += 1

            if path:
                files_to_delete.append((path, mtime))

            # Remove from every state table so the item is only in trash.
            conn.execute("DELETE FROM archived WHERE item_key=?", (item_key,))
            conn.execute("DELETE FROM dislikes WHERE item_key=?", (item_key,))
            conn.execute("DELETE FROM endorsements WHERE item_key=?", (item_key,))
            conn.execute("DELETE FROM staged WHERE item_key=?", (item_key,))
            conn.execute("DELETE FROM generated_images WHERE item_key=?", (item_key,))

        conn.commit()

    # Delete originals and their cached thumbnails/previews after the DB transaction commits.
    for path, mtime in files_to_delete:
        if not path:
            continue

        if os.path.isfile(path):
            try:
                file_size = os.path.getsize(path)
                os.remove(path)
                deleted += 1
                freed_bytes += file_size
            except OSError:
                errors += 1
        else:
            skipped += 1

        if mtime is not None:
            thumb_path = _trash_thumb_cache_path(path, mtime)
            if os.path.isfile(thumb_path):
                try:
                    os.remove(thumb_path)
                    thumb_deleted += 1
                except OSError:
                    errors += 1

            preview_path = _trash_preview_cache_path(path, mtime)
            if os.path.isfile(preview_path):
                try:
                    os.remove(preview_path)
                    preview_deleted += 1
                except OSError:
                    errors += 1

    # Mirror the trash transition into the v2 store (state + blob media policy).
    gallery_bridge.on_trash_keys(item_keys)

    if trashed > 0 or deleted > 0 or errors > 0:
        freed_mb = freed_bytes / (1024 * 1024)
        print(
            f"[Gallery] Moved {trashed} archived/disliked item(s) to trash, "
            f"deleted {deleted} original(s), freed {freed_mb:.1f} MB"
            + (f", {errors} error(s)" if errors else "")
            + (f", {skipped} already gone" if skipped else "")
            + (f", {thumb_deleted} thumbnail(s)" if thumb_deleted else "")
            + (f", {preview_deleted} preview(s)" if preview_deleted else "")
        )

    return {
        "trashed": trashed,
        "deleted": deleted,
        "skipped": skipped,
        "thumb_deleted": thumb_deleted,
        "preview_deleted": preview_deleted,
        "errors": errors,
        "freed_bytes": freed_bytes,
    }


def _meta_int(value, default=0):
    try:
        return int(float(str(value).split(",")[0].strip()))
    except (TypeError, ValueError):
        return default


def _file_mtime(path):
    if not path:
        return None
    try:
        return os.path.getmtime(path)
    except OSError:
        return None


def trash_item_by_key(item_key: str) -> dict:
    """Move a single item to trash (used by the v2 gallery action bar).

    Mirrors trash_archived_and_disliked for one key: metadata into trash,
    original + cached media deleted, removed from all state tables, v2 store
    updated via the bridge. Returns {"ok": True, ...} or {"error": ...}.
    """
    key = str(item_key or "")
    if not key:
        return {"error": "empty key"}
    now = datetime.now().isoformat(timespec="seconds")
    path = None
    mtime = None
    v2_alias = None

    with _get_conn() as conn:
        if conn.execute("SELECT id FROM trash WHERE item_key=?", (key,)).fetchone():
            return {"error": "already trashed"}
        meta_row = conn.execute(
            """
            SELECT path, file_mtime, prompt, negative_prompt, seed, steps, sampler,
                   cfg_scale, width, height, model_name, model_hash, infotext
            FROM generated_images WHERE item_key=? LIMIT 1
            """,
            (key,),
        ).fetchone()
        if meta_row:
            columns = meta_row
        else:
            row = conn.execute(
                """
                SELECT image_path, prompt, negative_prompt, seed, steps, sampler,
                       cfg_scale, width, height, model_name, model_hash, infotext
                FROM dislikes WHERE item_key=? ORDER BY id DESC LIMIT 1
                """,
                (key,),
            ).fetchone()
            if row:
                columns = (row[0], None) + tuple(row[1:])
            else:
                row = conn.execute(
                    """
                    SELECT image_path, prompt, negative_prompt, seed, steps, sampler,
                           cfg_scale, width, height, model_name, model_hash, infotext
                    FROM endorsements WHERE item_key=? ORDER BY id DESC LIMIT 1
                    """,
                    (key,),
                ).fetchone()
                if row:
                    columns = (row[0], None) + tuple(row[1:])
                else:
                    columns = (None, None, "", "", "", 0, "", 0.0, 0, 0, "", "", "")

        path, mtime = columns[0], columns[1]
        if path is None and (key.startswith("qwen-") or key.startswith("krea2-")):
            path = _sidecar_output_paths_by_key().get(key)
            if path and not os.path.isfile(path):
                path = None
            if path:
                columns = (path, None) + tuple(columns[2:])
        if path is None:
            # v2-only sources (composition / image_maker / ...) and freshly indexed
            # files have no legacy row: resolve through the gallery store instead.
            try:
                from modules import gallery_db
                v2_item = gallery_db.get_item(gallery_db.resolve_item_id(key))
            except Exception:
                v2_item = None
            if v2_item:
                path = v2_item.get("path") or v2_item.get("alias_path")
                if path and not os.path.isfile(path):
                    alias = v2_item.get("alias_path")
                    path = alias if alias and os.path.isfile(alias) else None
                if path:
                    v2_meta = gallery_db.get_item_meta(v2_item["id"])
                    columns = (
                        path, columns[1],
                        columns[2] or (v2_item.get("prompt") or ""),
                        columns[3] or (v2_item.get("negative_prompt") or ""),
                        columns[4] or str(v2_meta.get("seed") or ""),
                        columns[5] or _meta_int(v2_meta.get("steps")),
                        columns[6] or str(v2_meta.get("sampler") or ""),
                        columns[7] or 0.0,
                        columns[8] or int(v2_item.get("width") or 0),
                        columns[9] or int(v2_item.get("height") or 0),
                        columns[10] or str(v2_meta.get("model") or ""),
                        columns[11] or str(v2_meta.get("model_hash") or ""),
                        columns[12] or (v2_item.get("infotext") or ""),
                    )
                    v2_alias = v2_item.get("alias_path")
        if path and mtime is None and os.path.isfile(path):
            try:
                mtime = os.path.getmtime(path)
                columns = (columns[0], mtime) + tuple(columns[2:])
            except OSError:
                pass

        conn.execute(
            """
            INSERT OR REPLACE INTO trash
                (item_key, trashed_at, path, file_mtime, prompt, negative_prompt, seed, steps,
                 sampler, cfg_scale, width, height, model_name, model_hash, infotext)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            (
                key, now, columns[0], columns[1], columns[2], columns[3],
                str(columns[4] or ""), int(columns[5] or 0), columns[6],
                float(columns[7] or 0), int(columns[8] or 0), int(columns[9] or 0),
                columns[10], columns[11], columns[12],
            ),
        )
        conn.execute("DELETE FROM archived WHERE item_key=?", (key,))
        conn.execute("DELETE FROM dislikes WHERE item_key=?", (key,))
        conn.execute("DELETE FROM endorsements WHERE item_key=?", (key,))
        conn.execute("DELETE FROM staged WHERE item_key=?", (key,))
        conn.execute("DELETE FROM generated_images WHERE item_key=?", (key,))
        conn.commit()

    deleted = 0
    freed = 0
    seen_inodes = set()
    for candidate in (path, v2_alias):
        if not candidate or not os.path.isfile(candidate):
            continue
        try:
            stat = os.stat(candidate)
            inode = getattr(stat, "st_ino", None)
            if inode is not None and inode in seen_inodes:
                continue
            if inode is not None:
                seen_inodes.add(inode)
            freed += stat.st_size
            os.remove(candidate)
            deleted += 1
        except OSError:
            pass
    for cache_base, cache_mtime in ((path, mtime), (v2_alias, _file_mtime(v2_alias))):
        if cache_mtime is None:
            continue
        for cache_path in (_trash_thumb_cache_path(cache_base, cache_mtime), _trash_preview_cache_path(cache_base, cache_mtime)):
            if os.path.isfile(cache_path):
                try:
                    os.remove(cache_path)
                except OSError:
                    pass
    gallery_bridge.on_trash_keys([key])
    print(f"[Gallery] Trashed '{key}'" + (f" (deleted {freed / 1048576:.1f} MB)" if deleted else ""))
    return {"ok": True, "deleted": deleted, "freed_bytes": freed}


def remove_trash_row(item_key: str) -> None:
    """Delete the legacy trash row (restore / purge)."""
    key = str(item_key or "")
    if not key:
        return
    with _get_conn() as conn:
        conn.execute("DELETE FROM trash WHERE item_key=?", (key,))
        conn.commit()


def delete_archived_originals() -> dict:
    """Delete original image files for all archived items, keeping thumbnails/preview caches.

    Kept for backward compatibility; new UI uses trash_archived_and_disliked().

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

    Kept for backward compatibility; new UI uses trash_archived_and_disliked().

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
