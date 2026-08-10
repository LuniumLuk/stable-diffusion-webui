"""
gemini_nano_banana.py — Google Gemini "Nano Banana" image generation.

Generates EXACTLY ONE image per API call and returns it as a PIL.Image.

The heavy lifting runs in a SEPARATE venv (`gemini_workflow/venv`) that holds
the `google-genai` SDK, because installing it in the webui root `.venv` would
break the pinned gradio/fastapi/pydantic versions. This module auto-creates
that venv on first use (one-time cost).

API key resolution order:
  1. `api_key=` argument / UI textbox
  2. saved key in `config_states/gemini_nano_banana.txt` (txt config file)
  3. `GEMINI_API_KEY` environment variable

Usage (CLI):
  python scripts/gemini_nano_banana.py --prompt "a cyberpunk cat" \
      [--model gemini-2.5-flash-image] [--aspect-ratio 16:9] [--image-size 1K] \
      [--out outputs/nano-banana]

  # Prompt from a .txt file:
  python scripts/gemini_nano_banana.py --prompt-file prompt.txt

  # With reference image(s) for editing / style transfer:
  python scripts/gemini_nano_banana.py \
      --prompt "change the background to a neon city" --image ref.png \
      [--image ref2.png ...]

Programmatic:
  from scripts.gemini_nano_banana import generate_image
  img = generate_image("a cyberpunk cat")          # -> PIL.Image
  img = generate_image("make it a neon city", reference_images=["ref.png"])
  img = generate_image(prompt_file="prompt.txt")
"""
import argparse
import datetime
import importlib.util
import json
import os
import subprocess
import sys

from PIL import Image

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_ROOT_DIR   = os.path.dirname(_SCRIPT_DIR)

WORKFLOW_DIR    = os.path.join(_ROOT_DIR, "gemini_workflow")
WORKFLOW_PY     = os.path.join(WORKFLOW_DIR, "generate.py")
WORKFLOW_VENV   = os.path.join(WORKFLOW_DIR, "venv")
WORKFLOW_PYTHON = os.path.join(WORKFLOW_VENV, "Scripts", "python.exe")  # Windows
if not os.path.exists(WORKFLOW_PYTHON):
    WORKFLOW_PYTHON = os.path.join(WORKFLOW_VENV, "bin", "python")      # POSIX

OUTPUT_DIR   = os.path.join(_ROOT_DIR, "outputs", "nano-banana")
CONFIG_FILE  = os.path.join(_ROOT_DIR, "config_states", "gemini_nano_banana.txt")

# ---------------------------------------------------------------------------
# Model / option choices
# ---------------------------------------------------------------------------
MODEL_CHOICES = [
    "gemini-2.5-flash-image",        # Nano Banana        (legacy workhorse)
    "gemini-3.1-flash-lite-image",   # Nano Banana 2 Lite (cheapest/fastest)
    "gemini-3.1-flash-image",        # Nano Banana 2      (recommended)
    "gemini-3-pro-image",            # Nano Banana Pro    (premium)
]


def _default_image_model() -> str:
    """Image-model default from config_states/gemini_models.txt (shared file)."""
    fallback = "gemini-2.5-flash-image"
    try:
        spec = importlib.util.spec_from_file_location(
            "gemini_models_config",
            os.path.join(_ROOT_DIR, "gemini_workflow", "models_config.py"),
        )
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod.load_model_config().get("image_model") or fallback
    except Exception:
        return fallback


DEFAULT_MODEL = _default_image_model()
if DEFAULT_MODEL not in MODEL_CHOICES:
    MODEL_CHOICES = [DEFAULT_MODEL] + MODEL_CHOICES
ASPECT_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4",
                 "9:16", "16:9", "21:9", "1:4", "4:1"]
IMAGE_SIZES   = ["1K", "2K", "4K", "512px"]

# ---------------------------------------------------------------------------
# API key handling (dedicated txt config file)
# ---------------------------------------------------------------------------
def _read_key_from_config() -> str:
    """Parse config_states/gemini_nano_banana.txt.

    Accepted forms (first match wins):
      GEMINI_API_KEY=xxx  /  api_key=xxx  /  key=xxx   (key name case-insensitive)
      a bare line holding only the key
    Lines starting with '#' are comments; unknown key=value lines are skipped.
    """
    if not os.path.exists(CONFIG_FILE):
        return ""
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            for raw in f:
                line = raw.strip()
                if not line or line.startswith("#"):
                    continue
                if "=" in line:
                    name, _, value = line.partition("=")
                    if name.strip().lower() in ("gemini_api_key", "api_key", "key"):
                        return value.strip()
                    continue  # unknown setting: skip
                return line  # bare key
    except Exception:
        return ""
    return ""


def get_api_key(override: str = "") -> str:
    """Resolve API key: override > config txt > GEMINI_API_KEY env var."""
    if override and override.strip():
        return override.strip()
    key = _read_key_from_config()
    if key:
        return key
    return os.environ.get("GEMINI_API_KEY", "").strip()


def save_api_key(key: str) -> None:
    """Persist the API key to config_states/gemini_nano_banana.txt."""
    if not key or not key.strip():
        return
    os.makedirs(os.path.dirname(CONFIG_FILE), exist_ok=True)
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        f.write("# Gemini Nano Banana API key\n")
        f.write("# Get one at https://aistudio.google.com/apikey\n")
        f.write(f"GEMINI_API_KEY={key.strip()}\n")


# ---------------------------------------------------------------------------
# Workflow venv bootstrap (one-time)
# ---------------------------------------------------------------------------
def ensure_workflow_venv(verbose: bool = True) -> str:
    """Return the workflow venv python path, creating + installing if needed."""
    if os.path.exists(WORKFLOW_PYTHON):
        return WORKFLOW_PYTHON

    os.makedirs(WORKFLOW_DIR, exist_ok=True)
    if verbose:
        print("[nano-banana] creating workflow venv ...")
    subprocess.run([sys.executable, "-m", "venv", WORKFLOW_VENV], check=True)

    def _pip(*args: str) -> None:
        subprocess.run([WORKFLOW_PYTHON, "-m", "pip"] + list(args),
                       check=True, stdout=subprocess.DEVNULL if not verbose else None)

    if verbose:
        print("[nano-banana] installing google-genai SDK (one-time) ...")
    _pip("install", "--upgrade", "pip")
    _pip("install", "google-genai")
    if verbose:
        print("[nano-banana] workflow venv ready.")
    return WORKFLOW_PYTHON


# ---------------------------------------------------------------------------
# Core: generate ONE image and return it
# ---------------------------------------------------------------------------
_LAST_OUTPUT_PATH = None  # path of the most recently generated image


def generate_image(
    prompt: str = "",
    prompt_file: str = "",
    model: str = DEFAULT_MODEL,
    api_key: str = "",
    aspect_ratio: str = "",
    image_size: str = "",
    reference_images=None,
    output_dir: str = "",
    save: bool = True,
    timeout: int = 300,
) -> Image.Image:
    """Generate exactly one image with Gemini Nano Banana.

    Args:
        prompt: text prompt. With reference images this describes the edit
            (e.g. "change the background to a neon city").
        prompt_file: path to a .txt file containing the prompt (UTF-8).
            Overrides `prompt` and avoids command-line length limits.
        reference_images: optional list of image file paths passed to the API
            as reference inputs (edit / style transfer / composition).

    Returns a PIL.Image. When `save` is True (default) the PNG is also
    persisted to ``outputs/nano-banana/YYYY-MM-DD/`` with a .txt sidecar.
    """
    if prompt_file:
        if not os.path.exists(prompt_file):
            raise ValueError(f"Prompt file not found: {prompt_file}")
        with open(prompt_file, "r", encoding="utf-8") as f:
            prompt = f.read().strip()
    if not prompt or not prompt.strip():
        raise ValueError("prompt must not be empty (pass --prompt or --prompt-file).")

    key = get_api_key(api_key)
    if not key:
        raise RuntimeError(
            "No Gemini API key found. Set the GEMINI_API_KEY env var, pass "
            "api_key=..., or save a key in the Nano Banana tab."
        )

    python = ensure_workflow_venv()

    out_root = output_dir or OUTPUT_DIR
    day_dir = os.path.join(out_root, datetime.date.today().strftime("%Y-%m-%d"))
    os.makedirs(day_dir, exist_ok=True)
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    out_path = os.path.join(day_dir, f"nano_banana_{stamp}.png")

    cmd = [
        python, WORKFLOW_PY,
        "--model", model,
        "--output", out_path,
    ]
    if prompt_file:
        cmd += ["--prompt-file", prompt_file]
    else:
        cmd += ["--prompt", prompt]
    if aspect_ratio:
        cmd += ["--aspect-ratio", aspect_ratio]
    if image_size:
        cmd += ["--image-size", image_size]
    for ref in (reference_images or []):
        cmd += ["--image", ref]

    env = dict(os.environ)
    env["GEMINI_API_KEY"] = key  # key via env, not argv (avoids process-list leak)

    proc = subprocess.run(
        cmd, capture_output=True, text=True, encoding="utf-8", env=env,
        timeout=timeout,
    )

    try:
        result = json.loads(proc.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        result = {"ok": False, "error": proc.stderr.strip() or "unparseable output"}

    if not result.get("ok"):
        raise RuntimeError(
            f"Gemini API call failed: {result.get('error', 'unknown error')}"
        )

    if not os.path.exists(out_path):
        raise RuntimeError("Workflow finished but the output PNG is missing.")

    # Write the .txt sidecar (repo convention: PNG + txt sidecar for prompts)
    try:
        with open(os.path.splitext(out_path)[0] + ".txt", "w", encoding="utf-8") as f:
            f.write(prompt + "\n")
            f.write(f"Model: {model}\n")
            if aspect_ratio:
                f.write(f"Aspect ratio: {aspect_ratio}\n")
            if image_size:
                f.write(f"Image size: {image_size}\n")
            if reference_images:
                f.write("Reference images: "
                        + ", ".join(os.path.basename(p) for p in reference_images)
                        + "\n")
    except Exception:
        pass

    global _LAST_OUTPUT_PATH
    _LAST_OUTPUT_PATH = out_path

    if save:
        return Image.open(out_path).convert("RGB")
    return out_path


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def cli_main() -> int:
    parser = argparse.ArgumentParser(
        description="Generate one image with Google Gemini Nano Banana and save it."
    )
    parser.add_argument("--prompt", default="", help="Text prompt for the image.")
    parser.add_argument("--prompt-file", default="",
                        help="Path to a .txt file containing the prompt (overrides --prompt).")
    parser.add_argument("--model", default=DEFAULT_MODEL, choices=MODEL_CHOICES,
                        help=f"Gemini image model (default: {DEFAULT_MODEL}).")
    parser.add_argument("--aspect-ratio", default="",
                        help="e.g. 1:1, 16:9, 9:16 (omit for model default).")
    parser.add_argument("--image-size", default="",
                        help="e.g. 1K, 2K, 4K (omit for model default).")
    parser.add_argument("--image", action="append", default=[], metavar="PATH",
                        help="Reference image path, repeatable (image editing).")
    parser.add_argument("--api-key", default="",
                        help="Gemini API key (or GEMINI_API_KEY env var).")
    parser.add_argument("--out", default="",
                        help="Output directory (default: outputs/nano-banana).")
    parser.add_argument("--no-save", action="store_true",
                        help="Do not save; just print the generated image path.")
    args = parser.parse_args()

    try:
        generate_image(
            prompt=args.prompt,
            prompt_file=args.prompt_file,
            model=args.model,
            api_key=args.api_key,
            aspect_ratio=args.aspect_ratio,
            image_size=args.image_size,
            reference_images=args.image or None,
            output_dir=args.out,
            save=not args.no_save,
        )
    except Exception as exc:  # noqa: BLE001 - CLI should always report cleanly
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    print("OK: image generated.")
    if _LAST_OUTPUT_PATH:
        print(f"Path: {_LAST_OUTPUT_PATH}")
    return 0


# ---------------------------------------------------------------------------
# Gradio tab
# ---------------------------------------------------------------------------
def on_ui_tabs():
    import gradio as gr

    default_key = get_api_key()

    with gr.Blocks() as tab:
        gr.Markdown(
            "## 🍌 Nano Banana — Google Gemini image generation\n"
            "Generates **one image per call** via the official Gemini API. "
            "Set your API key once (from [Google AI Studio](https://aistudio.google.com/apikey)).\n"
            "Optionally add **reference image(s)** to edit them with the prompt "
            "(e.g. \"change the background to a neon city\"), or load the prompt "
            "from a **.txt file** (overrides the box)."
        )
        with gr.Row():
            with gr.Column(scale=2):
                prompt = gr.Textbox(
                    lines=4, label="Prompt",
                    placeholder="e.g. a cyberpunk cat with a neon sign, cinematic lighting",
                )
                prompt_file = gr.File(
                    label="Prompt file (.txt, optional — overrides the box)",
                    file_types=[".txt"],
                )
                with gr.Row():
                    model = gr.Dropdown(
                        choices=MODEL_CHOICES, value=DEFAULT_MODEL,
                        label="Model", info="Nano Banana = gemini-2.5-flash-image",
                    )
                    aspect = gr.Dropdown(
                        choices=["Auto"] + ASPECT_RATIOS, value="Auto",
                        label="Aspect ratio",
                    )
                    size = gr.Dropdown(
                        choices=["Auto"] + IMAGE_SIZES, value="Auto",
                        label="Image size",
                    )
                ref_files = gr.Files(
                    label="Reference image(s) (optional)", file_types=["image"],
                )
                with gr.Row():
                    api_key_box = gr.Textbox(
                        value=default_key, type="password", label="Gemini API Key",
                        placeholder="GEMINI_API_KEY",
                    )
                    save_key_btn = gr.Button("💾 Save Key", variant="secondary")
                gen_btn = gr.Button("✨ Generate (1 image)", variant="primary")
                status = gr.Markdown("_Ready._")
            with gr.Column():
                out_img = gr.Image(label="Result", type="pil")

        def _generate(prompt_text, model_id, aspect_val, size_val, key_val, ref_paths, prompt_file_path):
            try:
                img = generate_image(
                    prompt=prompt_text, model=model_id, api_key=key_val or "",
                    prompt_file=prompt_file_path or "",
                    aspect_ratio="" if aspect_val == "Auto" else aspect_val,
                    image_size="" if size_val == "Auto" else size_val,
                    reference_images=list(ref_paths) if ref_paths else None,
                )
                return img, "✅ Generated. Saved to `outputs/nano-banana/`."
            except Exception as exc:  # noqa: BLE001 - surface error to the UI
                return None, f"❌ {exc}"

        def _save_key(key_val):
            if not key_val or not key_val.strip():
                return "⚠️ Key is empty — nothing saved."
            save_api_key(key_val)
            return "✅ API key saved to `config_states/gemini_nano_banana.txt`."

        gen_btn.click(_generate, [prompt, model, aspect, size, api_key_box, ref_files, prompt_file],
                      [out_img, status])
        save_key_btn.click(_save_key, [api_key_box], [status])

    return [(tab, "🍌 Nano Banana", "nano_banana")]


def _register_webui_tab():
    """Register the Gradio tab when loaded inside the webui.

    Standalone CLI runs must NOT import `modules` (it drags in torch/xformers
    and only works inside the webui process), so the integration is lazy.
    """
    try:
        from modules import script_callbacks
    except Exception:
        return
    script_callbacks.on_ui_tabs(on_ui_tabs)


_register_webui_tab()


if __name__ == "__main__":
    sys.exit(cli_main())
