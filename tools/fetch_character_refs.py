#!/usr/bin/env python3
"""
fetch_character_refs.py
Download canonical character reference images (official art / in-game render /
figure photos) into the collection folder so the LoRA dataset pipeline has
real ground truth instead of only AI-generated pictures.

Two ways to fetch:

  1. MediaWiki (Fandom) page scan - the default:
       .venv\\Scripts\\python.exe tools\\fetch_character_refs.py ^
           --page Mika ^
           --out data\\collection\\genshin\\_refs\\mika

     It lists every image used on that wiki page, keeps the ones whose file
     name matches --match (default: the page title), drops images narrower
     than --min-width, then downloads the rest.

  2. Explicit URLs (any host) - reproducible, no wiki needed:
       .venv\\Scripts\\python.exe tools\\fetch_character_refs.py ^
           --out data\\collection\\genshin\\_refs\\mika ^
           --url https://example.com/mika_full.png

Notes:
  * A browser-like User-Agent is sent; wikis reject the default urllib agent.
  * Existing files with identical content are skipped (sha256 compare), so
    re-running is cheap and idempotent.
  * Nothing is resized or cropped here - the dataset pipeline validates and
    normalises references itself.
"""

import argparse
import hashlib
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

DEFAULT_API = "https://genshin-impact.fandom.com/api.php"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/122.0 Safari/537.36")
# Wiki image CDNs (static.wikia.nocookie.net) answer 403 to requests without a
# Referer from the wiki itself, so the origin of --api is used by default.
REFERER = ""


def _get(url: str, timeout: int = 60) -> bytes:
    headers = {
        "User-Agent": UA,
        "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    }
    if REFERER:
        headers["Referer"] = REFERER
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def _get_json(url: str):
    return json.loads(_get(url).decode("utf-8"))


def _api(params: dict, api: str):
    params = dict(params, format="json")
    url = api + "?" + urllib.parse.urlencode(params)
    return _get_json(url)


def page_images(page: str, api: str):
    """All File: titles used on `page` (main namespace + images from templates)."""
    data = _api({"action": "query", "prop": "images", "titles": page,
                 "imlimit": "500"}, api)
    pages = (data.get("query") or {}).get("pages") or {}
    for _pid, entry in pages.items():
        return [img["title"] for img in entry.get("images", [])]
    return []


def image_info(titles, api: str):
    """{title: {url, width, height, mime, size}} for up to 50 titles."""
    out = {}
    for i in range(0, len(titles), 50):
        chunk = titles[i:i + 50]
        data = _api({"action": "query", "prop": "imageinfo",
                     "iiprop": "url|size|mime", "titles": "|".join(chunk)}, api)
        pages = (data.get("query") or {}).get("pages") or {}
        for _pid, entry in pages.items():
            info = (entry.get("imageinfo") or [{}])[0]
            if info.get("url"):
                out[entry["title"]] = {
                    "url": info["url"],
                    "width": info.get("width") or 0,
                    "height": info.get("height") or 0,
                    "mime": info.get("mime") or "",
                    "size": info.get("size") or 0,
                }
        time.sleep(0.2)  # be polite to the wiki
    return out


def safe_name(title: str) -> str:
    name = title.split(":", 1)[-1]
    stem, ext = os.path.splitext(name)
    stem = re.sub(r"[^A-Za-z0-9._-]+", "_", stem).strip("_").lower()
    return stem + (ext.lower() if ext else ".png")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def existing_hashes(out_dir: str) -> set:
    hashes = set()
    if not os.path.isdir(out_dir):
        return hashes
    for fn in os.listdir(out_dir):
        path = os.path.join(out_dir, fn)
        if os.path.isfile(path):
            with open(path, "rb") as f:
                hashes.add(sha256_bytes(f.read()))
    return hashes


def download(url: str, out_path: str) -> int:
    data = _get(url)
    with open(out_path, "wb") as f:
        f.write(data)
    return len(data)


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Download character reference images for a LoRA dataset")
    ap.add_argument("--page", default="", help="Wiki page title, e.g. Mika")
    ap.add_argument("--api", default=DEFAULT_API, help="MediaWiki api.php URL")
    ap.add_argument("--match", default="",
                    help="Only file names matching this regex (default: page title)")
    ap.add_argument("--out", required=True, help="Output folder for the references")
    ap.add_argument("--url", action="append", default=[],
                    help="Explicit image URL (repeatable); skips the wiki scan")
    ap.add_argument("--min-width", type=int, default=600,
                    help="Skip wiki images narrower than this (default: 600)")
    ap.add_argument("--limit", type=int, default=0,
                    help="Keep at most N images (0 = all)")
    ap.add_argument("--referer", default="",
                    help="Referer header (default: origin of --api; wikis "
                         "answer 403 without one)")
    ap.add_argument("--dry-run", action="store_true", help="List, download nothing")
    args = ap.parse_args()

    if not args.url and not args.page:
        ap.error("pass --page and/or --url")

    global REFERER
    if args.referer:
        REFERER = args.referer
    else:
        parts = urllib.parse.urlparse(args.api)
        REFERER = f"{parts.scheme}://{parts.netloc}/"

    os.makedirs(args.out, exist_ok=True)
    seen = existing_hashes(args.out)
    saved, skipped, failed = [], [], []

    def _save(title: str, url: str, meta: dict):
        fname = safe_name(title)
        dest = os.path.join(args.out, fname)
        if os.path.exists(dest):
            skipped.append((fname, "exists"))
            return
        if args.dry_run:
            saved.append({"file": fname, "url": url, **meta})
            print(f"  [DRY] {fname}  {meta.get('width', '?')}x{meta.get('height', '?')}")
            return
        try:
            data = _get(url)
        except Exception as exc:  # noqa: BLE001 - report and continue
            failed.append((fname, str(exc)))
            print(f"  [FAIL] {fname}: {exc}")
            return
        digest = sha256_bytes(data)
        if digest in seen:
            skipped.append((fname, "duplicate content"))
            print(f"  [SKIP] {fname}: identical content already downloaded")
            return
        with open(dest, "wb") as f:
            f.write(data)
        seen.add(digest)
        saved.append({"file": fname, "url": url, "bytes": len(data), **meta})
        print(f"  [OK] {fname}  {len(data) // 1024} KB")

    if args.url:
        for url in args.url:
            title = "File:" + os.path.basename(urllib.parse.urlparse(url).path)
            _save(title, url, {})
    else:
        pattern = re.compile(args.match or re.escape(args.page), re.IGNORECASE)
        titles = [t for t in page_images(args.page, args.api)
                  if pattern.search(t) and t.lower().endswith(
                      (".png", ".jpg", ".jpeg", ".webp"))]
        print(f"page '{args.page}': {len(titles)} matching image(s)")
        infos = image_info(titles, args.api)
        picked = []
        for title in titles:
            meta = infos.get(title)
            if not meta:
                continue
            if meta["width"] and meta["width"] < args.min_width:
                print(f"  [SMALL] {title} ({meta['width']}px) skipped")
                continue
            picked.append((title, meta))
        if args.limit:
            picked = picked[:args.limit]
        for title, meta in picked:
            _save(title, meta["url"], {"width": meta["width"],
                                       "height": meta["height"]})

    print(json.dumps({
        "ok": not failed,
        "out": os.path.abspath(args.out),
        "saved": saved,
        "skipped": skipped,
        "failed": failed,
    }, ensure_ascii=False))
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
