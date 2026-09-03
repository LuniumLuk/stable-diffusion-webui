"""
gemini_workflow/lora_data_maker.py -- LoRA dataset maker (no prompt files).

One bat entry (lora_data_maker.bat) + this script. Prompts are built in,
so the only inputs are the pictures:

    lora_data_maker.bat --avatar A --fullbody B C D

  * avatar A alone            -> one 3x4 face sheet  -> 12 expression images
  * A + fullbody B            -> one 3x4 upper grid  -> 12 images
                              + one 3x4 fullbody grid -> 12 images
  * A + fullbody C, A + D, ... -> same per outfit picture

CONFIG (YAML, config_states/lora_data_maker.yaml, created on first run):
  randomize_panel_style   true/false - give every panel its own random art
                          style (false = uniform first entry; --style TAG
                          on the command line always wins).
  styles                  the full list of art styles (tag + text).
  randomize_panel_scene   true/false - give every panel its own random
                          background scene (false = plain white sheet).
  scenes                  the full list of scene/background settings.
  Override the file with: --config PATH

Variety (no two sheets are prompted alike, governed by the config):
  * panels      -- each sheet samples 12 panels from an 18-item expression
                   (face) / pose (upper, fullbody) pool, in random order.
  * lighting    -- each sheet picks a random lighting line.
  * reproducible with --seed N.
  * reference roles -- the prompt names each attached image: first ref =
    the character's FACE, last ref (fullbody picture) = the OUTFIT.
  * if a sheet fails (e.g. one artist style is blocked), the pipeline
    resamples styles/panels and retries automatically.

Grid framing: the sheet layout stays in the concise mode that keeps grids
accurate ("clean 3-column by 4-row matrix of 12 separate panels ... wide
uniform white gutters"); art-style / scene variation lives INSIDE each
panel's description instead of bloating the framing text.

Final output: one flat folder of images (default
training_data/lora_<trigger>/, trigger inferred from the avatar filename),
optionally with kohya-style .txt captions (--captions; each caption carries
its panel's style and scene tags so training can separate them).

Pipeline per stage:
  generate sheet (Gemini Nano Banana, refs attached)
  -> split into 3x4 grid cells (--grid-padding px trimmed per border)
  -> collect numbered images into the result folder.

API key: --api-key > GEMINI_API_KEY env > config_states/gemini_nano_banana.txt.
Result is printed to stdout as a JSON object; exit code 0 when everything
rendered and collected, 1 otherwise.
"""
import argparse
import datetime
import json
import os
import random
import re
import shutil
import sys
import time

_WORKFLOW_DIR = os.path.dirname(os.path.abspath(__file__))
if _WORKFLOW_DIR not in sys.path:
    sys.path.insert(0, _WORKFLOW_DIR)

from generate import _make_client  # noqa: E402
from image_maker import (  # noqa: E402 - shared pipeline helpers
    _resolve_api_key,
    generate_image,
    split_grid,
    parse_panels,
    ref_images_from_args,
    infer_trigger,
)

_ROOT_DIR = os.path.dirname(_WORKFLOW_DIR)
DEFAULT_OUTPUT_DIR = os.path.join(_ROOT_DIR, "outputs", "lora_data_maker")
DEFAULT_RESULT_DIR = os.path.join(_ROOT_DIR, "training_data")
DEFAULT_CONFIG_PATH = os.path.join(_ROOT_DIR, "config_states",
                                   "lora_data_maker.yaml")

GRID_COLS, GRID_ROWS = 3, 4          # one sheet = 12 panels
GRID_CELLS = GRID_COLS * GRID_ROWS   # 12

# ---------------------------------------------------------------------------
# Built-in defaults (used until a YAML config is loaded)
# ---------------------------------------------------------------------------
# (caption/style tag, style text injected into the panel description).
# NOTE: the artist-style entries can occasionally be refused by the image
# model; on failure the pipeline resamples the styles and retries. Remove
# any line you do not want - either here or in the YAML config.
DEFAULT_STYLES = [
    {"tag": "anime screencap", "text": "high-resolution anime style, soft cel shading, clean linework"},
    {"tag": "anime movie style", "text": "modern anime movie style, painterly shading, soft gradients"},
    {"tag": "retro 90s anime", "text": "retro 1990s anime style, thick bold lineart, flat cel shading"},
    {"tag": "light novel illustration", "text": "light novel illustration style, delicate thin lineart, soft lighting"},
    {"tag": "watercolor anime", "text": "watercolor anime style, gentle pastel colors, loose soft edges"},
    {"tag": "vibrant flat anime", "text": "official anime production art, sharp linework, vibrant flat colors"},
    {"tag": "detailed hatching", "text": "detailed ink hatching style, fine cross-hatched pen shading, bold outlines"},
    {"tag": "plain flat colors", "text": "flat plain colors, minimal shading, clean simple coloring with bold shapes"},
    {"tag": "vibrant saturated colors", "text": "vibrant saturated colors, high contrast, glowing highlights"},
    {"tag": "monochrome grayscale", "text": "monochrome grayscale, elegant black and white ink with soft gray tones"},
    {"tag": "pastel anime", "text": "soft pastel anime style, light airy colors, gentle blush shading"},
    {"tag": "cute simplified anime", "text": "cute simplified anime style, big expressive eyes, clean simple shapes"},
    {"tag": "shoujo manga style", "text": "classic shoujo manga style, large sparkling eyes, elegant thin lineart"},
    {"tag": "shonen action style", "text": "dynamic shonen action style, bold speed-line shading, high energy"},
    {"tag": "Makoto Shinkai style", "text": "in the style of Makoto Shinkai, luminous soft shading, dreamy lighting"},
    {"tag": "Akira Toriyama style", "text": "in the style of Akira Toriyama, clean rounded lineart, bright cel shading"},
    {"tag": "Naoko Takeuchi style", "text": "in the style of Naoko Takeuchi, elegant 90s shoujo art, sparkling eyes"},
    {"tag": "Yoshitaka Amano style", "text": "in the style of Yoshitaka Amano, ethereal ink and watercolor, delicate lines"},
    {"tag": "Vanripper style", "text": "in the style of Vanripper, clean bold lineart, dramatic rim lighting, high-contrast cel shading"},
    {"tag": "Kantoku style", "text": "in the style of Kantoku, soft pastel colors, glossy detailed eyes, fine delicate shading"},
]

# (scene caption tag, background instruction shown per panel).
DEFAULT_SCENES = [
    {"tag": "sunny park", "text": "background: a sunny public park with green lawn and trees"},
    {"tag": "city street, daytime", "text": "background: a busy city street in daytime with shops and signs"},
    {"tag": "city street, night", "text": "background: a quiet city street at night with warm streetlights"},
    {"tag": "cozy cafe interior", "text": "background: a cozy cafe interior with wooden tables and warm tones"},
    {"tag": "school classroom", "text": "background: a school classroom with desks and a blackboard"},
    {"tag": "tidy bedroom", "text": "background: a tidy bedroom with a bed and soft window light"},
    {"tag": "library", "text": "background: a library with tall bookshelves full of books"},
    {"tag": "cherry blossom road", "text": "background: a road lined with blooming cherry trees, petals in the air"},
    {"tag": "seaside", "text": "background: a sunny seaside with soft waves on the shore"},
    {"tag": "mountain view", "text": "background: distant green mountains under a clear sky"},
    {"tag": "starry night sky", "text": "background: a night sky full of stars"},
    {"tag": "sunset sky", "text": "background: an orange and pink sunset sky"},
    {"tag": "rainy street", "text": "background: a rainy street with puddle reflections"},
    {"tag": "winter snow", "text": "background: a snowy winter street with falling snow"},
    {"tag": "autumn park", "text": "background: an autumn park with red and gold leaves"},
    {"tag": "soft gradient backdrop", "text": "background: a plain soft-colored gradient backdrop"},
    {"tag": "rooftop at dusk", "text": "background: a rooftop at dusk with city lights below"},
    {"tag": "traditional japanese room", "text": "background: a traditional Japanese room with tatami and sliding doors"},
]

DEFAULT_CONFIG = {
    "randomize_panel_style": True,
    "styles": DEFAULT_STYLES,
    "randomize_panel_scene": False,
    "scenes": DEFAULT_SCENES,
}

# Runtime config (module-level so helpers can read it without plumbing).
CFG = {
    "randomize_panel_style": True,
    "styles": list(DEFAULT_STYLES),
    "randomize_panel_scene": False,
    "scenes": list(DEFAULT_SCENES),
}


def use_default_config():
    global CFG  # noqa: PLW0603 - helper rebinds the runtime config
    CFG = {
        "randomize_panel_style": DEFAULT_CONFIG["randomize_panel_style"],
        "styles": [dict(s) for s in DEFAULT_CONFIG["styles"]],
        "randomize_panel_scene": DEFAULT_CONFIG["randomize_panel_scene"],
        "scenes": [dict(s) for s in DEFAULT_CONFIG["scenes"]],
    }


def apply_config(cfg: dict):
    """Validate/normalize a loaded config dict and activate it."""
    use_default_config()
    if not isinstance(cfg, dict):
        raise RuntimeError("config must be a YAML mapping")
    b = lambda key, cur: (  # noqa: E731
        bool(cfg[key]) if isinstance(cfg.get(key), bool)
        else str(cfg.get(key, cur)).strip().lower() in ("1", "true", "yes", "on")
        if cfg.get(key) is not None else cur)
    CFG["randomize_panel_style"] = b("randomize_panel_style",
                                     CFG["randomize_panel_style"])
    CFG["randomize_panel_scene"] = b("randomize_panel_scene",
                                     CFG["randomize_panel_scene"])
    for key, dst in (("styles", CFG["styles"]), ("scenes", CFG["scenes"])):
        items = cfg.get(key, [])
        if items is None:
            items = []
        if not isinstance(items, list):
            raise RuntimeError(f"config '{key}' must be a list")
        dst[:] = [_entry(e, key) for e in items]


def _entry(e, where):
    if isinstance(e, dict):
        tag = str(e.get("tag", "")).strip() or str(e.get("name", "")).strip()
        text = str(e.get("text", "")).strip() or tag
        return {"tag": tag, "text": text}
    s = str(e).strip()
    return {"tag": s, "text": s}


# ---------------------------------------------------------------------------
# YAML loading (PyYAML when available, tiny fallback otherwise)
# ---------------------------------------------------------------------------
def load_config_file(path: str) -> dict:
    if not os.path.isfile(path):
        raise RuntimeError(f"Config file not found: {path}")
    try:
        import yaml  # PyYAML (preferred)
        with open(path, "r", encoding="utf-8") as f:
            return yaml.safe_load(f) or {}
    except ImportError:
        return _mini_yaml_load(path)


def _mini_yaml_load(path):
    """Minimal YAML-subset loader for the config schema used here:
    top-level 'key: value' scalars and 'key:' blocks containing
    '- tag: X' / '- text: Y' entries (nested under the item or as
    '- tag: X' / '- text: Y' dash lines, or inline '- {tag: X, text: Y}')."""
    cfg, section = {}, None
    for raw in open(path, "r", encoding="utf-8").read().splitlines():
        ln = re.sub(r"\s*#.*$", "", raw).rstrip()
        body = ln.strip()
        if not body:
            continue
        if body.startswith("-"):
            # list item (indented or not): '- tag: X' / '- {tag: X, text: Y}'
            if section is None:
                continue
            item = body[1:].strip()
            if item.startswith("{") and item.endswith("}"):
                kv = {}
                for k, v in re.findall(r"([A-Za-z_]\w*)\s*:\s*"
                                       r"((?:\"[^\"]*\")|(?:'[^']*')|[^,}]+)",
                                       item):
                    kv[k] = v.strip().strip("\"'")
                cfg.setdefault(section, []).append(kv)
            else:
                km = re.match(r"([A-Za-z_]\w*)\s*:\s*(.*)$", item)
                if km:
                    cfg.setdefault(section, []).append(
                        {km.group(1): km.group(2).strip().strip("\"'")})
            continue
        if ln[:1] in (" ", "\t"):
            # indented continuation belongs to the last list item
            m = re.match(r"([A-Za-z_]\w*)\s*:\s*(.*)$", body)
            if m and section is not None and cfg.get(section):
                cfg[section][-1].setdefault(m.group(1),
                                            m.group(2).strip().strip("\"'"))
            continue
        m = re.match(r"([A-Za-z_]\w*)\s*:\s*(.*)$", body)
        if m:
            key, val = m.group(1), m.group(2).strip()
            if val:
                cfg[key] = _mini_scalar(val)
            else:
                cfg[key] = []
                section = key
    for sec in ("styles", "scenes"):
        for e in cfg.get(sec, []):
            if isinstance(e, dict):
                e.setdefault("text", e.get("tag", ""))
    return cfg


def _mini_scalar(val):
    low = val.lower()
    if low in ("true", "yes", "on", "1"):
        return True
    if low in ("false", "no", "off", "0"):
        return False
    return val


def default_config_text() -> str:
    y = ["# lora_data_maker.yaml - per-panel randomization settings.",
         "",
         "# Randomize art style per panel?",
         "#   true  -> every panel of a sheet gets its own random style",
         "#           (12 distinct styles per sheet).",
         "#   false -> one uniform style for every panel (the FIRST entry",
         "#           of the styles list below).",
         "# --style TAG on the command line overrides everything.",
         "randomize_panel_style: true",
         "",
         "styles:"]
    for s in DEFAULT_STYLES:
        y.append(f"  - tag: {s['tag']}")
        y.append(f"    text: \"{s['text']}\"")
    y += ["",
          "# Randomize background scene per panel?",
          "#   true  -> every panel gets its own random scene from the scenes",
          "#           list (panels no longer stay plain white).",
          "#   false -> panels stay on the plain white sheet.",
          "randomize_panel_scene: false",
          "",
          "scenes:"]
    for s in DEFAULT_SCENES:
        y.append(f"  - tag: {s['tag']}")
        y.append(f"    text: \"{s['text']}\"")
    return "\n".join(y) + "\n"


def resolve_config(args):
    """Load the YAML config; create the default template when it is missing
    (skipped for --dry-run / --selftest so those stay side-effect free)."""
    if args.config:
        return load_config_file(args.config)
    if os.path.isfile(DEFAULT_CONFIG_PATH):
        return load_config_file(DEFAULT_CONFIG_PATH)
    if not args.dry_run and not args.selftest:
        os.makedirs(os.path.dirname(DEFAULT_CONFIG_PATH), exist_ok=True)
        with open(DEFAULT_CONFIG_PATH, "w", encoding="utf-8") as f:
            f.write(default_config_text())
        print(f"[lora_data_maker] created config template: "
              f"{DEFAULT_CONFIG_PATH}", flush=True)
    else:
        print("[lora_data_maker] note: no config file yet; using built-in "
              "defaults", flush=True)
    return dict(DEFAULT_CONFIG)


# ---------------------------------------------------------------------------
# Built-in pose / expression pools (internal)
# ---------------------------------------------------------------------------
# (caption tags, panel description). 18 items each; every sheet samples 12.
FACE_POOL = [
    ("portrait, front view, neutral expression", "Shoulder-up portrait, direct front view, calm neutral expression."),
    ("portrait, front view, gentle smile", "Shoulder-up portrait, direct front view, soft gentle smile."),
    ("portrait, front view, joyful laugh", "Shoulder-up portrait, direct front view, open joyful laugh."),
    ("portrait, front view, serious", "Shoulder-up portrait, direct front view, serious focused expression."),
    ("portrait, front view, determined", "Shoulder-up portrait, direct front view, determined fierce expression."),
    ("portrait, front view, angry", "Shoulder-up portrait, direct front view, angry scowl, furrowed brows."),
    ("portrait, front view, sad", "Shoulder-up portrait, direct front view, sad melancholic expression."),
    ("portrait, front view, surprised", "Shoulder-up portrait, direct front view, surprised wide-eyed expression."),
    ("portrait, front view, embarrassed", "Shoulder-up portrait, direct front view, embarrassed blushing expression."),
    ("portrait, front view, happy, eyes closed", "Shoulder-up portrait, direct front view, happy smile with eyes closed."),
    ("portrait, front view, sleepy", "Shoulder-up portrait, direct front view, sleepy relaxed half-closed eyes."),
    ("portrait, front view, confident smirk", "Shoulder-up portrait, direct front view, confident smirk."),
    ("portrait, front view, pouting", "Shoulder-up portrait, direct front view, pouting with puffed cheeks."),
    ("portrait, front view, worried", "Shoulder-up portrait, direct front view, worried expression, slightly raised brows."),
    ("portrait, front view, excited", "Shoulder-up portrait, direct front view, excited sparkling eyes, open smile."),
    ("portrait, front view, calm, eyes closed", "Shoulder-up portrait, direct front view, serene calm with eyes closed."),
    ("portrait, three-quarter view, neutral", "Shoulder-up portrait, three-quarter angle, neutral expression."),
    ("portrait, three-quarter view, gentle smile", "Shoulder-up portrait, three-quarter angle, gentle smile."),
]

UPPER_POOL = [
    ("upper body, front view, arms at sides", "Medium shot from head to waist, direct front view, arms relaxed at sides."),
    ("upper body, front view, arms crossed", "Medium shot from head to waist, front view, arms crossed."),
    ("upper body, front view, hand on hip", "Medium shot from head to waist, front view, one hand on hip."),
    ("upper body, three-quarter view, right", "Medium shot from head to waist, three-quarter angle turned to the right."),
    ("upper body, three-quarter view, left", "Medium shot from head to waist, three-quarter angle turned to the left."),
    ("upper body, side profile", "Medium shot from head to waist, side profile view, arms relaxed."),
    ("upper body, back view, looking back", "Medium shot from head to waist, back view, head turned looking back over shoulder."),
    ("upper body, waving", "Medium shot from head to waist, three-quarter angle, one hand raised waving."),
    ("upper body, pointing", "Medium shot from head to waist, three-quarter angle, one arm pointing to the side."),
    ("upper body, both hands raised", "Medium shot from head to waist, front view, both hands raised beside the head."),
    ("upper body, adjusting hair", "Medium shot from head to waist, three-quarter angle, one hand touching the hair."),
    ("upper body, holding skirt hem", "Medium shot from head to waist, front view, both hands holding the skirt hem."),
    ("upper body, hands clasped in front", "Medium shot from head to waist, front view, hands clasped in front."),
    ("upper body, peace sign", "Medium shot from head to waist, front view, one hand raised in a peace sign."),
    ("upper body, hand behind back", "Medium shot from head to waist, three-quarter angle, one arm tucked behind the back."),
    ("upper body, touching collar", "Medium shot from head to waist, front view, fingers touching the shirt collar."),
    ("upper body, saluting", "Medium shot from head to waist, front view, hand raised in a playful salute."),
    ("upper body, holding phone", "Medium shot from head to waist, front view, holding a smartphone at chest height."),
]

FULLBODY_POOL = [
    ("full body, standing, front view, neutral", "Full-body direct front view, standing straight, arms relaxed, whole body visible head to toe with margin."),
    ("full body, standing, three-quarter right", "Full-body three-quarter front view, turned 45 degrees to the right."),
    ("full body, standing, side profile", "Full-body side profile view, facing right, whole body visible with margin."),
    ("full body, standing, back view", "Full-body back view, showing the back of the outfit."),
    ("full body, standing, three-quarter left", "Full-body three-quarter front view, turned 45 degrees to the left."),
    ("full body, walking, side view", "Full-body walking pose, side view, one leg forward."),
    ("full body, sitting on chair", "Full-body sitting on a simple chair, hands on lap, whole body visible."),
    ("full body, standing, arms raised", "Full-body front view, both arms raised above the head."),
    ("full body, standing, looking back", "Full-body three-quarter back view, head turned looking back over the shoulder."),
    ("full body, standing, hand on hip", "Full-body front view, one hand on hip, weight shifted to one leg."),
    ("full body, kneeling", "Full-body kneeling on one knee, looking at viewer."),
    ("full body, dynamic pose, hand forward", "Full-body action pose, one hand reaching forward, slight lean."),
    ("full body, sitting on floor", "Full-body sitting on the floor, legs folded to the side, whole body visible."),
    ("full body, running", "Full-body running pose, side view, arms swinging."),
    ("full body, jumping", "Full-body jumping pose, both feet off the ground, arms spread."),
    ("full body, leaning against wall", "Full-body leaning against a plain wall, one leg crossed over the other."),
    ("full body, crouching", "Full-body crouching pose, one knee up, looking at viewer."),
    ("full body, stretching", "Full-body stretching pose, arms reaching upward, standing on tiptoes."),
]

_POOLS = {"face": FACE_POOL, "upper": UPPER_POOL, "fullbody": FULLBODY_POOL}

LIGHTING = [
    "soft studio lighting",
    "gentle diffused lighting",
    "bright even lighting",
    "soft top-down lighting",
]


# ---------------------------------------------------------------------------
# Prompt assembly (per-panel styles / scenes, concise grid framing)
# ---------------------------------------------------------------------------
def lookup_style(style_arg: str):
    want = style_arg.strip().lower()
    for s in CFG["styles"]:
        if want in s["tag"].lower():
            return s
    raise RuntimeError(
        f"--style '{style_arg}' not found; available: "
        f"{', '.join(s['tag'] for s in CFG['styles'])}"
    )


def sample_styles(style_arg: str, rng) -> list:
    """Art styles for one sheet: per-panel entries when randomization is on,
    one uniform style otherwise. --style TAG pins it for every panel."""
    if style_arg:
        pinned = lookup_style(style_arg)
        return [pinned] * GRID_CELLS
    if not CFG["randomize_panel_style"]:
        return [CFG["styles"][0]] * GRID_CELLS if CFG["styles"] else []
    if len(CFG["styles"]) >= GRID_CELLS:
        return rng.sample(CFG["styles"], GRID_CELLS)
    return rng.choices(CFG["styles"], k=GRID_CELLS)


def sample_scenes(rng) -> list:
    """Background scenes for one sheet: per-panel when randomization is on,
    empty otherwise (panels keep the plain white sheet)."""
    if not CFG["randomize_panel_scene"] or not CFG["scenes"]:
        return []
    if len(CFG["scenes"]) >= GRID_CELLS:
        return rng.sample(CFG["scenes"], GRID_CELLS)
    return rng.choices(CFG["scenes"], k=GRID_CELLS)


def reference_guide(base: str, refs) -> str:
    """Explain which attached reference image is the face and which is the
    outfit. In this pipeline refs are ordered avatar(s) first, then the
    outfit fullbody picture (last)."""
    if not refs:
        return ""
    if base == "face" or len(refs) < 2:
        names = ", ".join(f"'{os.path.basename(r)}'" for r in refs)
        return (f"REFERENCE IMAGE ROLES: the attached reference image(s) "
                f"{names} show the character's FACE. Copy this exact face, "
                f"hairstyle, eye color and facial features into all 12 "
                f"panels; never change the character's identity.")
    return (f"REFERENCE IMAGE ROLES: the FIRST attached reference image "
            f"({os.path.basename(refs[0])}) is the character's FACE - copy "
            f"this exact face, hairstyle and identity into all 12 panels. "
            f"The LAST attached reference image "
            f"({os.path.basename(refs[-1])}) is the character's OUTFIT "
            f"(fullbody clothing picture) - copy this exact outfit, its "
            f"colors and details onto the character in all 12 panels. Never "
            f"take the face from the outfit picture and never take the "
            f"outfit from the face picture.")


def assemble_sheet(stage: str, rng, styles: list, scenes: list, light: str,
                   refs):
    """Assemble one sheet prompt in the simple framing mode: 12 panels
    sampled from the stage's pool, each panel carrying its own art style
    (`styles`, len 0 or GRID_CELLS) and its own background scene (`scenes`,
    len 0 or GRID_CELLS), plus the explicit reference-image roles.

    Returns (prompt, panel_map) where panel_map[(r, c)] =
    (caption tags, style tag, scene tag) for the 12 panels (1-based)."""
    base = "face" if stage == "face" else stage.split("_")[1]
    pool = _POOLS[base]
    panels = rng.sample(pool, GRID_CELLS)
    lines, panel_map = [], {}
    for idx, (tags, desc) in enumerate(panels):
        r, c = divmod(idx, GRID_COLS)
        line = f"* R{r + 1}C{c + 1}: {tags} :: {desc}"
        st = styles[idx] if idx < len(styles) else None
        sc = scenes[idx] if idx < len(scenes) else None
        if st:
            line += f" Panel art style: {st['text']}."
        if sc:
            line += f" Background scene: {sc['text']}."
        lines.append(line)
        panel_map[(r + 1, c + 1)] = (
            tags,
            st["tag"] if st else "",
            sc["tag"] if sc else "",
        )
    panel_block = "\n".join(lines)
    has_style = any(styles)
    has_scene = any(scenes)

    if base == "face":
        subject = ("Character: the same face, hair and identity as the FIRST "
                   "reference image, with identical features and colors in "
                   "all 12 panels.")
        geometry = ("* Geometry: every panel the same square size, head and "
                    "shoulders centered in each panel, no panel borders or "
                    "frames, only white gutters separate panels.")
        core_neg = ("NO text, NO words, NO letters, NO numbers, NO labels, "
                    "NO watermark, NO speech bubbles, NO back views, NO "
                    "merged panels, NO missing panels, NO extra panels, NO "
                    "uneven rows, NO crooked grid.")
    elif base == "upper":
        subject = ("Character & outfit: the same face as the FIRST reference "
                   "image and the same outfit as the LAST reference image, "
                   "identical in all 12 panels.")
        geometry = ("* Geometry: equal panel sizes, consistent head-to-waist "
                    "scale, no panel borders or frames, only white gutters "
                    "separate panels.")
        core_neg = ("NO text, NO words, NO letters, NO numbers, NO "
                    "watermark, NO logos, NO merged panels, NO missing "
                    "panels, NO extra panels, NO uneven rows, NO crooked grid.")
    else:
        subject = ("Character & outfit: the same face as the FIRST reference "
                   "image and the same outfit as the LAST reference image, "
                   "identical in all 12 panels.")
        geometry = ("* Geometry: every panel the same size, full body visible "
                    "head to toe with margin in each panel, no panel borders "
                    "or frames, only white gutters separate panels.")
        core_neg = ("NO text, NO words, NO letters, NO numbers, NO height "
                    "grid lines, NO color swatches, NO watermark, NO merged "
                    "panels, NO missing panels, NO extra panels, NO uneven "
                    "rows, NO crooked grid.")

    if has_scene:
        sheet_line = (f"A character {base} reference sheet drawn as a clean "
                      f"3-column by 4-row matrix of 12 separate square "
                      f"panels on a pure white sheet, with wide uniform "
                      f"white gutters between every panel. Each panel is "
                      f"filled edge to edge with the background scene "
                      f"declared in its own panel line.")
        end_neg = (" White gutters and sheet around the panels; the panels "
                   "themselves show their declared scene. Never leave a "
                   "panel empty or white.")
    else:
        sheet_line = (f"A character {base} reference sheet drawn as a clean "
                      f"3-column by 4-row matrix of 12 separate square "
                      f"panels on a pure white background, with wide uniform "
                      f"white gutters between every panel.")
        end_neg = (" Plain solid white background only.")

    style_bullet = ""
    if has_style:
        distinct = len({s["tag"] for s in styles})
        if distinct > 1:
            style_bullet = ("* Art styles: every panel uses the art style "
                            "declared in its own panel description; the "
                            "panels intentionally differ in style.\n")
        else:
            style_bullet = ("* Art styles: all panels share the art style "
                            "declared in each panel description.\n")

    ref_guide = reference_guide(base, refs)

    return f"""GRID: 3x4
{sheet_line}

{subject}

{ref_guide}

Layout & Framing (row-major order, left to right, top to bottom):
{panel_block}

Art Style & Constraints:
{style_bullet}* The character's face, hair, eyes, outfit and colors must stay identical across all 12 panels.
* Lighting: {light}.
{geometry}
* Strict Negative Constraints: {core_neg + end_neg}""", panel_map


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def make_caption(trigger: str, stage: str, panel_tags: str,
                 style_tag: str = "", scene_tag: str = "") -> str:
    base = "face" if stage == "face" else stage.split("_")[1]
    fallback = {"face": "portrait", "upper": "upper body",
                "fullbody": "full body"}.get(base, "")
    parts = [trigger, "1girl", "solo"]
    if panel_tags or fallback:
        parts.append(panel_tags or fallback)
    if style_tag:
        parts.append(style_tag)
    if scene_tag:
        parts.append(scene_tag)
    return ", ".join(parts)


def build_plan(avatars, fullbodies):
    """Stages for one run: face (avatar only), then per fullbody picture
    one upper grid and one fullbody grid (avatar + that picture)."""
    plan = [{"stage": "face", "refs": list(avatars)}]
    for i, fb in enumerate(fullbodies, 1):
        refs = list(avatars) + [fb]
        plan.append({"stage": f"o{i:02d}_upper", "refs": refs})
        plan.append({"stage": f"o{i:02d}_fullbody", "refs": refs})
    return plan


def run_stage(stage: str, refs, args, client, rng, raw_dir: str, result_dir):
    """Generate the stage's sheets (each sheet samples 12 panels, plus
    per-panel art styles / scenes according to the config), split them into
    12 cells, and collect the numbered images into the result folder.
    Returns a stage record."""
    record = {"stage": stage, "grid": [GRID_COLS, GRID_ROWS],
              "variations": args.variations, "sheets": [],
              "images": [], "errors": []}
    tile_dir = os.path.join(raw_dir, f"tiles_{stage}")
    os.makedirs(tile_dir, exist_ok=True)
    counter = 1
    for v in range(1, args.variations + 1):
        styles = sample_styles(args.style, rng)
        scenes = sample_scenes(rng)
        light = rng.choice(LIGHTING)
        prompt, panel_map = assemble_sheet(stage, rng, styles, scenes, light,
                                           refs)
        sheet_path = os.path.join(raw_dir, f"{stage}_v{v:02d}.png")

        # Generate with retries; on failure resample styles/panels (e.g. a
        # blocked artist style) and try again.
        last_err = None
        for attempt in range(args.retries + 1):
            if attempt:
                styles = sample_styles(args.style, rng)
                scenes = sample_scenes(rng)
                light = rng.choice(LIGHTING)
                prompt, panel_map = assemble_sheet(stage, rng, styles,
                                                   scenes, light, refs)
            n_style = len({s["tag"] for s in styles}) if styles else 0
            shown = ", ".join(s["tag"] for s in styles[:3]) if styles else "none"
            scenes_shown = ", ".join(s["tag"] for s in scenes[:3]) if scenes else "none"
            print(f"[lora_data_maker] {stage} variation {v}/"
                  f"{args.variations} attempt {attempt + 1}/{args.retries + 1}: "
                  f"generating (refs {len(refs)}, light '{light}', "
                  f"styles [{shown}] ({n_style} distinct), scenes [{scenes_shown}])",
                  flush=True)
            try:
                generate_image(client, args.image_model, prompt, refs,
                               sheet_path, args.aspect_ratio, args.image_size)
                break
            except Exception as exc:  # noqa: BLE001 - resample and retry
                last_err = exc
                if attempt >= args.retries:
                    break
                print(f"[lora_data_maker] {stage} variation {v} attempt "
                      f"{attempt + 1} failed: {str(exc)[:140]} - resampling "
                      f"styles/scenes and retrying", flush=True)
                time.sleep(2 ** attempt)

        if last_err is not None:
            record["errors"].append((v, str(last_err)))
            print(f"[lora_data_maker] {stage} variation {v} FAILED after "
                  f"retries: {last_err}", flush=True)
            continue

        record["sheets"].append(os.path.basename(sheet_path))
        print(f"[lora_data_maker] {stage} variation {v} -> {sheet_path}",
              flush=True)

        tiles = split_grid(sheet_path, GRID_COLS, GRID_ROWS,
                           args.grid_padding, tile_dir, v)
        print(f"[lora_data_maker] {stage} variation {v} split into "
              f"{GRID_COLS}x{GRID_ROWS} grid -> {len(tiles)} tiles "
              f"(padding {args.grid_padding}px)", flush=True)

        for i, tile_path in enumerate(tiles):
            r, c = divmod(i, GRID_COLS)
            tags, style_tag, scene_tag = panel_map.get((r + 1, c + 1),
                                                       ("", "", ""))
            final_name = f"{args.prefix}_{stage}_{counter:03d}.png"
            shutil.copy2(tile_path, os.path.join(result_dir, final_name))
            caption = make_caption(args.trigger, stage, tags, style_tag,
                                   scene_tag)
            if args.captions:
                with open(os.path.join(result_dir, final_name[:-4] + ".txt"),
                          "w", encoding="utf-8") as f:
                    f.write(caption + "\n")
            record["images"].append({
                "file": final_name,
                "caption": caption if args.captions else "",
                "style": style_tag,
                "scene": scene_tag,
                "variation": v,
                "panel": f"R{r + 1}C{c + 1}",
                "sheet": os.path.basename(sheet_path),
            })
            counter += 1
    return record


# ---------------------------------------------------------------------------
# Self test (no API, no key)
# ---------------------------------------------------------------------------
def selftest() -> int:
    import tempfile
    from PIL import Image, ImageDraw

    use_default_config()
    ok = True
    work = tempfile.mkdtemp(prefix="lora_data_maker_selftest_")
    try:
        cols, rows, pad = GRID_COLS, GRID_ROWS, 8
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
        assert len(tiles) == 12, f"expected 12 tiles, got {len(tiles)}"
        exp_w, exp_h = w // cols, h // rows
        for t in tiles:
            with Image.open(t) as ti:
                tw, th = ti.size
                assert tw in (exp_w, exp_w + 1) and th in (exp_h, exp_h + 1), \
                    f"bad tile size {ti.size}"
                assert ti.getbbox() is not None, "tile is empty"
        print(f"[selftest] split: 3x4 sheet -> 12 tiles ~{exp_w}x{exp_h} OK")

        tiles2 = split_grid(sheet, cols, rows, 2, work, 0)
        with Image.open(tiles2[0]) as ti:
            assert ti.size == (exp_w - 4, exp_h - 4), \
                f"bad trimmed size {ti.size}"
        print(f"[selftest] padding trim: 2px/side -> "
              f"{exp_w - 4}x{exp_h - 4} tile OK")

        # Prompt assembler, style randomization ON.
        for stage, pool in (("face", FACE_POOL), ("o01_upper", UPPER_POOL),
                            ("o01_fullbody", FULLBODY_POOL)):
            assert len(pool) >= GRID_CELLS, f"{stage}: pool too small"
            rng = random.Random(42)
            styles = sample_styles("", rng)
            assert len({s["tag"] for s in styles}) == 12, \
                "style randomization must give 12 distinct panel styles"
            sample_refs = (["avatar.png"] if stage == "face"
                           else ["avatar.png", "outfit_fullbody.png"])
            prompt, panel_map = assemble_sheet(stage, rng, styles, [],
                                               LIGHTING[0], sample_refs)
            assert "clean 3-column by 4-row matrix of 12 separate" in prompt \
                and "wide uniform white gutters" in prompt, \
                f"{stage}: grid framing wording missing"
            panels = parse_panels(prompt)
            assert len(panels) == 12, f"{stage}: {len(panels)} panels"
            assert len(panel_map) == 12, f"{stage}: panel map incomplete"
            assert all("Panel art style:" in line
                       for line in prompt.splitlines()
                       if line.strip().startswith("* R") and "::" in line), \
                f"{stage}: a panel line lacks its art style"
            assert "Background scene:" not in prompt, \
                f"{stage}: scenes off but scene text present"
            assert "FACE" in prompt, f"{stage}: face role missing"
            if stage != "face":
                assert "OUTFIT" in prompt, f"{stage}: outfit role missing"
            print(f"[selftest] {stage}: style-randomized sheet, plain panels "
                  f"OK")

        # Scene randomization ON (no styles).
        CFG["randomize_panel_scene"] = True
        try:
            rng = random.Random(5)
            prompt, panel_map = assemble_sheet(
                "o01_fullbody", rng, [], sample_scenes(rng), LIGHTING[0],
                ["avatar.png", "outfit_fullbody.png"])
            assert len(panel_map) == 12, "scene map incomplete"
            assert all("Background scene:" in line
                       for line in prompt.splitlines()
                       if line.strip().startswith("* R") and "::" in line), \
                "a panel line lacks its background scene"
            assert "Plain solid white background only." not in prompt, \
                "scene mode must not demand white interiors"
            assert "Never leave a panel empty" in prompt, \
                "scene mode empty-panel rule missing"
            print("[selftest] scene randomization: 12 panels x 12 scenes OK")
        finally:
            CFG["randomize_panel_scene"] = False

        # Determinism with a seed + variety without one.
        rng_a, rng_b = random.Random(7), random.Random(7)
        pa, _ = assemble_sheet("face", rng_a, sample_styles("", rng_a), [],
                               LIGHTING[0], ["avatar.png"])
        pb, _ = assemble_sheet("face", rng_b, sample_styles("", rng_b), [],
                               LIGHTING[0], ["avatar.png"])
        assert pa == pb, "same seed must give identical prompts"
        pinned = sample_styles("monochrome grayscale", random.Random(1))
        assert len({s["tag"] for s in pinned}) == 1, "--style must pin"
        styles_seen = {sample_styles("", random.Random(s))[0]["tag"]
                       for s in range(12)}
        assert len(styles_seen) > 1, "style pool should give variety"
        print("[selftest] seed determinism + --style pinning + variety OK")
    except Exception as exc:  # noqa: BLE001
        ok = False
        print(f"[selftest] FAILED: {exc}")
    finally:
        use_default_config()
        shutil.rmtree(work, ignore_errors=True)
    print("[selftest] " + ("ALL OK" if ok else "FAILED"))
    return 0 if ok else 1


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def main() -> int:
    parser = argparse.ArgumentParser(
        description="LoRA dataset maker: avatar -> 12-expression face grid; "
                    "avatar + each fullbody picture -> 12-image upper grid + "
                    "12-image fullbody grid. Per-panel art style + scene "
                    "randomization from a YAML config. Output: one flat "
                    "folder of images."
    )
    parser.add_argument("--avatar", nargs="+", default=None,
                        help="Avatar/portrait picture(s) for the character "
                             "identity (used for the face grid and attached "
                             "to every outfit grid).")
    parser.add_argument("--fullbody", nargs="*", default=None,
                        help="Fullbody outfit picture(s); each one produces "
                             "one upper grid + one fullbody grid with the "
                             "avatar attached (A+B, A+C, ...).")
    parser.add_argument("--out", default="",
                        help="Result folder (default: "
                             "training_data/lora_<trigger>/).")
    parser.add_argument("--variations", type=int, default=1,
                        help="Sheets per stage (default: 1; each sheet = 12 "
                             "images).")
    parser.add_argument("--style", default="",
                        help="Pin one art style for all 12 panels of every "
                             "sheet instead of per-panel randomization. "
                             "Available: " + ", ".join(s["tag"] for s in CFG["styles"]))
    parser.add_argument("--seed", type=int, default=None,
                        help="Random seed for style/scene/panel sampling "
                             "(default: random every run).")
    parser.add_argument("--config", default="",
                        help="YAML config path (default: "
                             + DEFAULT_CONFIG_PATH + ").")
    parser.add_argument("--grid-padding", type=int, default=8,
                        help="Trim P pixels from every side of each grid cell "
                             "to remove grid-line artifacts (default: 8).")
    parser.add_argument("--image-size", default="2K",
                        help="Gemini image size e.g. 1K, 2K, 4K (default: 2K).")
    parser.add_argument("--aspect-ratio", default="3:4",
                        help="Sheet aspect ratio (default: 3:4, matches the "
                             "3-column x 4-row grids).")
    parser.add_argument("--captions", action="store_true",
                        help="Write kohya-style .txt tag files beside the "
                             "images (default: images only).")
    parser.add_argument("--trigger", default="",
                        help="Trigger word used for the folder name, file "
                             "prefix and captions (default: inferred from "
                             "the avatar filename, else 'chara').")
    parser.add_argument("--image-model", default="",
                        help="Nano Banana image model (default: "
                             "config_states/gemini_models.txt).")
    parser.add_argument("--output-dir", default="",
                        help="Raw working directory for sheets/tiles "
                             "(default: outputs/lora_data_maker/<timestamp>/).")
    parser.add_argument("--retries", type=int, default=3,
                        help="Max retries per image on error (default: 3; "
                             "styles/scenes/panels are resampled on retry).")
    parser.add_argument("--api-key", default="",
                        help="Gemini API key (or GEMINI_API_KEY env / config txt).")
    parser.add_argument("--dry-run", action="store_true",
                        help="Print the plan (stages, grids, sampled styles, "
                             "scenes, counts) without calling the API.")
    parser.add_argument("--selftest", action="store_true",
                        help="Run the offline self test and exit.")
    args = parser.parse_args()

    if args.selftest:
        return selftest()
    if not args.avatar:
        parser.error("--avatar is required (the character's portrait picture)")
    if args.variations < 1:
        parser.error("--variations must be >= 1")
    if args.grid_padding < 0:
        parser.error("--grid-padding must be >= 0")
    if not args.image_model:
        from models_config import load_model_config
        args.image_model = load_model_config()["image_model"]

    try:
        cfg = resolve_config(args)
        apply_config(cfg)

        avatars = ref_images_from_args(args.avatar)
        fullbodies = ref_images_from_args(args.fullbody or [])
        all_refs = avatars + fullbodies
        args.trigger = (args.trigger or "").strip() or infer_trigger(all_refs)
        if args.trigger == "chara" and all_refs:
            print("[lora_data_maker] warning: no trigger inferred from the "
                  "pictures; using 'chara'. Set --trigger.", flush=True)
        # File-name-safe version of the trigger: prefix for every output image.
        args.prefix = re.sub(r"[^A-Za-z0-9_-]+", "_", args.trigger).strip("_") \
            or "chara"

        result_dir = args.out or os.path.join(DEFAULT_RESULT_DIR,
                                              f"lora_{args.prefix}")
        raw_dir = args.output_dir or os.path.join(
            DEFAULT_OUTPUT_DIR,
            datetime.date.today().strftime("%Y-%m-%d"),
            datetime.datetime.now().strftime("%H%M%S"),
        )

        plan = build_plan(avatars, fullbodies)
        total = sum(GRID_CELLS * args.variations for _ in plan)
        rng = random.Random(args.seed)

        # ---------------- dry run ----------------
        if args.dry_run:
            print("\n[lora_data_maker] PLAN (dry run, no API calls):",
                  flush=True)
            print(f"  config: style randomization = "
                  f"{CFG['randomize_panel_style']} "
                  f"({len(CFG['styles'])} styles) | scene randomization = "
                  f"{CFG['randomize_panel_scene']} "
                  f"({len(CFG['scenes'])} scenes)", flush=True)
            for p in plan:
                styles = sample_styles(args.style, rng)
                scenes = sample_scenes(rng)
                _, panel_map = assemble_sheet(p["stage"], rng, styles,
                                              scenes, LIGHTING[0], p["refs"])
                refs = [os.path.basename(r) for r in p["refs"]]
                tags, style_tag, scene_tag = panel_map.get((1, 1),
                                                           ("", "", ""))
                sample = make_caption(args.trigger, p["stage"], tags,
                                      style_tag, scene_tag)
                n_style = len({s["tag"] for s in styles}) if styles else 0
                shown_s = (", ".join(s["tag"] for s in styles[:3])
                           if styles else "uniform/off")
                shown_c = (", ".join(s["tag"] for s in scenes[:3])
                           if scenes else "plain white")
                print(f"  {p['stage']:<14} grid 3x4  refs {refs}  "
                      f"-> {GRID_CELLS * args.variations} images  "
                      f"light '{LIGHTING[0]}'", flush=True)
                print(f"      panel styles: {shown_s} ... "
                      f"({n_style} distinct)", flush=True)
                print(f"      panel scenes: {shown_c} ...", flush=True)
                print(f"      files: {args.prefix}_{p['stage']}_001.png ...",
                      flush=True)
                print(f"      sample caption: {sample}", flush=True)
            print(f"  TOTAL {total} images -> {result_dir}", flush=True)
            result = {
                "ok": True, "dry_run": True, "trigger": args.trigger,
                "result_dir": result_dir, "seed": args.seed,
                "config": os.path.abspath(args.config or DEFAULT_CONFIG_PATH),
                "randomize_panel_style": CFG["randomize_panel_style"],
                "randomize_panel_scene": CFG["randomize_panel_scene"],
                "stages": [{"stage": p["stage"],
                            "cells": GRID_CELLS * args.variations}
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
        client = _make_client(api_key)
        os.makedirs(raw_dir, exist_ok=True)
        os.makedirs(result_dir, exist_ok=True)

        stage_records, errors = [], []
        for p in plan:
            rec = run_stage(p["stage"], p["refs"], args, client, rng,
                            raw_dir, result_dir)
            stage_records.append(rec)
            errors.extend(rec["errors"])

        images = [img for rec in stage_records for img in rec["images"]]
        ok = not errors
        result = {
            "ok": ok,
            "trigger": args.trigger,
            "seed": args.seed,
            "image_model": args.image_model,
            "output_dir": raw_dir,
            "result_dir": result_dir,
            "stages": stage_records,
            "total_images": len(images),
        }
        manifest = dict(result)
        manifest["created"] = datetime.datetime.now().isoformat(timespec="seconds")
        with open(os.path.join(raw_dir, "manifest.json"), "w",
                  encoding="utf-8") as f:
            json.dump(manifest, f, ensure_ascii=False, indent=2)
        if errors:
            result["errors"] = errors
        print(json.dumps(result, ensure_ascii=False), flush=True)
        return 0 if ok else 1

    except Exception as exc:  # noqa: BLE001 - report any failure as JSON
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False),
              flush=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
