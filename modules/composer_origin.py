"""Write a composition back over the gallery image it was opened from.

The Composer (desktop) and the SD Lite Compose screen can both reopen an image
from the gallery, edit it and then replace that same file - the *origin image* -
with the result. The file is rewritten in place (same inode), so hardlinked
endorsed copies and gallery rows keep pointing at the same picture.
"""

import os
import shutil
import time

from PIL import Image, PngImagePlugin

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

IMAGE_EXTENSIONS = (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp")
ORIGIN_ROOTS = (os.path.join(_ROOT, "outputs"),)


class OriginError(ValueError):
    """The origin image cannot be replaced (missing, unsupported, outside outputs)."""


def _is_under(path: str, root: str) -> bool:
    try:
        return os.path.commonpath([os.path.normcase(path), os.path.normcase(root)]) == os.path.normcase(root)
    except ValueError:
        return False


def resolve_origin(path: str) -> str:
    """Absolute origin path, validated; raises OriginError with a user-facing message."""
    raw = str(path or "").strip()
    if not raw:
        raise OriginError("no origin image is set - open an image from the Gallery first")
    absolute = os.path.abspath(os.path.expanduser(raw))
    if not os.path.isfile(absolute):
        raise OriginError("the origin image no longer exists on disk")
    if os.path.splitext(absolute)[1].lower() not in IMAGE_EXTENSIONS:
        raise OriginError("the origin is not a supported image file")
    if not any(_is_under(absolute, root) for root in ORIGIN_ROOTS):
        raise OriginError("the origin is outside the outputs folder")
    return absolute


def _backup_origin(path: str) -> str:
    """Copy the current file aside so an override can be undone by hand."""
    backup_dir = os.path.join(_ROOT, "outputs", "composition", "origin-backups")
    os.makedirs(backup_dir, exist_ok=True)
    stem, ext = os.path.splitext(os.path.basename(path))
    stamp = time.strftime("%Y%m%d-%H%M%S")
    target = os.path.join(backup_dir, f"{stem}-{stamp}{ext}")
    counter = 1
    while os.path.exists(target):
        target = os.path.join(backup_dir, f"{stem}-{stamp}-{counter}{ext}")
        counter += 1
    shutil.copy2(path, target)
    return target


def _read_generation_info(path: str) -> tuple[str, dict]:
    """(infotext, png text chunks) of the file that is about to be replaced."""
    try:
        with Image.open(path) as source:
            info = dict(source.info or {})
    except Exception:
        return "", {}

    text = info.pop("parameters", "") or ""
    if not text and info.get("exif"):
        try:
            import piexif
            import piexif.helper
            exif = piexif.load(info["exif"])
            raw = (exif.get("Exif") or {}).get(piexif.ExifIFD.UserComment, b"")
            try:
                text = piexif.helper.UserComment.load(raw) or ""
            except Exception:
                text = raw.decode("utf8", errors="ignore") if isinstance(raw, (bytes, bytearray)) else ""
        except Exception:
            text = ""
    if not text and info.get("comment"):
        comment = info["comment"]
        text = comment.decode("utf8", errors="ignore") if isinstance(comment, (bytes, bytearray)) else str(comment)

    extra = {k: v for k, v in info.items() if isinstance(v, str) and k not in ("exif", "comment")}
    return str(text or ""), extra


def _save_preserving_metadata(image: Image.Image, path: str, geninfo: str, extra: dict) -> None:
    ext = os.path.splitext(path)[1].lower()
    if ext == ".png":
        info = PngImagePlugin.PngInfo()
        for key, value in (extra or {}).items():
            if value is None:
                continue
            try:
                info.add_text(str(key), str(value))
            except Exception:
                pass
        if geninfo:
            info.add_text("parameters", str(geninfo))
        image.save(path, format="PNG", pnginfo=info)
        return

    if ext in (".jpg", ".jpeg", ".webp"):
        flat = image.convert("RGB") if image.mode not in ("RGB", "L") else image
        if ext == ".webp":
            flat.save(path, format="WEBP", quality=95, method=6)
        else:
            flat.save(path, format="JPEG", quality=95)
        if geninfo:
            try:
                import piexif
                import piexif.helper
                exif = piexif.dump({"Exif": {
                    piexif.ExifIFD.UserComment: piexif.helper.UserComment.dump(geninfo, encoding="unicode"),
                }})
                piexif.insert(exif, path)
            except Exception:
                pass
        return

    if ext == ".gif":
        image.save(path, format="GIF", comment=geninfo or "")
        return

    image.convert("RGB").save(path, format="BMP")


def _refresh_gallery_row(path: str, stat: os.stat_result) -> int | None:
    """Keep the gallery row and its cached thumbnails in sync with the new file."""
    try:
        from modules import gallery_db
        item_id = gallery_db.resolve_item_id(path)
        if not item_id:
            return None

        width = height = None
        try:
            with Image.open(path) as image:
                width, height = image.width, image.height
        except Exception:
            pass

        with gallery_db.get_conn() as conn:
            conn.execute(
                "UPDATE items SET mtime=?, file_size=?, width=COALESCE(?, width), "
                "height=COALESCE(?, height), updated_at=? WHERE id=?",
                (stat.st_mtime, stat.st_size, width, height, gallery_db._now_iso(), item_id),
            )
            conn.commit()
    except Exception:
        return None

    try:
        from modules import gallery_blobs
        gallery_blobs.get_store().delete(
            item_id, kinds=(gallery_blobs.KIND_THUMB, gallery_blobs.KIND_PREVIEW)
        )
    except Exception:
        pass
    return item_id


def _refresh_legacy_index(path: str, stat: os.stat_result) -> None:
    try:
        from modules import endorsement_db
        endorsement_db.set_file_mtime(path, stat.st_mtime)
    except Exception:
        pass


def override_origin(image: Image.Image, origin_path: str, composer_state: str = "") -> dict:
    """Replace the origin image with `image`; returns path/backup/item details.

    `composer_state` (JSON text) refreshes the origin's existing
    .composerstate.json sidecar so reopening the composition keeps working.
    """
    if image is None:
        raise OriginError("there is no composed image yet")
    path = resolve_origin(origin_path)

    geninfo, extra = _read_generation_info(path)
    backup = _backup_origin(path)
    try:
        _save_preserving_metadata(image, path, geninfo, extra)
    except Exception as exc:
        raise OriginError(f"writing the origin failed: {exc} (backup kept at {backup})") from exc

    sidecar_path = os.path.splitext(path)[0] + ".composerstate.json"
    if composer_state and os.path.isfile(sidecar_path):
        try:
            with open(sidecar_path, "w", encoding="utf-8") as handle:
                handle.write(composer_state)
        except OSError:
            pass

    stat = os.stat(path)
    item_id = _refresh_gallery_row(path, stat)
    _refresh_legacy_index(path, stat)
    return {
        "ok": True,
        "path": path,
        "backup": backup,
        "item_id": item_id,
        "width": image.width,
        "height": image.height,
    }
