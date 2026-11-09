"""Download the video models used by the Video tab / SD Lite video screen.

Run it by hand (it is not imported by the WebUI):

    python scripts/download_video_models.py            # all three engines
    python scripts/download_video_models.py animatediff
    python scripts/download_video_models.py cogvideox svd
    python scripts/download_video_models.py --check    # only report what is installed

Everything comes from the Hugging Face mirror (``hf-mirror.com``), resumes
interrupted files, and lands exactly where ``modules.video_manager`` looks:

    models/AnimateDiff/motion-adapter-v1-5-2/   AnimateDiff v1-5-2 motion module (fp16)
    models/AnimateDiff/lightning/               AnimateDiff-Lightning 4/8-step modules
    models/Video/bases/AnyLoRA/                 diffusers SD1.5 anime base (fp16)
    models/Video/CogVideoX-2b/                  CogVideoX-2B (diffusers)
    models/Video/Stable-Video-Diffusion/        SVD-XT (diffusers, fp16 variant)

Disk: ~4.7 GB (AnimateDiff) + ~13 GB (CogVideoX) + ~4.3 GB (SVD).

Licences: AnimateDiff MIT / AnimateDiff-Lightning Apache-2.0, AnyLoRA CreativeML
OpenRAIL-M, CogVideoX Apache-2.0, SVD Stability AI Community License.  Read them
before redistributing anything you generate.
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MIRROR = os.environ.get("HF_ENDPOINT", "https://hf-mirror.com").rstrip("/")
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

ANIMATEDIFF = [
    ("guoyww/animatediff-motion-adapter-v1-5-2", "config.json", "models/AnimateDiff/motion-adapter-v1-5-2/config.json"),
    ("guoyww/animatediff-motion-adapter-v1-5-2", "diffusion_pytorch_model.fp16.safetensors", "models/AnimateDiff/motion-adapter-v1-5-2/diffusion_pytorch_model.fp16.safetensors"),
    ("ByteDance/AnimateDiff-Lightning", "animatediff_lightning_4step_diffusers.safetensors", "models/AnimateDiff/lightning/animatediff_lightning_4step_diffusers.safetensors"),
    ("ByteDance/AnimateDiff-Lightning", "animatediff_lightning_8step_diffusers.safetensors", "models/AnimateDiff/lightning/animatediff_lightning_8step_diffusers.safetensors"),
    ("Lykon/AnyLoRA", "model_index.json", "models/Video/bases/AnyLoRA/model_index.json"),
    ("Lykon/AnyLoRA", "scheduler/scheduler_config.json", "models/Video/bases/AnyLoRA/scheduler/scheduler_config.json"),
    ("Lykon/AnyLoRA", "feature_extractor/preprocessor_config.json", "models/Video/bases/AnyLoRA/feature_extractor/preprocessor_config.json"),
    ("Lykon/AnyLoRA", "text_encoder/config.json", "models/Video/bases/AnyLoRA/text_encoder/config.json"),
    ("Lykon/AnyLoRA", "text_encoder/model.fp16.safetensors", "models/Video/bases/AnyLoRA/text_encoder/model.fp16.safetensors"),
    ("Lykon/AnyLoRA", "tokenizer/merges.txt", "models/Video/bases/AnyLoRA/tokenizer/merges.txt"),
    ("Lykon/AnyLoRA", "tokenizer/special_tokens_map.json", "models/Video/bases/AnyLoRA/tokenizer/special_tokens_map.json"),
    ("Lykon/AnyLoRA", "tokenizer/tokenizer_config.json", "models/Video/bases/AnyLoRA/tokenizer/tokenizer_config.json"),
    ("Lykon/AnyLoRA", "tokenizer/vocab.json", "models/Video/bases/AnyLoRA/tokenizer/vocab.json"),
    ("Lykon/AnyLoRA", "unet/config.json", "models/Video/bases/AnyLoRA/unet/config.json"),
    ("Lykon/AnyLoRA", "unet/diffusion_pytorch_model.fp16.safetensors", "models/Video/bases/AnyLoRA/unet/diffusion_pytorch_model.fp16.safetensors"),
    ("Lykon/AnyLoRA", "vae/config.json", "models/Video/bases/AnyLoRA/vae/config.json"),
    ("Lykon/AnyLoRA", "vae/diffusion_pytorch_model.fp16.safetensors", "models/Video/bases/AnyLoRA/vae/diffusion_pytorch_model.fp16.safetensors"),
]

COGVIDEOX = [
    ("THUDM/CogVideoX-2b", rel, f"models/Video/CogVideoX-2b/{rel}")
    for rel in (
        "model_index.json",
        "scheduler/scheduler_config.json",
        "text_encoder/config.json",
        "text_encoder/model.safetensors.index.json",
        "text_encoder/model-00001-of-00002.safetensors",
        "text_encoder/model-00002-of-00002.safetensors",
        "tokenizer/added_tokens.json",
        "tokenizer/special_tokens_map.json",
        "tokenizer/spiece.model",
        "tokenizer/tokenizer_config.json",
        "transformer/config.json",
        "transformer/diffusion_pytorch_model.safetensors",
        "vae/config.json",
        "vae/diffusion_pytorch_model.safetensors",
    )
]

SVD = [
    ("stabilityai/stable-video-diffusion-img2vid-xt", rel, f"models/Video/Stable-Video-Diffusion/{rel}")
    for rel in (
        "model_index.json",
        "scheduler/scheduler_config.json",
        "feature_extractor/preprocessor_config.json",
        "image_encoder/config.json",
        "image_encoder/model.fp16.safetensors",
        "unet/config.json",
        "unet/diffusion_pytorch_model.fp16.safetensors",
        "vae/config.json",
        "vae/diffusion_pytorch_model.fp16.safetensors",
    )
]

LTX = [
    # two transformer shards; video_manager merges them on the first load because the
    # accelerate pinned in requirements_versions.txt cannot dispatch sharded checkpoints
    ("Lightricks/LTX-Video", rel, f"models/Video/LTX-Video/{rel}")
    for rel in (
        "model_index.json",
        "scheduler/scheduler_config.json",
        "tokenizer/added_tokens.json",
        "tokenizer/special_tokens_map.json",
        "tokenizer/spiece.model",
        "tokenizer/tokenizer_config.json",
        "transformer/config.json",
        "transformer/diffusion_pytorch_model.safetensors.index.json",
        "transformer/diffusion_pytorch_model-00001-of-00002.safetensors",
        "transformer/diffusion_pytorch_model-00002-of-00002.safetensors",
        "vae/config.json",
        "vae/diffusion_pytorch_model.safetensors",
    )
]

GROUPS = {"animatediff": ANIMATEDIFF, "cogvideox": COGVIDEOX, "svd": SVD, "ltx": LTX}


def human(size: int) -> str:
    return f"{size / (1024 ** 3):.2f} GB" if size >= 1024 ** 3 else f"{size / (1024 ** 2):.1f} MB"


def fetch(repo: str, remote: str, dest: str) -> None:
    target = os.path.join(ROOT, dest)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    url = f"{MIRROR}/{repo}/resolve/main/{remote}?download=true"

    have = os.path.getsize(target) if os.path.isfile(target) else 0
    request = urllib.request.Request(url, headers={"Range": f"bytes={have}-"} if have else {})
    try:
        response = OPENER.open(request, timeout=120)
    except urllib.error.HTTPError as error:
        if error.code == 416 and have:
            print(f"  ok {dest} ({human(have)})")
            return
        raise

    with response:
        resuming = have > 0 and response.status == 206
        if have and not resuming:
            have = 0  # server ignored the range: start over
        total = int(response.headers.get("Content-Length") or 0) + have
        mode = "ab" if resuming else "wb"
        written = have
        print(f"  {'resume' if resuming else 'get  '} {dest} ({human(total)})")
        with open(target, mode) as handle:
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                handle.write(chunk)
                written += len(chunk)
                if total:
                    print(f"\r    {written * 100 / total:5.1f}%  {human(written)} / {human(total)}", end="", flush=True)
        print()

    if total and os.path.getsize(target) != total:
        raise RuntimeError(f"size mismatch for {dest}: {os.path.getsize(target)} != {total}")


def report(groups) -> int:
    missing = 0
    for name, entries in groups.items():
        print(f"{name}:")
        for _repo, _remote, dest in entries:
            path = os.path.join(ROOT, dest)
            exists = os.path.isfile(path)
            missing += 0 if exists else 1
            print(f"  {'ok     ' if exists else 'MISSING'} {dest}")
    return missing


def main() -> int:
    global MIRROR, OPENER

    parser = argparse.ArgumentParser(description="Download the WebUI video models from the HF mirror.")
    parser.add_argument("groups", nargs="*", default=[], help="animatediff / cogvideox / svd (default: all)")
    parser.add_argument("--check", action="store_true", help="only report what is installed")
    parser.add_argument("--endpoint", default=MIRROR, help="model host (default: hf-mirror.com or $HF_ENDPOINT)")
    parser.add_argument("--proxy", default=os.environ.get("HTTPS_PROXY") or "", help="HTTP(S) proxy, e.g. http://127.0.0.1:7890")
    args = parser.parse_args()

    MIRROR = args.endpoint.rstrip("/")
    if args.proxy:
        OPENER = urllib.request.build_opener(
            urllib.request.ProxyHandler({"http": args.proxy, "https": args.proxy})
        )
        print(f"using proxy {args.proxy} -> {MIRROR}")

    selected = args.groups or list(GROUPS)
    unknown = [name for name in selected if name not in GROUPS]
    if unknown:
        print(f"unknown group(s): {', '.join(unknown)}; expected {', '.join(GROUPS)}", file=sys.stderr)
        return 2

    if args.check:
        return 0 if report({name: GROUPS[name] for name in selected}) == 0 else 1

    if shutil.which("curl") and os.name == "nt":
        print("note: this script uses urllib; curl also works and resumes with -C -")

    for name in selected:
        print(f"== {name} ==")
        for repo, remote, dest in GROUPS[name]:
            try:
                fetch(repo, remote, dest)
            except Exception as error:
                print(f"  FAILED {dest}: {error}", file=sys.stderr)
                return 1
    print("done")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
