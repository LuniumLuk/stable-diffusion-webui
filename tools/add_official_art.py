#!/usr/bin/env python3
"""
add_official_art.py
Add the style-anchor tag "official art" to every caption in the Rana
dataset so the training set's shared style binds to that token.  At
inference, "official art" goes into the NEGATIVE prompt to suppress
style bleed.

Inserted right after the quality prefix:
    masterpiece, best quality, official art, bangdream, mygo, kaname rana, 1girl, ...

Idempotent: captions that already contain "official art" are skipped.
Pre-change captions are backed up to
data/_bangdream_cleanup/caption_backup_pre_official_art/

USAGE:
    .venv\\Scripts\\python.exe tools\\add_official_art.py --dry-run
    .venv\\Scripts\\python.exe tools\\add_official_art.py
"""

import argparse
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATASET_DIRS = sorted(
    d for d in (ROOT / "data" / "bangdream").glob("*_rana")
    if d.is_dir() and any(p.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"} for p in d.iterdir())
)
CLEANUP = ROOT / "data" / "_bangdream_cleanup"
BACKUP = CLEANUP / "caption_backup_pre_official_art"
ANCHOR = "official art"


def main() -> int:
    ap = argparse.ArgumentParser(description="Add 'official art' style anchor to Rana captions")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not DATASET_DIRS:
        print(f"ERROR: no *_rana dataset folder found under {ROOT / 'data' / 'bangdream'}")
        return 1

    for d in DATASET_DIRS:
        txts = sorted(d.glob("*.txt"))
        changed = 0
        skipped = 0
        print(f"Dataset: {d}  ({len(txts)} captions)")
        for txt in txts:
            cap = txt.read_text(encoding="utf-8")
            tags = [t.strip() for t in cap.replace("\n", " ").split(",") if t.strip()]
            if ANCHOR in tags:
                skipped += 1
                continue
            # insert after "masterpiece, best quality" if present, else at front
            if "best quality" in tags:
                tags.insert(tags.index("best quality") + 1, ANCHOR)
            else:
                tags.insert(0, ANCHOR)
            new_cap = ", ".join(tags)
            print(f"  [ADD] {txt.name}")
            if not args.dry_run:
                BACKUP.mkdir(parents=True, exist_ok=True)
                shutil.copy2(str(txt), str(BACKUP / txt.name))
                txt.write_text(new_cap, encoding="utf-8")
            changed += 1
        print(f"  -> {changed} updated, {skipped} already had the tag\n")

    print("Done." + ("  (dry-run, no changes)" if args.dry_run else f"  (backups in {BACKUP})"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
