"""
gemini_workflow/comic_maker.py — generate a multi-page comic with Google Gemini.

Pipeline:
  1. Load a "root prompt" (story concept) from a .txt file.
  2. Feed it to a Gemini TEXT model (txt2txt) to expand it into N page prompts.
  3. Feed each page prompt + that page's reference images to a Nano Banana
     IMAGE model to render the page.
  4. Every API call is retried up to --retries times (default 3) on errors
     such as safety blocks ("cannot generate unsafe image"), rate limits, etc.

Usage:
  <workflow-python> comic_maker.py --root-prompt-file story.txt --pages 4 \
      [--text-model gemini-3.5-flash] [--image-model gemini-2.5-flash-image] \
      [--ref-dir refs] [--aspect-ratio 3:4] [--image-size 1K] \
      [--output-dir outputs/comic_maker] [--retries 3] [--variations 1] \
      [--api-key KEY]

  # N variations per page (same prompt + refs, each with its own retry budget):
  <workflow-python> comic_maker.py --root-prompt-file story.txt --pages 4 \
      --variations 2   # -> page_01_v01.png, page_01_v02.png, page_02_v01.png, ...

Reference image layout (--ref-dir, optional):
  refs/
    page1/   a.png   b.png       <- references used when rendering page 1
    page2/   style.png           <- references used when rendering page 2
  If refs/page<N>/ is missing, that page is rendered without references.

API key: --api-key > GEMINI_API_KEY env > config_states/gemini_nano_banana.txt.
Output lands in outputs/comic_maker/YYYY-MM-DD/HHMMSS/ (unique per run).
Result is printed to stdout as a JSON object; exit code 0 if every page
rendered, 1 otherwise.
"""
import argparse
import base64
import datetime
import json
import os
import re
import sys
import time

_WORKFLOW_DIR = os.path.dirname(os.path.abspath(__file__))
if _WORKFLOW_DIR not in sys.path:
    sys.path.insert(0, _WORKFLOW_DIR)

from generate import _encode_image, _make_client, _run_with_proxy_fallback  # noqa: E402
from models_config import load_model_config  # noqa: E402

_ROOT_DIR = os.path.dirname(_WORKFLOW_DIR)
DEFAULT_OUTPUT_DIR = os.path.join(_ROOT_DIR, "outputs", "comic_maker")
_IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp")


# ---------------------------------------------------------------------------
# Input helpers
# ---------------------------------------------------------------------------
def _load_root_prompt(path: str) -> str:
    if not os.path.exists(path):
        raise RuntimeError(f"Root prompt file not found: {path}")
    with open(path, "r", encoding="utf-8") as f:
        prompt = f.read().strip()
    if not prompt:
        raise RuntimeError("Root prompt file is empty.")
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


# ---------------------------------------------------------------------------
# Retry
# ---------------------------------------------------------------------------
def with_retry(fn, what: str, retries: int = 3):
    """Call fn(); on any exception retry up to `retries` times with backoff."""
    for attempt in range(retries + 1):  # 1 initial attempt + `retries` retries
        try:
            return fn()
        except Exception as exc:  # noqa: BLE001 - retry on any API error
            if attempt >= retries:
                raise
            delay = 2 ** (attempt + 1)
            print(
                f"[comic_maker] {what} failed (attempt {attempt + 1}/{retries + 1}): "
                f"{str(exc)[:160]} — retrying in {delay}s",
                flush=True,
            )
            time.sleep(delay)


# ---------------------------------------------------------------------------
# Step 1: root prompt -> page prompts (txt2txt)
# ---------------------------------------------------------------------------
_PAGE_MARKER_RE = re.compile(
    r"^\s*[*=\-]*\s*PAGE\s*(\d+)\s*[*=\-:]*\s*$", re.IGNORECASE | re.MULTILINE
)


def _parse_page_prompts(text: str, n_pages: int):
    """Extract n_pages prompts from the text model output.

    Primary format: marker-delimited blocks ('=== PAGE 1 ===', 'PAGE 1:',
    '--- PAGE 1 ---', ...). Falls back to a JSON array, then to numbered or
    plain lines — but ONLY when the count matches n_pages exactly, so prompts
    that contain their own numbered sections ('1)', '2)', ...) are never
    silently mis-split.
    """
    text = text.strip()

    # 1) Marker-delimited blocks
    markers = list(_PAGE_MARKER_RE.finditer(text))
    if markers:
        blocks = []
        for idx, m in enumerate(markers):
            start = m.end()
            end = markers[idx + 1].start() if idx + 1 < len(markers) else len(text)
            blocks.append((int(m.group(1)), text[start:end].strip()))
        blocks.sort(key=lambda x: x[0])  # order by page number, not occurrence
        prompts = []
        for _, content in blocks:
            cleaned = re.sub(r"^```[^\n]*\n|```\s*$", "", content, flags=re.S).strip()
            if cleaned:
                prompts.append(cleaned)
        if len(prompts) >= n_pages:
            return prompts[:n_pages]

    # 2) JSON array fallback
    m = re.search(r"\[.*\]", text, re.S)
    if m:
        try:
            data = json.loads(m.group(0))
            if isinstance(data, list):
                prompts = [str(x).strip() for x in data if str(x).strip()]
                if prompts:
                    if len(prompts) < n_pages:
                        raise RuntimeError(
                            f"Text model returned only {len(prompts)} page prompts, "
                            f"expected {n_pages}."
                        )
                    return prompts[:n_pages]
        except RuntimeError:
            raise
        except Exception:
            pass  # not valid JSON -> fall through

    # 3) Numbered / plain-lines fallback — only when the count matches exactly
    numbered, plain = [], []
    for ln in text.splitlines():
        ln = ln.strip()
        if not ln:
            continue
        if re.match(r"^\s*\d+[.)\-:]\s*", ln):
            numbered.append(re.sub(r"^\s*\d+[.)\-:]\s*", "", ln).strip())
        else:
            plain.append(ln)
    if len(numbered) == n_pages:
        return numbered
    if len(plain) == n_pages and not numbered:
        return plain

    raise RuntimeError(
        f"Could not cleanly separate {n_pages} page prompts from the text model "
        f"output: no '=== PAGE N ===' markers, no valid JSON array, and "
        f"{len(numbered)} numbered / {len(plain)} plain lines found. "
        "Retry or adjust the root prompt."
    )


def generate_page_prompts(client, text_model: str, root_prompt: str, n_pages: int) -> str:
    instruction = (
        "You are a comic script writer for an AI image generator. "
        f"Given a story concept, write exactly {n_pages} detailed image-generation "
        "prompts, one per comic page, in chronological order. Each prompt must "
        "describe the composition, characters, actions, emotion, setting, camera "
        "angle, lighting and art style, and must work standalone as an image prompt. "
        f"Separate the page prompts with marker lines in this exact format: "
        f"'=== PAGE 1 ===', '=== PAGE 2 ===', ... up to '=== PAGE {n_pages} ==='. "
        "Each marker must be alone on its own line, immediately followed by that "
        "page's prompt. Do not wrap the page prompts in code blocks or any other "
        "markdown. "
        f"Output ONLY the {n_pages} marker-separated page prompts and nothing else."
    )
    interaction = _run_with_proxy_fallback(
        lambda: client.interactions.create(
            model=text_model,
            input=f"{instruction}\n\nStory concept:\n{root_prompt}",
        )
    )
    text = interaction.output_text
    if not text or not text.strip():
        raise RuntimeError("Text model returned no output.")
    return text


# ---------------------------------------------------------------------------
# Step 2: per-page image generation (prompt + reference images)
# ---------------------------------------------------------------------------
def ref_images_for_page(ref_dir: str, page_idx: int):
    """Return reference image paths for a page: <ref_dir>/page<idx>/."""
    if not ref_dir:
        return []
    folder = os.path.join(ref_dir, f"page{page_idx}")
    if not os.path.isdir(folder):
        return []
    return sorted(
        os.path.join(folder, fn)
        for fn in os.listdir(folder)
        if os.path.splitext(fn)[1].lower() in _IMAGE_EXTS
    )


def generate_page(client, image_model: str, page_prompt: str, ref_images,
                  output_path: str, aspect_ratio: str = "", image_size: str = "") -> None:
    content = [{"type": "text", "text": page_prompt}]
    for p in ref_images:
        mime, data = _encode_image(p)
        content.append({"type": "image", "data": data, "mime_type": mime})
    model_input = content if ref_images else page_prompt

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
        description="Generate a multi-page comic with Google Gemini."
    )
    parser.add_argument("--root-prompt-file", required=True,
                        help=".txt file containing the story concept (root prompt).")
    parser.add_argument("--pages", type=int, default=4,
                        help="Number of comic pages (default: 4).")
    _cfg = load_model_config()
    parser.add_argument("--text-model", default=_cfg["text_model"],
                        help="Text LLM that expands the root prompt into page prompts.")
    parser.add_argument("--image-model", default=_cfg["image_model"],
                        help="Nano Banana image model used to render each page.")
    parser.add_argument("--ref-dir", default="",
                        help="Directory with per-page reference images (refs/page1/, page2/, ...).")
    parser.add_argument("--aspect-ratio", default="3:4",
                        help="Output aspect ratio (default: 3:4).")
    parser.add_argument("--image-size", default="",
                        help="e.g. 1K, 2K (omit for model default).")
    parser.add_argument("--output-dir", default="",
                        help="Output directory (default: outputs/comic_maker/YYYY-MM-DD).")
    parser.add_argument("--retries", type=int, default=3,
                        help="Max retries per image on error (default: 3).")
    parser.add_argument("--variations", type=int, default=1,
                        help="Number of images to generate per page (default: 1). "
                             "Each variation uses the same prompt + references and "
                             "gets its own retry budget.")
    parser.add_argument("--dry-run", action="store_true",
                        help="Only expand the root prompt into page prompts (txt2txt); "
                             "print raw + parsed output and skip image generation.")
    parser.add_argument("--api-key", default="",
                        help="Gemini API key (or GEMINI_API_KEY env / config txt).")
    args = parser.parse_args()

    try:
        root_prompt = _load_root_prompt(args.root_prompt_file)
        api_key = _resolve_api_key(args)
        if not api_key:
            raise RuntimeError(
                "No Gemini API key. Set GEMINI_API_KEY, pass --api-key, or "
                "configure config_states/gemini_nano_banana.txt."
            )

        client = _make_client(api_key)

        # ---- Step 1: root prompt -> page prompts (txt2txt) ----------------
        print(f"[comic_maker] expanding root prompt into {args.pages} page prompts "
              f"with {args.text_model} ...", flush=True)
        raw_text = with_retry(
            lambda: generate_page_prompts(client, args.text_model, root_prompt, args.pages),
            "text-model call", args.retries,
        )
        page_prompts = _parse_page_prompts(raw_text, args.pages)
        print(f"[comic_maker] got {len(page_prompts)} page prompts.", flush=True)

        out_dir = args.output_dir or os.path.join(
            DEFAULT_OUTPUT_DIR,
            datetime.date.today().strftime("%Y-%m-%d"),
            datetime.datetime.now().strftime("%H%M%S"),
        )
        os.makedirs(out_dir, exist_ok=True)

        manifest_path = os.path.join(out_dir, "comic_prompts.txt")
        with open(manifest_path, "w", encoding="utf-8") as f:
            f.write("# Comic Maker root prompt\n")
            f.write(root_prompt + "\n\n")
            f.write(f"# Page prompts generated by {args.text_model}\n")
            for i, p in enumerate(page_prompts, 1):
                f.write(f"{i}. {p}\n")

        if args.dry_run:
            with open(os.path.join(out_dir, "raw_page_prompts.txt"), "w", encoding="utf-8") as f:
                f.write(raw_text)
            print("\n===== RAW TEXT MODEL OUTPUT =====", flush=True)
            print(raw_text, flush=True)
            print("===== END RAW OUTPUT =====", flush=True)
            print(f"\n===== PARSED {len(page_prompts)} PAGE PROMPTS (separated) =====", flush=True)
            for i, p in enumerate(page_prompts, 1):
                print(f"\n----- PAGE {i} -----", flush=True)
                print(p, flush=True)
            print(f"\n[dry-run] raw output + parsed prompts saved to {out_dir}", flush=True)
            return 0

        # ---- Step 2: render each page (N variations each) -----------------
        variations = max(1, args.variations)
        outputs, errors = {}, {}
        for i, page_prompt in enumerate(page_prompts, 1):
            refs = ref_images_for_page(args.ref_dir, i)
            page_paths, page_errs = [], []
            for v in range(1, variations + 1):
                out_path = os.path.join(out_dir, f"page_{i:02d}_v{v:02d}.png")
                print(f"[comic_maker] page {i}/{len(page_prompts)} variation "
                      f"{v}/{variations}: generating ({len(refs)} reference images) ...",
                      flush=True)
                try:
                    with_retry(
                        lambda: generate_page(
                            client, args.image_model, page_prompt, refs, out_path,
                            args.aspect_ratio, args.image_size,
                        ),
                        f"page {i} v{v} image call", args.retries,
                    )
                    page_paths.append(out_path)
                    print(f"[comic_maker] page {i} v{v} -> {out_path}", flush=True)
                except Exception as exc:  # noqa: BLE001 - continue next variation/page
                    page_errs.append((v, str(exc)))
                    print(f"[comic_maker] page {i} v{v} FAILED after retries: {exc}",
                          flush=True)
            outputs[str(i)] = page_paths
            if page_errs:
                errors[str(i)] = page_errs

        ok = not errors
        result = {
            "ok": ok,
            "text_model": args.text_model,
            "image_model": args.image_model,
            "pages": len(page_prompts),
            "variations": variations,
            "output_dir": out_dir,
            "manifest": manifest_path,
            "outputs": outputs,  # {page: [v1_path, v2_path, ...]}
            "errors": errors,    # {page: [(variation, message), ...]}
        }
        print(json.dumps(result, ensure_ascii=False), flush=True)
        return 0 if ok else 1

    except Exception as exc:  # noqa: BLE001 - report any failure as JSON
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), flush=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
