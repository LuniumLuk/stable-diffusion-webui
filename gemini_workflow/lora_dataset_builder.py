"""
gemini_workflow/lora_dataset_builder.py -- one-shot, self-checking LoRA
dataset pipeline for a game/anime character.

WHY THIS EXISTS (what went wrong with the old lora_data_maker flow)
  1. It rendered 3x4 / 3x3 CONTACT SHEETS and cut them into tiles, so every
     image was ~550-600px - trained at 1024 SDXL buckets that is a 1.8x
     upscale, i.e. blurry training data.
  2. Every tile was the same shot type (shoulder-up face) on pure white, so
     the LoRA learned "face + cloud-white background" and nothing about the
     outfit, the back/side views or full body.
  3. Nothing was verified: wrong character, broken tiles, double faces and
     duplicates all reached training and had to be deleted by hand.
  4. Captions came from DeepDanbooru on AI output, which hallucinates tags
     (`1girl` on a boy, wrong eye colour) and needs a manual cleanup pass.

  This builder generates ONE full-quality image per API call, from an explicit
  shot plan that covers face / upper / cowboy / full body x front /
  three-quarter / side / back, with a mix of white and real backgrounds. Then
  it verifies every image (local metrics + a batched vision-model judge),
  writes plan-accurate captions and emits a kohya-ready folder. No manual
  selection step is needed - rejected images never reach the dataset.

USAGE
  lora_dataset_builder.bat --profile mika ^
      --face  data\\collection\\genshin\\mika_avatar.png ^
      --outfit data\\collection\\genshin\\_refs\\mika\\character_mika_game.png ^
      --out  data\\train_data\\genshin\\mika_v4

  lora_dataset_builder.bat --profile mika --face ... --dry-run    (plan only)
  lora_dataset_builder.bat --profile mika --face ... --resume     (reuse raw/)
  lora_dataset_builder.bat --selftest                             (offline)

SHOTS (--shots)
  all (default) | a comma list of kinds: face,upper,cowboy,full

VERIFICATION (--no-judge turns the vision-model pass off)
  * local:  decode / size / blur / blank / gutter / duplicate
            (tools/dataset_qa.py, root .venv, numpy+PIL only)
  * judge:  the Gemini TEXT model checks every candidate in batches:
            right character, exactly one person, shot/view/background it
            actually drew, ahoge visible, outfit correct, artifacts.
            Text-model calls do not consume image-generation quota.

OUTPUT
  dataset   <--out>/<repeat>_lora_<trigger>/
            img_001.png + img_001.txt ... (SDXL bucket sizes, kohya layout).
            The repeat comes from that folder name, which is what sd-scripts
            reads, and <--out> is exactly what you pass to the training bat.
            Default --out: data/train_data/<group>/<character>.
  raw       outputs/lora_dataset_builder/<date>/<time>/
            shots/*.png (as generated), review.html, report.json, run.json
"""
import argparse
import base64
import datetime
import io
import json
import os
import re
import shutil
import subprocess
import sys

_WORKFLOW_DIR = os.path.dirname(os.path.abspath(__file__))
if _WORKFLOW_DIR not in sys.path:
    sys.path.insert(0, _WORKFLOW_DIR)

from generate import _make_client  # noqa: E402
from image_maker import (  # noqa: E402 - shared pipeline helpers
    _resolve_api_key,
    generate_image,
    ref_images_from_args,
)
from models_config import load_model_config  # noqa: E402

_ROOT_DIR = os.path.dirname(_WORKFLOW_DIR)
DEFAULT_RAW_DIR = os.path.join(_ROOT_DIR, "outputs", "lora_dataset_builder")
DEFAULT_DATASET_ROOT = os.path.join(_ROOT_DIR, "data", "train_data")
DEFAULT_PROFILES_PATH = os.path.join(_ROOT_DIR, "config_states",
                                     "lora_dataset_profiles.json")
QA_SCRIPT = os.path.join(_ROOT_DIR, "tools", "dataset_qa.py")

IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".bmp")


# ---------------------------------------------------------------------------
# Character profiles
# ---------------------------------------------------------------------------
# A profile is everything the pipeline needs to know about the character:
# trigger tokens for the caption, the canonical identity/outfit tags (so the
# deleted DeepDanbooru pass is no longer needed), and the wording that goes
# into the generation prompt. Add entries to
# config_states/lora_dataset_profiles.json to override or extend these.
DEFAULT_PROFILES = {
    "mika": {
        "game": "genshin impact",
        "character": "mika (genshin impact)",
        "trigger": "mika_v4",
        "repeat": 3,
        "dataset_group": "genshin",
        "gender": ["1boy", "male focus"],
        "identity": ["blonde hair", "short hair", "ahoge", "curly hair",
                     "colored tips", "blue eyes"],
        "identity_prompt": (
            "short messy blonde hair growing in curled tufts, the tips fading "
            "to warm golden-brown; ONE tall pointed ahoge rising from the top "
            "of the head; bright blue eyes; a soft rounded young-boy anime "
            "face with light skin"),
        "outfit": ["white high collar", "blue jacket", "gold trim",
                   "yellow necktie", "white shorts", "black gloves",
                   "brown boots", "blue sash", "feather ornament"],
        "outfit_prompt": (
            "a white high-collared shirt under a dark-blue jacket with gold "
            "and pale-blue trim, a bright yellow necktie with a white "
            "geometric emblem, a white hooded capelet resting behind the "
            "shoulders, a large dark-blue feather ornament with a glowing "
            "pale-blue crystal on the left shoulder, a diagonal leather chest "
            "strap, black gloves with blue gems, white knee-length shorts "
            "with grey diamond patterns, dark-blue waist sashes ending in "
            "silver cross-shaped ornaments, dark patterned socks and brown "
            "boots with white folded cuffs"),
        "must_keep": [
            "the tall curly ahoge on top of the head must stay clearly "
            "visible - never hidden by the hood, hair strands or the framing",
            "the white hooded capelet stays behind the shoulders and never "
            "covers the hair",
        ],
        "avoid": ["long hair", "female body", "adult man", "chibi"],
        "require_ahoge": True,
    },
}

# Tags that make a training caption describe the SHOT rather than the
# character, so the trigger keeps the identity and the rest stays steerable.
KIND_TAGS = {
    "face": ["portrait", "close-up"],
    "upper": ["upper body"],
    "cowboy": ["cowboy shot"],
    "full": ["full body"],
}
VIEW_TAGS = {
    "front": ["looking at viewer"],
    "three_quarter": ["three-quarter view"],
    "side": ["from side", "profile"],
    "back": ["from behind"],
}

# Without an explicit crop rule the image model happily draws the whole figure
# even when the shot asks for a close-up (the full-body OUTFIT reference pulls
# it that way), so every non-full shot states where the frame ends.
FRAMING_RULES = {
    "face": ("FRAMING (hard rule): the picture is cropped at the collarbone - "
             "only the head, neck and the very top of the shoulders are "
             "visible. The torso, arms, hands, waist, legs and feet are "
             "OUTSIDE the picture and must not be drawn."),
    "upper": ("FRAMING (hard rule): the picture is cropped at the waist - head, "
              "chest, arms and hands are visible; hips, legs and feet are "
              "OUTSIDE the picture and must not be drawn."),
    "cowboy": ("FRAMING (hard rule): the picture is cropped at mid-thigh - head, "
               "torso, hands and the top of the legs are visible; knees, shins "
               "and feet are OUTSIDE the picture and must not be drawn."),
    "full": ("FRAMING (hard rule): the whole body is inside the picture, from "
             "the top of the head down to the soles of both boots, with a "
             "small margin above the head and below the feet."),
}
# Extra negatives that keep a non-full shot from drifting into a full body.
FRAMING_AVOID = {
    "face": ["full body", "legs", "feet", "torso below the collar", "arms"],
    "upper": ["full body", "legs", "feet"],
    "cowboy": ["full body", "feet"],
    "full": [],
}
BUCKETS = [(1024, 1024), (896, 1152), (832, 1216), (768, 1344)]

BACKGROUNDS = {
    "white": {
        "prompt": ("Pure flat white #FFFFFF background - no scenery, no props, "
                   "no floor, no horizon, no gradient, no vignette, no shadow "
                   "on the wall."),
        "tags": ["white background", "simple background"],
    },
    "gradient": {
        "prompt": ("A plain soft pastel-blue studio gradient backdrop and "
                   "nothing else - no scenery, no props."),
        "tags": ["gradient background", "simple background"],
    },
    "scene": {
        "prompt": "",
        "tags": ["blurry background"],
    },
    "indoor": {
        "prompt": ("Inside the Favonius Cathedral library in Mondstadt: warm "
                   "stone walls, tall arched windows with soft daylight, "
                   "wooden bookshelves - clearly out of focus behind the "
                   "character."),
        "tags": ["indoors", "library", "window", "blurry background"],
    },
    "outdoor": {
        "prompt": ("A sunny Mondstadt plaza: pale stone paving, red-roofed "
                   "houses, a clear blue sky with small clouds - clearly out "
                   "of focus behind the character."),
        "tags": ["outdoors", "day", "sky", "city", "blurry background"],
    },
    "sky": {
        "prompt": ("A bright blue sky with soft cumulus clouds behind the "
                   "character - no ground, no props."),
        "tags": ["outdoors", "sky", "cloud", "blurry background"],
    },
}

# One entry = one image-generation call. The plan deliberately covers every
# shot type x view that a character LoRA has to be able to reproduce, and
# mixes clean backgrounds with real ones so the white backdrop never gets
# baked into the LoRA.
SHOTS = [
    {"id": "01_face_front", "kind": "face", "view": "front",
     "aspect": "1:1", "bg": "white", "expr": ["closed mouth", "calm"],
     "prompt": ("Close-up face shot, head and shoulders, facing the viewer "
                "straight on, calm neutral expression with a small "
                "closed-mouth smile.")},
    {"id": "02_face_three_quarter", "kind": "face", "view": "three_quarter",
     "aspect": "1:1", "bg": "white", "expr": ["smile", "closed mouth"],
     "prompt": ("Close-up face shot, head and shoulders, head turned about "
                "30 degrees to the character's right, gentle closed-mouth "
                "smile, eyes toward the viewer.")},
    {"id": "03_face_side", "kind": "face", "view": "side",
     "aspect": "1:1", "bg": "white", "expr": ["closed mouth", "calm"],
     "prompt": ("Close-up face shot in exact side profile, facing to the "
                "right of the frame, calm expression, the ear and the full "
                "jawline visible.")},
    {"id": "04_face_laugh", "kind": "face", "view": "front",
     "aspect": "1:1", "bg": "gradient", "expr": ["open mouth", "laughing", "happy"],
     "prompt": ("Close-up face shot, front view, laughing warmly with an open "
                "mouth and slightly closed happy eyes.")},
    {"id": "05_face_serious", "kind": "face", "view": "front",
     "aspect": "1:1", "bg": "white", "expr": ["serious", "closed mouth"],
     "prompt": ("Close-up face shot, front view, serious focused expression, "
                "mouth closed, brows slightly lowered.")},
    {"id": "06_face_surprised", "kind": "face", "view": "three_quarter",
     "aspect": "1:1", "bg": "sky", "expr": ["surprised", "open mouth"],
     "prompt": ("Close-up face shot, head turned slightly to the left, "
                "surprised wide-eyed expression with a small open mouth.")},
    {"id": "07_upper_front", "kind": "upper", "view": "front",
     "aspect": "3:4", "bg": "white", "expr": ["closed mouth", "calm"],
     "prompt": ("Upper-body shot from the top of the head to the waist, "
                "facing the viewer, arms relaxed at the sides, gentle smile.")},
    {"id": "08_upper_three_quarter", "kind": "upper", "view": "three_quarter",
     "aspect": "3:4", "bg": "white", "expr": ["smile"],
     "prompt": ("Upper-body shot from head to waist, body turned about 40 "
                "degrees to the character's left, looking at the viewer over "
                "the shoulder, soft smile.")},
    {"id": "09_upper_arms_crossed", "kind": "upper", "view": "front",
     "aspect": "3:4", "bg": "gradient", "expr": ["closed mouth", "confident"],
     "prompt": ("Upper-body shot from head to waist, front view, arms crossed "
                "over the chest with both hands visible, confident slight "
                "smirk.")},
    {"id": "10_upper_back", "kind": "upper", "view": "back",
     "aspect": "3:4", "bg": "white", "expr": ["closed mouth"],
     "prompt": ("Upper-body shot seen from behind, head turned to look back "
                "over the right shoulder at the viewer, back of the outfit "
                "and hood clearly visible.")},
    {"id": "11_cowboy_front", "kind": "cowboy", "view": "front",
     "aspect": "2:3", "bg": "white", "expr": ["closed mouth", "calm"],
     "prompt": ("Cowboy shot from the head to mid-thigh, front view, standing "
                "relaxed with arms loose at the sides, calm expression.")},
    {"id": "12_cowboy_side", "kind": "cowboy", "view": "side",
     "aspect": "2:3", "bg": "outdoor", "expr": ["smile"],
     "prompt": ("Cowboy shot from the head to mid-thigh, side view walking to "
                "the right of the frame with one hand raised in a small "
                "greeting, cheerful smile.")},
    {"id": "13_full_front", "kind": "full", "view": "front",
     "aspect": "2:3", "bg": "white", "expr": ["closed mouth", "calm"],
     "prompt": ("Full-body shot, head to toe, facing the viewer straight on, "
                "standing with weight even and arms relaxed, whole body inside "
                "the frame with a small margin.")},
    {"id": "14_full_three_quarter", "kind": "full", "view": "three_quarter",
     "aspect": "2:3", "bg": "white", "expr": ["smile"],
     "prompt": ("Full-body shot, head to toe, body turned about 40 degrees to "
                "the character's right, one hand on the hip, whole body inside "
                "the frame with a small margin.")},
    {"id": "15_full_side", "kind": "full", "view": "side",
     "aspect": "2:3", "bg": "white", "expr": ["closed mouth"],
     "prompt": ("Full-body shot in exact side profile, facing right, standing "
                "still with arms relaxed, the whole outfit visible head to toe.")},
    {"id": "16_full_back", "kind": "full", "view": "back",
     "aspect": "2:3", "bg": "white", "expr": ["closed mouth"],
     "prompt": ("Full-body shot seen from behind, standing straight, head "
                "turned slightly to the left so the cheek is visible, the back "
                "of the outfit, hood and sashes clearly visible head to toe.")},
    {"id": "17_full_walking", "kind": "full", "view": "three_quarter",
     "aspect": "2:3", "bg": "outdoor", "expr": ["smile"],
     "prompt": ("Full-body shot, walking toward the viewer at a "
                "three-quarter angle, one leg forward, arms swinging "
                "naturally, cheerful smile.")},
    {"id": "18_full_action", "kind": "full", "view": "front",
     "aspect": "2:3", "bg": "sky", "expr": ["open mouth", "excited"],
     "prompt": ("Full-body dynamic action pose, floating slightly above the "
                "ground with one knee raised and both arms out for balance, "
                "excited expression, whole body inside the frame.")},
    {"id": "19_full_sitting", "kind": "full", "view": "three_quarter",
     "aspect": "2:3", "bg": "indoor", "expr": ["smile"],
     "prompt": ("Full-body shot of the character sitting on a simple wooden "
                "chair, hands resting on the knees, legs and boots visible, "
                "three-quarter view.")},
    {"id": "20_full_book", "kind": "full", "view": "front",
     "aspect": "2:3", "bg": "indoor", "expr": ["closed mouth", "calm"],
     "prompt": ("Full-body shot, front view, standing and holding an open "
                "leather book in both hands at chest height, calm focused "
                "expression, whole body inside the frame.")},
    {"id": "21_upper_indoor", "kind": "upper", "view": "three_quarter",
     "aspect": "3:4", "bg": "indoor", "expr": ["smile"],
     "prompt": ("Upper-body shot from head to waist inside the library, body "
                "turned slightly to the right, looking at the viewer with a "
                "warm smile.")},
    {"id": "22_full_outdoor", "kind": "full", "view": "front",
     "aspect": "2:3", "bg": "outdoor", "expr": ["closed mouth", "calm"],
     "prompt": ("Full-body shot, front view, standing on the plaza with arms "
                "relaxed, whole body visible head to toe with margin.")},
]


# ---------------------------------------------------------------------------
# Profiles / plan
# ---------------------------------------------------------------------------
def load_profiles(path: str = "") -> dict:
    """Built-in profiles merged with config_states/lora_dataset_profiles.json."""
    profiles = {k: dict(v) for k, v in DEFAULT_PROFILES.items()}
    path = path or DEFAULT_PROFILES_PATH
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        extra = data.get("profiles", data)
        for name, values in (extra or {}).items():
            merged = dict(profiles.get(name, {}))
            merged.update(values or {})
            profiles[name] = merged
    return profiles


def resolve_profile(profiles: dict, name: str, overrides: dict) -> dict:
    """Pick a profile, apply CLI overrides, fill the derived fields."""
    key = (name or "mika").lower()
    if key not in profiles:
        raise SystemExit(
            f"unknown profile '{name}'. Known: {', '.join(sorted(profiles))} "
            f"(add more in {DEFAULT_PROFILES_PATH})")
    prof = dict(profiles[key])
    for field, value in (overrides or {}).items():
        if value not in (None, "", []):
            prof[field] = value
    prof.setdefault("game", "genshin impact")
    prof.setdefault("gender", [])
    prof.setdefault("identity", [])
    prof.setdefault("outfit", [])
    prof.setdefault("must_keep", [])
    prof.setdefault("avoid", [])
    prof.setdefault("traits", [])
    prof.setdefault("repeat", 3)
    prof.setdefault("trigger", key)
    prof.setdefault("character", f"{key} ({prof['game']})")
    return prof


def select_shots(kinds: str):
    want = [k.strip().lower() for k in (kinds or "all").split(",") if k.strip()]
    if not want or "all" in want:
        return list(SHOTS)
    valid = {s["kind"] for s in SHOTS}
    bad = [k for k in want if k not in valid]
    if bad:
        raise SystemExit(f"--shots: unknown kind(s) {bad}; choose from "
                         f"{sorted(valid)} or 'all'")
    return [s for s in SHOTS if s["kind"] in want]


def shot_bucket(shot: dict):
    """Bucket for a shot's aspect ratio (longest side first)."""
    ratios = {"1:1": (1024, 1024), "3:4": (896, 1152), "2:3": (832, 1216)}
    return ratios.get(shot.get("aspect", ""), (1024, 1024))


# ---------------------------------------------------------------------------
# Prompt / caption assembly
# ---------------------------------------------------------------------------
def sanitize_component(name: str) -> str:
    """Folder-safe name: lower case, single underscores, no spaces/punctuation."""
    cleaned = re.sub(r"[^A-Za-z0-9_-]+", "_", (name or "").strip()).strip("_")
    return cleaned.lower() or "unknown"


def display_name(character: str) -> str:
    """'mika (genshin impact)' -> 'Mika' (used in the generation prompt)."""
    head = (character or "").split("(")[0].strip()
    return head.title() if head else "the character"


def build_prompt(shot: dict, prof: dict, refs: dict, desc: str = "") -> str:
    """One single-image prompt: identity + outfit from the references, one
    explicit shot, one explicit background."""
    bg = BACKGROUNDS[shot["bg"]]
    face_refs = refs.get("face") or []
    outfit_refs = refs.get("outfit") or []

    ref_lines = []
    if face_refs:
        names = ", ".join(f"'{os.path.basename(p)}'" for p in face_refs)
        ref_lines.append(
            f"* FACE reference {names}: the exact face shape, eye shape and "
            f"eye colour, eyebrows, hairstyle, hair colour and hair tips. "
            f"This reference governs the IDENTITY only - do not copy its "
            f"clothing, background or pose.")
    if outfit_refs:
        names = ", ".join(f"'{os.path.basename(p)}'" for p in outfit_refs)
        ref_lines.append(
            f"* OUTFIT reference {names}: the exact garments, trims, buckles, "
            f"sashes and ornaments with their exact colours and placement. "
            f"This reference governs the OUTFIT only - do not copy its face, "
            f"art style or background.")
    refs_block = ("\nREFERENCE IMAGES (all of them show the SAME single "
                  "character):\n" + "\n".join(ref_lines) + "\n") if ref_lines else ""

    must_keep = "".join(f"\n* {line}" for line in prof.get("must_keep", []))
    kind = shot["kind"]
    avoid = list(prof.get("avoid", [])) + list(FRAMING_AVOID.get(kind, [])) + [
        "text", "watermark", "signature", "logo", "UI elements",
        "multiple characters", "character sheet", "multiple panels",
        "split image", "collage", "border", "frame",
        "cropped head", "cut-off face", "blurry", "low resolution",
        "sketch", "monochrome",
    ]
    if kind == "full":
        avoid += ["cropped feet", "cropped legs", "half body only"]
    extra = ""
    if desc:
        extra = ("\nADDITIONAL REQUIREMENTS (highest priority):\n"
                 + "\n".join(f"* {ln.strip()}" for ln in desc.splitlines()
                             if ln.strip()) + "\n")
    # Wide shots are where the eyes drift: the iris is a few dozen pixels, so
    # the model falls back to its prior for the character. Restating the eye
    # colour at the end of the prompt is what keeps it correct.
    eye_note = ""
    if prof.get("eye_line") and kind in ("full", "cowboy"):
        eye_note = (f"EYES AT THIS DISTANCE: {prof['eye_line']}\n")

    return (
        f"Create ONE single, high-resolution anime illustration of "
        f"{display_name(prof['character'])} from {prof['game'].title()}.\n"
        f"{refs_block}"
        f"IDENTITY (must match the FACE reference exactly, no "
        f"reinterpretation): {prof.get('identity_prompt', '')}."
        f"{must_keep}\n"
        f"OUTFIT (must match the OUTFIT reference exactly): "
        f"{prof.get('outfit_prompt', '')}.\n"
        f"SHOT: {shot['prompt']}\n"
        f"{FRAMING_RULES.get(kind, '')}\n"
        f"BACKGROUND: {bg['prompt']}\n"
        f"LIGHTING: soft, even, neutral daylight on the character; no harsh "
        f"shadows; the character is evenly lit and clearly readable.\n"
        f"{eye_note}"
        f"STYLE: clean modern anime illustration, crisp lineart, cel shading "
        f"with soft gradients, official game art quality, high detail.\n"
        f"RULES: exactly ONE character, alone, centered, whole head inside "
        f"the frame; this is a single illustration - NOT a character sheet, "
        f"NOT a collage, NOT several panels.\n"
        f"STRICTLY AVOID: {', '.join(dict.fromkeys(avoid))}.\n"
        f"{extra}"
    )


def resolve_kind(planned: str, verdict: dict) -> str:
    """Which framing the caption should claim.

    The judge's own shot label is used, except that feet_visible arbitrates the
    full-vs-cowboy question: a shot with both feet in frame IS a full body
    (the judge mislabels those as "cowboy" fairly often), and a shot without
    them is never captioned "full body"."""
    v = verdict or {}
    shot = v.get("shot")
    if v.get("feet_visible") is True:
        return "full"
    if v.get("feet_visible") is False and shot == "full":
        return "upper" if planned == "face" else "cowboy"
    return shot if shot in KIND_TAGS else planned


def background_tags(shot: dict, verdict: dict) -> list:
    """Background tags for the caption, corrected by what the judge saw.

    A generic 'scene' answer keeps the planned scene tags (so an indoor shot
    stays 'indoors, library'), and an unexpected scene on a planned white
    shot degrades to a neutral 'blurry background' instead of inventing a
    location."""
    planned = shot.get("bg") or "white"
    seen = (verdict or {}).get("background")
    if seen == "white":
        return BACKGROUNDS["white"]["tags"]
    if seen == "gradient":
        return BACKGROUNDS["gradient"]["tags"]
    if seen == "scene":
        if planned in ("indoor", "outdoor", "sky"):
            return BACKGROUNDS[planned]["tags"]
        return BACKGROUNDS["scene"]["tags"]
    if seen in BACKGROUNDS:
        return BACKGROUNDS[seen]["tags"]
    return BACKGROUNDS.get(planned, BACKGROUNDS["white"])["tags"]


def build_caption(shot: dict, prof: dict, verdict: dict = None) -> str:
    """kohya caption: trigger tokens first (keep_tokens=2), then identity,
    outfit, and the shot/view/background description.

    `verdict` (the judge's reading of the finished image) overrides the
    planned shot/view/background so a caption never lies about what the model
    actually drew."""
    v = verdict or {}
    kind = resolve_kind(shot["kind"], v)
    view = v.get("view") if v.get("view") in VIEW_TAGS else shot["view"]

    parts = [prof["game"], prof["character"]]
    parts += list(prof.get("gender") or [])
    parts += list(prof.get("identity") or [])
    parts += list(prof.get("outfit") or [])
    parts += KIND_TAGS.get(kind, [])
    parts += VIEW_TAGS.get(view, [])
    parts += list(shot.get("expr") or [])
    parts += background_tags(shot, v)
    parts.append("solo")
    seen, out = set(), []
    for tag in parts:
        tag = (tag or "").strip().strip(",")
        if tag and tag not in seen:
            out.append(tag)
            seen.add(tag)
    return ", ".join(out)


def _flatten_rgb(img, background=(255, 255, 255)):
    """RGB copy with any alpha composited onto `background` (PIL only)."""
    from PIL import Image

    if img.mode in ("RGBA", "LA", "P", "PA"):
        rgba = img.convert("RGBA")
        canvas = Image.new("RGB", rgba.size, background)
        canvas.paste(rgba, mask=rgba.split()[-1])
        return canvas
    return img.convert("RGB")


def normalize_refs(paths, out_dir: str, max_side: int = 2048):
    """Copy the reference images into the run folder as white-backed PNGs.

    Reference art is often a transparent cut-out (webp/png). Sent as-is it
    makes the image model render a black backdrop, and stored as-is it becomes
    a black-background training image. Flattening once, up front, fixes both.
    Returns the new paths in the same order.
    """
    from PIL import Image

    os.makedirs(out_dir, exist_ok=True)
    out = []
    for path in paths:
        with Image.open(path) as img:
            img.load()
            flat = _flatten_rgb(img)
            if max(flat.size) > max_side:
                flat.thumbnail((max_side, max_side), Image.LANCZOS)
            stem = os.path.splitext(os.path.basename(path))[0]
            dst = os.path.join(out_dir, sanitize_component(stem) + ".png")
            flat.save(dst, format="PNG")
        out.append(dst)
    return out


# ---------------------------------------------------------------------------
# Judge (vision verification through the text model)
# ---------------------------------------------------------------------------
JUDGE_SCHEMA = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "character": {"type": "string",
                                  "enum": ["match", "weak", "wrong"]},
                    "people": {"type": "integer"},
                    "shot": {"type": "string",
                             "enum": ["face", "upper", "cowboy", "full", "other"]},
                    "feet_visible": {"type": "boolean"},
                    "view": {"type": "string",
                             "enum": ["front", "three_quarter", "side", "back", "other"]},
                    "background": {"type": "string",
                                   "enum": ["white", "gradient", "scene"]},
                    "ahoge": {"type": "boolean"},
                    "outfit": {"type": "string",
                               "enum": ["correct", "partial", "wrong"]},
                    "art_style": {"type": "string",
                                  "enum": ["2d_anime", "3d_render", "other"]},
                    "anatomy": {"type": "string",
                                "enum": ["ok", "minor", "broken"]},
                    "artifacts": {"type": "array", "items": {"type": "string"}},
                    "traits": {"type": "object",
                               "additionalProperties": {
                                   "type": "string",
                                   "enum": ["ok", "partial", "wrong", "unclear"]}},
                    "keep": {"type": "boolean"},
                    "reason": {"type": "string"},
                },
                "required": ["id", "character", "people", "shot", "view",
                             "background", "keep", "reason"],
            },
        }
    },
    "required": ["items"],
}


HARD_REASONS = {"wrong_character", "extra_characters", "broken_anatomy",
                "3d_render_not_for_training"}


def confirm_soft_rejections(client, model: str, verdicts: dict, items,
                            prof: dict, face_ref: str, kind_of,
                            batch_size: int = 4, verbose: bool = True) -> dict:
    """Re-judge only the images that failed a *soft* check, and let a clean
    second opinion overturn the first.

    The vision judge is not perfectly repeatable about subtle traits (a dull red
    iris vs a pink one), and a single unlucky call must not delete a good image.
    Hard failures (wrong character, extra people, broken anatomy, artifacts,
    3D-render references) are never overturned."""
    soft = []
    for cid, path in items:
        if cid.startswith("ref_"):
            continue
        keep, reasons = decide(cid, verdicts.get(cid, {}), prof, kind_of(cid))
        if keep:
            continue
        if any(r in HARD_REASONS for r in reasons):
            continue
        if any(r.startswith(("artifact:", "small:", "blank", "blur", "gutter"))
               for r in reasons):
            continue
        soft.append((cid, path))
    if not soft:
        return verdicts
    if verbose:
        print(f"[builder] confirming {len(soft)} soft rejection(s) with a "
              f"second judge pass", flush=True)
    second = run_judge(client, model, soft, prof, face_ref,
                       batch_size=batch_size, verbose=verbose)
    for cid, _path in soft:
        v2 = second.get(cid)
        if not v2:
            continue
        keep2, _ = decide(cid, v2, prof, kind_of(cid))
        if keep2:
            verdicts[cid] = v2
            if verbose:
                print(f"[builder] {cid}: second opinion is clean - kept",
                      flush=True)
    return verdicts


def _encode_for_judge(path: str, max_side: int = 640) -> dict:
    """Small JPEG for the judge - full PNGs would be slow and pointless."""
    from PIL import Image

    with Image.open(path) as img:
        img = img.convert("RGB")
        img.thumbnail((max_side, max_side), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=85)
    return {"type": "image",
            "data": base64.b64encode(buf.getvalue()).decode("utf-8"),
            "mime_type": "image/jpeg"}


def judge_prompt(prof: dict, batch) -> str:
    """The verification brief: canonical facts, optional per-trait checks, and
    the exact answer keys the schema expects."""
    traits = prof.get("traits") or []
    lines = [
        f"You are a strict QA reviewer for a character LoRA dataset of "
        f"{prof['character']} from {prof['game']}.",
        "The FIRST image is the FACE reference (the canonical character).",
        "Then come numbered candidate images, each labelled with its id.",
        "",
        "Canonical character facts (use them to check the candidates):",
        f"- identity: {prof.get('identity_prompt', '')}",
        f"- outfit: {prof.get('outfit_prompt', '')}",
        "",
    ]
    if traits:
        lines += [
            "SPECIFIC TRAITS TO VERIFY - judge each one only from what is "
            "actually visible in that candidate image:",
        ]
        lines += [f"- '{t['id']}': {t['expect']}" for t in traits]
        lines.append("")
    lines += [
        "For EVERY candidate return one item:",
        "- character: 'match' if it is clearly this character, 'weak' if the "
        "face is off but plausibly the same character, 'wrong' if it is a "
        "different person.",
        "- people: number of characters visible.",
        "- shot: what is actually framed (face = closer than the shoulders, "
        "upper = head to waist, cowboy = head to mid-thigh, full = head to toe).",
        "- feet_visible: true only if both feet (or both boots) are actually "
        "inside the frame.",
        "- view: the body/face orientation actually shown.",
        "- background: 'white' for plain white, 'gradient' for a plain colored "
        "backdrop, 'scene' for any real environment.",
        "- ahoge: true only if the tall hair tuft on top of the head is clearly "
        "visible.",
        "- outfit: 'correct' if it matches the outfit description, 'partial' if "
        "some pieces are missing or recolored, 'wrong' if it is a different "
        "outfit.",
        "- art_style: '2d_anime' for drawn/painted anime art, '3d_render' for a "
        "3D/CGI render (in-game model), 'other' for anything else.",
        "- anatomy: 'broken' for extra/missing limbs, melted face or hands that "
        "are visibly wrong; 'minor' for small issues; else 'ok'.",
        "- artifacts: any of 'text', 'watermark', 'logo', 'border', "
        "'multiple_views', 'panel', 'blurry', 'low_quality' that are present.",
    ]
    if traits:
        lines.append(
            "- traits: an object with one key per trait id above, valued 'ok' "
            "(exactly as described), 'partial' (right base but a detail is "
            "missing), 'wrong' (clearly a different colour/shape) or 'unclear' "
            "(too small or hidden to judge). Judge colour precisely: if the "
            "canon is a dull red iris whose outer edge is a thin greenish ring, "
            "then a pink, magenta or plain bright-red iris is 'wrong', and a "
            "red iris without the greenish outer ring is 'partial'.")
    lines += [
        "- keep: false if the image must not be used for training (wrong "
        "character, extra people, text, visible damage).",
        "- reason: one short sentence.",
        "",
        "Candidates:",
    ]
    lines += [f"- id {cid}" for cid, _path in batch]
    return "\n".join(lines)


def run_judge(client, model: str, items, prof: dict, face_ref: str,
              batch_size: int = 4, verbose: bool = True) -> dict:
    """{id: verdict} for every generated image."""
    verdicts = {}
    batches = [items[i:i + batch_size] for i in range(0, len(items), batch_size)]
    for bi, batch in enumerate(batches, 1):
        content = [{"type": "text", "text": judge_prompt(prof, batch)}]
        if face_ref:
            content.append(_encode_for_judge(face_ref, 512))
        for cid, path in batch:
            content.append({"type": "text", "text": f"id {cid}:"})
            content.append(_encode_for_judge(path))
        if verbose:
            print(f"[builder] judge batch {bi}/{len(batches)} "
                  f"({len(batch)} image(s))", flush=True)
        try:
            resp = client.interactions.create(
                model=model, input=content,
                response_format={"type": "text",
                                 "mime_type": "application/json",
                                 "schema": JUDGE_SCHEMA})
            data = json.loads(resp.output_text or "{}")
        except Exception as exc:  # noqa: BLE001 - judging must never fail a run
            if verbose:
                print(f"[builder] judge batch {bi} failed: {str(exc)[:160]} "
                      f"- keeping the local QA verdict only", flush=True)
            continue
        for entry in data.get("items") or []:
            cid = str(entry.get("id") or "").strip()
            if cid:
                verdicts[cid] = entry
    return verdicts


def decide(item_id: str, verdict: dict, prof: dict, kind: str = None) -> tuple:
    """(keep, [reasons]) from the judge verdict alone.

    `kind` is the planned shot kind: the ahoge must be clearly visible in
    face/upper shots, while in a full-body frame it is legitimately small, so
    it is only a warning there.

    Profile `traits` are checked here too. A trait evaluated 'wrong' always
    rejects; 'partial' rejects only for strict traits (colour/detail traits
    where "close" is still a lie in the caption), and 'unclear' never rejects
    (a full body shot cannot show a thin eye ring)."""
    if not verdict:
        return True, []
    reasons = []
    if verdict.get("character") == "wrong":
        reasons.append("wrong_character")
    if int(verdict.get("people") or 1) > 1:
        reasons.append("extra_characters")
    if verdict.get("anatomy") == "broken":
        reasons.append("broken_anatomy")
    bad = {"text", "watermark", "logo", "border", "multiple_views", "panel",
           "low_quality"}
    for art in verdict.get("artifacts") or []:
        if str(art).lower() in bad:
            reasons.append(f"artifact:{art}")
    if verdict.get("outfit") == "wrong":
        reasons.append("wrong_outfit")
    if kind == "ref" and verdict.get("art_style") == "3d_render":
        reasons.append("3d_render_not_for_training")
    if (prof.get("require_ahoge") and verdict.get("ahoge") is False
            and kind in (None, "face", "upper")):
        reasons.append("ahoge_missing")
    seen_traits = verdict.get("traits") or {}
    for trait in prof.get("traits") or []:
        # A thin iris ring or a beauty mark cannot be judged (or trained) on a
        # full-body frame, so each trait names the framings it applies to.
        kinds = trait.get("kinds")
        if kinds and kind not in kinds:
            continue
        if trait.get("warn_only"):
            continue
        state = str(seen_traits.get(trait["id"]) or "").lower()
        if state == "wrong":
            reasons.append(f"trait:{trait['id']}=wrong")
        elif state == "partial" and trait.get("strict"):
            reasons.append(f"trait:{trait['id']}=partial")
    # The judge's blanket `keep: false` is intentionally NOT a rejection: every
    # hard criterion has its own field above, and the blanket flag fires on
    # cosmetic details (a misplaced beauty mark, a missing accessory) that must
    # not veto an otherwise correct training image. It is still recorded in the
    # verdict for the review sheet.
    return not reasons, reasons


# ---------------------------------------------------------------------------
# Local QA
# ---------------------------------------------------------------------------
def find_qa_python(explicit: str = "") -> str:
    """Root .venv python (numpy + PIL live there, not in the workflow venv)."""
    if explicit:
        return explicit
    for rel in (os.path.join(".venv", "Scripts", "python.exe"),
                os.path.join(".venv", "bin", "python")):
        cand = os.path.join(_ROOT_DIR, rel)
        if os.path.exists(cand):
            return cand
    return sys.executable


def run_qa(src_dir: str, out_dir: str, report: str, python: str,
           min_side: int, blur: float, bucket: bool = True) -> dict:
    cmd = [python, QA_SCRIPT, "--in", src_dir, "--json", report,
           "--out", out_dir, "--min-side", str(min_side),
           "--blur-threshold", str(blur)]
    if bucket:
        cmd.append("--bucket")
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
    if not os.path.exists(report):
        raise RuntimeError(
            "dataset_qa.py produced no report: "
            + ((proc.stdout or "") + (proc.stderr or ""))[-600:])
    with open(report, "r", encoding="utf-8") as f:
        return json.load(f)


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
def write_review(run_dir: str, rows, budget: dict, prof: dict) -> str:
    """Self-contained HTML contact sheet: kept images, rejected images and why."""
    def esc(text):
        return (str(text).replace("&", "&amp;").replace("<", "&lt;")
                .replace(">", "&gt;"))

    kept = [r for r in rows if r["keep"]]
    rejected = [r for r in rows if not r["keep"]]
    css = """
body{font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;margin:24px;
     background:#14161a;color:#e6e6e6}
h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:26px 0 8px}
.sum{color:#9aa4b2;margin-bottom:8px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));
      gap:14px}
figure{margin:0;background:#1d2129;border-radius:10px;overflow:hidden;
       border:1px solid #262c36}
figure img{width:100%;display:block;aspect-ratio:3/4;object-fit:contain;
           background:#0d0f12}
figcaption{padding:7px 9px;font-size:11.5px;color:#b9c2cf;word-break:break-word}
.tag{color:#7f8b9b}
.bad{outline:2px solid #7d2b2b}
.reason{color:#e08a8a}
"""
    parts = [f"<!doctype html><meta charset='utf-8'><title>dataset review</title>"
             f"<style>{css}</style>",
             f"<h1>{esc(prof.get('character', ''))} - dataset review</h1>",
             f"<div class='sum'>{len(kept)} kept &middot; {len(rejected)} "
             f"rejected &middot; {budget.get('used', 0)}/"
             f"{budget.get('max', 0)} image calls used</div>"]
    if rejected:
        parts.append("<h2>Rejected</h2><div class='grid'>")
        for r in rejected:
            parts.append(
                f"<figure class='bad'><img src='{esc(r['raw_rel'])}'>"
                f"<figcaption>{esc(r['id'])}<br>"
                f"<span class='reason'>{esc(', '.join(r['reasons']))}</span>"
                f"</figcaption></figure>")
        parts.append("</div>")
    parts.append("<h2>Kept</h2><div class='grid'>")
    for r in kept:
        parts.append(
            f"<figure><img src='{esc(r['raw_rel'])}'>"
            f"<figcaption>{esc(r['id'])}<br><span class='tag'>"
            f"{esc(r['caption'])}</span></figcaption></figure>")
    parts.append("</div>")
    path = os.path.join(run_dir, "review.html")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(parts))
    return path


# ---------------------------------------------------------------------------
# Self test
# ---------------------------------------------------------------------------
def selftest() -> int:
    ok = True

    def check(cond, msg):
        nonlocal ok
        print(("  ok   " if cond else "  FAIL ") + msg)
        ok = ok and bool(cond)

    profiles = load_profiles()
    prof = resolve_profile(profiles, "mika", {})
    refs = {"face": ["mika_avatar.png"],
            "outfit": ["character_mika_game.png"]}

    caps = select_shots("all")
    check(len(caps) == len(SHOTS) and len(caps) >= 20,
          f"full plan has {len(caps)} shots (>= 20)")
    check({s["kind"] for s in caps} == {"face", "upper", "cowboy", "full"},
          "plan covers face/upper/cowboy/full")
    check({s["view"] for s in caps} >= {"front", "three_quarter", "side", "back"},
          "plan covers front/three-quarter/side/back")
    check(len(select_shots("face,full")) ==
          sum(1 for s in SHOTS if s["kind"] in ("face", "full")),
          "--shots kind filter works")
    check(len({s["id"] for s in SHOTS}) == len(SHOTS), "shot ids are unique")

    shot = SHOTS[0]
    prompt = build_prompt(shot, prof, refs)
    check("FACE reference" in prompt and "OUTFIT reference" in prompt,
          "prompt names both reference roles")
    check("ahoge" in prompt, "prompt carries the ahoge requirement")
    check("NOT a character sheet" in prompt, "prompt forbids sheets")
    check("cropped at the collarbone" in prompt,
          "face shots state where the frame ends")
    full_shot = next(s for s in SHOTS if s["kind"] == "full")
    full_prompt = build_prompt(full_shot, prof, refs)
    check("soles of both boots" in full_prompt, "full shots ask for head to toe")
    check("full body" not in full_prompt.split("STRICTLY AVOID")[1],
          "full shots do not forbid full body")
    check("full body" in prompt.split("STRICTLY AVOID")[1],
          "close-up shots forbid full body / legs / feet")
    check("Pure flat white" in prompt, "white shot gets the white background")
    check("dark-blue jacket" in prompt, "prompt carries the canonical outfit")
    check("EXTRA" not in prompt, "no empty reference section")
    indoor = next(s for s in SHOTS if s["bg"] == "indoor")
    check("Favonius Cathedral" in build_prompt(indoor, prof, refs),
          "scene shots ask for the scene background")

    cap = build_caption(shot, prof)
    tokens = [t.strip() for t in cap.split(",")]
    check(tokens[:2] == ["genshin impact", "mika (genshin impact)"],
          f"caption starts with the keep_tokens pair: {tokens[:2]}")
    check("1boy" in tokens and "1girl" not in tokens, "caption says 1boy only")
    check("ahoge" in tokens and "blonde hair" in tokens,
          "caption carries the identity block")
    check(tokens[-1] == "solo", "caption ends with solo")
    check("portrait" in tokens and "looking at viewer" in tokens,
          "caption carries the shot/view tags")

    # The judge's reading of the image wins over the planned shot.
    v = {"shot": "cowboy", "view": "back", "background": "scene"}
    cap2 = [t.strip() for t in build_caption(shot, prof, v).split(",")]
    check("cowboy shot" in cap2 and "from behind" in cap2,
          "judge's shot/view override the plan in the caption")
    check("white background" not in cap2,
          "judge's scene background replaces the planned white one")
    v_feet = {"shot": "cowboy", "feet_visible": True}
    check("full body" in [t.strip() for t in
                          build_caption(shot, prof, v_feet).split(",")],
          "feet in frame -> captioned full body, not cowboy")
    v_nofeet = {"shot": "full", "feet_visible": False}
    check("full body" not in [t.strip() for t in
                              build_caption(shot, prof, v_nofeet).split(",")],
          "no feet in frame -> never captioned full body")

    keep, why = decide("x", {"character": "match", "people": 1,
                             "anatomy": "ok", "outfit": "correct",
                             "ahoge": True, "artifacts": [], "keep": True}, prof)
    check(keep and not why, "clean verdict is kept")
    keep, why = decide("x", {"character": "wrong", "people": 1}, prof)
    check(not keep and "wrong_character" in why, "wrong character rejected")
    keep, why = decide("x", {"character": "match", "people": 2}, prof)
    check(not keep and "extra_characters" in why, "two characters rejected")
    keep, why = decide("x", {"character": "match", "people": 1,
                             "ahoge": False}, prof)
    check(not keep and "ahoge_missing" in why, "missing ahoge rejected")
    keep, why = decide("x", {"character": "match", "people": 1,
                             "artifacts": ["watermark"]}, prof)
    check(not keep and any("watermark" in r for r in why),
          "watermark rejected")
    check(decide("x", {}, prof) == (True, []), "missing verdict does not reject")

    eye_prof = {"traits": [{"id": "eyes", "strict": False}]}
    check(decide("x", {"character": "match", "people": 1,
                       "traits": {"eyes": "wrong"}}, eye_prof)[1]
          == ["trait:eyes=wrong"], "wrong eye colour rejects")
    check(decide("x", {"character": "match", "people": 1,
                       "traits": {"eyes": "partial"}}, eye_prof)[0],
          "missing iris rim (partial, non-strict) is kept")
    check(decide("x", {"character": "match", "people": 1,
                       "traits": {"eyes": "unclear"}}, eye_prof)[0],
          "unjudgeable eye colour is kept")
    only_full = {"traits": [{"id": "eyes", "kinds": ["face", "upper"]}]}
    check(decide("x", {"character": "match", "people": 1,
                       "traits": {"eyes": "wrong"}}, only_full, "full")[0],
          "trait outside its framing scope does not reject")
    warn_only = {"traits": [{"id": "beauty_mark", "warn_only": True}]}
    check(decide("x", {"character": "match", "people": 1,
                       "traits": {"beauty_mark": "wrong"}}, warn_only)[0],
          "warn-only trait never rejects")
    weak_prof = resolve_profile(load_profiles(), "lohen", {})
    check(bool(weak_prof.get("eye_line")), "lohen profile carries an eye line")
    wide = build_prompt(full_shot, weak_prof, refs)
    check("EYES AT THIS DISTANCE" in wide, "wide shots restate the eye colour")
    check("EYES AT THIS DISTANCE" not in build_prompt(shot, weak_prof, refs),
          "close-ups do not need the wide-shot eye line")

    check(shot_bucket({"aspect": "2:3"}) == (832, 1216), "2:3 shot -> 832x1216")
    check(shot_bucket({"aspect": "1:1"}) == (1024, 1024), "1:1 shot -> 1024x1024")
    check(sanitize_component("genshin impact") == "genshin_impact",
          "game name is folder-safe")
    check(display_name("mika (genshin impact)") == "Mika",
          "prompt uses the plain display name")

    qa_py = find_qa_python()
    if os.path.exists(QA_SCRIPT):
        proc = subprocess.run([qa_py, QA_SCRIPT, "--selftest"],
                              capture_output=True, text=True, encoding="utf-8")
        check(proc.returncode == 0, "dataset_qa.py selftest passes "
              f"({os.path.basename(qa_py)})")
    else:
        check(False, "tools/dataset_qa.py is missing")

    import tempfile
    from PIL import Image

    tmp = tempfile.mkdtemp(prefix="builder_selftest_refs_")
    cut = Image.new("RGBA", (600, 800), (0, 0, 0, 0))
    cut.paste(Image.new("RGB", (300, 500), (40, 90, 160)), (150, 150))
    src = os.path.join(tmp, "cutout.png")
    cut.save(src, format="PNG")
    norm = normalize_refs([src], os.path.join(tmp, "refs"))
    with Image.open(norm[0]) as im:
        check(im.mode == "RGB" and im.getpixel((2, 2)) == (255, 255, 255),
              "transparent reference is flattened onto white")
    check(os.path.basename(norm[0]) == "cutout.png",
          "normalized reference keeps a stable name")

    print("selftest: %s" % ("PASS" if ok else "FAIL"))
    return 0 if ok else 1


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        description="Build a verified, kohya-ready LoRA dataset for one "
                    "character: one full-resolution image per call, plan-based "
                    "captions, automatic QA.")
    ap.add_argument("--profile", default="mika",
                    help="Character profile name (built-ins + "
                         f"{DEFAULT_PROFILES_PATH})")
    ap.add_argument("--face", nargs="+", default=None,
                    help="Face/identity reference image(s)")
    ap.add_argument("--outfit", nargs="*", default=None,
                    help="Outfit/full-body reference image(s), e.g. official "
                         "art or the in-game render")
    ap.add_argument("--include-refs", action="store_true", default=True,
                    help="Also put the reference images into the dataset "
                         "(default: on; --no-include-refs to disable)")
    ap.add_argument("--no-include-refs", dest="include_refs",
                    action="store_false")
    ap.add_argument("--shots", default="all",
                    help="Which shot kinds to generate: all, or a comma list "
                         "of face,upper,cowboy,full")
    ap.add_argument("--out", default="",
                    help="Dataset ROOT — the folder you hand to the training "
                         "bat. Images land in <out>/<repeat>_<name>/ because "
                         "sd-scripts reads the repeat from that folder name. "
                         "Default: data/train_data/<group>/<character>")
    ap.add_argument("--name", default="",
                    help="Dataset folder name override, e.g. lora_mika_v4")
    ap.add_argument("--repeat", type=int, default=0,
                    help="kohya repeat prefix for the folder name "
                         "(default: profile 'repeat')")
    ap.add_argument("--desc", action="append", default=None,
                    help="Extra high-priority requirement line(s) for every "
                         "prompt (repeatable, or use a literal \\n)")
    ap.add_argument("--trigger", default="", help="Override the trigger word")
    ap.add_argument("--seed", type=int, default=None,
                    help="Seed for shot order (default: fixed plan order)")
    ap.add_argument("--max-calls", type=int, default=32,
                    help="Hard cap on image-generation calls for this run "
                         "(default: 32). The run stops cleanly at the cap.")
    ap.add_argument("--retries", type=int, default=1,
                    help="Retry attempts per shot on API errors (default: 1)")
    ap.add_argument("--size", default="2K",
                    help="Gemini image size for generation (default: 2K)")
    ap.add_argument("--min-side", type=int, default=640,
                    help="Reject images whose short side is below this")
    ap.add_argument("--blur-threshold", type=float, default=100.0,
                    help="Laplacian-variance floor (default: 100)")
    ap.add_argument("--no-judge", dest="judge", action="store_false",
                    default=True,
                    help="Skip the vision-model verification pass")
    ap.add_argument("--judge-model", default="",
                    help="Text model for the judge (default from "
                         "config_states/gemini_models.txt)")
    ap.add_argument("--judge-batch", type=int, default=4,
                    help="Images per judge call (default: 4)")
    ap.add_argument("--lenient", action="store_true",
                    help="Keep images the judge flags for ahoge/outfit/style "
                         "only (hard failures still drop)")
    ap.add_argument("--qa-python", default="",
                    help="Python with numpy for tools/dataset_qa.py "
                         "(default: root .venv)")
    ap.add_argument("--resume", action="store_true",
                    help="Reuse already generated raw/<shot>.png files")
    ap.add_argument("--reshoot", default="",
                    help="Comma list of shot ids to regenerate (e.g. "
                         "'01_face_front,05_face_serious'); every other "
                         "existing shot is reused, so only these cost calls")
    ap.add_argument("--audit", action="store_true",
                    help="Judge the shots already in the run folder and print "
                         "the verdict table (including profile traits); no "
                         "generation, no dataset write")
    ap.add_argument("--output-dir", default="",
                    help="Raw run folder (default: outputs/lora_dataset_builder/"
                         "<date>/<time>)")
    ap.add_argument("--image-model", default="",
                    help="Gemini image model (default from "
                         "config_states/gemini_models.txt)")
    ap.add_argument("--api-key", default="",
                    help="Gemini API key (or GEMINI_API_KEY / config file)")
    ap.add_argument("--dry-run", action="store_true",
                    help="Print the plan, prompts and captions; no API calls")
    ap.add_argument("--selftest", action="store_true", help="Offline self test")
    return ap


def resolve_overrides(args) -> dict:
    overrides = {}
    if args.trigger:
        overrides["trigger"] = args.trigger.strip()
    if args.repeat:
        overrides["repeat"] = int(args.repeat)
    return overrides


def normalize_desc(desc) -> str:
    if not desc:
        return ""
    joined = "\n".join(d if isinstance(d, str) else " ".join(d) for d in desc)
    return "\n".join(ln.strip() for ln in joined.replace("\\n", "\n").splitlines()
                     if ln.strip())


def main() -> int:
    args = build_parser().parse_args()
    if args.selftest:
        return selftest()

    if not args.face:
        build_parser().error("--face is required (identity reference image)")

    models_cfg = load_model_config()
    args.image_model = args.image_model or models_cfg["image_model"]
    args.judge_model = args.judge_model or models_cfg["text_model"]

    prof = resolve_profile(load_profiles(), args.profile, resolve_overrides(args))
    desc = normalize_desc(args.desc)
    shots = select_shots(args.shots)
    if args.seed is not None:
        import random
        random.Random(args.seed).shuffle(shots)

    face_refs = ref_images_from_args(args.face or [])
    outfit_refs = ref_images_from_args(args.outfit or [])
    original_refs = {"face": list(face_refs), "outfit": list(outfit_refs)}

    name = (args.name or f"lora_{prof['trigger']}").strip()
    inner = f"{int(prof.get('repeat', 3))}_{sanitize_component(name)}"
    group = prof.get("dataset_group") or sanitize_component(prof["game"])
    char_slug = sanitize_component(prof["character"].split("(")[0])
    dataset_root = args.out or os.path.join(DEFAULT_DATASET_ROOT, group,
                                            char_slug)
    dataset_dir = os.path.join(dataset_root, inner)
    stamp = datetime.datetime.now()
    run_dir = args.output_dir or os.path.join(
        DEFAULT_RAW_DIR, stamp.strftime("%Y-%m-%d"), stamp.strftime("%H%M%S"))
    shots_dir = os.path.join(run_dir, "shots")
    budget = {"max": max(1, int(args.max_calls)), "used": 0}

    # White-backed PNG copies: transparent cut-outs otherwise render a black
    # backdrop and would train as black-background images.
    if not args.dry_run:
        refs_dir = os.path.join(run_dir, "refs")
        face_refs = normalize_refs(face_refs, refs_dir)
        outfit_refs = normalize_refs(outfit_refs, refs_dir)
    refs = {"face": face_refs, "outfit": outfit_refs}

    # ------------------------------ audit --------------------------------
    # Re-judge what is already on disk (text-model calls only) so a profile fix
    # - a wrong eye colour, a missing accessory - can be applied to exactly the
    # shots that need re-shooting instead of the whole plan.
    if args.audit:
        if not os.path.isdir(shots_dir):
            print(json.dumps({"ok": False, "error":
                              f"no shots to audit at {shots_dir}"}))
            return 1
        present = [(s["id"], os.path.join(shots_dir, s["id"] + ".png"))
                   for s in shots
                   if os.path.exists(os.path.join(shots_dir, s["id"] + ".png"))]
        if not present:
            print(json.dumps({"ok": False, "error": "no shot images found"}))
            return 1
        api_key = _resolve_api_key(args)
        if not api_key:
            print(json.dumps({"ok": False, "error": "no Gemini API key"}))
            return 1
        client = _make_client(api_key)
        verdicts = run_judge(client, args.judge_model, present, prof,
                             face_refs[0] if face_refs else "",
                             batch_size=max(1, args.judge_batch))
        kinds = {s["id"]: s["kind"] for s in shots}
        verdicts = confirm_soft_rejections(
            client, args.judge_model, verdicts, present, prof,
            face_refs[0] if face_refs else "",
            lambda cid: kinds.get(cid),
            batch_size=max(1, args.judge_batch))
        rows, failing = [], []
        for sid, _path in present:
            shot = next(s for s in shots if s["id"] == sid)
            verdict = verdicts.get(sid, {})
            keep, reasons = decide(sid, verdict, prof, shot["kind"])
            traits = verdict.get("traits") or {}
            rows.append({"id": sid, "kind": shot["kind"], "keep": keep,
                         "reasons": reasons, "traits": traits,
                         "character": verdict.get("character"),
                         "outfit": verdict.get("outfit")})
            if not keep:
                failing.append(sid)
            trait_txt = " ".join(f"{k}={v}" for k, v in traits.items()) or "-"
            print(f"  {sid:<22} {'ok   ' if keep else 'FAIL '} "
                  f"char={str(verdict.get('character', '')):<5} "
                  f"outfit={str(verdict.get('outfit', '')):<7} {trait_txt}"
                  f"{'  <- ' + ','.join(reasons) if reasons else ''}",
                  flush=True)
        ok = not failing
        print(json.dumps({"ok": ok, "run_dir": run_dir, "audited": len(rows),
                          "failing": failing,
                          "reshoot": ",".join(failing),
                          "rows": rows}, ensure_ascii=False))
        return 0

    # ------------------------------ dry run ------------------------------
    if args.dry_run:
        print(f"\n[builder] PLAN for {prof['character']} "
              f"(dry run - no API calls)", flush=True)
        print(f"  profile   : {args.profile}  trigger={prof['trigger']}", flush=True)
        print(f"  refs      : face={[os.path.basename(p) for p in face_refs]} "
              f"outfit={[os.path.basename(p) for p in outfit_refs]}", flush=True)
        print(f"  dataset   : {dataset_dir}", flush=True)
        print(f"  train with: train_lora_sdxl_pro.bat \"{dataset_root}\" "
              f"{prof['trigger']}", flush=True)
        print(f"  raw       : {run_dir}", flush=True)
        print(f"  calls     : {len(shots)} shots, hard cap {budget['max']}, "
              f"judge {'on' if args.judge else 'off'}", flush=True)
        for s in shots:
            print(f"\n  --- {s['id']}  ({s['kind']}/{s['view']}, "
                  f"{s['aspect']}, bg {s['bg']}, bucket "
                  f"{shot_bucket(s)[0]}x{shot_bucket(s)[1]})", flush=True)
            print("      caption: " + build_caption(s, prof), flush=True)
            if args.desc:
                print("      prompt : "
                      + build_prompt(s, prof, refs, desc)[:400].replace("\n", " ")
                      + " ...", flush=True)
        print("\n[builder] first prompt in full:\n" + build_prompt(
            shots[0], prof, refs, desc), flush=True)
        print(json.dumps({"ok": True, "dry_run": True,
                          "profile": args.profile, "shots": len(shots),
                          "max_calls": budget["max"],
                          "dataset_dir": dataset_dir,
                          "dataset_root": dataset_root,
                          "run_dir": run_dir},
                         ensure_ascii=False), flush=True)
        return 0

    # ---------------------------- generation -----------------------------
    api_key = _resolve_api_key(args)
    if not api_key:
        print(json.dumps({"ok": False, "error":
                          "No Gemini API key (GEMINI_API_KEY, --api-key or "
                          "config_states/gemini_nano_banana.txt)"}))
        return 1
    client = _make_client(api_key)
    os.makedirs(shots_dir, exist_ok=True)

    generated, generation_errors = [], []
    reshoot = {s.strip() for s in (args.reshoot or "").split(",") if s.strip()}
    unknown = sorted(reshoot - {s["id"] for s in shots})
    if unknown:
        print(f"[builder] warning: --reshoot ids not in this plan: {unknown}",
              flush=True)
    reuse_existing = args.resume or bool(reshoot)
    for shot in shots:
        raw_path = os.path.join(shots_dir, shot["id"] + ".png")
        if shot["id"] in reshoot and os.path.exists(raw_path):
            os.remove(raw_path)
            print(f"[builder] {shot['id']}: re-shooting (deleted old file)",
                  flush=True)
        if reuse_existing and os.path.exists(raw_path):
            print(f"[builder] {shot['id']}: reusing {raw_path}", flush=True)
            generated.append((shot["id"], raw_path))
            continue
        if budget["used"] >= budget["max"]:
            print(f"[builder] call budget {budget['max']} reached - stopping "
                  f"generation ({len(generated)} image(s) kept)", flush=True)
            break
        prompt = build_prompt(shot, prof, refs, desc)
        last_err = None
        for attempt in range(args.retries + 1):
            if budget["used"] >= budget["max"]:
                break
            budget["used"] += 1
            print(f"[builder] {shot['id']} ({shot['kind']}/{shot['view']}) "
                  f"attempt {attempt + 1} - call {budget['used']}/"
                  f"{budget['max']}", flush=True)
            try:
                generate_image(client, args.image_model, prompt,
                               face_refs + outfit_refs, raw_path,
                               shot["aspect"], args.size)
                last_err = None
                break
            except Exception as exc:  # noqa: BLE001 - retry, then skip
                last_err = exc
                print(f"[builder] {shot['id']} failed: {str(exc)[:160]}",
                      flush=True)
        if last_err is not None:
            generation_errors.append({"id": shot["id"], "error": str(last_err)})
            continue
        generated.append((shot["id"], raw_path))

    if not generated:
        print(json.dumps({"ok": False, "error": "no image was generated",
                          "errors": generation_errors}, ensure_ascii=False))
        return 1

    print(f"[builder] generated {len(generated)} image(s) with "
          f"{budget['used']} call(s)", flush=True)

    # ------------------------------ judge --------------------------------
    verdicts = {}
    if args.judge:
        judge_items = [(sid, path) for sid, path in generated]
        if args.include_refs:
            for i, ref in enumerate(face_refs + outfit_refs, 1):
                judge_items.append((f"ref_{i:02d}", ref))
        verdicts = run_judge(client, args.judge_model, judge_items, prof,
                             face_refs[0] if face_refs else "",
                             batch_size=max(1, args.judge_batch))
        kind_by_id = {s["id"]: s["kind"] for s in shots}
        kind_by_id.update({f"ref_{i:02d}": "ref"
                           for i in range(1, len(face_refs) + len(outfit_refs) + 1)})
        verdicts = confirm_soft_rejections(
            client, args.judge_model, verdicts, judge_items, prof,
            face_refs[0] if face_refs else "",
            lambda cid: kind_by_id.get(cid),
            batch_size=max(1, args.judge_batch))
        print(f"[builder] judge returned {len(verdicts)} verdict(s)", flush=True)

    # ------------------------------- QA ----------------------------------
    # Every candidate - generated shots AND the reference images that go into
    # the dataset - is staged under one folder, so a single QA pass buckets
    # them all to SDXL sizes and checks them with the same rules.
    candidates_dir = os.path.join(run_dir, "candidates")
    if os.path.isdir(candidates_dir):
        shutil.rmtree(candidates_dir)
    os.makedirs(candidates_dir, exist_ok=True)
    for sid, path in generated:
        shutil.copy2(path, os.path.join(candidates_dir, sid + ".png"))
    ref_pairs = []
    if args.include_refs:
        for i, ref in enumerate(face_refs + outfit_refs, 1):
            rid = f"ref_{i:02d}"
            ref_pairs.append((rid, ref))
            shutil.copy2(ref, os.path.join(candidates_dir, rid + ".png"))

    qa_report = os.path.join(run_dir, "qa.json")
    qa_ok_dir = os.path.join(run_dir, "qa_ok")
    if os.path.isdir(qa_ok_dir):
        shutil.rmtree(qa_ok_dir)
    try:
        qa = run_qa(candidates_dir, qa_ok_dir, qa_report,
                    find_qa_python(args.qa_python), args.min_side,
                    args.blur_threshold, bucket=True)
    except Exception as exc:  # noqa: BLE001 - degrade to judge-only
        print(f"[builder] WARNING local QA failed ({exc}); continuing with the "
              f"judge verdict only", flush=True)
        qa = {"items": [], "kept": [], "rejected": []}
    qa_items = {it["file"]: it for it in qa.get("items") or []}

    # ---------------------------- decisions ------------------------------
    rows = []
    for sid, path in generated:
        shot = next(s for s in shots if s["id"] == sid)
        verdict = verdicts.get(sid, {})
        keep, reasons = decide(sid, verdict, prof, shot["kind"])
        qitem = qa_items.get(sid + ".png")
        if qitem:
            if not qitem.get("keep", True):
                keep = False
                reasons += list(qitem.get("reasons") or [])
        if args.lenient:
            reasons = [r for r in reasons if r not in ("ahoge_missing",
                                                       "3d_render_not_for_training")]
            reasons = [r for r in reasons if not r.startswith("wrong_outfit")]
            keep = not reasons
        rows.append({
            "id": sid, "raw": path,
            "raw_rel": f"candidates/{sid}.png",
            "kind": shot["kind"], "view": shot["view"], "bg": shot["bg"],
            "keep": keep, "reasons": reasons, "verdict": verdict,
            "qa": qitem, "caption": build_caption(shot, prof, verdict),
        })

    for rid, ref in ref_pairs:
        verdict = verdicts.get(rid, {})
        keep, reasons = decide(rid, verdict, prof, kind="ref")
        qitem = qa_items.get(rid + ".png")
        if qitem and not qitem.get("keep", True):
            keep = False
            reasons += list(qitem.get("reasons") or [])
        pseudo = {"kind": "full", "view": "front", "bg": "white", "expr": []}
        rows.append({
            "id": rid, "raw": ref,
            "raw_rel": f"candidates/{rid}.png",
            "kind": "ref", "view": "", "bg": "",
            "keep": keep, "reasons": reasons, "verdict": verdict,
            "qa": qitem, "caption": build_caption(pseudo, prof, verdict),
        })

    # -------------------------- dataset assembly -------------------------
    kept = [r for r in rows if r["keep"]]
    if not kept:
        write_review(run_dir, rows, budget, prof)
        print(json.dumps({"ok": False,
                          "error": "every image was rejected - nothing to "
                                   "train on",
                          "run_dir": run_dir,
                          "rejected": [{"id": r["id"], "reasons": r["reasons"]}
                                       for r in rows]}, ensure_ascii=False))
        return 1

    if os.path.isdir(dataset_dir):
        leftovers = [f for f in os.listdir(dataset_dir)
                     if f.lower().endswith(IMAGE_EXTS + (".txt",))]
        if leftovers:
            backup = os.path.join(run_dir, "dataset_before_overwrite",
                                  stamp.strftime("%H%M%S"))
            os.makedirs(backup, exist_ok=True)
            for f in leftovers:
                shutil.move(os.path.join(dataset_dir, f),
                            os.path.join(backup, f))
            print(f"[builder] existing dataset files moved to {backup}",
                  flush=True)
    os.makedirs(dataset_dir, exist_ok=True)

    from PIL import Image

    width = max(3, len(str(len(kept))))
    written = []
    for n, row in enumerate(kept, 1):
        stem = f"img_{n:0{width}d}"
        src = os.path.join(qa_ok_dir, row["id"] + ".png")
        if not os.path.exists(src):
            src = row["raw"]
        dst = os.path.join(dataset_dir, stem + ".png")
        with Image.open(src) as img:
            img.load()
            img.convert("RGB").save(dst, format="PNG")
        with open(os.path.join(dataset_dir, stem + ".txt"), "w",
                  encoding="utf-8") as f:
            f.write(row["caption"] + "\n")
        written.append({"file": stem + ".png", "from": row["id"],
                        "reasons_ok": True})

    review_path = write_review(run_dir, rows, budget, prof)
    detail = {
        "created": stamp.isoformat(timespec="seconds"),
        "profile": args.profile,
        "character": prof["character"],
        "trigger": prof["trigger"],
        "image_model": args.image_model,
        "judge_model": args.judge_model if args.judge else "",
        "refs": {"face": face_refs, "outfit": outfit_refs},
        "refs_source": original_refs,
        "budget": budget,
        "dataset_dir": dataset_dir,
        "dataset_root": dataset_root,
        "run_dir": run_dir,
        "images": [{k: r[k] for k in ("id", "keep", "reasons", "kind",
                                      "view", "bg")} for r in rows],
        "verdicts": {r["id"]: r["verdict"] for r in rows if r["verdict"]},
        "captions": {r["id"]: r["caption"] for r in rows},
        "dataset_files": written,
        "generation_errors": generation_errors,
    }
    with open(os.path.join(run_dir, "run.json"), "w", encoding="utf-8") as f:
        json.dump(detail, f, ensure_ascii=False, indent=2)

    rejected = [r for r in rows if not r["keep"]]
    print(f"[builder] kept {len(kept)}/{len(rows)} image(s) -> {dataset_dir}",
          flush=True)
    if rejected:
        print("[builder] rejected: " + ", ".join(
            f"{r['id']}({','.join(r['reasons'])})" for r in rejected),
            flush=True)
    print(f"[builder] review sheet: {review_path}", flush=True)
    print(json.dumps({
        "ok": True,
        "dataset_dir": dataset_dir,
        "dataset_root": dataset_root,
        "train_cmd": f'train_lora_sdxl_pro.bat "{os.path.relpath(dataset_root, _ROOT_DIR)}" {prof["trigger"]}',
        "run_dir": run_dir,
        "review": review_path,
        "kept": len(kept),
        "rejected": len(rejected),
        "calls_used": budget["used"],
        "calls_max": budget["max"],
        "rejected_ids": [r["id"] for r in rejected],
        "generation_errors": generation_errors,
    }, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
