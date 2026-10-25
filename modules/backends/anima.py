"""Anima (stable-diffusion.cpp) backend specifics: payload mapping and image decoding."""

from __future__ import annotations

import base64
import io

from PIL import Image

# A1111 dropdown label -> sd.cpp sample_method. Matching is done on the label
# stem so "DPM++ 2M Karras" and "DPM++ 2M" share one entry.
_SAMPLERS = {
    "euler a": "euler_a",
    "euler": "euler",
    "heun": "heun",
    "dpm2": "dpm2",
    "dpm2 a": "dpm2_a",
    "dpm++ 2s a": "dpmpp_2s_a",
    "dpm++ 2m": "dpmpp_2m",
    "dpm++ sde": "dpmpp_sde",
    "dpm++ 2m sde": "dpmpp_2m_sde",
    "lms": "lms",
    "ddim": "ddim",
    "unipc": "unipc",
    "lcm": "lcm",
}

_SCHEDULERS = {
    "karras": "karras",
    "exponential": "exponential",
    "sgm uniform": "sgm_uniform",
    "simple": "simple",
    "normal": "normal",
    "ddim": "ddim_uniform",
    "beta": "beta",
}

MIN_SIDE = 256
MAX_SIDE = 2048


def map_sampler(sampler_name: str | None) -> tuple[str, str]:
    """Return (sample_method, scheduler) for an A1111 sampler label."""
    label = (sampler_name or "").strip().lower()
    scheduler = "discrete"

    for suffix, mapped in _SCHEDULERS.items():
        if label.endswith(suffix):
            scheduler = mapped
            label = label[: -len(suffix)].strip()
            break

    method = _SAMPLERS.get(label)
    if method is None:
        # longest key first so "dpm++ 2m sde" wins over "dpm++ 2m"
        for key in sorted(_SAMPLERS, key=len, reverse=True):
            if label.startswith(key):
                method = _SAMPLERS[key]
                break

    return method or "euler_a", scheduler


def clamp_side(value) -> int:
    try:
        value = int(value)
    except Exception:
        return 1024
    return max(MIN_SIDE, min(MAX_SIDE, value))


def encode_image(image: Image.Image | None, size: tuple[int, int] | None = None) -> str | None:
    if image is None:
        return None
    picture = image.convert("RGB")
    if size is not None and picture.size != size:
        picture = picture.resize(size, Image.LANCZOS)
    buffer = io.BytesIO()
    picture.save(buffer, format="PNG")
    return base64.b64encode(buffer.getvalue()).decode("ascii")


def build_payload(
    *,
    prompt: str,
    negative_prompt: str,
    width: int,
    height: int,
    steps: int,
    cfg_scale: float,
    sampler_name: str,
    seed: int,
    flow_shift: float = 0.0,
    init_image: Image.Image | None = None,
    mask_image: Image.Image | None = None,
    denoising_strength: float | None = None,
) -> dict:
    method, scheduler = map_sampler(sampler_name)
    sample_params = {
        "scheduler": scheduler,
        "sample_method": method,
        "sample_steps": max(1, int(steps)),
        "guidance": {"txt_cfg": float(cfg_scale)},
    }
    # sd.cpp treats an explicit flow_shift of 0 as "no shift" and produces a blank
    # image; only send it when the user actually wants a specific value.
    if flow_shift and float(flow_shift) > 0:
        sample_params["flow_shift"] = float(flow_shift)

    payload = {
        "prompt": prompt,
        "negative_prompt": negative_prompt,
        "width": width,
        "height": height,
        "seed": int(seed),
        "batch_count": 1,
        "output_format": "png",
        "sample_params": sample_params,
    }

    if init_image is not None:
        payload["init_image"] = encode_image(init_image, (width, height))
        payload["strength"] = float(denoising_strength if denoising_strength is not None else 0.75)
    if mask_image is not None:
        payload["mask_image"] = encode_image(mask_image, (width, height))

    return payload


def decode_images(status: dict) -> list[Image.Image]:
    result = status.get("result") or {}
    images = result.get("images") or []
    decoded = []
    for entry in images:
        data = entry.get("b64_json") if isinstance(entry, dict) else None
        if not data:
            continue
        picture = Image.open(io.BytesIO(base64.b64decode(data)))
        picture.load()
        decoded.append(picture)
    return decoded
