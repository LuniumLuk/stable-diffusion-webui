#!/usr/bin/env python3
"""
clean_dataset_genshin.py
Normalise the caption sets of every character folder under
data/train_data/genshin/ (the dataset used for the Genshin LoRA).

For each character folder:

  1. Pin the trigger tokens to the front so keep_tokens=2 keeps them:
       genshin impact, <character> (genshin impact)
  2. Drop auto-tagger identity noise (kagamine len, virtual youtuber,
     1girl on a male character, emoticon tags, wrong eye colours).
  3. Derive the identity block per character and force it into EVERY caption:
       gender tag, focus tag, hair colour, hair length, signature extras
       (ahoge, ...), signature accessory (earrings), eye colour.
     Identity tags are derived from the captions themselves (modal value per
     category, runner-up must lose by 1.5x), so new characters are handled
     without editing this file. Derived values are printed before writing.
  4. Eye colour is skipped on captions that say the eyes are closed.
  5. Optional per-character OVERRIDES below replace the derived identity, add
     wiki-canonical traits the tagger cannot see (canon), or canonicalise an
     outfit / background that the tagger wrote several ways.

Everything is reversible: original captions are copied to
data/_genshin_cleanup/<folder>/caption_backup/ (first backup wins, so the
pristine auto-tagger output is never overwritten by a later pass).

USAGE:
    .venv\\Scripts\\python.exe tools\\clean_dataset_genshin.py --report
    .venv\\Scripts\\python.exe tools\\clean_dataset_genshin.py --dry-run
    .venv\\Scripts\\python.exe tools\\clean_dataset_genshin.py
    .venv\\Scripts\\python.exe tools\\clean_dataset_genshin.py --folder 3_lora_lohen_v2
"""

import argparse
import re
import shutil
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATASET_ROOT = ROOT / "data" / "train_data" / "genshin"
CLEANUP_ROOT = ROOT / "data" / "_genshin_cleanup"

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"}
GAME_TAG = "genshin impact"
TRIGGER_RE = re.compile(r"^.+\(genshin impact\)$")

# Tags the auto-tagger emits that are simply wrong for a Genshin character set.
WRONG_TAGS = {
    "kagamine len",
    "virtual youtuber",
    "komaeda nagito",
    "+ +",
    ":i",
    ":t",
    ":d",
    ":o",
}

GENDER_TAGS = ["1boy", "1girl"]
FOCUS_TAGS = ["male focus", "female focus"]
HAIR_COLORS = [
    "blonde hair", "yellow hair", "grey hair", "silver hair", "white hair",
    "black hair", "brown hair", "blue hair", "red hair", "pink hair",
    "purple hair", "green hair", "orange hair", "aqua hair",
    "multicolored hair", "gradient hair", "two-tone hair", "streaked hair",
    "colored inner hair", "coloured inner hair",
]
EYE_COLORS = [
    "blue eyes", "grey eyes", "purple eyes", "red eyes", "yellow eyes",
    "green eyes", "aqua eyes", "amber eyes", "orange eyes", "pink eyes",
    "brown eyes", "teal eyes", "cyan eyes",
]
HAIR_LENGTHS = ["short hair", "medium hair", "long hair", "very long hair",
                "absurdly long hair"]
EXTRA_IDENTITY = ["ahoge", "hair flaps"]
ACCESSORIES = ["earrings"]
EYES_HIDDEN_TAGS = ("closed eyes", "^ ^")

# Per-character overrides. Anything omitted is derived from the captions.
#   identity   - replaces the derived identity + accessory block
#   eyes       - replaces the derived eye colour
#   canon      - wiki-canonical traits the auto-tagger cannot see; forced
#                into every caption so the LoRA learns to present them
#   outfit     - canonical garment wording; also strips the variant tags
#   background - canonical background wording; also strips the variant tags
OVERRIDES = {
    # Mika: blue eyes; curled golden hair in irregular tufts; golden-brown tips.
    "3_lora_mika_v2": {
        "identity": ["1boy", "male focus", "blonde hair", "short hair", "ahoge"],
        "canon": ["curly hair", "colored tips"],
        "eyes": ["blue eyes"],
        "outfit": ["white capelet", "hood down", "blue trim"],
        "background": ["white background", "simple background"],
    },
    # Lohen: short, fluffy mint-grey hair; dull red eyes with a greenish outer
    # ring ("multicolored eyes"). Varied outdoor backgrounds and a mostly
    # untagged uniform, so neither outfit nor background is canonicalised.
    "3_lora_lohen_v2": {
        "identity": ["1boy", "male focus", "short hair", "grey hair"],
        "canon": ["fluffy hair"],
        "eyes": ["red eyes", "multicolored eyes"],
        "outfit": None,
        "background": None,
    },
}

OUTFIT_VARIANTS = {
    "shirt", "hood", "hoodie", "white hoodie", "blue hoodie", "grey hoodie",
    "hooded jacket", "sailor collar", "armor", "blue scarf", "cape", "cloak",
    "coat", "jacket", "uniform", "school uniform", "serafuku", "beret", "hat",
    "drawstring", "white capelet", "hood down", "blue trim",
}
BACKGROUND_VARIANTS = {
    "white background", "simple background", "gradient background",
    "polka dot background", "halftone background", "sparkle background",
}
# Background words that describe the *scene* and must survive canonicalisation.
SCENE_TAGS = {
    "sky", "blue sky", "cloudy sky", "cloud", "clouds", "outdoors", "indoors",
    "building", "castle", "city", "skyscraper", "mountain", "mountainous horizon",
    "beach", "tree", "flower", "snow", "night", "day", "sunset", "water",
}


def split_tags(caption: str) -> list[str]:
    return [t.strip() for t in caption.replace("\n", " ").split(",") if t.strip()]


def read_captions(folder: Path) -> dict[str, list[str]]:
    caps = {}
    for txt in sorted(folder.glob("*.txt")):
        caps[txt.name] = split_tags(txt.read_text(encoding="utf-8"))
    return caps


def modal(counter: Counter, candidates: list[str]):
    """Return (tag, count) of the most frequent candidate, or (None, 0)."""
    ranked = sorted(((counter[t], t) for t in candidates if counter[t]), reverse=True)
    if not ranked:
        return None, 0
    top_count, top_tag = ranked[0]
    second = ranked[1][0] if len(ranked) > 1 else 0
    return top_tag, top_count if top_count >= 1.5 * second else (None, top_count)


def derive_identity(caps: dict[str, list[str]]) -> dict:
    total = len(caps)
    counter: Counter = Counter()
    for tags in caps.values():
        counter.update(set(tags))

    trigger = None
    triggers = Counter(t for tags in caps.values() for t in tags if TRIGGER_RE.match(t))
    if triggers:
        trigger = triggers.most_common(1)[0][0]

    gender, gcount = modal(counter, GENDER_TAGS)
    if not gender or gcount < 0.6 * total:
        gender = None
    focus = None
    if gender == "1boy":
        focus = "male focus" if counter["male focus"] >= 0.5 * total else None
    elif gender == "1girl":
        focus = "female focus" if counter["female focus"] >= 0.5 * total else None

    hair, hcount = modal(counter, HAIR_COLORS)
    if hcount < 0.30 * total:
        hair = None
    eyes, ecount = modal(counter, EYE_COLORS)
    if ecount < 0.30 * total:
        eyes = None
    length, lcount = modal(counter, HAIR_LENGTHS)
    if lcount is None or lcount < 0.30 * total:
        length = None

    extras = [t for t in EXTRA_IDENTITY if counter[t] >= 0.5 * total]
    accessories = [t for t in ACCESSORIES if counter[t] >= 0.75 * total]

    identity = [t for t in [gender, focus, hair, length] if t] + extras
    return {
        "trigger": trigger,
        "identity": identity,
        "eyes": [eyes] if eyes else [],
        "accessories": accessories,
        "counts": counter,
        "total": total,
    }


def normalize_caption(caption: str, cfg: dict) -> str:
    trig = cfg["trigger_tokens"]
    toks = split_tags(caption)

    drop = set(WRONG_TAGS)
    drop |= {t for t in HAIR_COLORS if t not in cfg["identity"]}
    drop |= {t for t in EYE_COLORS if t not in cfg["eyes"]}
    if "1boy" in cfg["identity"]:
        drop |= {"1girl", "female focus"}
    if "1girl" in cfg["identity"]:
        drop |= {"1boy", "male focus"}
    if cfg["outfit"]:
        drop |= OUTFIT_VARIANTS
    if cfg["background"]:
        drop |= BACKGROUND_VARIANTS - SCENE_TAGS

    toks = [t for t in toks if t not in drop and t not in trig]
    seen, deduped = set(), []
    for t in toks:
        if t not in seen:
            deduped.append(t)
            seen.add(t)
    toks = deduped

    eyes_hidden = any(t in toks for t in EYES_HIDDEN_TAGS)
    head = list(trig) + list(cfg["identity"]) + list(cfg["canon"])
    if not eyes_hidden:
        head += list(cfg["eyes"])
    head += list(cfg["accessories"])
    if cfg["outfit"]:
        head += list(cfg["outfit"])

    head_set = set(head)
    toks = [t for t in toks if t not in head_set]
    return ", ".join(head + toks + list(cfg["background"] or []))


def build_config(folder_name: str, caps: dict[str, list[str]]) -> dict:
    derived = derive_identity(caps)
    override = OVERRIDES.get(folder_name, {})
    identity = override.get("identity") or derived["identity"]
    canon = override.get("canon") or []
    eyes = override.get("eyes") if "eyes" in override else derived["eyes"]
    outfit = override.get("outfit")
    background = override.get("background")
    trigger = derived["trigger"]
    trig_tokens = [GAME_TAG] + ([trigger] if trigger and trigger != GAME_TAG else [])
    return {
        "trigger": trigger,
        "trigger_tokens": trig_tokens,
        "identity": list(identity or []),
        "canon": list(canon),
        "eyes": list(eyes or []),
        "accessories": [t for t in derived["accessories"] if t not in (identity or [])],
        "outfit": list(outfit) if outfit else None,
        "background": list(background) if background else None,
        "derived": derived,
    }


def describe(name: str, cfg: dict, n_caps: int) -> None:
    print(f"  trigger   : {cfg['trigger']}  ({n_caps} captions)")
    d = cfg["derived"]
    print(f"  derived   : {d['identity']} | eyes={d['eyes']} | acc={d['accessories']}")
    print(f"  enforced  : {cfg['identity']} | eyes={cfg['eyes']} | acc={cfg['accessories']}")
    if cfg["canon"]:
        print(f"  canon     : {cfg['canon']}")
    if cfg["outfit"]:
        print(f"  outfit    : {cfg['outfit']}")
    if cfg["background"]:
        print(f"  background: {cfg['background']}")


def folders(root: Path, only=None) -> list[Path]:
    out = []
    for p in sorted(root.iterdir() if root.is_dir() else []):
        if not p.is_dir() or "cleanup" in p.name:
            continue
        if only and p.name != only:
            continue
        if not any(f.suffix.lower() in IMAGE_EXTS for f in p.iterdir()):
            continue
        out.append(p)
    return out


def report(folder: Path, cfg: dict, caps: dict[str, list[str]]) -> None:
    total = len(caps)
    counter: Counter = Counter()
    for tags in caps.values():
        counter.update(set(tags))
    print("  identity coverage:")
    for tag in cfg["identity"] + cfg["canon"] + cfg["eyes"] + cfg["accessories"]:
        print(f"    {tag:20s} {counter[tag]:3d}/{total}")
    outfit = OUTFIT_VARIANTS
    bg = BACKGROUND_VARIANTS
    no_outfit = sum(1 for tags in caps.values() if not (set(tags) & outfit))
    no_bg = sum(1 for tags in caps.values() if not (set(tags) & bg))
    print(f"    no outfit tag       {no_outfit:3d}/{total}")
    print(f"    no background tag   {no_bg:3d}/{total}")


def main() -> int:
    ap = argparse.ArgumentParser(description="Clean every genshin character caption set")
    ap.add_argument("--dry-run", action="store_true", help="preview only, change nothing")
    ap.add_argument("--report", action="store_true", help="print coverage and exit")
    ap.add_argument("--folder", default=None, help="only this dataset folder")
    args = ap.parse_args()

    if not DATASET_ROOT.is_dir():
        print(f"ERROR: dataset root not found: {DATASET_ROOT}")
        return 1

    targets = folders(DATASET_ROOT, args.folder)
    if not targets:
        print(f"ERROR: no character folders with images under {DATASET_ROOT}")
        return 1

    print(f"Root    : {DATASET_ROOT}")
    print(f"Folders : {[p.name for p in targets]}")
    print(f"Mode    : {'REPORT' if args.report else 'DRY-RUN' if args.dry_run else 'APPLY'}\n")

    grand_modified = 0
    for folder in targets:
        caps = read_captions(folder)
        if not caps:
            print(f"== {folder.name}: no captions found, skipped")
            continue
        cfg = build_config(folder.name, caps)
        if not cfg["trigger"]:
            print(f"== {folder.name}: no '<name> (genshin impact)' trigger found, skipped")
            continue
        print(f"== {folder.name}")
        describe(folder.name, cfg, len(caps))
        if args.report:
            report(folder, cfg, caps)
            print()
            continue

        backup = CLEANUP_ROOT / folder.name / "caption_backup"
        modified = 0
        unchanged = 0
        for txt in sorted(folder.glob("*.txt")):
            old = txt.read_text(encoding="utf-8")
            new = normalize_caption(old, cfg)
            if new == old:
                unchanged += 1
                continue
            modified += 1
            if args.dry_run and modified <= 3:
                print(f"  [MODIFY ] {txt.name}")
                print(f"      old: {old}")
                print(f"      new: {new}")
            elif not args.dry_run:
                backup.mkdir(parents=True, exist_ok=True)
                saved = backup / txt.name
                if not saved.exists():
                    shutil.copy2(str(txt), str(saved))
                txt.write_text(new, encoding="utf-8")
        if args.dry_run and modified > 3:
            print(f"  ... {modified - 3} more captions would change")
        grand_modified += modified
        print(f"  -> {modified} modified, {unchanged} unchanged")
        if not args.dry_run and modified:
            print(f"     originals: {backup}")
        print()

    if args.dry_run:
        print(f"Dry-run: {grand_modified} captions would change, nothing written.")
    elif args.report:
        print("Report only: nothing written.")
    else:
        print(f"Done: {grand_modified} captions modified.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
