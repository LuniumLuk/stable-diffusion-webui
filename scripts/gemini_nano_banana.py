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
# Multi-tool page helpers (Image Maker / Comic Maker / LoRA Data Maker)
# ---------------------------------------------------------------------------
WORKFLOW_SCRIPTS = {
    "image_maker": os.path.join(WORKFLOW_DIR, "image_maker.py"),
    "comic_maker": os.path.join(WORKFLOW_DIR, "comic_maker.py"),
    "lora_data_maker": os.path.join(WORKFLOW_DIR, "lora_data_maker.py"),
}

# outputs/<dir> -> gallery source id (source rows live in modules/gallery_db.py)
_GALLERY_DIR_SOURCES = (
    ("nano-banana", "nano_banana"),
    ("image_maker", "image_maker"),
    ("comic_maker", "comic_maker"),
    ("lora_data_maker", "lora_data_maker"),
)

IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp")


def _run_workflow(script_key, args, api_key="", timeout=3600):
    """Run a gemini_workflow CLI in its own venv; return (result_json, log_tail)."""
    python = ensure_workflow_venv(verbose=False)
    env = dict(os.environ)
    key = get_api_key(api_key)
    if key:
        env["GEMINI_API_KEY"] = key
    cmd = [python, WORKFLOW_SCRIPTS[script_key]] + [str(a) for a in args]
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                          env=env, timeout=timeout)
    result = None
    for line in reversed((proc.stdout or "").strip().splitlines()):
        try:
            result = json.loads(line)
            break
        except ValueError:
            continue
    if result is None:
        result = {"ok": False,
                  "error": (proc.stderr or "").strip() or "no JSON result on stdout"}
    log = ((proc.stdout or "") + "\n" + (proc.stderr or "")).strip()
    return result, log[-3000:]


def _prompt_to_file(text, prefix):
    """Persist a textarea prompt as a UTF-8 .txt for the workflow CLIs."""
    text = (text or "").strip()
    if not text:
        return ""
    folder = os.path.join(_ROOT_DIR, "tmp", "gemini_tab_prompts")
    os.makedirs(folder, exist_ok=True)
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    path = os.path.join(folder, "%s_%s.txt" % (prefix, stamp))
    with open(path, "w", encoding="utf-8") as f:
        f.write(text + "\n")
    return path


def _iter_images(paths):
    """Expand dirs/files into a sorted list of image paths."""
    found = []
    for p in paths or []:
        if not p:
            continue
        if os.path.isdir(p):
            for root_dir, _dirs, files in os.walk(p):
                for fn in files:
                    if fn.lower().endswith(IMAGE_EXTS):
                        found.append(os.path.join(root_dir, fn))
        elif os.path.isfile(p) and p.lower().endswith(IMAGE_EXTS):
            found.append(p)
    return sorted(found)


def register_run_outputs(paths):
    """Index freshly generated files into gallery.db so Gallery v2 sees them.

    Returns (indexed_count, error_message). No-op outside the webui process.
    """
    try:
        from modules import gallery_db, gallery_sources
    except Exception as exc:  # standalone CLI mode
        return 0, "gallery modules unavailable (%s)" % exc
    images = _iter_images(paths)
    if not images:
        return 0, ""
    try:
        by_id = {s["id"]: s for s in gallery_db.get_sources()}
        indexed = 0
        for p in images:
            rel = os.path.relpath(os.path.abspath(p), _ROOT_DIR).replace("\\", "/")
            source_id = ""
            for prefix, sid in _GALLERY_DIR_SOURCES:
                if rel.startswith(prefix + "/"):
                    source_id = sid
                    break
            if not source_id:
                continue
            parser = (by_id.get(source_id) or {}).get("parser") or "a1111"
            if gallery_sources.index_item(p, source_id, parser):
                indexed += 1
        return indexed, ""
    except Exception as exc:  # noqa: BLE001 - never fail a generation over indexing
        return 0, "indexing failed (%s)" % exc


def _fail_message(result, log):
    err = result.get("error")
    if err is None:
        fails = result.get("failures") or []
        if fails and isinstance(fails[0], dict):
            err = fails[0].get("example")
    if not err:
        err = (log or "")[-500:]
    return "\u274C %s" % str(err)[:700]


def _done_message(result, images, indexed, extra="", idx_err=""):
    rel = ""
    out_dir = result.get("output_dir") or result.get("training_dir") or ""
    if out_dir:
        try:
            rel = os.path.relpath(out_dir, _ROOT_DIR).replace("\\", "/")
        except ValueError:
            rel = out_dir
    msg = "\u2705 Done \u2014 %d image(s)" % len(images)
    if rel:
        msg += " \u00B7 `%s`" % rel
    if extra:
        msg += " \u00B7 %s" % extra
    if indexed:
        msg += " \u00B7 %d indexed into the Gallery (hit Refresh there)" % indexed
    if idx_err:
        msg += " \u00B7 \u26A0\uFE0F %s" % idx_err
    return msg



# ---------------------------------------------------------------------------
# Gradio tab
# ---------------------------------------------------------------------------
def on_ui_tabs():
    import gradio as gr

    default_key = get_api_key()

    with gr.Blocks() as tab:
        gr.Markdown(
            "## \U0001F34C Nano Banana \u2014 Gemini image workflows\n"
            "One page for the whole Gemini pipeline: **single image**, "
            "**Image Maker** (character sheets \u2192 LoRA training set), "
            "**Comic Maker** (story \u2192 multi-page comic) and "
            "**LoRA Data Maker** (built-in randomized sheets). "
            "Results land in `outputs/` and are indexed into the Gallery automatically."
        )
        with gr.Row():
            api_key_box = gr.Textbox(
                value=default_key, type="password", label="Gemini API Key",
                placeholder="GEMINI_API_KEY",
            )
            save_key_btn = gr.Button("\U0001F4BE Save Key", variant="secondary")
        key_status = gr.Markdown("")

        def _save_key(key_val):
            if not key_val or not key_val.strip():
                return "\u26A0\uFE0F Key is empty \u2014 nothing saved."
            save_api_key(key_val)
            return "\u2705 API key saved to `config_states/gemini_nano_banana.txt`."

        save_key_btn.click(_save_key, [api_key_box], [key_status])

        with gr.Tabs():
            # ------------------------------------------------------------ single
            with gr.Tab("\u2728 Single image"):
                with gr.Row():
                    with gr.Column(scale=2):
                        prompt = gr.Textbox(
                            lines=4, label="Prompt",
                            placeholder="e.g. a cyberpunk cat with a neon sign, cinematic lighting",
                        )
                        prompt_file = gr.File(
                            label="Prompt file (.txt, optional \u2014 overrides the box)",
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
                        gen_btn = gr.Button("\u2728 Generate (1 image)", variant="primary")
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
                        indexed, _err = register_run_outputs([_LAST_OUTPUT_PATH])
                        msg = "\u2705 Generated. Saved to `outputs/nano-banana/`."
                        if indexed:
                            msg += " Indexed into the Gallery (hit Refresh there)."
                        return img, msg
                    except Exception as exc:  # noqa: BLE001 - surface error to the UI
                        return None, "\u274C %s" % exc

                gen_btn.click(_generate, [prompt, model, aspect, size, api_key_box, ref_files, prompt_file],
                              [out_img, status])

            # -------------------------------------------------------- image maker
            with gr.Tab("\U0001F5BC Image Maker"):
                gr.Markdown(
                    "Character-sheet pipeline: **single** mode runs a verbatim prompt "
                    "(optional grid split); sheet modes (**face / upper / fullbody / all**) "
                    "take avatar + reference images \u2014 sheets are split, captioned and "
                    "collected into `training_data/lora_<trigger>[_<outfit>]`."
                )
                with gr.Row():
                    im_prompt = gr.Textbox(lines=3, label="Prompt (used in single mode)")
                    im_prompt_file = gr.File(label="Prompt file (.txt, optional)", file_types=[".txt"])
                with gr.Row():
                    im_mode = gr.Radio(choices=["single", "face", "upper", "fullbody", "all"],
                                       value="single", label="Mode")
                    im_model = gr.Dropdown(choices=MODEL_CHOICES, value=DEFAULT_MODEL, label="Image model")
                    im_variations = gr.Slider(1, 8, value=1, step=1, label="Variations")
                with gr.Row():
                    im_avatar = gr.Files(label="Avatar image(s) \u2014 sheet modes", file_types=["image"])
                    im_refs = gr.Files(label="Reference image(s)", file_types=["image"])
                with gr.Row():
                    im_outfit = gr.Textbox(label="Outfit name (opt.)", placeholder="e.g. casual")
                    im_outfit_desc = gr.Textbox(label="Outfit description (opt.)",
                                                placeholder="e.g. blue sailor uniform, white thighhighs")
                    im_trigger = gr.Textbox(label="Trigger word (opt.)", placeholder="e.g. rana")
                with gr.Row():
                    im_grid_c = gr.Number(value=0, precision=0, label="Grid cols (single, 0=off)")
                    im_grid_r = gr.Number(value=0, precision=0, label="Grid rows")
                    im_grid_p = gr.Number(value=8, precision=0, label="Grid padding px")
                    im_aspect = gr.Dropdown(choices=["Auto"] + ASPECT_RATIOS, value="Auto", label="Aspect ratio")
                    im_size = gr.Dropdown(choices=["Auto"] + IMAGE_SIZES, value="Auto", label="Image size")
                im_run = gr.Button("\U0001F680 Run Image Maker", variant="primary")
                im_status = gr.Markdown("_Ready._")
                im_preview = gr.Gallery(label="This run", columns=6, height=280)

                def _run_image_maker(prompt_text, prompt_file_path, mode, avatar, refs,
                                     outfit, outfit_desc, trigger, variations,
                                     grid_c, grid_r, grid_p, aspect_val, size_val, model_id, key_val):
                    try:
                        args = []
                        mode_val = (mode or "single").strip()
                        if mode_val != "single":
                            avatar = list(avatar or [])
                            if not avatar:
                                return [], "\u274C sheet mode needs at least one avatar image"
                            args += ["--mode", mode_val]
                            for a in avatar:
                                args += ["--avatar", a]
                            if outfit and outfit.strip():
                                args += ["--outfit", outfit.strip()]
                            if outfit_desc and outfit_desc.strip():
                                args += ["--outfit-desc", outfit_desc.strip()]
                            if trigger and trigger.strip():
                                args += ["--trigger", trigger.strip()]
                        else:
                            pf = prompt_file_path or _prompt_to_file(prompt_text, "image_maker")
                            if not pf:
                                return [], "\u274C provide a prompt (box or .txt), or pick a sheet mode"
                            args += ["--prompt-file", pf]
                            gc = int(grid_c or 0)
                            rc = int(grid_r or 0)
                            if gc > 0 and rc > 0:
                                args += ["--grid", gc, rc, "--grid-padding", int(grid_p or 0)]
                        if refs:
                            args += ["--ref-images"] + list(refs)
                        args += ["--variations", int(variations or 1), "--image-model", model_id]
                        if aspect_val and aspect_val != "Auto":
                            args += ["--aspect-ratio", aspect_val]
                        if size_val and size_val != "Auto":
                            args += ["--image-size", size_val]
                        result, log = _run_workflow("image_maker", args, key_val)
                        if not result.get("ok"):
                            return [], _fail_message(result, log)
                        out_dir = result.get("output_dir") or ""
                        images = _iter_images([out_dir])[:30]
                        indexed, idx_err = register_run_outputs([out_dir])
                        summary = result.get("summary") or {}
                        extra = "%s/%s panels" % (summary.get("succeeded", "?"),
                                                  summary.get("expected", "?"))
                        return images, _done_message(result, images, indexed, extra, idx_err)
                    except Exception as exc:  # noqa: BLE001
                        return [], "\u274C %s" % exc

                im_run.click(_run_image_maker,
                             [im_prompt, im_prompt_file, im_mode, im_avatar, im_refs,
                              im_outfit, im_outfit_desc, im_trigger, im_variations,
                              im_grid_c, im_grid_r, im_grid_p, im_aspect, im_size, im_model, api_key_box],
                             [im_preview, im_status])

            # -------------------------------------------------------- comic maker
            with gr.Tab("\U0001F4D6 Comic Maker"):
                gr.Markdown(
                    "Story \u2192 multi-page comic: the root prompt is expanded into N page "
                    "prompts by the text model, then each page is rendered with the image model."
                )
                with gr.Row():
                    cm_prompt = gr.Textbox(lines=4, label="Story / root prompt")
                    cm_prompt_file = gr.File(label="Root prompt file (.txt, optional)", file_types=[".txt"])
                with gr.Row():
                    cm_pages = gr.Slider(1, 12, value=4, step=1, label="Pages")
                    cm_variations = gr.Slider(1, 4, value=1, step=1, label="Variations / page")
                    cm_model = gr.Dropdown(choices=MODEL_CHOICES, value=DEFAULT_MODEL, label="Image model")
                    cm_aspect = gr.Dropdown(choices=["Auto"] + ASPECT_RATIOS, value="3:4", label="Aspect ratio")
                cm_refs = gr.Files(label="Reference image(s) for all pages (optional)", file_types=["image"])
                cm_dry = gr.Checkbox(value=False, label="Dry run (text expansion only \u2014 no image calls)")
                cm_run = gr.Button("\U0001F680 Run Comic Maker", variant="primary")
                cm_status = gr.Markdown("_Ready._")
                cm_preview = gr.Gallery(label="This run", columns=6, height=280)

                def _run_comic(prompt_text, prompt_file_path, pages, variations, aspect_val,
                               refs, dry, model_id, key_val):
                    try:
                        pf = prompt_file_path or _prompt_to_file(prompt_text, "comic_maker")
                        if not pf:
                            return [], "\u274C provide the story prompt (box or .txt)"
                        args = ["--root-prompt-file", pf, "--pages", int(pages),
                                "--variations", int(variations), "--image-model", model_id]
                        if aspect_val and aspect_val != "Auto":
                            args += ["--aspect-ratio", aspect_val]
                        if refs:
                            args += ["--ref-images"] + list(refs)
                        if dry:
                            args += ["--dry-run"]
                        result, log = _run_workflow("comic_maker", args, key_val)
                        if not result.get("ok"):
                            return [], _fail_message(result, log)
                        if dry:
                            return [], "\u2705 Dry run ok \u2014 page prompts expanded (no image calls)."
                        out_dir = result.get("output_dir") or ""
                        images = _iter_images([out_dir])[:30]
                        indexed, idx_err = register_run_outputs([out_dir])
                        msg = _done_message(result, images, indexed, "", idx_err)
                        errs = result.get("errors") or {}
                        if errs:
                            msg += " \u00B7 \u26A0\uFE0F some page(s) had failures"
                        return images, msg
                    except Exception as exc:  # noqa: BLE001
                        return [], "\u274C %s" % exc

                cm_run.click(_run_comic,
                             [cm_prompt, cm_prompt_file, cm_pages, cm_variations, cm_aspect,
                              cm_refs, cm_dry, cm_model, api_key_box],
                             [cm_preview, cm_status])

            # ---------------------------------------------------- lora data maker
            with gr.Tab("\U0001F3A8 LoRA Data Maker"):
                gr.Markdown(
                    "Built-in randomized prompt pools (no prompt files): avatar \u2192 face "
                    "sheets, avatar + outfit pictures \u2192 upper/fullbody sheets; panels + "
                    "optional captions are collected into `training_data/lora_<trigger>`."
                )
                with gr.Row():
                    ld_avatar = gr.Files(label="Avatar image(s) \u2014 required", file_types=["image"])
                    ld_fullbody = gr.Files(label="Outfit / fullbody image(s)", file_types=["image"])
                with gr.Row():
                    ld_trigger = gr.Textbox(label="Trigger word (opt.)", placeholder="e.g. rana")
                    ld_style = gr.Textbox(label="Pin one style tag (opt.)",
                                          placeholder="e.g. monochrome grayscale")
                    ld_variations = gr.Slider(1, 3, value=1, step=1, label="Variations")
                    ld_seed = gr.Number(value=0, precision=0, label="Seed (0 = random)")
                with gr.Row():
                    ld_captions = gr.Checkbox(value=True, label="Write kohya .txt captions")
                    ld_dry = gr.Checkbox(value=False, label="Dry run (plan only \u2014 no API calls)")
                    ld_model = gr.Dropdown(choices=MODEL_CHOICES, value=DEFAULT_MODEL, label="Image model")
                ld_run = gr.Button("\U0001F680 Run LoRA Data Maker", variant="primary")
                ld_status = gr.Markdown("_Ready._")
                ld_preview = gr.Gallery(label="Raw sheets of this run", columns=6, height=280)

                def _run_lora(avatar, fullbody, trigger, style, variations, seed,
                              captions, dry, model_id, key_val):
                    try:
                        avatar = list(avatar or [])
                        if not avatar:
                            return [], "\u274C at least one avatar image is required"
                        args = ["--avatar"] + avatar
                        if fullbody:
                            args += ["--fullbody"] + list(fullbody)
                        if trigger and trigger.strip():
                            args += ["--trigger", trigger.strip()]
                        if style and style.strip():
                            args += ["--style", style.strip()]
                        args += ["--variations", int(variations or 1)]
                        if seed and int(seed or 0) > 0:
                            args += ["--seed", int(seed)]
                        if captions:
                            args += ["--captions"]
                        args += ["--image-model", model_id]
                        if dry:
                            args += ["--dry-run"]
                        result, log = _run_workflow("lora_data_maker", args, key_val)
                        if not result.get("ok"):
                            return [], _fail_message(result, log)
                        if dry:
                            return [], "\u2705 Dry run ok \u2014 plan built (no API calls)."
                        out_dir = result.get("output_dir") or ""
                        images = _iter_images([out_dir])[:30]
                        indexed, idx_err = register_run_outputs([out_dir])
                        summary = result.get("summary") or {}
                        extra = "%s panels \u2192 training_data" % summary.get("succeeded", "?")
                        msg = _done_message(result, images, indexed, extra, idx_err)
                        errs = result.get("failures") or []
                        if errs:
                            msg += " \u00B7 \u26A0\uFE0F some sheets failed"
                        return images, msg
                    except Exception as exc:  # noqa: BLE001
                        return [], "\u274C %s" % exc

                ld_run.click(_run_lora,
                             [ld_avatar, ld_fullbody, ld_trigger, ld_style, ld_variations, ld_seed,
                              ld_captions, ld_dry, ld_model, api_key_box],
                             [ld_preview, ld_status])

    return [(tab, "\U0001F34C Nano Banana", "nano_banana")]



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
