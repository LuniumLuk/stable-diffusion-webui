"""
gemini_workflow/image_maker.py — direct image generation with Google Gemini.

Unlike comic_maker.py (root prompt -> txt2txt -> N page prompts -> N images),
this workflow renders images DIRECTLY from a prompt file: no text-model
expansion step. The prompt file is used verbatim as the image prompt.

Pipeline:
  1. Load the image prompt from a .txt file (--prompt-file).
  2. Optionally attach reference images (--ref-images) for editing /
     style transfer / composition.
  3. Generate --variations images (default 1) from the SAME prompt +
     references. Every call is retried up to --retries times (default 3)
     on errors such as safety blocks ("cannot generate unsafe image"),
     rate limits, etc. Each variation gets its own retry budget.

Usage:
  <workflow-python> image_maker.py --prompt-file prompt.txt \
      [--ref-images refs/char.png refs/style.png] \
      [--image-model gemini-3.1-flash-image] \
      [--aspect-ratio 16:9] [--image-size 1K] \
      [--output-dir outputs/image_maker] [--retries 3] [--variations 2] \
      [--api-key KEY]

API key: --api-key > GEMINI_API_KEY env > config_states/gemini_nano_banana.txt.
Output lands in outputs/image_maker/YYYY-MM-DD/HHMMSS/ (unique per run).
Result is printed to stdout as a JSON object; exit code 0 if every
variation rendered, 1 otherwise.
"""
import argparse
import base64
import datetime
import json
import os
import sys
import time

_WORKFLOW_DIR = os.path.dirname(os.path.abspath(__file__))
if _WORKFLOW_DIR not in sys.path:
    sys.path.insert(0, _WORKFLOW_DIR)

from generate import _encode_image, _make_client, _run_with_proxy_fallback  # noqa: E402
from models_config import load_model_config  # noqa: E402

_ROOT_DIR = os.path.dirname(_WORKFLOW_DIR)
DEFAULT_OUTPUT_DIR = os.path.join(_ROOT_DIR, "outputs", "image_maker")
_IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp")


# ---------------------------------------------------------------------------
# Input helpers
# ---------------------------------------------------------------------------
def _load_prompt(path: str) -> str:
    if not os.path.exists(path):
        raise RuntimeError(f"Prompt file not found: {path}")
    with open(path, "r", encoding="utf-8") as f:
        prompt = f.read().strip()
    if not prompt:
        raise RuntimeError("Prompt file is empty.")
    return prompt


def _resolve_api_key(args) -> str:
    if args.api_key and args.api_key.strip():
        return args.api_key.strip()
    env_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if env_key:
        return env_key
    cfg = os.path.join(_ROOT_DIR, "config_states", "gemini_nano_banana.txt")
    if os.path.exists(cfg):
        for raw in open(cfg, encoding="utf-8"):
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if "=" in line:
                name, _, val = line.partition("=")
                if name.strip().lower() in ("gemini_api_key", "api_key", "key"):
                    return val.strip()
                continue
            return line
    return ""


def ref_images_from_args(ref_images):
    """Return the --ref-images list, validated.

    Raises RuntimeError if any path is missing or not a supported image.
    """
    paths = []
    for p in ref_images or []:
        if not os.path.isfile(p):
            raise RuntimeError(f"Reference image not found: {p}")
        if os.path.splitext(p)[1].lower() not in _IMAGE_EXTS:
            raise RuntimeError(f"Unsupported reference image file: {p}")
        paths.append(p)
    return paths


# ---------------------------------------------------------------------------
# Retry
# ---------------------------------------------------------------------------
def _retry_delay(exc, attempt: int) -> int:
    """Backoff in seconds. HTTP 400 errors whose message mentions
    "Image generation blocked" retry immediately (0s): that rejection is
    usually transient and not caused by load, so sleeping only wastes time."""
    try:
        if (int(getattr(exc, "code", None)) == 400
                and "image generation blocked" in str(exc).lower()):
            return 0
    except (TypeError, ValueError):
        pass
    return 2 ** (attempt + 1)


def with_retry(fn, what: str, retries: int = 3):
    """Call fn(); on any exception retry up to `retries` times with backoff.

    HTTP 400 errors mentioning "Image generation blocked" are retried
    immediately (no backoff).
    """
    for attempt in range(retries + 1):  # 1 initial attempt + `retries` retries
        try:
            return fn()
        except Exception as exc:  # noqa: BLE001 - retry on any API error
            if attempt >= retries:
                raise
            delay = _retry_delay(exc, attempt)
            when = "immediately" if delay == 0 else f"in {delay}s"
            print(
                f"[image_maker] {what} failed (attempt {attempt + 1}/{retries + 1}): "
                f"{str(exc)[:160]} — retrying {when}",
                flush=True,
            )
            if delay:
                time.sleep(delay)


# ---------------------------------------------------------------------------
# Image generation (prompt + reference images)
# ---------------------------------------------------------------------------
def generate_image(client, image_model: str, prompt: str, ref_images,
                   output_path: str, aspect_ratio: str = "", image_size: str = "") -> None:
    content = [{"type": "text", "text": prompt}]
    for p in ref_images:
        mime, data = _encode_image(p)
        content.append({"type": "image", "data": data, "mime_type": mime})
    model_input = content if ref_images else prompt

    response_format = {"type": "image"}
    if aspect_ratio:
        response_format["aspect_ratio"] = aspect_ratio
    if image_size:
        response_format["image_size"] = image_size

    interaction = _run_with_proxy_fallback(
        lambda: client.interactions.create(
            model=image_model,
            input=model_input,
            response_format=response_format,
        )
    )
    out_image = interaction.output_image
    if out_image is None or not getattr(out_image, "data", None):
        raise RuntimeError("Image model returned no image (output_image is empty).")
    raw = base64.b64decode(out_image.data)
    with open(output_path, "wb") as f:
        f.write(raw)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def main() -> int:
    parser = argparse.ArgumentParser(
        description="Generate images directly from a prompt file with Google Gemini."
    )
    parser.add_argument("--prompt-file", required=True,
                        help=".txt file containing the image prompt (used verbatim).")
    parser.add_argument("--ref-images", nargs="+", default=[],
                        help="Reference image files attached to the prompt "
                             "(editing / style transfer / composition).")
    _cfg = load_model_config()
    parser.add_argument("--image-model", default=_cfg["image_model"],
                        help="Nano Banana image model used to render the image.")
    parser.add_argument("--aspect-ratio", default="",
                        help="Output aspect ratio e.g. 16:9, 3:4 (omit for model default).")
    parser.add_argument("--image-size", default="",
                        help="e.g. 1K, 2K (omit for model default).")
    parser.add_argument("--output-dir", default="",
                        help="Output directory (default: outputs/image_maker/YYYY-MM-DD).")
    parser.add_argument("--retries", type=int, default=3,
                        help="Max retries per image on error (default: 3).")
    parser.add_argument("--variations", type=int, default=1,
                        help="Number of images to generate (default: 1). "
                             "Each variation uses the same prompt + references and "
                             "gets its own retry budget.")
    parser.add_argument("--api-key", default="",
                        help="Gemini API key (or GEMINI_API_KEY env / config txt).")
    args = parser.parse_args()

    try:
        prompt = _load_prompt(args.prompt_file)
        ref_images = ref_images_from_args(args.ref_images)
        api_key = _resolve_api_key(args)
        if not api_key:
            raise RuntimeError(
                "No Gemini API key. Set GEMINI_API_KEY, pass --api-key, or "
                "configure config_states/gemini_nano_banana.txt."
            )

        client = _make_client(api_key)

        out_dir = args.output_dir or os.path.join(
            DEFAULT_OUTPUT_DIR,
            datetime.date.today().strftime("%Y-%m-%d"),
            datetime.datetime.now().strftime("%H%M%S"),
        )
        os.makedirs(out_dir, exist_ok=True)

        manifest_path = os.path.join(out_dir, "image_prompt.txt")
        with open(manifest_path, "w", encoding="utf-8") as f:
            f.write("# Image Maker prompt\n")
            f.write(prompt + "\n\n")
            f.write(f"# Image model: {args.image_model}\n")
            f.write(f"# Reference images ({len(ref_images)}):\n")
            for p in ref_images:
                f.write(f"#   {p}\n")

        variations = max(1, args.variations)
        outputs, errors = [], []
        for v in range(1, variations + 1):
            out_path = os.path.join(out_dir, f"image_v{v:02d}.png")
            print(f"[image_maker] variation {v}/{variations}: generating "
                  f"({len(ref_images)} reference images) ...", flush=True)
            try:
                with_retry(
                    lambda: generate_image(
                        client, args.image_model, prompt, ref_images, out_path,
                        args.aspect_ratio, args.image_size,
                    ),
                    f"variation {v} image call", args.retries,
                )
                outputs.append(out_path)
                print(f"[image_maker] variation {v} -> {out_path}", flush=True)
            except Exception as exc:  # noqa: BLE001 - continue next variation
                errors.append((v, str(exc)))
                print(f"[image_maker] variation {v} FAILED after retries: {exc}",
                      flush=True)

        ok = not errors
        result = {
            "ok": ok,
            "image_model": args.image_model,
            "variations": variations,
            "output_dir": out_dir,
            "manifest": manifest_path,
            "outputs": outputs,  # [v1_path, v2_path, ...]
            "errors": errors,    # [(variation, message), ...]
        }
        print(json.dumps(result, ensure_ascii=False), flush=True)
        return 0 if ok else 1

    except Exception as exc:  # noqa: BLE001 - report any failure as JSON
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), flush=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
