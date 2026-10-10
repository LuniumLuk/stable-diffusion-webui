"""Gallery v2 authoritative store (gallery.db).

Implements the schema from GALLERY_V2_REFACTOR_PLAN.html sections 4.2/4.3:
- sources registry (extensible parsers, UI chips come from this table)
- items with promoted columns only for filter/sort/route fields; everything
  else is compacted into meta_json (per-source schema_version)
- tag_categories / tags / item_tags with a partial unique index enforcing at
  most one single-select (composite) tag per category - e.g. rating
- state machine (active|staged|archived|trashed) + archive_expires_at TTL
- state_events history, composer_states (zlib), saved_views, legacy_keys
- FTS5 (items_fts) for the search grammar

This module has no dependency on the running webui: standalone scripts and
tests can import it directly. All paths default to the webui root but honour
GALLERY_DB_PATH / GALLERY_BLOB_DB_PATH environment overrides.
"""

import json
import os
import sqlite3
import time
import zlib
from datetime import datetime, timezone

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

DB_PATH = os.environ.get("GALLERY_DB_PATH") or os.path.join(_ROOT, "gallery.db")
BLOB_DB_PATH = os.environ.get("GALLERY_BLOB_DB_PATH") or os.path.join(_ROOT, "cache", "gallery_blobs.db")

DEFAULT_ARCHIVE_TTL_HOURS = 24.0

VALID_STATES = ("active", "staged", "archived", "trashed")
STATES_WITHOUT_ARCHIVE_TTL = ("active", "staged", "trashed")

RATING_CATEGORY = "rating"
WORKFLOW_CATEGORY = "workflow"
CAPTIONS_CATEGORY = "captions"

DEFAULT_SOURCES = (
    # id, label, parser, config
    ("txt2img", "txt2img", "a1111", '{"root": "outputs/txt2img-images"}'),
    ("img2img", "img2img", "a1111", '{"root": "outputs/img2img-images", "include_inpaint": true}'),
    ("inpaint", "Inpaint", "a1111", "{}"),
    ("composition", "Composed", "sidecar_json", '{"root": "outputs/composition"}'),
    ("image_maker", "Image Maker", "none", '{"root": "outputs/image_maker"}'),
    ("qwen", "Qwen", "sidecar_txt", '{"root": "outputs/qwen"}'),
    ("krea2", "Krea 2", "sidecar_txt", '{"root": "outputs/krea2"}'),
    ("removebg", "RemoveBG", "none", '{"root": "outputs/removebg", "variant_of": "parent"}'),
    ("nano_banana", "Nano Banana", "sidecar_txt", '{"root": "outputs/nano-banana"}'),
    ("comic_maker", "Comic Maker", "a1111", '{"root": "outputs/comic_maker"}'),
    ("sana", "SANA", "a1111", '{"root": "outputs/sana"}'),
)

DEFAULT_CATEGORIES = (
    # id, name, cardinality, kind, color, sort_order
    (RATING_CATEGORY, "Rating", "single", "rating", "#f59e0b", 0),
    (WORKFLOW_CATEGORY, "Workflow", "multi", "user", "#60a5fa", 10),
    (CAPTIONS_CATEGORY, "Captions", "multi", "caption", "#94a3b8", 20),
)

RATING_TAGS = (
    ("endorsed", "#f59e0b"),
    ("disliked", "#ef4444"),
)


def _now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


_ready = False
_fast_sync = False


def set_fast_sync(enabled: bool) -> None:
    """Migration mode: memory journal + no fsync (snapshot exists; big speedup).

    WAL autocheckpointing is the bottleneck for per-row commits; the memory
    journal removes both the checkpoint and the fsync cost. Call
    restore_journal_mode() when the migration finishes.
    """
    global _fast_sync
    _fast_sync = bool(enabled)
    if enabled:
        try:
            with sqlite3.connect(DB_PATH, timeout=60) as conn:
                conn.execute("PRAGMA journal_mode=MEMORY")
                conn.execute("PRAGMA synchronous=OFF")
        except sqlite3.Error:
            pass


def restore_journal_mode() -> None:
    try:
        with sqlite3.connect(DB_PATH, timeout=60) as conn:
            conn.execute("PRAGMA journal_mode=WAL")
    except sqlite3.Error:
        pass


def ensure_ready() -> None:
    """Run the schema init once per process (cheap guard for hot paths)."""
    global _ready
    if not _ready:
        init_db()


def get_conn() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=10000")
    if _fast_sync:
        conn.execute("PRAGMA synchronous=OFF")
    return conn


def init_db() -> None:
    """Create the schema (idempotent) and seed sources/categories."""
    with get_conn() as conn:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS gallery_meta(
              key TEXT PRIMARY KEY, value TEXT);

            CREATE TABLE IF NOT EXISTS sources(
              id TEXT PRIMARY KEY, label TEXT, parser TEXT,
              schema_version INTEGER DEFAULT 1, config_json TEXT, created_at TEXT);

            CREATE TABLE IF NOT EXISTS items(
              id INTEGER PRIMARY KEY,
              uid TEXT UNIQUE NOT NULL,
              source TEXT NOT NULL,
              kind TEXT DEFAULT 'image',
              path TEXT, rel_path TEXT,
              alias_path TEXT,
              album_id INTEGER,
              mtime REAL, file_size INTEGER,
              width INTEGER, height INTEGER,
              state TEXT DEFAULT 'active',
              archive_expires_at REAL,
              parent_id INTEGER REFERENCES items(id),
              variant TEXT,
              prompt TEXT, negative_prompt TEXT, infotext TEXT,
              tags_text TEXT DEFAULT '',
              meta_json TEXT DEFAULT '{}',
              sha256 TEXT,
              indexed_at TEXT, updated_at TEXT);

            CREATE INDEX IF NOT EXISTS idx_items_source ON items(source);
            CREATE INDEX IF NOT EXISTS idx_items_state ON items(state, archive_expires_at);
            CREATE INDEX IF NOT EXISTS idx_items_mtime ON items(mtime DESC);
            CREATE INDEX IF NOT EXISTS idx_items_size ON items(width, height);
            CREATE INDEX IF NOT EXISTS idx_items_path ON items(path COLLATE NOCASE);
            CREATE INDEX IF NOT EXISTS idx_items_alias ON items(alias_path COLLATE NOCASE);
            CREATE INDEX IF NOT EXISTS idx_items_parent ON items(parent_id);

            CREATE TABLE IF NOT EXISTS tag_categories(
              id TEXT PRIMARY KEY, name TEXT, cardinality TEXT,
              kind TEXT, color TEXT, sort_order INTEGER DEFAULT 0);

            CREATE TABLE IF NOT EXISTS tags(
              id INTEGER PRIMARY KEY,
              category_id TEXT REFERENCES tag_categories(id),
              name TEXT NOT NULL, color TEXT, created_at TEXT,
              UNIQUE(category_id, name COLLATE NOCASE));

            CREATE TABLE IF NOT EXISTS item_tags(
              item_id INTEGER REFERENCES items(id) ON DELETE CASCADE,
              tag_id INTEGER REFERENCES tags(id),
              category_id TEXT,
              single INTEGER DEFAULT 0,
              source TEXT DEFAULT 'user',
              score REAL,
              tagged_at TEXT,
              PRIMARY KEY(item_id, tag_id, source));

            CREATE UNIQUE INDEX IF NOT EXISTS idx_one_single_per_category
              ON item_tags(item_id, category_id) WHERE single = 1;
            CREATE INDEX IF NOT EXISTS idx_item_tags_tag ON item_tags(tag_id);

            CREATE TABLE IF NOT EXISTS state_events(
              id INTEGER PRIMARY KEY, item_id INTEGER,
              event TEXT, at TEXT, payload_json TEXT);
            CREATE INDEX IF NOT EXISTS idx_state_events_item ON state_events(item_id, id DESC);

            CREATE TABLE IF NOT EXISTS composer_states(
              item_id INTEGER PRIMARY KEY, blob BLOB,
              schema_version INTEGER, updated_at TEXT);

            CREATE TABLE IF NOT EXISTS saved_views(
              id INTEGER PRIMARY KEY, name TEXT UNIQUE,
              filter_json TEXT, sort_json TEXT, created_at TEXT);

            CREATE TABLE IF NOT EXISTS albums(
              id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
              created_at TEXT, bundled_at TEXT, bundle_path TEXT,
              bundle_size INTEGER, bundle_count INTEGER, bundle_sha256 TEXT);

            CREATE TABLE IF NOT EXISTS legacy_keys(
              legacy_key TEXT PRIMARY KEY, item_id INTEGER);
            CREATE INDEX IF NOT EXISTS idx_legacy_item ON legacy_keys(item_id);

            CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
              prompt, negative_prompt, infotext, tags_text, uid UNINDEXED);
            """
        )
        # migrations for pre-existing DBs (CREATE TABLE IF NOT EXISTS won't alter)
        item_cols = {row[1] for row in conn.execute("PRAGMA table_info(items)").fetchall()}
        if "album_id" not in item_cols:
            conn.execute("ALTER TABLE items ADD COLUMN album_id INTEGER")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_items_album ON items(album_id)")
        _backfill_engine_keys(conn)
        _seed(conn)
        conn.commit()
    global _ready
    _ready = True


def _backfill_engine_keys(conn: sqlite3.Connection) -> None:
    """One-time: map the canonical engine key for qwen/krea2 items.

    The desktop gallery and SD Lite archive/trash tables key engine outputs as
    <engine>-outputs-<engine>-<date>-<time>-<stem>; v2 action routing resolves
    legacy keys, so every engine item needs that mapping.
    """
    try:
        flag = conn.execute(
            "SELECT value FROM gallery_meta WHERE key='engine_keys_backfilled'"
        ).fetchone()
    except sqlite3.Error:
        return
    if flag:
        return
    for row in conn.execute(
        "SELECT id, source, rel_path FROM items WHERE source IN ('qwen','krea2')"
    ).fetchall():
        rel = (row[2] or "").replace("\\", "/")
        parts = [p for p in rel.split("/") if p]
        if len(parts) < 3:
            continue
        parts[-1] = os.path.splitext(parts[-1])[0]
        key = row[1] + "-" + "-".join(p.lower() for p in parts)
        conn.execute(
            "INSERT OR REPLACE INTO legacy_keys(legacy_key, item_id) VALUES (?,?)",
            (key, int(row[0])),
        )
    conn.execute(
        "INSERT OR REPLACE INTO gallery_meta(key, value) VALUES ('engine_keys_backfilled', '1')"
    )


def _seed(conn: sqlite3.Connection) -> None:
    now = _now_iso()
    for sid, label, parser, config in DEFAULT_SOURCES:
        conn.execute(
            "INSERT OR IGNORE INTO sources(id, label, parser, schema_version, config_json, created_at) "
            "VALUES (?,?,?,1,?,?)",
            (sid, label, parser, config, now),
        )
    for cid, name, cardinality, kind, color, order in DEFAULT_CATEGORIES:
        conn.execute(
            "INSERT OR IGNORE INTO tag_categories(id, name, cardinality, kind, color, sort_order) "
            "VALUES (?,?,?,?,?,?)",
            (cid, name, cardinality, kind, color, order),
        )
    for name, color in RATING_TAGS:
        _ensure_tag(conn, RATING_CATEGORY, name, color=color)
    conn.execute(
        "INSERT OR IGNORE INTO gallery_meta(key, value) VALUES ('schema_version', '1')"
    )


def _ensure_tag(conn: sqlite3.Connection, category_id: str, name: str, color: str | None = None) -> int:
    row = conn.execute(
        "SELECT id FROM tags WHERE category_id=? AND name=? COLLATE NOCASE",
        (category_id, name),
    ).fetchone()
    if row:
        return int(row[0])
    cur = conn.execute(
        "INSERT INTO tags(category_id, name, color, created_at) VALUES (?,?,?,?)",
        (category_id, name, color, _now_iso()),
    )
    return int(cur.lastrowid)


def make_uid(source: str, rel_path: str) -> str:
    """uid = source + ':' + lower(rel_path without extension), posix separators."""
    rel = str(rel_path or "").replace("\\", "/")
    stem = os.path.splitext(rel)[0]
    return f"{source}:{stem.lower()}"


# ---------------------------------------------------------------------------
# sources / categories / tags
# ---------------------------------------------------------------------------

def get_sources() -> list:
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM sources ORDER BY id").fetchall()
        return [dict(r) for r in rows]


def get_categories() -> list:
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM tag_categories ORDER BY sort_order, id").fetchall()
        return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# items
# ---------------------------------------------------------------------------

_UPSERT_FIELDS = (
    "source", "kind", "path", "rel_path", "alias_path", "mtime", "file_size",
    "width", "height", "prompt", "negative_prompt", "infotext", "sha256", "variant",
)


def upsert_item(uid=None, source="txt2img", rel_path=None, path=None, **fields) -> int:
    """Insert or refresh an item row. Never overwrites state or archive TTL."""
    ensure_ready()
    if not uid:
        uid = make_uid(source, rel_path or path or "")
    values = {}
    if rel_path is not None:
        values["rel_path"] = rel_path
    if path is not None:
        values["path"] = path
    for k in _UPSERT_FIELDS:
        if k in fields:
            values[k] = fields[k]
    values["source"] = source
    meta = fields.get("meta")
    if meta is not None:
        values["meta_json"] = json.dumps(meta, ensure_ascii=False, separators=(",", ":"))
    now = _now_iso()

    with get_conn() as conn:
        row = conn.execute("SELECT id FROM items WHERE uid=?", (uid,)).fetchone()
        if row:
            item_id = int(row[0])
            sets = [f"{k}=?" for k in values]
            params = list(values.values())
            sets.append("updated_at=?")
            params.append(now)
            params.append(item_id)
            conn.execute(f"UPDATE items SET {', '.join(sets)} WHERE id=?", params)
        else:
            item_id = _insert_item(conn, uid, values, now)
        if "parent_uid" in fields and fields["parent_uid"]:
            parent = conn.execute("SELECT id FROM items WHERE uid=?", (fields["parent_uid"],)).fetchone()
            if parent:
                conn.execute("UPDATE items SET parent_id=? WHERE id=?", (int(parent[0]), item_id))
        _refresh_fts(conn, item_id)
        conn.commit()
    return item_id


def _insert_item(conn: sqlite3.Connection, uid: str, values: dict, now: str) -> int:
    columns = ["uid"] + list(values.keys()) + ["state", "indexed_at", "updated_at"]
    params = [uid] + list(values.values()) + ["active", now, now]
    placeholders = ",".join("?" * len(columns))
    cur = conn.execute(
        f"INSERT INTO items({','.join(columns)}) VALUES ({placeholders})", params
    )
    return int(cur.lastrowid)


def update_item_meta(item_id: int, meta: dict) -> None:
    with get_conn() as conn:
        conn.execute(
            "UPDATE items SET meta_json=?, updated_at=? WHERE id=?",
            (json.dumps(meta, ensure_ascii=False, separators=(",", ":")), _now_iso(), item_id),
        )
        conn.commit()


def get_item(item_id: int):
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM items WHERE id=?", (int(item_id),)).fetchone()
        return dict(row) if row else None


def get_item_meta(item_id: int) -> dict:
    item = get_item(item_id)
    if not item:
        return {}
    try:
        return json.loads(item.get("meta_json") or "{}")
    except Exception:
        return {}


def get_item_by_path(path: str):
    if not path:
        return None
    norm = str(path).replace("/", os.sep)
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM items WHERE path=? COLLATE NOCASE OR alias_path=? COLLATE NOCASE LIMIT 1",
            (norm, norm),
        ).fetchone()
        return dict(row) if row else None


def map_legacy_key(legacy_key: str, item_id: int) -> None:
    if not legacy_key:
        return
    with get_conn() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO legacy_keys(legacy_key, item_id) VALUES (?,?)",
            (str(legacy_key).lower(), int(item_id)),
        )
        conn.commit()


def resolve_item_id(key) -> int | None:
    """Resolve any historic handle (uid, legacy item_key, path) to an item id."""
    if key is None or key == "":
        return None
    if isinstance(key, int):
        return key
    key = str(key).strip()
    if key.isdigit():
        with get_conn() as conn:
            row = conn.execute("SELECT id FROM items WHERE id=?", (int(key),)).fetchone()
            if row:
                return int(row[0])
    lowered = key.lower()
    with get_conn() as conn:
        row = conn.execute("SELECT id FROM items WHERE uid=? LIMIT 1", (lowered,)).fetchone()
        if row:
            return int(row[0])
        row = conn.execute(
            "SELECT item_id FROM legacy_keys WHERE legacy_key=? LIMIT 1", (lowered,)
        ).fetchone()
        if row:
            return int(row[0])
        norm = key.replace("/", os.sep)
        row = conn.execute(
            "SELECT id FROM items WHERE path=? COLLATE NOCASE OR alias_path=? COLLATE NOCASE LIMIT 1",
            (norm, norm),
        ).fetchone()
        if row:
            return int(row[0])
    return None


def set_item_path(item_id: int, path: str, mtime: float | None = None) -> None:
    with get_conn() as conn:
        if mtime is None:
            conn.execute("UPDATE items SET path=?, updated_at=? WHERE id=?", (path, _now_iso(), int(item_id)))
        else:
            conn.execute(
                "UPDATE items SET path=?, mtime=?, updated_at=? WHERE id=?",
                (path, float(mtime), _now_iso(), int(item_id)),
            )
        conn.commit()


def set_item_alias(item_id: int, alias_path: str | None) -> None:
    with get_conn() as conn:
        conn.execute(
            "UPDATE items SET alias_path=?, updated_at=? WHERE id=?",
            (alias_path, _now_iso(), int(item_id)),
        )
        conn.commit()


def set_sha256(item_id: int, sha256: str) -> None:
    with get_conn() as conn:
        conn.execute("UPDATE items SET sha256=? WHERE id=?", (sha256, int(item_id)))
        conn.commit()


def delete_item(item_id: int) -> None:
    with get_conn() as conn:
        conn.execute("DELETE FROM item_tags WHERE item_id=?", (int(item_id),))
        conn.execute("DELETE FROM legacy_keys WHERE item_id=?", (int(item_id),))
        conn.execute("DELETE FROM items_fts WHERE rowid=?", (int(item_id),))
        conn.execute("DELETE FROM items WHERE id=?", (int(item_id),))
        conn.commit()


# ---------------------------------------------------------------------------
# state machine
# ---------------------------------------------------------------------------

def set_state(item_id: int, state: str, ttl_hours: float | None = None,
              event: str | None = None, payload: dict | None = None,
              drop_media: bool = True) -> None:
    """Move an item through the state machine and log a state event.

    archive TTL: archived items receive archive_expires_at = now + ttl (24 h
    default). Endorsed items are protected by the lifecycle sweeper, which
    refreshes their expiry instead of trashing them.
    """
    if state not in VALID_STATES:
        raise ValueError(f"invalid state: {state}")
    ttl = DEFAULT_ARCHIVE_TTL_HOURS if ttl_hours is None else float(ttl_hours)
    now_wall = time.time()
    expires = now_wall + ttl * 3600.0 if state == "archived" else None
    with get_conn() as conn:
        conn.execute(
            "UPDATE items SET state=?, archive_expires_at=?, updated_at=? WHERE id=?",
            (state, expires, _now_iso(), int(item_id)),
        )
        conn.execute(
            "INSERT INTO state_events(item_id, event, at, payload_json) VALUES (?,?,?,?)",
            (int(item_id), event or state, _now_iso(),
             json.dumps(payload, ensure_ascii=False) if payload else None),
        )
        conn.commit()

    if drop_media:
        from modules import gallery_blobs
        try:
            if state == "trashed":
                gallery_blobs.get_store().delete(item_id)
            elif state == "archived":
                # media policy: archived keeps the thumb, drops the preview
                gallery_blobs.get_store().delete(item_id, kinds=("preview",))
        except Exception:
            pass


def refresh_archive_ttl(item_id: int, ttl_hours: float | None = None) -> None:
    ttl = DEFAULT_ARCHIVE_TTL_HOURS if ttl_hours is None else float(ttl_hours)
    with get_conn() as conn:
        conn.execute(
            "UPDATE items SET archive_expires_at=? WHERE id=?",
            (time.time() + ttl * 3600.0, int(item_id)),
        )
        conn.commit()


def get_states(item_ids: list) -> dict:
    if not item_ids:
        return {}
    ids = [int(i) for i in item_ids]
    result = {}
    with get_conn() as conn:
        for chunk in _chunks(ids, 500):
            ph = ",".join("?" * len(chunk))
            rows = conn.execute(
                f"SELECT id, state, archive_expires_at FROM items WHERE id IN ({ph})", chunk
            ).fetchall()
            for r in rows:
                result[int(r[0])] = {
                    "state": r[1],
                    "archive_expires_at": r[2],
                }
    return result


def add_state_event(item_id: int, event: str, payload: dict | None = None) -> None:
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO state_events(item_id, event, at, payload_json) VALUES (?,?,?,?)",
            (int(item_id), event, _now_iso(),
             json.dumps(payload, ensure_ascii=False) if payload else None),
        )
        conn.commit()


def get_state_events(item_id: int, limit: int = 50) -> list:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM state_events WHERE item_id=? ORDER BY id DESC LIMIT ?",
            (int(item_id), int(limit)),
        ).fetchall()
        return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# tags
# ---------------------------------------------------------------------------

def set_rating(item_id: int, rating: str | None, source: str = "user") -> None:
    """Single-select composite rating (endorsed | disliked | None)."""
    item_id = int(item_id)
    with get_conn() as conn:
        conn.execute("DELETE FROM item_tags WHERE item_id=? AND category_id=?", (item_id, RATING_CATEGORY))
        if rating:
            tag_id = _ensure_tag(conn, RATING_CATEGORY, str(rating))
            conn.execute(
                "INSERT INTO item_tags(item_id, tag_id, category_id, single, source, tagged_at) "
                "VALUES (?,?,?,1,?,?)",
                (item_id, tag_id, RATING_CATEGORY, source, _now_iso()),
            )
        _refresh_fts(conn, item_id)
        conn.commit()


def get_rating(item_id: int) -> str | None:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT t.name FROM item_tags it JOIN tags t ON t.id=it.tag_id "
            "WHERE it.item_id=? AND it.category_id=? LIMIT 1",
            (int(item_id), RATING_CATEGORY),
        ).fetchone()
        return row[0] if row else None


def add_tag(item_id: int, category_id: str, name: str, source: str = "user",
            score: float | None = None, single: bool = False) -> None:
    name = str(name or "").strip()
    if not name:
        return
    item_id = int(item_id)
    with get_conn() as conn:
        cat = conn.execute(
            "SELECT cardinality FROM tag_categories WHERE id=?", (category_id,)
        ).fetchone()
        is_single = bool(single or (cat and cat[0] == "single"))
        if is_single:
            conn.execute(
                "DELETE FROM item_tags WHERE item_id=? AND category_id=?", (item_id, category_id)
            )
        tag_id = _ensure_tag(conn, category_id, name)
        conn.execute(
            "INSERT OR REPLACE INTO item_tags(item_id, tag_id, category_id, single, source, score, tagged_at) "
            "VALUES (?,?,?,?,?,?,?)",
            (item_id, tag_id, category_id, 1 if is_single else 0, source, score, _now_iso()),
        )
        _refresh_fts(conn, item_id)
        conn.commit()


def remove_tag(item_id: int, category_id: str, name: str, source: str | None = None) -> None:
    item_id = int(item_id)
    with get_conn() as conn:
        row = conn.execute(
            "SELECT id FROM tags WHERE category_id=? AND name=? COLLATE NOCASE",
            (category_id, name),
        ).fetchone()
        if not row:
            return
        if source:
            conn.execute(
                "DELETE FROM item_tags WHERE item_id=? AND tag_id=? AND source=?",
                (item_id, int(row[0]), source),
            )
        else:
            conn.execute(
                "DELETE FROM item_tags WHERE item_id=? AND tag_id=?",
                (item_id, int(row[0])),
            )
        _refresh_fts(conn, item_id)
        conn.commit()


def save_captions(item_id: int, tags_dict: dict, source: str = "deepbooru") -> None:
    """Replace auto-caption tags for an item (captions category, scored)."""
    item_id = int(item_id)
    with get_conn() as conn:
        conn.execute(
            "DELETE FROM item_tags WHERE item_id=? AND category_id=?", (item_id, CAPTIONS_CATEGORY)
        )
        for tag, score in (tags_dict or {}).items():
            tag = str(tag or "").strip()
            if not tag:
                continue
            try:
                score_val = float(score or 0)
            except (TypeError, ValueError):
                score_val = 0.0
            tag_id = _ensure_tag(conn, CAPTIONS_CATEGORY, tag)
            conn.execute(
                "INSERT OR REPLACE INTO item_tags(item_id, tag_id, category_id, single, source, score, tagged_at) "
                "VALUES (?,?,?,0,?,?,?)",
                (item_id, tag_id, CAPTIONS_CATEGORY, source, score_val, _now_iso()),
            )
        _refresh_fts(conn, item_id)
        conn.commit()


def save_captions_many(pairs: list, source: str = "deepbooru") -> int:
    """Batched caption import: pairs = [(item_id, {tag: score}), ...]."""
    if not pairs:
        return 0
    count = 0
    with get_conn() as conn:
        for item_id, tags_dict in pairs:
            item_id = int(item_id)
            conn.execute(
                "DELETE FROM item_tags WHERE item_id=? AND category_id=?",
                (item_id, CAPTIONS_CATEGORY),
            )
            rows = []
            for tag, score in (tags_dict or {}).items():
                tag = str(tag or "").strip()
                if not tag:
                    continue
                try:
                    score_val = float(score or 0)
                except (TypeError, ValueError):
                    score_val = 0.0
                tag_id = _ensure_tag(conn, CAPTIONS_CATEGORY, tag)
                rows.append((item_id, tag_id, CAPTIONS_CATEGORY, source, score_val, _now_iso()))
            if rows:
                conn.executemany(
                    "INSERT OR REPLACE INTO item_tags(item_id, tag_id, category_id, single, source, score, tagged_at) "
                    "VALUES (?,?,?,0,?,?,?)",
                    rows,
                )
                count += len(rows)
            _refresh_fts(conn, item_id)
        conn.commit()
    return count


def get_tags(item_ids: list, categories: list | None = None) -> dict:
    """Batched tag fetch: {item_id: [{category, name, source, score}]}."""
    if not item_ids:
        return {}
    result = {}
    ids = [int(i) for i in item_ids]
    with get_conn() as conn:
        for chunk in _chunks(ids, 500):
            ph = ",".join("?" * len(chunk))
            sql = (
                "SELECT it.item_id, it.category_id, t.name, it.source, it.score "
                f"FROM item_tags it JOIN tags t ON t.id=it.tag_id WHERE it.item_id IN ({ph})"
            )
            params = list(chunk)
            if categories:
                cph = ",".join("?" * len(categories))
                sql += f" AND it.category_id IN ({cph})"
                params += list(categories)
            sql += " ORDER BY it.category_id, t.name"
            for r in conn.execute(sql, params).fetchall():
                result.setdefault(int(r[0]), []).append(
                    {"category": r[1], "name": r[2], "source": r[3], "score": r[4]}
                )
    return result


def top_tags(category_id: str, limit: int = 50, min_count: int = 1) -> list:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT t.name, COUNT(*) AS n FROM item_tags it JOIN tags t ON t.id=it.tag_id "
            "WHERE it.category_id=? GROUP BY t.id HAVING n>=? ORDER BY n DESC LIMIT ?",
            (category_id, int(min_count), int(limit)),
        ).fetchall()
        return [{"name": r[0], "count": int(r[1])} for r in rows]


def category_tag_count(category_id: str) -> int:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT COUNT(DISTINCT tag_id) FROM item_tags WHERE category_id=?", (category_id,)
        ).fetchone()
        return int(row[0] or 0)


def _refresh_fts(conn: sqlite3.Connection, item_id: int) -> None:
    row = conn.execute(
        "SELECT id, uid, prompt, negative_prompt, infotext FROM items WHERE id=?",
        (int(item_id),),
    ).fetchone()
    if not row:
        return
    tags_rows = conn.execute(
        "SELECT t.name FROM item_tags it JOIN tags t ON t.id=it.tag_id WHERE it.item_id=?",
        (int(item_id),),
    ).fetchall()
    tags_text = " ".join(r[0] for r in tags_rows if r[0])
    conn.execute("UPDATE items SET tags_text=? WHERE id=?", (tags_text, int(item_id)))
    conn.execute("DELETE FROM items_fts WHERE rowid=?", (int(item_id),))
    conn.execute(
        "INSERT INTO items_fts(rowid, prompt, negative_prompt, infotext, tags_text, uid) "
        "VALUES (?,?,?,?,?,?)",
        (int(item_id), row[2] or "", row[3] or "", row[4] or "", tags_text, row[1] or ""),
    )


# ---------------------------------------------------------------------------
# composer states / saved views / stats
# ---------------------------------------------------------------------------

def put_composer_state(item_id: int, data, schema_version: int = 1) -> None:
    """Store zlib-compressed composer JSON for an item (str or dict)."""
    if isinstance(data, (dict, list)):
        payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
    else:
        payload = str(data or "").encode("utf-8")
    blob = zlib.compress(payload, 6)
    with get_conn() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO composer_states(item_id, blob, schema_version, updated_at) "
            "VALUES (?,?,?,?)",
            (int(item_id), blob, int(schema_version), _now_iso()),
        )
        conn.commit()


def get_composer_state(item_id: int) -> str | None:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT blob FROM composer_states WHERE item_id=?", (int(item_id),)
        ).fetchone()
    if not row or row[0] is None:
        return None
    try:
        return zlib.decompress(row[0]).decode("utf-8")
    except Exception:
        return None


def has_composer_state(item_ids: list) -> set:
    if not item_ids:
        return set()
    found = set()
    ids = [int(i) for i in item_ids]
    with get_conn() as conn:
        for chunk in _chunks(ids, 500):
            ph = ",".join("?" * len(chunk))
            for r in conn.execute(
                f"SELECT item_id FROM composer_states WHERE item_id IN ({ph})", chunk
            ).fetchall():
                found.add(int(r[0]))
    return found


def save_view(name: str, filter_json: str, sort_json: str = "") -> None:
    with get_conn() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO saved_views(name, filter_json, sort_json, created_at) "
            "VALUES (?,?,?,?)",
            (name, filter_json, sort_json, _now_iso()),
        )
        conn.commit()


def list_views() -> list:
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM saved_views ORDER BY name").fetchall()
        return [dict(r) for r in rows]


def delete_view(name: str) -> None:
    with get_conn() as conn:
        conn.execute("DELETE FROM saved_views WHERE name=?", (name,))
        conn.commit()


# ---------------------------------------------------------------------------
# albums
# ---------------------------------------------------------------------------

def create_album(name: str) -> int:
    """Create an album. Raises ValueError when the name is empty or taken."""
    name = str(name or "").strip()
    if not name:
        raise ValueError("album name required")
    name = name[:80]
    with get_conn() as conn:
        row = conn.execute("SELECT id FROM albums WHERE name=? COLLATE NOCASE", (name,)).fetchone()
        if row:
            raise ValueError("album already exists")
        cur = conn.execute(
            "INSERT INTO albums(name, created_at) VALUES (?,?)", (name, _now_iso())
        )
        conn.commit()
        return int(cur.lastrowid)


def get_album(album_id=None, name=None):
    with get_conn() as conn:
        if album_id is not None:
            row = conn.execute("SELECT * FROM albums WHERE id=?", (int(album_id),)).fetchone()
        else:
            row = conn.execute(
                "SELECT * FROM albums WHERE name=? COLLATE NOCASE", (str(name or "").strip(),)
            ).fetchone()
        return dict(row) if row else None


def list_albums() -> list:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT a.*, (SELECT COUNT(*) FROM items i "
            " WHERE i.album_id=a.id AND i.state != 'trashed') AS count "
            "FROM albums a ORDER BY a.name COLLATE NOCASE"
        ).fetchall()
        return [dict(r) for r in rows]


def rename_album(album_id: int, name: str) -> None:
    name = str(name or "").strip()
    if not name:
        raise ValueError("album name required")
    with get_conn() as conn:
        dup = conn.execute(
            "SELECT id FROM albums WHERE name=? COLLATE NOCASE AND id!=?",
            (name[:80], int(album_id)),
        ).fetchone()
        if dup:
            raise ValueError("album name already exists")
        conn.execute("UPDATE albums SET name=? WHERE id=?", (name[:80], int(album_id)))
        conn.commit()


def delete_album(album_id: int) -> None:
    """Delete an album and clear its memberships. Caller must guard bundles."""
    with get_conn() as conn:
        conn.execute(
            "UPDATE items SET album_id=NULL, updated_at=? WHERE album_id=?",
            (_now_iso(), int(album_id)),
        )
        conn.execute("DELETE FROM albums WHERE id=?", (int(album_id),))
        conn.commit()


def set_item_album(item_id: int, album_id) -> None:
    with get_conn() as conn:
        conn.execute(
            "UPDATE items SET album_id=?, updated_at=? WHERE id=?",
            (album_id, _now_iso(), int(item_id)),
        )
        conn.commit()


def set_album_bundle(album_id: int, bundle_path: str, size: int, count: int,
                     sha256: str | None = None) -> None:
    with get_conn() as conn:
        conn.execute(
            "UPDATE albums SET bundled_at=?, bundle_path=?, bundle_size=?, bundle_count=?, "
            "bundle_sha256=? WHERE id=?",
            (_now_iso(), bundle_path, int(size), int(count), sha256, int(album_id)),
        )
        conn.commit()


def clear_album_bundle(album_id: int) -> None:
    with get_conn() as conn:
        conn.execute(
            "UPDATE albums SET bundled_at=NULL, bundle_path=NULL, bundle_size=NULL, "
            "bundle_count=NULL, bundle_sha256=NULL WHERE id=?",
            (int(album_id),),
        )
        conn.commit()


def album_items(album_id: int) -> list:
    """Full item rows for an album, oldest first."""
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM items WHERE album_id=? ORDER BY id", (int(album_id),)
        ).fetchall()
        return [dict(r) for r in rows]


def album_item_ids(album_id: int) -> list:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id FROM items WHERE album_id=? ORDER BY id", (int(album_id),)
        ).fetchall()
        return [int(r[0]) for r in rows]


def state_counts() -> dict:
    with get_conn() as conn:
        rows = conn.execute("SELECT state, COUNT(*) FROM items GROUP BY state").fetchall()
        return {r[0]: int(r[1]) for r in rows}


def source_counts() -> list:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT source, COUNT(*) AS n, SUM(COALESCE(file_size,0)) AS bytes "
            "FROM items GROUP BY source ORDER BY n DESC"
        ).fetchall()
        return [{"source": r[0], "count": int(r[1]), "bytes": int(r[2] or 0)} for r in rows]


def stats() -> dict:
    with get_conn() as conn:
        total = conn.execute("SELECT COUNT(*) FROM items").fetchone()[0]
        size = conn.execute("SELECT COALESCE(SUM(file_size),0) FROM items").fetchone()[0]
    return {"items": int(total), "bytes": int(size)}


def _chunks(seq: list, size: int):
    for i in range(0, len(seq), size):
        yield seq[i:i + size]
