"""Pre-resize for img2img / inpaint init images (shared by the desktop tab and Mobile Lite).

The optional "Resize Input" step runs before img2img touches the picture: the init image is
resized once and the inpaint mask is resized with the identical geometry, so painted regions
stay aligned. Pure helpers only (PIL + math) so they can be unit tested without WebUI state.
"""

from __future__ import annotations

import math

from PIL import Image

RESAMPLING = getattr(Image, "Resampling", Image)

MIN_SIZE = 64
MAX_SIZE = 2048
GRID = 8
MIN_SCALE = 0.1
MAX_SCALE = 4.0

FIT_LABELS = {"Aspect fill": "fill", "Stretch": "stretch"}
MODE_LABELS = {"Scale": "scale", "Size": "size"}


def round8(value: float, multiple: int = GRID) -> int:
    """Half-up grid snap (like JS Math.round, not Python's half-even) clamped to 64..2048."""
    return max(MIN_SIZE, min(MAX_SIZE, int(value / multiple + 0.5) * multiple))


def canonical_mode(mode) -> str:
    text = str(mode or "").strip().lower()
    if text in ("scale", "by scale"):
        return "scale"
    if text in ("size", "custom", "by size"):
        return "size"
    return "off"


def plan_resize(
    source_width: int,
    source_height: int,
    mode,
    *,
    scale: float = 1.0,
    width=None,
    height=None,
    fit: str = "fill",
    min_scale: float = MIN_SCALE,
    max_scale: float = MAX_SCALE,
):
    """Target of the pre-resize, or ``None`` when it is off / a no-op.

    Returns ``{"mode", "width", "height", "fit", "cover", "downscale"}``:
    ``fill`` covers the target box and center-crops (aspect kept), ``stretch`` distorts to the
    exact size. A scale-only resize always keeps the aspect ratio.
    """
    mode = canonical_mode(mode)
    if mode == "off":
        return None

    source_width = max(1, int(source_width))
    source_height = max(1, int(source_height))

    if mode == "scale":
        try:
            factor = float(scale)
        except (TypeError, ValueError):
            factor = 1.0
        factor = max(float(min_scale), min(float(max_scale), factor))
        target_width = round8(source_width * factor)
        target_height = round8(source_height * factor)
        fit = "fill"
    else:
        target_width = round8(width if width else source_width)
        target_height = round8(height if height else source_height)
        fit = "stretch" if str(fit).strip().lower() == "stretch" else "fill"

    if (target_width, target_height) == (source_width, source_height):
        return None

    cover = mode == "size" and fit == "fill"
    if cover:
        downscale = max(target_width / source_width, target_height / source_height) < 1
    else:
        downscale = target_width * target_height < source_width * source_height

    return {
        "mode": mode,
        "width": target_width,
        "height": target_height,
        "fit": fit,
        "cover": cover,
        "downscale": downscale,
    }


def scaled_size(width, height, factor) -> tuple[int, int]:
    """Grid-snapped size after the img2img "Resize by" factor; same limits as the pre-resize."""
    return round8(width * factor), round8(height * factor)


def working_size(plan, *, set_output: bool = False, scale_by=None):
    """img2img working size implied by a pre-resize ``plan``, or ``None`` to leave it alone.

    The "Resize by" factor applies to the *resized* input, because that is the picture img2img
    encodes; falling back to the raw source dimensions would undo the pre-resize.
    """
    if plan is None:
        return None
    if scale_by:
        return scaled_size(plan["width"], plan["height"], scale_by)
    if set_output:
        return plan["width"], plan["height"]
    return None


def resize_pair(image, mask, plan):
    """Apply ``plan`` to the image and (optionally) the mask; returns ``(image, mask, detail)``."""
    if plan is None or image is None:
        return image, mask, None

    target = (plan["width"], plan["height"])
    crop = bool(plan.get("cover"))
    downscale = bool(plan.get("downscale"))
    resample = RESAMPLING.BOX if downscale else RESAMPLING.LANCZOS
    reducing_gap = 2.0 if downscale else None

    def resize_one(item):
        if item is None:
            return None
        if crop:
            ratio = max(target[0] / item.width, target[1] / item.height)
            scaled = (max(1, math.ceil(item.width * ratio)), max(1, math.ceil(item.height * ratio)))
            resized = item.resize(scaled, resample, reducing_gap=reducing_gap)
            left = (resized.width - target[0]) // 2
            top = (resized.height - target[1]) // 2
            return resized.crop((left, top, left + target[0], top + target[1]))
        return item.resize(target, resample, reducing_gap=reducing_gap)

    detail = f"{image.width}x{image.height} -> {plan['width']}x{plan['height']} ({'area' if downscale else 'lanczos'}"
    if plan["mode"] == "size":
        detail += ", aspect fill" if crop else ", stretch"
    detail += ")"

    return resize_one(image), (resize_one(mask) if mask is not None else None), detail
