#!/usr/bin/env python3
"""
clean_dataset_rana.py
Clean the BangDream Rana character dataset (data/bangdream/1_rana):

  1. Quarantine images whose captions contain comic-panel border tags
     (black/white/outside border) - these teach the LoRA to draw panels.
  2. Unify hair wording: "silver hair" -> "grey hair".
  3. Remove wrong eye tag "grey eyes".
  4. Inject consistent identity tags after "1girl":
       short hair, grey hair, heterochromia, blue eyes, yellow eyes
     (eye tags skipped when the caption says the eyes are closed).
  5. Prepend quality tags: "masterpiece, best quality".
  6. Dedupe tags, preserve order.

Everything is reversible: original captions are copied to
data/_bangdream_cleanup/caption_backup/ and removed images (with captions)
are MOVED to data/_bangdream_cleanup/removed_border_images/ (never deleted).

USAGE:
    .venv\\Scripts\\python.exe tools\\clean_dataset_rana.py --dry-run
    .venv\\Scripts\\python.exe tools\\clean_dataset_rana.py
"""

import argparse
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATASET = ROOT / "data" / "bangdream" / "1_rana"
CLEANUP = ROOT / "data" / "_bangdream_cleanup"
QUARANTINE = CLEANUP / "removed_border_images"
BACKUP = CLEANUP / "caption_backup"

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"}
IDENTITY_HAIR = ["short hair", "grey hair"]
IDENTITY_EYES = ["heterochromia", "blue eyes", "yellow eyes"]
QUALITY_PREFIX = ["masterpiece", "best quality"]
EYES_HIDDEN_TAGS = ("closed eyes", "^ ^")  # skip eye tags when any present


def split_tags(caption: str) -> list[str]:
    return [t.strip() for t in caption.replace("\n", " ").split(",") if t.strip()]


def normalize_caption(caption: str) -> str:
    toks = split_tags(caption)
    # 1. unify hair wording
    toks = ["grey hair" if t == "silver hair" else t for t in toks]
    # 2. drop wrong eye tag
    toks = [t for t in toks if t != "grey eyes"]
    # 3. dedupe preserving order
    seen, out = set(), []
    for t in toks:
        if t not in seen:
            out.append(t)
            seen.add(t)
    toks = out
    # 4. identity injection after "1girl"
    add_hair = [t for t in IDENTITY_HAIR if t not in toks]
    eyes_hidden = any(t in toks for t in EYES_HIDDEN_TAGS)
    add_eyes = [] if eyes_hidden else [t for t in IDENTITY_EYES if t not in toks]
    insert = add_hair + add_eyes
    if "1girl" in toks:
        i = toks.index("1girl") + 1
        toks[i:i] = insert
    else:
        toks = insert + toks
    # 5. quality prefix
    prefix = [t for t in QUALITY_PREFIX if t not in toks]
    return ", ".join(prefix + toks)


def has_border_tag(caption: str) -> bool:
    return any(t.endswith("border") for t in split_tags(caption))


def main() -> int:
    ap = argparse.ArgumentParser(description="Clean the BangDream Rana dataset")
    ap.add_argument("--dry-run", action="store_true", help="preview only, change nothing")
    args = ap.parse_args()

    if not DATASET.is_dir():
        print(f"ERROR: dataset folder not found: {DATASET}")
        return 1

    images = sorted(p for p in DATASET.iterdir() if p.suffix.lower() in IMAGE_EXTS)
    print(f"Dataset : {DATASET}")
    print(f"Images  : {len(images)}")
    print(f"Mode    : {'DRY-RUN (no changes)' if args.dry_run else 'APPLY'}\n")

    removed = []
    modified = 0
    unchanged = 0
    problems = []

    for img in images:
        txt = img.with_suffix(".txt")
        if not txt.is_file():
            problems.append(f"{img.name}: no caption file")
            continue
        caption = txt.read_text(encoding="utf-8")

        if has_border_tag(caption):
            removed.append((img, txt, caption))
            continue

        new_caption = normalize_caption(caption)
        if new_caption != caption:
            modified += 1
            print(f"[MODIFY ] {txt.name}")
            print(f"    old: {caption}")
            print(f"    new: {new_caption}")
            if not args.dry_run:
                BACKUP.mkdir(parents=True, exist_ok=True)
                shutil.copy2(str(txt), str(BACKUP / txt.name))
                txt.write_text(new_caption, encoding="utf-8")
        else:
            unchanged += 1

    print(f"\n[REMOVE ] border images: {len(removed)}")
    for img, txt, cap in removed:
        print(f"    {img.name}   ({[t for t in split_tags(cap) if t.endswith('border')]})")
        if not args.dry_run:
            QUARANTINE.mkdir(parents=True, exist_ok=True)
            for src in (img, txt):
                shutil.move(str(src), str(QUARANTINE / src.name))
            # move latent cache alongside if present
            for npz in img.parent.glob(f"{img.stem}*_sdxl.npz"):
                shutil.move(str(npz), str(QUARANTINE / npz.name))

    if not args.dry_run and modified:
        print(f"(originals backed up to {BACKUP})")

    print(f"\nSummary: {modified} captions modified, {unchanged} unchanged, "
          f"{len(removed)} border images quarantined, {len(problems)} problems")
    for p in problems:
        print(f"  PROBLEM: {p}")
    if args.dry_run:
        print("Dry-run: nothing was changed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
