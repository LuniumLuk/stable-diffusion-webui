import os
from datetime import datetime

from PIL import Image

from modules import errors

try:
    from rembg import new_session, remove
except Exception as import_error:
    new_session = None
    remove = None
    rembg_import_error = import_error
else:
    rembg_import_error = None


_sessions = {}
_ROOT_DIR = os.path.dirname(os.path.dirname(__file__))
_REMOVEBG_ROOT = os.path.join(_ROOT_DIR, "outputs", "removebg")


def get_removebg_root() -> str:
    return _REMOVEBG_ROOT


def _get_session(model_name: str):
    session = _sessions.get(model_name)
    if session is None:
        session = new_session(model_name)
        _sessions[model_name] = session
    return session


def remove_background_image(image: Image.Image, model_name: str = "u2net", alpha_matting: bool = False,
                            post_process_mask: bool = False, only_mask: bool = False) -> tuple[Image.Image | None, dict]:
    if remove is None or new_session is None:
        return None, {"rembg": "unavailable", "error": str(rembg_import_error)}

    try:
        source = image.convert("RGB")
        session = _get_session(model_name)
        result = remove(
            source,
            session=session,
            alpha_matting=alpha_matting,
            post_process_mask=post_process_mask,
            only_mask=only_mask,
        )

        if isinstance(result, Image.Image):
            output = result.convert("L") if only_mask else result.convert("RGBA")
        else:
            output = Image.fromarray(result)

        return output, {
            "rembg model": model_name,
            "rembg alpha matting": bool(alpha_matting),
            "rembg post-process mask": bool(post_process_mask),
            "rembg only mask": bool(only_mask),
        }
    except Exception:
        errors.report("rembg processing failed", exc_info=True)
        return None, {"rembg": "failed"}


def build_removebg_target_path(source_path: str, ext: str = ".png") -> str:
    day_folder = datetime.now().strftime("%Y-%m-%d")
    target_dir = os.path.join(_REMOVEBG_ROOT, day_folder)
    os.makedirs(target_dir, exist_ok=True)

    stem = os.path.splitext(os.path.basename(source_path))[0] or "image"
    desired = os.path.join(target_dir, f"{stem}-rembg{ext}")
    if not os.path.exists(desired):
        return desired

    idx = 1
    while True:
        candidate = os.path.join(target_dir, f"{stem}-rembg-{idx}{ext}")
        if not os.path.exists(candidate):
            return candidate
        idx += 1