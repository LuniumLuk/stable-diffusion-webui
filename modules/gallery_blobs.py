"""Gallery v2 blob store (cache/gallery_blobs.db) - derived, regenerable.

One SQLite file bundles every thumbnail/preview so the gallery stops writing
thousands of loose webp files. Rows are keyed by item id (not path+mtime), so
moves never invalidate blobs.

The store is intentionally behind a tiny interface (put/get/delete/sweep) so a
pack-shard backend can replace it at scale without touching callers.

Media policy (user principle 2026-10-10):
  active   -> thumb + preview
  staged   -> thumb + preview
  archived -> thumb only (preview dropped; TTL auto-trash)
  trashed  -> no media at all
"""

import io
import os
import sqlite3
import time
import zlib

from modules import gallery_db

ROOT = gallery_db._ROOT
BLOB_DB_PATH = os.environ.get("GALLERY_BLOB_DB_PATH") or os.path.join(ROOT, "cache", "gallery_blobs.db")

THUMB_PX = 192
PREVIEW_PX = 1024
THUMB_QUALITY = 72
PREVIEW_QUALITY = 88

KIND_THUMB = "thumb"
KIND_PREVIEW = "preview"
KIND_NET = "net_variant"

MEDIA_POLICY = {
    "active": (KIND_THUMB, KIND_PREVIEW),
    "staged": (KIND_THUMB, KIND_PREVIEW),
    "archived": (KIND_THUMB,),
    "trashed": (),
}

_store = None
_fast_sync = False


def set_fast_sync(enabled: bool) -> None:
    global _fast_sync
    _fast_sync = bool(enabled)
    if enabled:
        try:
            with sqlite3.connect(BLOB_DB_PATH, timeout=60) as conn:
                conn.execute("PRAGMA journal_mode=MEMORY")
                conn.execute("PRAGMA synchronous=OFF")
        except sqlite3.Error:
            pass


def restore_journal_mode() -> None:
    try:
        with sqlite3.connect(BLOB_DB_PATH, timeout=60) as conn:
            conn.execute("PRAGMA journal_mode=WAL")
    except sqlite3.Error:
        pass


def get_store() -> "BlobStore":
    global _store
    if _store is None or _store.path != BLOB_DB_PATH:
        _store = BlobStore(BLOB_DB_PATH)
        _store.init()
    return _store


class BlobStore:
    def __init__(self, path: str = BLOB_DB_PATH):
        self.path = path

    def _conn(self) -> sqlite3.Connection:
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        conn = sqlite3.connect(self.path, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout=10000")
        if _fast_sync:
            conn.execute("PRAGMA synchronous=OFF")
        return conn

    def init(self) -> None:
        with self._conn() as conn:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS blobs(
                  id INTEGER PRIMARY KEY, item_id INTEGER,
                  kind TEXT, format TEXT, width INTEGER, height INTEGER,
                  size INTEGER, crc32 INTEGER, data BLOB, created_at TEXT)
                """
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_blobs_item ON blobs(item_id, kind)")
            conn.commit()

    def put(self, item_id: int, kind: str, data: bytes, fmt: str = "webp",
            width: int | None = None, height: int | None = None) -> None:
        payload = bytes(data)
        with self._conn() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO blobs(item_id, kind, format, width, height, size, crc32, data, created_at) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                (int(item_id), kind, fmt, width, height, len(payload),
                 zlib.crc32(payload) & 0xFFFFFFFF, payload,
                 time.strftime("%Y-%m-%dT%H:%M:%S")),
            )
            conn.commit()

    def has(self, item_id: int, kind: str) -> bool:
        with self._conn() as conn:
            row = conn.execute(
                "SELECT 1 FROM blobs WHERE item_id=? AND kind=? LIMIT 1", (int(item_id), kind)
            ).fetchone()
            return bool(row)

    def get_row(self, item_id: int, kind: str):
        with self._conn() as conn:
            row = conn.execute(
                "SELECT * FROM blobs WHERE item_id=? AND kind=? LIMIT 1", (int(item_id), kind)
            ).fetchone()
            return dict(row) if row else None

    def get_data(self, item_id: int, kind: str) -> bytes | None:
        with self._conn() as conn:
            row = conn.execute(
                "SELECT data FROM blobs WHERE item_id=? AND kind=? LIMIT 1", (int(item_id), kind)
            ).fetchone()
            return bytes(row[0]) if row and row[0] is not None else None

    def delete(self, item_id: int, kinds: tuple | None = None) -> int:
        with self._conn() as conn:
            if kinds:
                ph = ",".join("?" * len(kinds))
                cur = conn.execute(
                    f"DELETE FROM blobs WHERE item_id=? AND kind IN ({ph})", (int(item_id),) + tuple(kinds)
                )
            else:
                cur = conn.execute("DELETE FROM blobs WHERE item_id=?", (int(item_id),))
            conn.commit()
            return int(cur.rowcount or 0)

    def enforce_policy(self, item_id: int, state: str) -> int:
        allowed = set(MEDIA_POLICY.get(state, ()))
        deleted = 0
        for kind in (KIND_THUMB, KIND_PREVIEW, KIND_NET):
            if kind not in allowed:
                deleted += self.delete(item_id, kinds=(kind,))
        return deleted

    def stats(self) -> dict:
        with self._conn() as conn:
            row = conn.execute(
                "SELECT COUNT(*), COALESCE(SUM(size),0) FROM blobs"
            ).fetchone()
            kinds = conn.execute(
                "SELECT kind, COUNT(*), COALESCE(SUM(size),0) FROM blobs GROUP BY kind"
            ).fetchall()
        return {
            "rows": int(row[0]), "bytes": int(row[1]),
            "kinds": {r[0]: {"rows": int(r[1]), "bytes": int(r[2])} for r in kinds},
        }

    def count_covered(self, item_ids: list, kind: str = KIND_THUMB) -> int:
        if not item_ids:
            return 0
        covered = 0
        with self._conn() as conn:
            for chunk in _chunks([int(i) for i in item_ids], 500):
                ph = ",".join("?" * len(chunk))
                covered += conn.execute(
                    f"SELECT COUNT(DISTINCT item_id) FROM blobs WHERE kind=? AND item_id IN ({ph})",
                    [kind] + chunk,
                ).fetchone()[0]
        return int(covered)

    def sweep(self, item_states: dict) -> int:
        """Delete blobs whose item is gone or whose kind its state may not hold.

        item_states: {item_id: state} for items that still exist.
        """
        deleted = 0
        with self._conn() as conn:
            rows = conn.execute("SELECT id, item_id, kind FROM blobs").fetchall()
            drop = []
            for r in rows:
                item_id, kind = int(r[1]), r[2]
                state = item_states.get(item_id)
                if state is None or kind not in set(MEDIA_POLICY.get(state, ())):
                    drop.append(int(r[0]))
            for chunk in _chunks(drop, 500):
                ph = ",".join("?" * len(chunk))
                conn.execute(f"DELETE FROM blobs WHERE id IN ({ph})", chunk)
            conn.commit()
        return len(drop)


def _chunks(seq, size):
    for i in range(0, len(seq), size):
        yield seq[i:i + size]


# ---------------------------------------------------------------------------
# generation helpers (shared by the desktop + lite galleries and the migrator)
# ---------------------------------------------------------------------------

def render_bytes(src_path: str, kind: str) -> tuple[bytes, int, int] | None:
    """Create a webp thumb/preview from an image file. Returns (data, w, h)."""
    from PIL import Image
    max_px = THUMB_PX if kind == KIND_THUMB else PREVIEW_PX
    quality = THUMB_QUALITY if kind == KIND_THUMB else PREVIEW_QUALITY
    try:
        with Image.open(src_path) as img:
            img.load()
            img.thumbnail((max_px, max_px))
            buf = io.BytesIO()
            img.save(buf, format="WEBP", quality=quality, method=5)
            return buf.getvalue(), img.width, img.height
    except Exception:
        return None


def ensure_blob(item_id: int, kind: str, src_path: str) -> bytes | None:
    """Return blob bytes, generating + storing from src_path on a miss."""
    store = get_store()
    data = store.get_data(item_id, kind)
    if data is not None:
        return data
    if not src_path or not os.path.isfile(src_path):
        return None
    rendered = render_bytes(src_path, kind)
    if not rendered:
        return None
    payload, w, h = rendered
    store.put(item_id, kind, payload, fmt="webp", width=w, height=h)
    return payload


def import_legacy_file(item_id: int, kind: str, file_path: str) -> bool:
    """Move an existing cache webp into the store (migration M3)."""
    try:
        with open(file_path, "rb") as f:
            payload = f.read()
    except OSError:
        return False
    if not payload:
        return False
    get_store().put(item_id, kind, payload, fmt="webp")
    try:
        os.remove(file_path)
    except OSError:
        pass
    return True
