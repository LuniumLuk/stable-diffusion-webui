"""Gallery v2 lifecycle: archive TTL sweeper + trash maintenance.

Media policy (user principle 2026-10-10):
  active    thumb + preview, original on disk
  archived  thumb only, original on disk, auto-trash after 24 h TTL
            (endorsed items are TTL-protected: their expiry is refreshed)
  trashed   no media at all - original/alias files deleted, blobs dropped,
            metadata kept for audit/insights until "Empty Trash"
"""

import os
import threading
import time

from modules import gallery_blobs, gallery_db


def trash_item(item_id: int, reason: str = "manual", delete_files: bool = True) -> dict:
    """Move an item to trash: delete files (original + hardlink alias), drop blobs."""
    item = gallery_db.get_item(item_id)
    if not item:
        return {"ok": False, "reason": "not_found"}
    deleted = 0
    errors = 0
    freed = 0
    seen_inodes = set()
    if delete_files:
        for path in (item.get("path"), item.get("alias_path")):
            if not path:
                continue
            try:
                stat = os.stat(path)
                inode = getattr(stat, "st_ino", None)
                if inode is not None and inode in seen_inodes:
                    continue
                if inode is not None:
                    seen_inodes.add(inode)
                size = stat.st_size
                os.remove(path)
                deleted += 1
                freed += size
            except OSError:
                pass
    gallery_db.set_state(item_id, "trashed", event="trash", payload={"reason": reason})
    blob_store = gallery_blobs.get_store()
    try:
        blob_store.delete(item_id)
    except Exception:
        errors += 1
    return {"ok": True, "deleted_files": deleted, "freed_bytes": freed, "errors": errors}


def unarchive(item_id: int) -> dict:
    item = gallery_db.get_item(item_id)
    if not item or item.get("state") != "archived":
        return {"ok": False, "reason": "not_archived"}
    gallery_db.set_state(item_id, "active", event="unarchive")
    return {"ok": True}


def restore_from_trash(item_id: int) -> dict:
    """Restore only possible while media still exists (pre-TTL states)."""
    item = gallery_db.get_item(item_id)
    if not item or item.get("state") != "trashed":
        return {"ok": False, "reason": "not_trashed"}
    path = item.get("path") or ""
    alias = item.get("alias_path") or ""
    if (path and os.path.isfile(path)) or (alias and os.path.isfile(alias)):
        gallery_db.set_state(item_id, "active", event="restore")
        return {"ok": True}
    return {"ok": False, "reason": "media_gone"}


def empty_trash(item_ids: list | None = None) -> int:
    """Delete trashed items entirely (metadata included). Returns rows removed."""
    with gallery_db.get_conn() as conn:
        if item_ids:
            ids = [int(i) for i in item_ids]
            ph = ",".join("?" * len(ids))
            rows = conn.execute(
                f"SELECT id FROM items WHERE state='trashed' AND id IN ({ph})", ids
            ).fetchall()
        else:
            rows = conn.execute("SELECT id FROM items WHERE state='trashed'").fetchall()
    count = 0
    for row in rows:
        gallery_db.delete_item(int(row[0]))
        count += 1
    return count


def enforce_trash_media() -> dict:
    """Guarantee 'trash holds zero media': delete lingering files + blobs."""
    deleted_files = 0
    blob_store = gallery_blobs.get_store()
    dropped = 0
    with gallery_db.get_conn() as conn:
        rows = conn.execute(
            "SELECT id, path, alias_path FROM items WHERE state='trashed'"
        ).fetchall()
    for row in rows:
        for path in (row[1], row[2]):
            if path and os.path.isfile(path):
                try:
                    os.remove(path)
                    deleted_files += 1
                except OSError:
                    pass
        dropped += blob_store.delete(int(row[0]))
    return {"files_deleted": deleted_files, "blobs_dropped": dropped}


def sweep(now: float | None = None, dry_run: bool = False) -> dict:
    """Archive TTL sweep: expired archived items -> trash; endorsed protected."""
    now = time.time() if now is None else float(now)
    report = {"expired": 0, "protected": 0, "deleted_files": 0, "freed_bytes": 0, "errors": 0}
    with gallery_db.get_conn() as conn:
        rows = conn.execute(
            """
            SELECT i.id, i.path, i.alias_path,
                   (SELECT t.name FROM item_tags it JOIN tags t ON t.id=it.tag_id
                    WHERE it.item_id=i.id AND it.category_id='rating' LIMIT 1) AS rating
            FROM items i
            WHERE i.state='archived' AND i.archive_expires_at IS NOT NULL
              AND i.archive_expires_at <= ?
            """,
            (now,),
        ).fetchall()
    for row in rows:
        item_id = int(row[0])
        if row[3] == "endorsed":
            report["protected"] += 1
            if not dry_run:
                # refresh the protected window instead of trashing
                gallery_db.refresh_archive_ttl(item_id)
            continue
        report["expired"] += 1
        if dry_run:
            continue
        result = trash_item(item_id, reason="ttl_expired")
        report["deleted_files"] += result.get("deleted_files", 0)
        report["freed_bytes"] += result.get("freed_bytes", 0)
        report["errors"] += result.get("errors", 0)
    if not dry_run and (report["expired"] or report["protected"]):
        print(
            f"[Gallery] Lifecycle sweep: {report['expired']} archived item(s) moved to trash, "
            f"{report['protected']} endorsed item(s) TTL-protected, "
            f"{report['deleted_files']} file(s) deleted ({report['freed_bytes'] / 1048576:.1f} MB)"
        )
    return report


def session_report() -> dict:
    """Startup integrity: blob store health + basic counts."""
    store = gallery_blobs.get_store()
    stats = store.stats()
    return {
        "items": gallery_db.stats(),
        "blobs": stats,
        "states": gallery_db.state_counts(),
    }


_sweeper_thread = None
_sweeper_stop = threading.Event()


def start_sweeper(interval_seconds: float = 3600.0) -> None:
    """Start the hourly lifecycle sweeper (idempotent)."""
    global _sweeper_thread
    if _sweeper_thread and _sweeper_thread.is_alive():
        return
    _sweeper_stop.clear()

    def _loop():
        first = True
        while not _sweeper_stop.is_set():
            if not first:
                if _sweeper_stop.wait(interval_seconds):
                    break
            first = False
            try:
                gallery_db.init_db()
                sweep()
                enforce_trash_media()
            except Exception as exc:
                print(f"[Gallery] lifecycle sweep failed: {exc}")

    _sweeper_thread = threading.Thread(target=_loop, name="gallery-lifecycle", daemon=True)
    _sweeper_thread.start()


def stop_sweeper() -> None:
    _sweeper_stop.set()
