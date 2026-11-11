#!/usr/bin/env python3
"""
dataset_qa.py
Automatic quality gate for LoRA training images - the step that replaces the
manual "open every picture and delete the broken ones" pass.

It never needs a model or the network. Every image gets a set of cheap,
deterministic measurements and is either KEPT or REJECTED with a reason:

  broken     file does not decode
  small      shorter side below --min-side (SDXL wants >= ~768 after bucketing)
  blank      flat / near-empty canvas (std too low, almost no ink)
  blur       soft focus or smeared detail (Laplacian variance too low)
  gutter     a leftover white grid line / blank band on an edge, i.e. a bad
             cut out of a contact sheet
  duplicate  perceptually identical to an already-kept image (dHash)

Images that survive are optionally rewritten to SDXL bucket sizes with a
cover-crop, so training never upscales a 580px tile into a 1024px bucket
(the biggest silent quality loss in the old avatar-sheet pipeline).

USAGE
  .venv\\Scripts\\python.exe tools\\dataset_qa.py --in DIR --json qa.json
  .venv\\Scripts\\python.exe tools\\dataset_qa.py --in DIR --json qa.json ^
      --out DIR_bucketed --bucket
  .venv\\Scripts\\python.exe tools\\dataset_qa.py --calibrate --in DIR
  .venv\\Scripts\\python.exe tools\\dataset_qa.py --selftest

The JSON result printed on stdout is
  {"ok": true, "items": [{file, w, h, blur, std, mono, gutter, hash,
                          keep, reasons, bucket}], "kept": [...], "rejected": [...]}
"""

import argparse
import json
import os
import sys

import numpy as np
from PIL import Image

IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".bmp")

# SDXL-friendly buckets (area ~1.0-1.05 MP, 64px aligned).
SDXL_BUCKETS = [
    (1024, 1024),
    (1152, 896), (896, 1152),
    (1216, 832), (832, 1216),
    (1344, 768), (768, 1344),
    (1536, 640), (640, 1536),
]

DEFAULTS = {
    "min_side": 640,
    "blur": 40.0,
    "blank_std": 6.0,
    "blank_ink": 0.02,
    "gutter_white": 0.985,
    "gutter_std": 6.0,
    "dedupe": 8,
    "dup_mad": 12.0,
}


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------
def _gray_array(img: Image.Image, max_side: int = 512) -> np.ndarray:
    g = img.convert("L")
    if max(g.size) > max_side:
        scale = max_side / float(max(g.size))
        g = g.resize((max(1, int(g.width * scale)),
                      max(1, int(g.height * scale))), Image.BILINEAR)
    return np.asarray(g, dtype=np.float32)


def blur_score(img: Image.Image) -> float:
    """Variance of the 4-neighbour Laplacian - high = crisp linework."""
    g = _gray_array(img)
    if g.shape[0] < 3 or g.shape[1] < 3:
        return 0.0
    lap = (-4.0 * g[1:-1, 1:-1] + g[:-2, 1:-1] + g[2:, 1:-1]
           + g[1:-1, :-2] + g[1:-1, 2:])
    return float(lap.var())


def ink_fraction(img: Image.Image) -> float:
    """Share of pixels that are neither near-white nor near-black."""
    g = _gray_array(img)
    return float(np.mean((g > 24) & (g < 236)))


def colorfulness(img: Image.Image) -> float:
    """Mean channel spread; ~0 means a monochrome image."""
    small = img.convert("RGB")
    if max(small.size) > 256:
        small.thumbnail((256, 256), Image.BILINEAR)
    a = np.asarray(small, dtype=np.float32)
    return float(np.mean(np.abs(a[..., 0] - a[..., 1]))
                 + np.mean(np.abs(a[..., 1] - a[..., 2])))


def gutter_score(img: Image.Image, white: float, flat_std: float,
                 step: float = 25.0) -> float:
    """1.0 when an edge carries a leftover white gutter / grid line.

    A white *background* is fine and common here, so "the edge is white" says
    nothing. A bad grid cut shows up as a solid band that ends in a hard
    straight step: the outermost pixels are flat white and only a couple of
    pixels in the artwork starts. That step, not the white itself, is what is
    detected - measured per edge on a 1024px thumbnail.
    """
    g = _gray_array(img, max_side=1024)
    h, w = g.shape
    band = max(2, min(h, w) // 200)          # outermost band
    probe = max(band * 2, min(h, w) // 100)  # where artwork would start
    edges = []
    for prof in (g.mean(axis=0), g.mean(axis=1)):   # column means, row means
        edges.append((prof[:band], prof[probe:probe + band]))
        edges.append((prof[-band:], prof[-probe - band:-probe]))
    for outer, inner in edges:
        outer_flat = float(np.std(outer)) < flat_std
        outer_white = float(np.mean(outer)) >= 235.0
        jump = abs(float(np.mean(inner)) - float(np.mean(outer)))
        if outer_flat and outer_white and jump >= step:
            return 1.0
        if outer_flat and outer_white and jump >= step * 0.6:
            return 0.5
    return 0.0


def dhash(img: Image.Image, size: int = 8) -> int:
    """64-bit difference hash; Hamming distance ~ visual similarity."""
    return _hash_of(_thumb(img.convert("L").resize((size + 1, size),
                                                   Image.BILINEAR)))


def _hash_of(arr: np.ndarray) -> int:
    bits = (arr[:, 1:] > arr[:, :-1]).flatten()
    out = 0
    for bit in bits:
        out = (out << 1) | int(bit)
    return out


def _thumb(img: Image.Image) -> np.ndarray:
    if max(img.size) > 512:
        img = img.copy()
        img.thumbnail((512, 512), Image.BILINEAR)
    return np.asarray(img, dtype=np.float32)


def content_signature(img: Image.Image, tol: float = 8.0,
                      size: int = 32):
    """(hash, float32 size x size array) of the drawn area only.

    Cropping to the non-background bounding box first is what makes this work
    on white-background art: a whole-image hash of a portrait on #FFFFFF is
    dominated by the white area, and two completely different poses then hash
    to nearly the same value. Returns None when the image has no content.
    """
    g = _thumb(img.convert("L"))
    border = np.concatenate([g[0, :], g[-1, :], g[:, 0], g[:, -1]])
    bg = float(np.median(border))
    mask = np.abs(g - bg) > tol
    if not mask.any():
        return None
    rows = np.where(mask.any(axis=1))[0]
    cols = np.where(mask.any(axis=0))[0]
    crop = g[rows[0]:rows[-1] + 1, cols[0]:cols[-1] + 1]
    if crop.shape[0] < 8 or crop.shape[1] < 8:
        return None
    small = np.asarray(
        Image.fromarray(crop.astype(np.uint8)).resize((size, size),
                                                      Image.BILINEAR),
        dtype=np.float32)
    return _hash_of(small), small


def hamming(a: int, b: int) -> int:
    return bin(a ^ b).count("1")


def closest_bucket(w: int, h: int):
    """Nearest SDXL bucket in log space, preferring the same aspect ratio."""
    target = np.log(w / float(h))
    best, best_cost = SDXL_BUCKETS[0], None
    for bw, bh in SDXL_BUCKETS:
        cost = abs(np.log(bw / float(bh)) - target)
        if best_cost is None or cost < best_cost:
            best, best_cost = (bw, bh), cost
    return best


def flatten_rgb(img: Image.Image,
                background=(255, 255, 255)) -> Image.Image:
    """RGB copy with any alpha composited onto `background`.

    Reference art is often a transparent PNG/WebP cut-out; a plain
    convert("RGB") turns transparent pixels black, which then trains as a
    black background and breaks the captions."""
    if img.mode in ("RGBA", "LA", "P", "PA"):
        rgba = img.convert("RGBA")
        canvas = Image.new("RGB", rgba.size, background)
        canvas.paste(rgba, mask=rgba.split()[-1])
        return canvas
    return img.convert("RGB")


def to_bucket(img: Image.Image, bucket) -> Image.Image:
    """Cover-resize + center crop onto the bucket (no distortion, no bars)."""
    bw, bh = bucket
    scale = max(bw / float(img.width), bh / float(img.height))
    nw, nh = max(bw, int(round(img.width * scale))), \
        max(bh, int(round(img.height * scale)))
    resized = flatten_rgb(img).resize((nw, nh), Image.LANCZOS)
    left = (nw - bw) // 2
    top = (nh - bh) // 2
    return resized.crop((left, top, left + bw, top + bh))


# ---------------------------------------------------------------------------
# Analysis
# ---------------------------------------------------------------------------
def analyze(path: str, cfg: dict) -> dict:
    item = {"file": os.path.basename(path), "path": path, "reasons": [],
            "keep": True}
    try:
        with Image.open(path) as img:
            img.load()
            item["w"], item["h"] = img.size
            item["blur"] = round(blur_score(img), 1)
            g = _gray_array(img)
            item["std"] = round(float(g.std()), 1)
            item["mono"] = round(colorfulness(img), 1)
            item["ink"] = round(ink_fraction(img), 3)
            item["gutter"] = gutter_score(img, cfg["gutter_white"],
                                          cfg["gutter_std"])
            sig = content_signature(img)
            if sig is None:
                item["hash"] = dhash(img)
                item["_sig"] = None
            else:
                item["hash"], item["_sig"] = sig
    except Exception as exc:  # noqa: BLE001 - unreadable file = reject
        item["keep"] = False
        item["reasons"].append("broken:%s" % str(exc)[:60])
        return item

    if min(item["w"], item["h"]) < cfg["min_side"]:
        item["reasons"].append("small:%dx%d" % (item["w"], item["h"]))
    if item["std"] < cfg["blank_std"] or item["ink"] < cfg["blank_ink"]:
        item["reasons"].append("blank")
    if item["blur"] < cfg["blur"]:
        item["reasons"].append("blur:%s" % item["blur"])
    if item["gutter"] >= 1.0:
        item["reasons"].append("gutter")
    item["keep"] = not item["reasons"]
    return item


def run(paths, cfg: dict):
    items = [analyze(p, cfg) for p in paths]
    # Sharpest first, so a duplicate pair keeps the better copy.
    order = sorted(range(len(items)),
                   key=lambda i: (not items[i]["keep"],
                                  -float(items[i].get("blur") or 0.0)))
    kept, rejected = [], []
    kept_sigs = []
    taken = set()
    for i in order:
        item = items[i]
        if not item["keep"]:
            rejected.append(item)
            taken.add(i)
            continue
        sig = item.get("_sig")
        dup = None
        for k_hash, k_item, k_sig in kept_sigs:
            if hamming(item["hash"], k_hash) > cfg["dedupe"]:
                continue
            if sig is None or k_sig is None:
                dup = k_item
                break
            # Both hashes and the actual pixels must agree: a white-background
            # portrait and a different pose can share a hash, never the pixels.
            mad = float(np.abs(sig - k_sig).mean())
            if mad <= cfg["dup_mad"]:
                dup = k_item
                break
        if dup is not None:
            item["keep"] = False
            item["reasons"].append("duplicate:%s" % dup["file"])
            rejected.append(item)
        else:
            kept_sigs.append((item["hash"], item, sig))
            kept.append(item)
        taken.add(i)
    for i, item in enumerate(items):
        if i not in taken:
            kept.append(item)
    kept.sort(key=lambda it: it["file"])
    rejected.sort(key=lambda it: it["file"])
    for item in items:
        item.pop("_sig", None)
    return items, kept, rejected


# ---------------------------------------------------------------------------
# Self test
# ---------------------------------------------------------------------------
def selftest() -> int:
    import tempfile
    from PIL import ImageDraw, ImageFilter

    ok = True
    cfg = dict(DEFAULTS)
    work = tempfile.mkdtemp(prefix="dataset_qa_selftest_")

    def make(name, draw):
        img = Image.new("RGB", (768, 1024), (250, 250, 250))
        draw(ImageDraw.Draw(img))
        path = os.path.join(work, name)
        img.save(path)
        return path

    def sharp(d):
        for k in range(0, 700, 14):
            d.arc((60, 80 + k // 4, 660, 900), 0, 180, fill=(20, 30, 120), width=4)
        d.ellipse((240, 300, 520, 620), fill=(255, 220, 160), outline=(0, 0, 0), width=5)
        d.ellipse((330, 420, 370, 470), fill=(40, 80, 200))
        d.ellipse((420, 420, 460, 470), fill=(40, 80, 200))

    def full_bleed(d):
        d.rectangle((0, 0, 767, 1023), fill=(90, 110, 150))
        sharp(d)

    good = make("good.png", sharp)                      # white margins, no cut
    dup = os.path.join(work, "dup.png")
    Image.open(good).save(dup)
    blurred = os.path.join(work, "blurred.png")
    Image.open(good).filter(ImageFilter.GaussianBlur(6)).save(blurred)

    def gutted(d):
        full_bleed(d)
        d.rectangle((0, 0, 767, 6), fill=(255, 255, 255))

    gutter = make("gutter.png", gutted)
    bleed = make("bleed.png", full_bleed)

    def other_pose(d):
        # Same white canvas, different drawing: must never be a "duplicate".
        d.ellipse((120, 180, 640, 860), fill=(255, 225, 170), outline=(10, 10, 10),
                  width=6)
        d.rectangle((300, 620, 470, 760), fill=(30, 60, 160))
        d.line((150, 900, 620, 940), fill=(120, 30, 30), width=9)

    pose2 = make("pose2.png", other_pose)
    blank = os.path.join(work, "blank.png")
    Image.new("RGB", (768, 1024), (255, 255, 255)).save(blank)
    broken = os.path.join(work, "broken.png")
    with open(broken, "wb") as f:
        f.write(b"not an image")

    items, kept, rejected = run([good, dup, blurred, gutter, bleed, pose2,
                                 blank, broken], cfg)
    by_file = {it["file"]: it for it in items}

    def check(cond, msg):
        nonlocal ok
        print(("  ok   " if cond else "  FAIL ") + msg)
        ok = ok and bool(cond)

    check(by_file["good.png"]["keep"], "white-margin image kept (blur=%s)"
          % by_file["good.png"].get("blur"))
    check(by_file["bleed.png"]["keep"], "full-bleed image kept")
    check(by_file["pose2.png"]["keep"],
          "different pose on the same white canvas is NOT a duplicate "
          f"(hamming={hamming(by_file['good.png']['hash'], by_file['pose2.png']['hash'])})")
    check(not by_file["dup.png"]["keep"]
          and any(r.startswith("duplicate") for r in by_file["dup.png"]["reasons"]),
          "exact duplicate rejected")
    check(not by_file["blurred.png"]["keep"]
          and "blur" in " ".join(by_file["blurred.png"]["reasons"]),
          "blurred image rejected (blur=%s)" % by_file["blurred.png"].get("blur"))
    check(not by_file["gutter.png"]["keep"]
          and "gutter" in by_file["gutter.png"]["reasons"],
          "leftover white gutter rejected")
    check(not by_file["blank.png"]["keep"], "blank canvas rejected")
    check(not by_file["broken.png"]["keep"], "undecodable file rejected")
    check(len(kept) == 3, "three images survive (%d)" % len(kept))

    src = Image.new("RGB", (1536, 2048), (10, 10, 10))
    out = to_bucket(src, (832, 1216))
    check(out.size == (832, 1216), "bucket cover-crop produced %s" % (out.size,))

    transparent = Image.new("RGBA", (900, 1200), (0, 0, 0, 0))
    transparent.paste(Image.new("RGB", (400, 700), (200, 60, 60)), (250, 250))
    white = to_bucket(transparent, (1024, 1024))
    corner = white.getpixel((4, 4))
    check(min(corner) > 245, "transparent reference becomes white, not black "
          f"(corner={corner})")
    check(closest_bucket(1080, 1620) == (832, 1216),
          "2:3 source maps to the 832x1216 bucket")
    check(closest_bucket(1536, 2048) == (896, 1152),
          "3:4 source maps to the 896x1152 bucket")
    check(closest_bucket(2048, 2048) == (1024, 1024),
          "1:1 source maps to the 1024x1024 bucket")

    print("selftest: %s" % ("PASS" if ok else "FAIL"))
    return 0 if ok else 1


def calibrate(paths, cfg):
    items = [analyze(p, cfg) for p in paths]
    print(f"{'file':44s} {'w x h':>11s} {'blur':>8s} {'std':>6s} "
          f"{'ink':>6s} {'gut':>4s} keep")
    for it in items:
        print(f"{it['file'][:44]:44s} {str(it.get('w','?')) + 'x' + str(it.get('h','?')):>11s} "
              f"{str(it.get('blur','?')):>8s} {str(it.get('std','?')):>6s} "
              f"{str(it.get('ink','?')):>6s} {str(it.get('gutter','?')):>4s} "
              f"{it['keep']} {' '.join(it['reasons'])}")
    vals = [it["blur"] for it in items if isinstance(it.get("blur"), float)]
    if vals:
        print(f"\nblur: min={min(vals):.1f} p10={np.percentile(vals, 10):.1f} "
              f"median={np.median(vals):.1f} max={max(vals):.1f}")
    return 0


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def collect(root: str):
    if os.path.isfile(root):
        return [root]
    out = []
    for dirpath, _dirs, files in os.walk(root):
        for fn in sorted(files):
            if fn.lower().endswith(IMAGE_EXTS):
                out.append(os.path.join(dirpath, fn))
    return out


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Quality gate + bucket normalisation for LoRA datasets")
    ap.add_argument("--in", dest="src", default="", help="Image folder (or one file)")
    ap.add_argument("--json", default="", help="Write the full report to this path")
    ap.add_argument("--out", default="", help="Copy accepted images here")
    ap.add_argument("--bucket", action="store_true",
                    help="Resize accepted images onto the nearest SDXL bucket")
    ap.add_argument("--min-side", type=int, default=DEFAULTS["min_side"])
    ap.add_argument("--blur-threshold", type=float, default=DEFAULTS["blur"])
    ap.add_argument("--dedupe", type=int, default=DEFAULTS["dedupe"],
                    help="dHash Hamming distance treated as a duplicate "
                         "candidate (0-64); the pixel check below still has "
                         "to agree")
    ap.add_argument("--dup-mad", type=float, default=DEFAULTS["dup_mad"],
                    help="Max mean absolute pixel difference (0-255) between "
                         "the content crops of two duplicates (default 12)")
    ap.add_argument("--calibrate", action="store_true",
                    help="Print metrics for every image and exit")
    ap.add_argument("--selftest", action="store_true", help="Run the offline test")
    args = ap.parse_args()

    if args.selftest:
        return selftest()
    if not args.src:
        ap.error("--in is required")

    cfg = dict(DEFAULTS)
    cfg["min_side"] = args.min_side
    cfg["blur"] = args.blur_threshold
    cfg["dedupe"] = args.dedupe
    cfg["dup_mad"] = args.dup_mad

    paths = collect(args.src)
    if not paths:
        print(json.dumps({"ok": False, "error": f"no images under {args.src}"}))
        return 1
    if args.calibrate:
        return calibrate(paths, cfg)

    items, kept, rejected = run(paths, cfg)

    if args.out:
        os.makedirs(args.out, exist_ok=True)
        for item in kept:
            with Image.open(item["path"]) as img:
                img.load()
                if args.bucket:
                    bucket = closest_bucket(img.width, img.height)
                    out_img = to_bucket(img, bucket)
                    item["bucket"] = list(bucket)
                else:
                    out_img = flatten_rgb(img)
                    item["bucket"] = [img.width, img.height]
                dest = os.path.join(args.out, item["file"])
                out_img.save(dest, format="PNG")

    result = {
        "ok": True,
        "in": os.path.abspath(args.src),
        "thresholds": {k: cfg[k] for k in ("min_side", "blur", "dedupe",
                                           "dup_mad")},
        "kept": [it["file"] for it in kept],
        "rejected": [{"file": it["file"], "reasons": it["reasons"]}
                     for it in rejected],
        "items": items,
    }
    if args.json:
        os.makedirs(os.path.dirname(os.path.abspath(args.json)) or ".", exist_ok=True)
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
    print(json.dumps({k: result[k] for k in
                      ("ok", "in", "kept", "rejected", "thresholds")},
                     ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
