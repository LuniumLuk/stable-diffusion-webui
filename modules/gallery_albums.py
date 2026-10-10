"""Album bundling: compress an album's originals into one verified zip.

Contract (user 2026-10-10):
  - an item belongs to at most one album (enforced by items.album_id)
  - bundling keeps thumb + preview media in the blob store so the gallery
    still browses normally, while the physical originals (and their hardlink
    aliases) move into a single compressed archive
  - the original file cannot be accessed again until the album is unbundled
    (unbundle restores every file, sha256-verified, then drops the archive)

The archive is a plain zip: manifest.json (paths + sizes + sha256 + mtimes)
followed by one entry per file. It is written to a .part file and renamed
only after passing zipfile.testzip(), so a crash never leaves a bad bundle.
"""

import hashlib
import json
import os
import re
import time
import zipfile

from modules import gallery_blobs, gallery_db

BUNDLE_VERSION = 1
MANIFEST_NAME = "manifest.json"
PREVIEW_STATES = ("active", "staged")


def bundle_dir() -> str:
    """Where album archives live (follows GALLERY_DB_PATH for isolated tests)."""
    override = os.environ.get("GALLERY_ALBUM_DIR")
    if override:
        return override
    root = os.path.dirname(os.path.abspath(gallery_db.DB_PATH))
    return os.path.join(root, "cache", "gallery_albums")


def _slug(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", str(name or "").lower()).strip("-")
    return slug[:40]


def _sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _ensure_media(store, item: dict, path: str, alias: str) -> str | None:
    """Guarantee the blobs an item's state keeps before its file disappears."""
    kinds = ("thumb", "preview") if item.get("state") in PREVIEW_STATES else ("thumb",)
    for kind in kinds:
        if store.has(item["id"], kind):
            continue
        if not gallery_blobs.ensure_blob(item["id"], kind, path) and alias:
            gallery_blobs.ensure_blob(item["id"], kind, alias)
        if not store.has(item["id"], kind):
            return kind
    return None


def _arcname(item_id: int, filename: str, suffix: str = "") -> str:
    base = os.path.basename(filename or "") or "file"
    return "items/%06d%s_%s" % (int(item_id), suffix, base)


def bundle_album(album_id: int) -> dict:
    """Move an album's originals into one zip. Returns a summary dict."""
    album = gallery_db.get_album(album_id)
    if not album:
        return {"ok": False, "error": "album not found"}
    items = gallery_db.album_items(album["id"])
    if not items:
        return {"ok": False, "error": "album is empty"}

    store = gallery_blobs.get_store()
    entries = []
    skipped = []
    for item in items:
        if item.get("state") == "trashed":
            skipped.append({"key": item["uid"], "reason": "trashed"})
            continue
        path = item.get("path") or ""
        alias = item.get("alias_path") or ""
        if not path or not os.path.isfile(path):
            skipped.append({"key": item["uid"], "reason": "file missing"})
            continue
        gap = _ensure_media(store, item, path, alias)
        if gap:
            return {"ok": False, "error": "cannot build %s for %s" % (gap, item["uid"])}
        entries.append((item, path, alias))
    if not entries:
        return {"ok": False, "error": "no bundleable files", "skipped": skipped}

    os.makedirs(bundle_dir(), exist_ok=True)
    slug = _slug(album["name"]) or "album-%d" % int(album["id"])
    zip_path = os.path.join(bundle_dir(), "%d-%s.zip" % (int(album["id"]), slug))
    part_path = zip_path + ".part"

    manifest = {
        "version": BUNDLE_VERSION,
        "album_id": int(album["id"]),
        "album": album["name"],
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "entries": [],
    }
    try:
        with zipfile.ZipFile(part_path, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as zf:
            for item, path, alias in entries:
                entry = {
                    "item": int(item["id"]),
                    "uid": item["uid"],
                    "arc": _arcname(item["id"], path),
                    "path": path,
                    "size": os.path.getsize(path),
                    "mtime": float(item.get("mtime") or os.path.getmtime(path)),
                    "sha256": _sha256_file(path),
                }
                zf.write(path, entry["arc"])
                if alias and os.path.isfile(alias) and not os.path.samefile(alias, path):
                    entry["alias"] = alias
                    entry["alias_arc"] = _arcname(item["id"], alias, "_alias")
                    entry["alias_size"] = os.path.getsize(alias)
                    entry["alias_sha256"] = _sha256_file(alias)
                    zf.write(alias, entry["alias_arc"])
                manifest["entries"].append(entry)
            zf.writestr(MANIFEST_NAME, json.dumps(manifest, ensure_ascii=False, indent=1))
        with zipfile.ZipFile(part_path) as zf:
            broken = zf.testzip()
        if broken:
            raise RuntimeError("verify failed at %s" % broken)
        os.replace(part_path, zip_path)
    except Exception as exc:
        try:
            os.remove(part_path)
        except OSError:
            pass
        return {"ok": False, "error": str(exc)}

    deleted = 0
    for item, path, alias in entries:
        for candidate in (path, alias):
            if candidate and os.path.isfile(candidate):
                try:
                    os.remove(candidate)
                    deleted += 1
                except OSError:
                    pass

    size = os.path.getsize(zip_path)
    gallery_db.set_album_bundle(
        album["id"], zip_path, size, len(manifest["entries"]),
        sha256=_sha256_file(zip_path),
    )
    return {
        "ok": True, "bundled": len(manifest["entries"]), "deleted": deleted,
        "bytes": size, "path": zip_path, "skipped": skipped,
    }


def unbundle_album(album_id: int) -> dict:
    """Restore every archived original (sha256-verified) and drop the zip."""
    album = gallery_db.get_album(album_id)
    if not album or not album.get("bundle_path"):
        return {"ok": False, "error": "album is not bundled"}
    zip_path = album["bundle_path"]
    if not os.path.isfile(zip_path):
        return {"ok": False, "error": "bundle file missing: %s" % zip_path}

    restored = 0
    links = 0
    skipped = []
    errors = []
    with zipfile.ZipFile(zip_path) as zf:
        try:
            manifest = json.loads(zf.read(MANIFEST_NAME).decode("utf-8"))
        except Exception as exc:
            return {"ok": False, "error": "manifest unreadable: %s" % exc}
        for entry in manifest.get("entries", []):
            item = gallery_db.get_item(int(entry.get("item") or 0))
            if not item:
                skipped.append({"uid": entry.get("uid"), "reason": "purged"})
                continue
            try:
                payload = zf.read(entry["arc"])
            except KeyError:
                errors.append({"uid": entry.get("uid"), "error": "entry missing"})
                continue
            if len(payload) != int(entry.get("size") or -1) or \
                    hashlib.sha256(payload).hexdigest() != entry.get("sha256"):
                errors.append({"uid": entry.get("uid"), "error": "sha256 mismatch"})
                continue
            target = entry["path"]
            try:
                os.makedirs(os.path.dirname(target) or ".", exist_ok=True)
                tmp = target + ".part"
                with open(tmp, "wb") as handle:
                    handle.write(payload)
                os.replace(tmp, target)
                if entry.get("mtime"):
                    os.utime(target, (float(entry["mtime"]), float(entry["mtime"])))
                restored += 1
            except OSError as exc:
                errors.append({"uid": entry.get("uid"), "error": str(exc)})
                continue
            alias = entry.get("alias")
            if alias:
                try:
                    if os.path.isfile(alias):
                        os.remove(alias)
                    os.link(target, alias)
                    links += 1
                except OSError:
                    try:
                        payload_alias = zf.read(entry["alias_arc"])
                        with open(alias, "wb") as handle:
                            handle.write(payload_alias)
                        links += 1
                    except Exception as exc:
                        errors.append({"uid": entry.get("uid"), "error": "alias: %s" % exc})

    if errors:
        return {
            "ok": False, "restored": restored, "links": links,
            "skipped": skipped, "errors": errors,
            "error": "restore incomplete; bundle kept",
        }
    try:
        os.remove(zip_path)
    except OSError:
        pass
    gallery_db.clear_album_bundle(album["id"])
    return {"ok": True, "restored": restored, "links": links, "skipped": skipped}
