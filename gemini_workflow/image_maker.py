"""
gemini_workflow/image_maker.py -- merged LoRA data-preparation pipeline.

One python script + one bat entry (image_maker.bat) that covers the whole
LoRA dataset workflow on the Gemini "Nano Banana" image models:

  1. PLAN      face / upper / fullbody character sheets (one mode, or all)
  2. PROMPT    curated sheet prompts with a machine-readable GRID header and
               per-panel R{r}C{c} caption tags (tmp/lora_*.txt)
  3. GENERATE  one sheet image per prompt per variation (reference images
               attached for character / outfit identity)
  4. SPLIT     slice each sheet into its grid cells (trim --grid-padding px
               from every cell border to remove grid-line artifacts)
  5. CAPTION   kohya-style .txt tag file per training image
  6. COLLECT   copy every generated + separated image into a result folder
               training_data/lora_<trigger>[_<outfit>]/ + manifest.json

Legacy single-run CLI stays fully supported, e.g.:
  image_maker.bat --prompt-file .\\tmp\\lora_face.txt
      --ref-images .\\tmp\\images.jpg .\\tmp\\img_chara_rana.png
      --variations 1 --grid 3 2 --grid-padding 8
      --image-size 2K --aspect-ratio 1:1

Merged one-command dataset run (20 training images for one outfit):
  image_maker.bat --mode all --avatar .\\tmp\\img_chara_rana.png
      --ref-images .\\tmp\\body_rana.png
      --outfit casual --outfit-desc "blue sailor uniform, white thighhighs"

Grids: splitting is opt-in. In single mode each variation is saved as ONE
full image unless --grid COLS ROWS is passed explicitly (the prompt text is
never auto-interpreted as a grid). In --mode all, each stage prompt's GRID
header decides its sheet grid.

API key: --api-key > GEMINI_API_KEY env > config_states/gemini_nano_banana.txt.
Result is printed to stdout as a JSON object; exit code 0 when every
requested image rendered and collected, 1 otherwise.
"""
import argparse
import base64
import datetime
import json
import os
import re
import shutil
import sys
import time
from concurrent.futures import ThreadPoolExecutor

_WORKFLOW_DIR = os.path.dirname(os.path.abspath(__file__))
if _WORKFLOW_DIR not in sys.path:
    sys.path.insert(0, _WORKFLOW_DIR)

from generate import _encode_image, _make_client, _run_with_proxy_fallback  # noqa: E402
from models_config import load_model_config  # noqa: E402

_ROOT_DIR = os.path.dirname(_WORKFLOW_DIR)
DEFAULT_OUTPUT_DIR = os.path.join(_ROOT_DIR, "outputs", "image_maker")
DEFAULT_TRAINING_DIR = os.path.join(_ROOT_DIR, "training_data")
_IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp")

STAGES = ("face", "upper", "fullbody")

# Per-stage defaults used when the prompt file / CLI does not pin a value.
STAGE_DEFAULTS = {
    "face":     {"grid": (3, 2), "aspect": "1:1"},
    "upper":    {"grid": (2, 3), "aspect": "3:2"},
    "fullbody": {"grid": (2, 4), "aspect": "16:9"},
}

# Fallback caption tag when a panel line carries no explicit tags.
STAGE_TAGS = {"face": "portrait", "upper": "upper body", "fullbody": "full body"}

# Curated sheet prompts used when tmp/lora_<mode>.txt is missing.
EMBEDDED_PROMPTS = {
    "face": """GRID: 3x2
A character face reference sheet drawn as a clean 3-column by 2-row matrix of 6 separate square panels on a pure white background, with wide uniform white gutters between every panel.

Character: the exact character from the reference images, with identical face, hair, eyes and colors in all 6 panels.

Layout & Framing (row-major order, left to right, top to bottom):
* R1C1: portrait, front view, neutral expression :: Shoulder-up portrait, direct front view, calm neutral expression.
* R1C2: portrait, front view, gentle smile :: Shoulder-up portrait, direct front view, soft gentle smile.
* R1C3: portrait, front view, joyful laugh :: Shoulder-up portrait, direct front view, open joyful laugh.
* R2C1: portrait, three-quarter view, serious :: Shoulder-up portrait, three-quarter angle, serious focused expression.
* R2C2: portrait, three-quarter view, determined :: Shoulder-up portrait, three-quarter angle, determined fierce expression.
* R2C3: portrait, tilted head, surprised :: Shoulder-up portrait, head tilted, surprised wide-eyed expression.

Art Style & Constraints:
* Style: high-resolution anime headshot sheet, soft cel shading, clean linework.
* Geometry: every panel the same square size, head and shoulders centered in each panel, no panel borders or frames, only white space separates panels.
* Strict Negative Constraints: NO text, NO words, NO letters, NO numbers, NO labels, NO watermark, NO speech bubbles, NO back views. Plain solid white background only.""",
    "upper": """GRID: 2x3
A character upper-body reference sheet drawn as a clean 2-row by 3-column matrix of 6 separate panels on a pure white background, with wide uniform white gutters between every panel.

Character & outfit: the exact character and the exact outfit from the reference images. {outfit}

Layout & Framing (row-major order, left to right, top to bottom):
* R1C1: upper body, front view, arms at sides :: Medium shot from head to waist, direct front view, arms relaxed at sides.
* R1C2: upper body, three-quarter view, hand on hip :: Medium shot from head to waist, three-quarter angle, one hand on hip.
* R1C3: upper body, side profile :: Medium shot from head to waist, side profile view, arms relaxed.
* R2C1: upper body, front view, arms crossed :: Medium shot from head to waist, front view, arms crossed.
* R2C2: upper body, three-quarter view, waving :: Medium shot from head to waist, three-quarter angle, one hand raised waving.
* R2C3: upper body, back view, looking back :: Medium shot from head to waist, back view, head turned looking back over shoulder.

Art Style & Constraints:
* Style: official anime production art, sharp linework, high detail on upper clothing, collars and shoulders, identical character and outfit in all 6 panels.
* Geometry: equal panel sizes, consistent head-to-waist scale, no panel borders or frames, only white space separates panels.
* Strict Negative Constraints: NO text, NO words, NO letters, NO numbers, NO watermark, NO logos. Pure solid white background only.""",
    "fullbody": """GRID: 2x4
A character full-body turnaround reference sheet drawn as a clean 2-row by 4-column matrix of 8 separate panels on a pure white background, with wide uniform white gutters between every panel.

Character & outfit: the exact character and the exact outfit from the reference images. {outfit}

Layout & Framing (row-major order, left to right, top to bottom):
* R1C1: full body, standing, front view, neutral :: Full-body direct front view, standing straight, arms relaxed, whole body visible head to toe with margin.
* R1C2: full body, standing, three-quarter view :: Full-body three-quarter front view, turned 45 degrees to the right.
* R1C3: full body, standing, side profile :: Full-body side profile view, facing right, whole body visible with margin.
* R1C4: full body, standing, back view :: Full-body back view, showing the back of the outfit.
* R2C1: full body, standing, three-quarter left :: Full-body three-quarter front view, turned 45 degrees to the left.
* R2C2: full body, walking, side view :: Full-body walking pose, side view, one leg forward.
* R2C3: full body, standing, arms raised :: Full-body front view, both arms raised above the head.
* R2C4: full body, standing, looking back :: Full-body three-quarter back view, head turned looking back over the shoulder.

Art Style & Constraints:
* Style: official anime concept art, high-resolution character design sheet, clean line art, soft cel shading, consistent outfit colors and details in all 8 panels.
* Geometry: every panel the same size, full body visible head to toe with margin in each panel, no panel borders or frames, only white space separates panels.
* Strict Negative Constraints: NO text, NO words, NO letters, NO numbers, NO height grid lines, NO color swatches, NO watermark. Pure solid white background only.""",
}


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
    """Validate the --ref-images list. Raises if a path is missing/unsupported."""
    paths = []
    for p in ref_images or []:
        if not os.path.isfile(p):
            raise RuntimeError(f"Reference image not found: {p}")
        if os.path.splitext(p)[1].lower() not in _IMAGE_EXTS:
            raise RuntimeError(f"Unsupported reference image file: {p}")
        paths.append(p)
    return paths


# ---------------------------------------------------------------------------
# Prompt refinement helpers (grid detection, panels, placeholders)
# ---------------------------------------------------------------------------
def detect_grid(prompt_text: str):
    """Read the intended sheet grid from the prompt text.

    Prefers an explicit "GRID: CxR" header; falls back to legacy prose
    like "3x3 matrix ... 3 rows and 3 columns". Returns (cols, rows) or None.
    """
    m = re.search(r"GRID:\s*(\d+)\s*[xX]\s*(\d+)", prompt_text)
    if m:
        return int(m.group(1)), int(m.group(2))
    m = re.search(r"(\d+)\s*[xX]\s*(\d+)\s*matrix", prompt_text)
    if m:
        return int(m.group(1)), int(m.group(2))
    m = re.search(r"(\d+)\s*columns?\D{0,60}?(\d+)\s*rows", prompt_text)
    if m:
        return int(m.group(1)), int(m.group(2))
    return None


def parse_panels(prompt_text: str):
    """Extract per-panel caption tags from "R{r}C{c}: tags :: description" lines.

    Returns {(row, col): "tag, tag, ..."} (1-based). Lines without tags are
    skipped; the pipeline falls back to the stage-level tag for those tiles.
    """
    panels = {}
    for raw in prompt_text.splitlines():
        m = re.match(r"^\s*\*?\s*R(\d+)C(\d+)\s*:\s*(.+)$", raw.strip())
        if not m:
            continue
        r, c = int(m.group(1)), int(m.group(2))
        tags = m.group(3).split("::")[0].strip().strip(",").strip()
        if tags:
            panels[(r, c)] = tags
    return panels


def substitute_placeholders(prompt_text: str, args) -> str:
    """Refine the prompt text: fill {outfit} from --outfit-desc (or the
    reference-image fallback) and {trigger} from the trigger word."""
    if args.outfit_desc:
        outfit = (f"The outfit is: {args.outfit_desc}. "
                  f"Draw this exact outfit in every panel.")
    else:
        outfit = ("Wear the exact outfit shown in the reference images, "
                  "identical in every panel.")
    text = prompt_text.replace("{outfit}", outfit)
    text = text.replace("{trigger}", args.trigger)
    return text


# ---------------------------------------------------------------------------
# Retry
# ---------------------------------------------------------------------------
def _retry_delay(exc, attempt: int) -> int:
    try:
        if (int(getattr(exc, "code", None)) == 400
                and "image generation blocked" in str(exc).lower()):
            return 0
    except (TypeError, ValueError):
        pass
    return 2 ** (attempt + 1)


def with_retry(fn, what: str, retries: int = 3, quiet: bool = False):
    for attempt in range(retries + 1):
        try:
            return fn()
        except Exception as exc:  # noqa: BLE001 - retry on any API error
            if attempt >= retries:
                raise
            delay = _retry_delay(exc, attempt)
            if not quiet:
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
# Grid splitting
# ---------------------------------------------------------------------------
def split_grid(path: str, cols: int, rows: int, padding: int,
               out_dir: str, variation: int):
    """Split the image at `path` into cols x rows tiles (row-major, top-left
    first) and trim `padding` pixels from every side of each tile to remove
    grid-line border artifacts.

    Returns the list of saved tile paths. Raises RuntimeError if the padding
    is too large for the resulting tile size.
    """
    from PIL import Image

    img = Image.open(path)
    img.load()
    w, h = img.size
    tiles = []
    for r in range(rows):
        y0 = r * h // rows
        y1 = (r + 1) * h // rows
        for c in range(cols):
            x0 = c * w // cols
            x1 = (c + 1) * w // cols
            if x1 - x0 <= 2 * padding or y1 - y0 <= 2 * padding:
                raise RuntimeError(
                    f"Grid padding {padding}px too large for tile size "
                    f"{x1 - x0}x{y1 - y0} (tiles must stay larger than "
                    f"{2 * padding}px per side)."
                )
            box = (x0 + padding, y0 + padding, x1 - padding, y1 - padding)
            tile = img.crop(box)
            tile_path = os.path.join(
                out_dir, f"image_v{variation:02d}_c{c + 1:02d}_r{r + 1:02d}.png"
            )
            tile.save(tile_path, format="PNG")
            tiles.append(tile_path)
    return tiles


# ---------------------------------------------------------------------------
# Captions / naming / refs
# ---------------------------------------------------------------------------
def make_caption(args, stage: str, panel_tags: str) -> str:
    parts = []
    if args.quality_tags:
        parts.append(args.quality_tags.strip())
    parts.append(args.trigger)
    parts.append("1girl")
    parts.append("solo")
    if panel_tags:
        parts.append(panel_tags)
    if args.outfit_desc and stage in ("upper", "fullbody"):
        parts.append(args.outfit_desc.strip())
    return ", ".join(parts)


def infer_trigger(ref_paths) -> str:
    for p in ref_paths or []:
        b = os.path.basename(p)
        m = (re.search(r"(?:img_)?chara[_\-]?([A-Za-z]+)", b)
             or re.search(r"body[_\-]?([A-Za-z]+)", b))
        if m:
            return m.group(1).lower()
    return "chara"


def stage_refs(stage: str, args):
    """Reference images attached to one stage's generation calls.

    face: avatar image(s) (falls back to --ref-images).
    upper/fullbody: avatar (identity) + outfit fullbody pictures.
    """
    avatar = list(args.avatar or [])
    refs = list(args.ref_images or [])
    if stage == "face":
        return avatar or refs
    if avatar:
        return avatar + refs
    return refs


def training_dir_for(args) -> str:
    name = f"lora_{args.trigger}"
    if args.outfit:
        name += "_" + re.sub(r"[^A-Za-z0-9_-]+", "_", args.outfit)
    return os.path.join(args.training_dir or DEFAULT_TRAINING_DIR, name)


# ---------------------------------------------------------------------------
# Stage execution
# ---------------------------------------------------------------------------
def run_stage(stage: str, prompt_text: str, grid, refs, args, api_key: str,
              out_dir: str, training_dir):
    """Generate the stage's variations and (optionally) split them.

    Variations run sequentially by default, or CONCURRENTLY with --parallel
    (each job is launched with a --parallel-delay gap, default 1 s).

    grid = (cols, rows): every generated image is split into that grid and
    each cell becomes one collected training image.
    grid = None: every variation stays ONE full image (no split at all).
    """
    if grid:
        cols, rows = grid
        cells = cols * rows
    else:
        cols = rows = 0
        cells = 1
    panels = parse_panels(prompt_text)
    sheet_name = "image" if stage == "sheet" else stage
    out_name = "image" if stage == "sheet" else stage

    record = {
        "stage": stage, "grid": list(grid) if grid else None,
        "variations": args.variations,
        "sheets": [], "images": [], "errors": [],
    }
    aspect = args.aspect_ratio or STAGE_DEFAULTS.get(stage, {}).get("aspect", "")
    size = args.image_size

    def do_variation(v):
        """One variation job: generate, split, and describe the outputs.
        Console stays quiet during retries and prints exactly ONE status
        line per variation at the end (ok / BLOCKED / FAILED)."""
        sheet_path = os.path.join(out_dir, f"{sheet_name}_v{v:02d}.png")

        def job():
            # A FRESH client per attempt: when a direct connection fails and
            # the proxy fallback activates (once, under a lock in
            # generate.py), the next attempt rebuilds the client with the
            # proxy environment already set - so parallel jobs reliably end
            # up routed through the proxy.
            client = _make_client(api_key)
            return generate_image(client, args.image_model, prompt_text,
                                  refs, sheet_path, aspect, size)

        try:
            with_retry(job, f"{stage} variation {v}", args.retries,
                       quiet=True)
        except Exception as exc:  # noqa: BLE001 - report and move on
            kind = classify_error(exc)
            label = "BLOCKED" if kind == "blocked" else "FAILED"
            print(f"[image_maker] {stage} v{v:02d} {label}: "
                  f"{str(exc)[:140]}", flush=True)
            return {"ok": False, "v": v, "error": str(exc)}
        items = []
        if grid is None:
            caption = make_caption(args, stage, STAGE_TAGS.get(stage, ""))
            items.append({"tile": sheet_path, "panel": "full",
                          "caption": caption})
            print(f"[image_maker] {stage} v{v:02d} ok -> "
                  f"{os.path.basename(sheet_path)}", flush=True)
        else:
            tile_dir = os.path.join(out_dir, f"tiles_{out_name}")
            os.makedirs(tile_dir, exist_ok=True)
            tiles = split_grid(sheet_path, cols, rows, args.grid_padding,
                               tile_dir, v)
            print(f"[image_maker] {stage} v{v:02d} ok -> "
                  f"{os.path.basename(sheet_path)} ({len(tiles)} tiles)",
                  flush=True)
            for i, tile_path in enumerate(tiles):
                r, c = divmod(i, cols)
                panel_tags = panels.get((r + 1, c + 1),
                                        STAGE_TAGS.get(stage, ""))
                items.append({"tile": tile_path,
                              "panel": f"R{r + 1}C{c + 1}",
                              "caption": make_caption(args, stage,
                                                      panel_tags)})
        return {"ok": True, "v": v,
                "sheet": os.path.basename(sheet_path), "items": items}

    variations = list(range(1, args.variations + 1))
    use_parallel = bool(getattr(args, "parallel", False)) and \
        len(variations) > 1
    if use_parallel:
        workers = int(getattr(args, "parallel_workers", 0) or 0)
        if workers < 1:
            workers = min(len(variations), 8)
        delay = max(0.0, float(getattr(args, "parallel_delay", 1.0)))
        print(f"[image_maker] {stage}: {len(variations)} variations, "
              f"{workers} workers, {delay}s launch delay", flush=True)
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = []
            for v in variations:
                futures.append(pool.submit(do_variation, v))
                if delay and v != variations[-1]:
                    time.sleep(delay)
            results = [f.result() for f in futures]
    else:
        print(f"[image_maker] {stage}: generating {len(variations)} "
              f"variation(s)", flush=True)
        results = [do_variation(v) for v in variations]

    for res in results:
        v = res["v"]
        if not res["ok"]:
            record["errors"].append((v, res["error"]))
            continue
        record["sheets"].append(res["sheet"])
        # Deterministic numbering: variation v owns numbers
        # (v-1)*cells+1 .. v*cells, so parallel and sequential runs produce
        # the same filenames (a failed variation leaves gaps instead of
        # renumbering the following ones).
        for j, item in enumerate(res["items"], 1):
            final_name = f"{out_name}_{(v - 1) * cells + j:03d}.png"
            if training_dir:
                shutil.copy2(item["tile"], os.path.join(training_dir,
                                                        final_name))
                if args.caption_style == "tags":
                    with open(os.path.join(training_dir,
                                           final_name[:-4] + ".txt"),
                              "w", encoding="utf-8") as f:
                        f.write(item["caption"] + "\n")
            record["images"].append({
                "file": os.path.join(os.path.basename(training_dir), final_name)
                        if training_dir else os.path.basename(item["tile"]),
                "caption": item["caption"] if args.caption_style == "tags" else "",
                "variation": v,
                "panel": item["panel"],
                "sheet": res["sheet"],
            })

    # Optional: keep the source sheets and refs inside the dataset folder.
    if training_dir and record["sheets"]:
        sheets_dir = os.path.join(training_dir, "sheets")
        os.makedirs(sheets_dir, exist_ok=True)
        for name in record["sheets"]:
            shutil.copy2(os.path.join(out_dir, name),
                         os.path.join(sheets_dir, name))
        if args.include_refs and refs:
            refs_dir = os.path.join(training_dir, "refs")
            os.makedirs(refs_dir, exist_ok=True)
            for k, p in enumerate(refs, 1):
                tag = "portrait" if stage == "face" else "full body"
                base = f"ref_{k:02d}"
                shutil.copy2(p, os.path.join(refs_dir,
                                             base + os.path.splitext(p)[1]))
                if args.caption_style == "tags":
                    cap = make_caption(args, stage, tag)
                    with open(os.path.join(refs_dir, base + ".txt"), "w",
                              encoding="utf-8") as f:
                        f.write(cap + "\n")
    return record


# ---------------------------------------------------------------------------
# Self test (no API, no key) — proves the split/caption machinery works
# ---------------------------------------------------------------------------
def selftest() -> int:
    import tempfile
    from PIL import Image, ImageDraw

    ok = True
    work = tempfile.mkdtemp(prefix="image_maker_selftest_")
    try:
        # 1. Synthetic 3x2 grid sheet with 8px white gutters.
        cols, rows, pad = 3, 2, 8
        cw, ch = 100, 100
        w = cols * cw + (cols + 1) * pad
        h = rows * ch + (rows + 1) * pad
        img = Image.new("RGB", (w, h), (255, 255, 255))
        d = ImageDraw.Draw(img)
        for i in range(cols * rows):
            r, c = divmod(i, cols)
            x = pad + c * (cw + pad)
            y = pad + r * (ch + pad)
            d.rectangle([x, y, x + cw - 1, y + ch - 1],
                        fill=((40 * i) % 256, (80 * i) % 256, (160 * i) % 256))
        sheet = os.path.join(work, "test_sheet.png")
        img.save(sheet)

        tiles = split_grid(sheet, cols, rows, 0, work, 0)
        assert len(tiles) == 6, f"expected 6 tiles, got {len(tiles)}"
        exp_w, exp_h = w // cols, h // rows
        for t in tiles:
            with Image.open(t) as ti:
                tw, th = ti.size
                assert tw in (exp_w, exp_w + 1) and th in (exp_h, exp_h + 1), \
                    f"bad tile size {ti.size}"
                assert ti.getbbox() is not None, "tile is empty"
        print(f"[selftest] split: 3x2 sheet -> {len(tiles)} tiles "
              f"~{exp_w}x{exp_h} OK")

        # 2. Padding trim (first tile keeps the top-left corner).
        tiles2 = split_grid(sheet, cols, rows, 2, work, 0)
        with Image.open(tiles2[0]) as ti:
            assert ti.size == (exp_w - 4, exp_h - 4), \
                f"bad trimmed size {ti.size}"
        print(f"[selftest] padding trim: 2px/side -> "
              f"{exp_w - 4}x{exp_h - 4} tile OK")

        # 3. Grid detection + panel parsing on the embedded prompts.
        for stage, expected in (("face", (3, 2)), ("upper", (2, 3)),
                                ("fullbody", (2, 4))):
            text = EMBEDDED_PROMPTS[stage]
            grid = detect_grid(text)
            assert grid == expected, f"{stage}: detect_grid -> {grid}, want {expected}"
            panels = parse_panels(text)
            assert len(panels) == expected[0] * expected[1], \
                f"{stage}: {len(panels)} panels, want {expected[0] * expected[1]}"
            print(f"[selftest] {stage}: GRID {grid[0]}x{grid[1]}, "
                  f"{len(panels)} captioned panels OK")

        # End-to-end run_stage in sequential AND parallel modes with a
        # stubbed generator (no API): same deterministic file names, no
        # overwrites, captions written, grid splitting intact.
        def _fake_gen(_client, _model, _prompt, _refs, out_path, _aspect,
                      _size):
            Image.new("RGB", (900, 600), (235, 235, 235)).save(out_path)

        real_gen = globals().get("generate_image")
        try:
            globals()["generate_image"] = _fake_gen

            def run_case(parallel, grid, n_dir):
                raw = os.path.join(work, f"raw_{n_dir}")
                res = os.path.join(work, f"res_{n_dir}")
                os.makedirs(raw, exist_ok=True)
                os.makedirs(res, exist_ok=True)
                a = argparse.Namespace(
                    quality_tags="", trigger="t", outfit_desc="",
                    caption_style="tags", include_refs=False,
                    image_model="test-model", retries=1, variations=3,
                    parallel=parallel, parallel_workers=3, parallel_delay=0.0,
                    image_size="1K", aspect_ratio="", grid_padding=8)
                rec = run_stage("sheet", "just a test prompt", grid, [], a,
                                "test-key", raw, res)
                assert not rec["errors"], f"{n_dir}: {rec['errors']}"
                return rec, raw, res

            # 3 full-image variations (no grid): 3 images.
            for par in (False, True):
                rec, raw, res = run_case(par, None, f"full_{par}")
                assert len(rec["images"]) == 3, f"{par}: want 3 full images"
                for img in rec["images"]:
                    p = os.path.join(res, os.path.basename(img["file"]))
                    assert os.path.isfile(p), f"missing {img['file']}"
                    assert os.path.isfile(p[:-4] + ".txt"), "caption missing"
                for v in (1, 2, 3):
                    assert os.path.isfile(
                        os.path.join(raw, f"image_v{v:02d}.png")), \
                        f"sheet image_v{v:02d}.png missing"
            # 3x2 grid x 3 variations in parallel: 18 tiles, unique names.
            rec, raw, res = run_case(True, (3, 2), "grid_par")
            assert len(rec["images"]) == 18, f"want 18 tiles, got {len(rec['images'])}"
            names = [os.path.basename(img["file"]) for img in rec["images"]]
            assert len(set(names)) == 18, "duplicate collected names"
            for img in rec["images"]:
                p = os.path.join(res, os.path.basename(img["file"]))
                assert os.path.isfile(p), f"missing tile {img['file']}"
            for v in (1, 2, 3):
                assert os.path.isfile(
                    os.path.join(raw, f"image_v{v:02d}.png")), \
                    f"grid sheet image_v{v:02d}.png missing"
            print("[selftest] run_stage sequential + parallel (stub) OK")
        finally:
            if real_gen is not None:
                globals()["generate_image"] = real_gen
    except Exception as exc:  # noqa: BLE001
        ok = False
        print(f"[selftest] FAILED: {exc}")
    finally:
        shutil.rmtree(work, ignore_errors=True)
    print("[selftest] " + ("ALL OK" if ok else "FAILED"))
    return 0 if ok else 1


# ---------------------------------------------------------------------------
# Compact run summary (success / blocked / other failures)
# ---------------------------------------------------------------------------
_BLOCK_WORDS = ("blocked", "unsafe", "safety", "inappropriate", "flagged",
                "recitation")


def classify_error(message) -> str:
    low = str(message).lower()
    return "blocked" if any(w in low for w in _BLOCK_WORDS) else "other"


def cells_for_record(record) -> int:
    grid = record.get("grid")
    return grid[0] * grid[1] if grid else 1


def summarize_run(stage_records):
    """Compress stage records into count-only summaries.

    Returns (summary, stage_rows, failure_rows) where
      summary   = {"expected", "succeeded", "blocked", "failed_other"}
      stage_rows= per-stage counts
      failure_rows = grouped failure reasons (kind, count, example)
    """
    totals = {"expected": 0, "succeeded": 0, "blocked": 0, "failed_other": 0}
    stage_rows, failure_map = [], {}
    for rec in stage_records:
        cells = cells_for_record(rec)
        expected = cells * rec.get("variations", 1)
        succeeded = len(rec.get("images", []))
        blocked = other = 0
        for _v, msg in rec.get("errors", []):
            kind = classify_error(msg)
            if kind == "blocked":
                blocked += cells
            else:
                other += cells
            key = (kind, str(msg)[:160])
            failure_map[key] = failure_map.get(key, 0) + cells
        stage_rows.append({
            "stage": rec.get("stage"),
            "grid": rec.get("grid"),
            "expected": expected,
            "succeeded": succeeded,
            "blocked": blocked,
            "failed_other": other,
        })
        totals["expected"] += expected
        totals["succeeded"] += succeeded
        totals["blocked"] += blocked
        totals["failed_other"] += other
    failures = []
    for (kind, example), count in sorted(failure_map.items(),
                                         key=lambda kv: -kv[1]):
        failures.append({"kind": kind, "count": count, "example": example})
    return totals, stage_rows, failures


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def main() -> int:
    parser = argparse.ArgumentParser(
        description="Merged LoRA data-prep pipeline: plan -> generate character "
                    "sheets -> split grid -> caption -> collect into "
                    "training_data/lora_<name>/."
    )
    parser.add_argument("--mode", choices=list(STAGES) + ["all"], default=None,
                        help="face/upper/fullbody single stage, or 'all' for the "
                             "merged ~20-image dataset run (default: infer from "
                             "--prompt-file name; single mode).")
    parser.add_argument("--prompt-file", default="",
                        help=".txt sheet prompt (single mode; used verbatim).")
    parser.add_argument("--face-prompt-file", default="",
                        help="all-mode override for the face sheet prompt.")
    parser.add_argument("--upper-prompt-file", default="",
                        help="all-mode override for the upper-body sheet prompt.")
    parser.add_argument("--fullbody-prompt-file", default="",
                        help="all-mode override for the fullbody sheet prompt.")
    parser.add_argument("--ref-images", nargs="*", default=None,
                        help="Reference images attached to the prompt: the "
                             "fullbody outfit picture(s). For face mode these "
                             "are used as the face/avatar references.")
    parser.add_argument("--avatar", action="append", default=None,
                        help="Avatar/portrait picture for character identity "
                             "(repeatable). In all mode it is attached to every "
                             "stage; face stage uses it alone.")
    parser.add_argument("--variations", type=int, default=1,
                        help="Sheets per stage (default: 1; each sheet yields "
                             "cols x rows training images).")
    parser.add_argument("--parallel", action="store_true",
                        help="Generate the stage's variations concurrently "
                             "instead of one after another.")
    parser.add_argument("--parallel-workers", type=int, default=0,
                        help="Max concurrent variation jobs (default: "
                             "min(variations, 8)).")
    parser.add_argument("--parallel-delay", type=float, default=1.0,
                        help="Seconds to wait between LAUNCHING each parallel "
                             "variation job, to pace API calls (default: 1.0).")
    parser.add_argument("--grid", nargs=2, type=int, metavar=("COLS", "ROWS"),
                        default=None,
                        help="Split every generated image into a COLS x ROWS "
                             "grid of tiles (single mode only). When omitted, "
                             "each variation is saved as ONE full image - no "
                             "auto grid detection.")
    parser.add_argument("--grid-padding", type=int, default=8,
                        help="Trim P pixels from every side of each grid cell to "
                             "remove grid-line artifacts (default: 8).")
    parser.add_argument("--image-size", default="2K",
                        help="Gemini image size e.g. 1K, 2K, 4K (default: 2K).")
    parser.add_argument("--aspect-ratio", default="",
                        help="Output aspect ratio e.g. 1:1, 3:2, 16:9 (default: "
                             "per stage).")
    parser.add_argument("--outfit", default="",
                        help="Outfit name; the result folder becomes "
                             "training_data/lora_<trigger>_<outfit>/.")
    parser.add_argument("--outfit-desc", default="",
                        help="Tag-style outfit description injected into "
                             "upper/fullbody prompts ({outfit}) and captions, "
                             "e.g. \"blue sailor uniform, white thighhighs\".")
    parser.add_argument("--trigger", default="",
                        help="LoRA trigger word for captions (default: inferred "
                             "from img_chara_<name>/body_<name> ref filenames, "
                             "else 'chara').")
    parser.add_argument("--quality-tags", default="",
                        help="Extra caption tags prepended to every caption, "
                             "e.g. \"masterpiece, best quality\" (default: none).")
    parser.add_argument("--caption-style", choices=["tags", "none"], default="tags",
                        help="Write kohya-style .txt tag files per image "
                             "(default: tags).")
    parser.add_argument("--include-refs", action="store_true",
                        help="Copy the avatar/outfit reference images into the "
                             "dataset folder (refs/).")
    parser.add_argument("--training-dir", default="",
                        help="Base result folder (default: training_data/).")
    parser.add_argument("--no-collect", action="store_true",
                        help="Skip the collect step; keep raw outputs only.")
    parser.add_argument("--image-model", default=load_model_config()["image_model"],
                        help="Nano Banana image model used to render the sheets.")
    parser.add_argument("--output-dir", default="",
                        help="Raw output directory (default: "
                             "outputs/image_maker/YYYY-MM-DD/HHMMSS/).")
    parser.add_argument("--retries", type=int, default=3,
                        help="Max retries per image on error (default: 3).")
    parser.add_argument("--api-key", default="",
                        help="Gemini API key (or GEMINI_API_KEY env / config txt).")
    parser.add_argument("--dry-run", action="store_true",
                        help="Print the full plan (stages, grids, captions, "
                             "counts) without calling the API.")
    parser.add_argument("--selftest", action="store_true",
                        help="Run the offline self test (grid split + prompt "
                             "parsing) and exit.")
    args = parser.parse_args()

    if args.selftest:
        return selftest()

    if args.grid is not None and min(args.grid) < 1:
        parser.error("--grid COLS ROWS: both must be >= 1")
    if args.grid_padding < 0:
        parser.error("--grid-padding must be >= 0")
    if args.parallel_workers < 0:
        parser.error("--parallel-workers must be >= 0")
    if args.parallel_delay < 0:
        parser.error("--parallel-delay must be >= 0")

    # Which stages run?
    if args.mode == "all":
        stages = list(STAGES)
    else:
        stage = args.mode
        if stage is None:
            for s in STAGES:
                if s in os.path.basename(args.prompt_file).lower():
                    stage = s
                    break
        if stage is None:
            stage = "sheet"  # legacy generic single run
        stages = [stage]
        if not args.prompt_file:
            parser.error("single mode needs --prompt-file (or use --mode all)")

    if args.mode == "all" and args.grid is not None:
        print("[image_maker] warning: --grid is ignored in all mode; each "
              "stage uses its prompt's GRID header.", flush=True)

    try:
        # Reference validation.
        all_refs = list(args.avatar or []) + list(args.ref_images or [])
        all_refs = ref_images_from_args(all_refs)
        args.avatar = ref_images_from_args(args.avatar)
        args.ref_images = ref_images_from_args(args.ref_images)

        args.trigger = (args.trigger or "").strip() or infer_trigger(all_refs)
        if args.trigger == "chara" and all_refs:
            print("[image_maker] warning: no trigger inferred from ref "
                  "filenames; using 'chara'. Set --trigger.", flush=True)

        training_dir = None if args.no_collect else training_dir_for(args)
        out_dir = args.output_dir or os.path.join(
            DEFAULT_OUTPUT_DIR,
            datetime.date.today().strftime("%Y-%m-%d"),
            datetime.datetime.now().strftime("%H%M%S"),
        )

        # Build the plan for dry-run / reporting.
        plan = []
        for st in stages:
            if args.mode == "all":
                flags = {"face": args.face_prompt_file,
                         "upper": args.upper_prompt_file,
                         "fullbody": args.fullbody_prompt_file}
                if flags.get(st):
                    text, src = _load_prompt(flags[st]), flags[st]
                else:
                    p = os.path.join(_ROOT_DIR, "tmp", f"lora_{st}.txt")
                    if os.path.exists(p):
                        text, src = _load_prompt(p), p
                    else:
                        text, src = EMBEDDED_PROMPTS[st], "<embedded>"
            else:
                text, src = _load_prompt(args.prompt_file), args.prompt_file

            detected = detect_grid(text)
            if args.mode == "all":
                # All-mode orchestrates sheet prompts: use each prompt's grid.
                grid = detected or STAGE_DEFAULTS.get(st, {}).get("grid", (3, 2))
                if detected is None:
                    print(f"[image_maker] warning: no grid in {src}; defaulting "
                          f"to {grid[0]}x{grid[1]}.", flush=True)
            elif args.grid is not None:
                grid = tuple(args.grid)
                if detected and detected != grid:
                    print(f"[image_maker] warning: prompt declares "
                          f"{detected[0]}x{detected[1]} but --grid "
                          f"{grid[0]} {grid[1]} given; using --grid.",
                          flush=True)
            else:
                # Single mode: split ONLY when --grid is passed explicitly.
                grid = None
                if detected:
                    print(f"[image_maker] note: prompt looks like a "
                          f"{detected[0]}x{detected[1]} grid sheet but --grid "
                          f"was not given -> saving ONE full image per "
                          f"variation (no split). Pass --grid {detected[0]} "
                          f"{detected[1]} to split it into tiles.", flush=True)

            refs = stage_refs(st, args)
            text = substitute_placeholders(text, args)
            cells = (grid[0] * grid[1] * args.variations) if grid \
                else args.variations
            plan.append({"stage": st, "src": src, "prompt": text,
                         "grid": grid, "refs": refs, "cells": cells})

        total = sum(p["cells"] for p in plan)

        # ---------------- dry run ----------------
        if args.dry_run:
            print("\n[image_maker] PLAN (dry run, no API calls):", flush=True)
            for p in plan:
                g = (f"{p['grid'][0]}x{p['grid'][1]}" if p["grid"]
                     else "full (no split)")
                print(f"  {p['stage']:<9} grid {g:<16} "
                      f"variations {args.variations}  refs {len(p['refs'])}  "
                      f"-> {p['cells']} images   ({p['src']})", flush=True)
            print(f"  TOTAL {total} training images"
                  + (f" -> {training_dir}" if training_dir else " (raw only)"),
                  flush=True)
            samples = []
            for p in plan:
                panels = parse_panels(p["prompt"])
                tags = (panels.get((1, 1), STAGE_TAGS.get(p["stage"], "")))
                samples.append(make_caption(args, p["stage"], tags))
            print("  sample captions:")
            for s in samples:
                print(f"    {s}", flush=True)
            result = {
                "ok": True, "dry_run": True, "trigger": args.trigger,
                "training_dir": training_dir,
                "stages": [{"stage": p["stage"],
                            "grid": list(p["grid"]) if p["grid"] else None,
                            "cells": p["cells"], "src": p["src"]}
                           for p in plan],
                "total_images": total,
            }
            print(json.dumps(result, ensure_ascii=False), flush=True)
            return 0

        # ---------------- real run ----------------
        api_key = _resolve_api_key(args)
        if not api_key:
            raise RuntimeError(
                "No Gemini API key. Set GEMINI_API_KEY, pass --api-key, or "
                "configure config_states/gemini_nano_banana.txt."
            )
        os.makedirs(out_dir, exist_ok=True)
        if training_dir:
            os.makedirs(training_dir, exist_ok=True)

        # Keep the used prompt beside the sheets for debugging.
        prompt_log = os.path.join(out_dir, "image_prompt.txt")
        with open(prompt_log, "w", encoding="utf-8") as f:
            f.write("# image_maker merged run\n")
            f.write(f"# trigger: {args.trigger}\n")
            f.write(f"# image model: {args.image_model}\n")
            for p in plan:
                g = (f"grid {p['grid'][0]}x{p['grid'][1]}"
                     if p["grid"] else "full image (no split)")
                f.write(f"\n# --- {p['stage']} ({p['src']}) {g} "
                        f"refs {len(p['refs'])} ---\n")
                f.write(p["prompt"] + "\n")

        stage_records, errors = [], []
        for p in plan:
            rec = run_stage(p["stage"], p["prompt"], p["grid"], p["refs"],
                            args, api_key, out_dir, training_dir)
            stage_records.append(rec)
            errors.extend(rec["errors"])

        summary, stage_rows, failures = summarize_run(stage_records)
        ok = not errors

        # Full detail goes to the manifest file; stdout stays compact.
        detail = {
            "created": datetime.datetime.now().isoformat(timespec="seconds"),
            "ok": ok,
            "trigger": args.trigger,
            "outfit": args.outfit or None,
            "image_model": args.image_model,
            "output_dir": out_dir,
            "training_dir": training_dir,
            "stages": stage_records,
            "total_images": summary["succeeded"],
        }
        manifest_path = os.path.join(out_dir, "manifest.json")
        with open(manifest_path, "w", encoding="utf-8") as f:
            json.dump(detail, f, ensure_ascii=False, indent=2)
        if training_dir:
            shutil.copy2(manifest_path, os.path.join(training_dir,
                                                     "manifest.json"))

        result = {
            "ok": ok,
            "trigger": args.trigger,
            "output_dir": out_dir,
            "training_dir": training_dir,
            "summary": summary,
            "stages": stage_rows,
            "failures": failures,
        }
        print(json.dumps(result, ensure_ascii=False), flush=True)
        return 0 if ok else 1

    except Exception as exc:  # noqa: BLE001 - report any failure as JSON
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False),
              flush=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
