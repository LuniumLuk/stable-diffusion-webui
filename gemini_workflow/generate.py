"""
gemini_workflow/generate.py — Standalone Google Gemini "Nano Banana" image generator.

Calls the official Gemini API using the `google-genai` SDK (installed in this
workflow's SEPARATE venv so the webui root .venv pins stay untouched).

Generates EXACTLY ONE image per call.

Supported models:
  - gemini-2.5-flash-image        (Nano Banana, legacy workhorse, 1024px)
  - gemini-3.1-flash-lite-image   (Nano Banana 2 Lite, cheapest/fastest)
  - gemini-3.1-flash-image        (Nano Banana 2, recommended)
  - gemini-3-pro-image            (Nano Banana Pro, premium)

Usage:
  <venv-python> generate.py --prompt "a cyberpunk cat" \
      --model gemini-2.5-flash-image --output out.png \
      [--aspect-ratio 16:9] [--image-size 1K] [--api-key KEY]

  # Prompt from a .txt file (avoids command-line length limits):
  <venv-python> generate.py --prompt-file prompt.txt \
      --model gemini-2.5-flash-image --output out.png

  # Text + reference image(s): image editing / style transfer / composition
  <venv-python> generate.py --prompt "Change the background to a neon city" \
      --model gemini-2.5-flash-image --output out.png --image ref1.png [--image ref2.png]

API key is read from GEMINI_API_KEY env var or --api-key.
The result is printed to stdout as a single JSON object:
  {"ok": true, "output": "...", "mime_type": "...", "model": "..."}
On failure: {"ok": false, "error": "..."} and exit code 1.
"""
import argparse
import base64
import json
import os
import sys

_WORKFLOW_DIR = os.path.dirname(os.path.abspath(__file__))
if _WORKFLOW_DIR not in sys.path:
    sys.path.insert(0, _WORKFLOW_DIR)

from models_config import load_model_config  # noqa: E402


# ---------------------------------------------------------------------------
# Client construction (with optional local-proxy fallback)
# ---------------------------------------------------------------------------
def _make_client(api_key: str):
    from google import genai

    # Some machines only reach the internet via a local proxy. If
    # GEMINI_HTTP_PROXY is set (or direct access fails), route through it.
    proxy = os.environ.get("GEMINI_HTTP_PROXY", "").strip()
    if proxy:
        os.environ["HTTP_PROXY"] = proxy
        os.environ["HTTPS_PROXY"] = proxy
    return genai.Client(api_key=api_key)


def _is_api_error(exc: Exception) -> bool:
    """True if Google's servers responded with an error (auth, quota, ...)."""
    try:
        from google.genai import errors as genai_errors
        return isinstance(exc, genai_errors.APIError)
    except Exception:
        return False


_IMAGE_MIME = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
}


def _encode_image(path: str):
    """Read an image file and return (mime_type, base64_data) for the API."""
    if not os.path.exists(path):
        raise RuntimeError(f"Reference image not found: {path}")
    ext = os.path.splitext(path)[1].lower()
    mime = _IMAGE_MIME.get(ext)
    if not mime:
        raise ValueError(
            f"Unsupported image type: {path} "
            f"(supported: {', '.join(sorted(_IMAGE_MIME))})"
        )
    with open(path, "rb") as f:
        data = base64.b64encode(f.read()).decode("utf-8")
    return mime, data


def _run_with_proxy_fallback(fn):
    """Run fn(); if it fails with a CONNECTION error and no proxy was set,
    retry once through the known-good local proxy 127.0.0.1:7897.

    API-level errors (invalid key, quota, blocked prompt, ...) mean the
    request reached Google, so they are surfaced as-is without a retry.
    """
    try:
        return fn()
    except Exception as first_err:
        if _is_api_error(first_err):
            raise
        if os.environ.get("GEMINI_HTTP_PROXY") or "GEMINI_PROXY_TRIED" in os.environ:
            raise
        os.environ["GEMINI_HTTP_PROXY"] = "http://127.0.0.1:7897"
        os.environ["GEMINI_PROXY_TRIED"] = "1"
        try:
            return fn()
        except Exception as retry_err:
            raise RuntimeError(
                f"Direct and proxy attempts both failed.\nDirect: {first_err}\nProxy: {retry_err}"
            ) from retry_err


# ---------------------------------------------------------------------------
# Generation
# ---------------------------------------------------------------------------
def generate(args) -> dict:
    if not args.api_key:
        raise RuntimeError(
            "No Gemini API key. Set GEMINI_API_KEY env var or pass --api-key."
        )

    # Resolve the prompt from --prompt or --prompt-file.
    if args.prompt_file:
        if not os.path.exists(args.prompt_file):
            raise RuntimeError(f"Prompt file not found: {args.prompt_file}")
        with open(args.prompt_file, "r", encoding="utf-8") as f:
            prompt = f.read().strip()
        if not prompt:
            raise RuntimeError("Prompt file is empty.")
    else:
        prompt = args.prompt
        if not prompt or not prompt.strip():
            raise RuntimeError("No prompt. Pass --prompt or --prompt-file.")

    client = _make_client(args.api_key)
    model = args.model

    # Force image-only output and optionally control ratio/size.
    response_format = {"type": "image"}
    if args.aspect_ratio:
        response_format["aspect_ratio"] = args.aspect_ratio
    if args.image_size:
        response_format["image_size"] = args.image_size

    # Prompt alone, or prompt + reference images (text-and-image-to-image).
    if args.image:
        content = [{"type": "text", "text": prompt}]
        for path in args.image:
            mime, data = _encode_image(path)
            content.append({"type": "image", "data": data, "mime_type": mime})
        model_input = content
    else:
        model_input = prompt

    # All Nano Banana models (2.5-flash-image included) are called through the
    # Interactions API on v1beta; the legacy models.generate_images (predict)
    # endpoint returns 404 "not supported for predict" for gemini-2.5-flash-image.
    interaction = _run_with_proxy_fallback(
        lambda: client.interactions.create(
            model=model,
            input=model_input,
            response_format=response_format,
        )
    )
    out_image = interaction.output_image
    if out_image is None or not getattr(out_image, "data", None):
        raise RuntimeError("API returned no image (output_image is empty).")
    raw = base64.b64decode(out_image.data)
    mime = getattr(out_image, "mime_type", None) or "image/png"

    with open(args.output, "wb") as f:
        f.write(raw)
    return {"ok": True, "output": args.output, "mime_type": mime, "model": model}


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def main() -> int:
    parser = argparse.ArgumentParser(
        description="Generate one image with Google Gemini Nano Banana."
    )
    parser.add_argument("--prompt", default="", help="Text prompt for the image.")
    parser.add_argument(
        "--prompt-file",
        default="",
        help="Path to a .txt file containing the prompt (overrides --prompt).",
    )
    parser.add_argument(
        "--model",
        default=load_model_config()["image_model"],
        help="Gemini image model id (default from config_states/gemini_models.txt).",
    )
    parser.add_argument("--output", required=True, help="Output PNG file path.")
    parser.add_argument(
        "--aspect-ratio",
        default=None,
        help="e.g. 1:1, 16:9, 9:16, 4:5, 3:2 (omit for model default).",
    )
    parser.add_argument(
        "--image-size",
        default=None,
        help="e.g. 1K, 2K, 4K, 512px (omit for model default).",
    )
    parser.add_argument(
        "--image",
        action="append",
        default=[],
        metavar="PATH",
        help="Reference image path, repeatable (prompt + images = image editing).",
    )
    parser.add_argument(
        "--api-key",
        default=os.environ.get("GEMINI_API_KEY", ""),
        help="Gemini API key (or set GEMINI_API_KEY env var).",
    )
    args = parser.parse_args()

    try:
        result = generate(args)
    except Exception as exc:  # noqa: BLE001 - report any failure as JSON
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 1

    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
