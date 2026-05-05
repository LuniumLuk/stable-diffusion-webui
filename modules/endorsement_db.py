"""SQLite persistence for generated images, endorsements, and dislikes."""

import os
import sqlite3
from datetime import datetime

_DB_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "endorsements.db")


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


def _column_exists(conn, table: str, column: str) -> bool:
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return any(r[1] == column for r in rows)


def _ensure_item_key_columns(conn):
    for table in ("endorsements", "dislikes", "generated_images"):
        if not _column_exists(conn, table, "item_key"):
            conn.execute(f"ALTER TABLE {table} ADD COLUMN item_key TEXT")


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
        _backfill_item_keys(conn)
        _dedupe_table_by_item_key(conn, "generated_images", "file_mtime")
        _dedupe_table_by_item_key(conn, "endorsements", "endorsed_at")
        _dedupe_table_by_item_key(conn, "dislikes", "disliked_at")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_generated_item_key ON generated_images(item_key)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_endorsements_item_key ON endorsements(item_key)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_dislikes_item_key ON dislikes(item_key)")
        conn.commit()


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


def endorse(image_path, prompt, negative_prompt, seed, steps, sampler,
            cfg_scale, width, height, model_name, model_hash, infotext):
    item_key = _item_key_from_path(image_path)
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
                (endorsed_at, image_path, prompt, negative_prompt, seed, steps,
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


def delete_endorsement(eid: int):
    with _get_conn() as conn:
        conn.execute("DELETE FROM endorsements WHERE id=?", (eid,))
        conn.commit()


def delete_endorsement_by_path(path: str):
    item_key = _item_key_from_path(path)
    with _get_conn() as conn:
        if item_key:
            conn.execute("DELETE FROM endorsements WHERE item_key=?", (item_key,))
        else:
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


def count_endorsements(query: str = "", exclude_disliked: bool = True) -> int:
    where_sql, params = _build_keyword_where(query, ["prompt", "negative_prompt", "model_name", "sampler"])
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
                        exclude_disliked: bool = True) -> list:
    where_sql, params = _build_keyword_where(query, ["prompt", "negative_prompt", "model_name", "sampler"])
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


def count_disliked(query: str = "") -> int:
    where_sql, params = _build_keyword_where(query, ["prompt", "negative_prompt", "model_name", "sampler"])
    with _get_conn() as conn:
        sql = "SELECT COUNT(*) FROM dislikes" + where_sql
        return conn.execute(sql, params).fetchone()[0]


def search_disliked(query: str = "", limit: int = 60, offset: int = 0) -> list:
    where_sql, params = _build_keyword_where(query, ["prompt", "negative_prompt", "model_name", "sampler"])
    sql = "SELECT * FROM dislikes" + where_sql + " ORDER BY disliked_at DESC LIMIT ? OFFSET ?"
    with _get_conn() as conn:
        rows = conn.execute(sql, params + [int(limit), int(offset)]).fetchall()
        return [dict(r) for r in rows]


def count_unrated(query: str = "") -> int:
    where_sql, params = _build_keyword_where(query, ["prompt", "negative_prompt", "model_name", "sampler"])
    sql = "SELECT COUNT(*) FROM generated_images"
    rated_filter = " AND item_key NOT IN (SELECT item_key FROM endorsements WHERE item_key IS NOT NULL AND item_key != '') AND item_key NOT IN (SELECT item_key FROM dislikes WHERE item_key IS NOT NULL AND item_key != '')"
    if where_sql:
        sql += where_sql + rated_filter
    else:
        sql += " WHERE item_key NOT IN (SELECT item_key FROM endorsements WHERE item_key IS NOT NULL AND item_key != '') AND item_key NOT IN (SELECT item_key FROM dislikes WHERE item_key IS NOT NULL AND item_key != '')"
    with _get_conn() as conn:
        return conn.execute(sql, params).fetchone()[0]


def search_unrated(query: str = "", limit: int = 48, offset: int = 0) -> list:
    where_sql, params = _build_keyword_where(query, ["prompt", "negative_prompt", "model_name", "sampler"])
    sql = "SELECT * FROM generated_images"
    rated_filter = " AND item_key NOT IN (SELECT item_key FROM endorsements WHERE item_key IS NOT NULL AND item_key != '') AND item_key NOT IN (SELECT item_key FROM dislikes WHERE item_key IS NOT NULL AND item_key != '')"
    if where_sql:
        sql += where_sql + rated_filter
    else:
        sql += " WHERE item_key NOT IN (SELECT item_key FROM endorsements WHERE item_key IS NOT NULL AND item_key != '') AND item_key NOT IN (SELECT item_key FROM dislikes WHERE item_key IS NOT NULL AND item_key != '')"
    sql += " ORDER BY file_mtime DESC LIMIT ? OFFSET ?"
    with _get_conn() as conn:
        rows = conn.execute(sql, params + [int(limit), int(offset)]).fetchall()
        return [dict(r) for r in rows]


def index_image(path: str, file_mtime: float, prompt: str, negative_prompt: str,
                seed: str, steps: int, sampler: str, cfg_scale: float,
                width: int, height: int, model_name: str, model_hash: str,
                infotext: str):
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


def count_generated_filtered(query: str = "", exclude_disliked: bool = True) -> int:
    where_sql, params = _build_keyword_where(query, ["prompt", "negative_prompt", "model_name", "sampler"])
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
                     exclude_disliked: bool = True) -> list:
    where_sql, params = _build_keyword_where(query, ["prompt", "negative_prompt", "model_name", "sampler"])
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
