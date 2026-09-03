#!/usr/bin/env python3
"""
remove_official_art.py
Remove the (now-proven-useless) "official art" style anchor from every
caption in the Rana dataset, undoing tools/add_official_art.py.

Idempotent. Pre-change captions are backed up to
data/_bangdream_cleanup/caption_backup_with_official_art/

USAGE:
    .venv\\Scripts\\python.exe tools\\remove_official_art.py --dry-run
    .venv\\Scripts\\python.exe tools\\remove_official_art.py
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
BACKUP = CLEANUP / "caption_backup_with_official_art"
ANCHOR = "official art"


def main() -> int:
    ap = argparse.ArgumentParser(description="Remove 'official art' anchor from Rana captions")
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
            if ANCHOR not in tags:
                skipped += 1
                continue
            tags = [t for t in tags if t != ANCHOR]
            new_cap = ", ".join(tags)
            print(f"  [DEL] {txt.name}")
            if not args.dry_run:
                BACKUP.mkdir(parents=True, exist_ok=True)
                shutil.copy2(str(txt), str(BACKUP / txt.name))
                txt.write_text(new_cap, encoding="utf-8")
            changed += 1
        print(f"  -> {changed} updated, {skipped} did not have the tag\n")

    print("Done." + ("  (dry-run, no changes)" if args.dry_run else f"  (backups in {BACKUP})"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
