#!/usr/bin/env python
"""Standalone SANA txt2img using diffusers SanaPipeline from the webui .venv.

Fully independent of the AUTOMATIC1111 webui pipeline. SANA is a DiT with
linear attention + DC-AE (not an LDM checkpoint), so it can never be a webui
"checkpoint" — it runs here as a separate workflow on the same venv, because
diffusers==0.32.2 already ships SanaPipeline (verified by import).

Model IDs / precision: https://nvlabs.github.io/Sana/docs/model_zoo/

Usage (or use sana_txt2img.bat):
    .venv\\Scripts\\python.exe sana_workflow\\txt2img.py --prompt "a cyberpunk cat"
"""
from __future__ import annotations

import argparse
import random
import sys
import time
from datetime import datetime
from pathlib import Path

import torch

# preset name -> (HF model id, note)
MODELS = {
    "sana-1.5-1.6b": ("Efficient-Large-Model/SANA1.5_1.6B_1024px_diffusers", "SANA-1.5 1.6B, bf16, 1024px (default)"),
    "sana-1.5-4.8b": ("Efficient-Large-Model/SANA1.5_4.8B_1024px_diffusers", "SANA-1.5 4.8B, bf16, 1024px (needs ~24GB)"),
    "sana-1.6b": ("Efficient-Large-Model/Sana_1600M_1024px_diffusers", "SANA 1.6B, fp16, 1024px"),
    "sana-1.6b-bf16": ("Efficient-Large-Model/Sana_1600M_1024px_BF16_diffusers", "SANA 1.6B, bf16, 1024px"),
    "sana-0.6b": ("Efficient-Large-Model/Sana_600M_1024px_diffusers", "SANA 0.6B, fp16, 1024px (~9GB)"),
    "sana-2k": ("Efficient-Large-Model/Sana_1600M_2Kpx_BF16_diffusers", "SANA 1.6B, bf16, 2Kpx"),
    "sana-4k": ("Efficient-Large-Model/Sana_1600M_4Kpx_BF16_diffusers", "SANA 1.6B, bf16, 4Kpx (auto VAE tiling)"),
    "sprint-1.6b": ("Efficient-Large-Model/Sana_Sprint_1.6B_1024px_diffusers", "SANA-Sprint 1.6B, few-step (use --steps 2..4)"),
    "sprint-0.6b": ("Efficient-Large-Model/Sana_Sprint_0.6B_1024px_diffusers", "SANA-Sprint 0.6B, few-step (use --steps 2..4)"),
}
DEFAULT_MODEL = "sana-1.5-1.6b"


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Standalone SANA txt2img via diffusers SanaPipeline")
    p.add_argument("--prompt", required=True, help="text prompt")
    p.add_argument("--negative-prompt", default="", help="negative prompt ("" = none)")
    p.add_argument("--model", default=DEFAULT_MODEL,
                   help="preset name or full HF id. Presets: " + ", ".join(MODELS))
    p.add_argument("--variant", default=None,
                   help="diffusers variant: bf16/fp16. Default: auto per preset (fallback to no variant)")
    p.add_argument("--width", type=int, default=1024)
    p.add_argument("--height", type=int, default=1024)
    p.add_argument("--steps", type=int, default=20, help="inference steps (Sprint: 2-4)")
    p.add_argument("--cfg", type=float, default=4.5, help="guidance scale")
    p.add_argument("--seed", type=int, default=-1, help="-1 = random")
    p.add_argument("--batch", type=int, default=1, help="images to generate (num_images_per_prompt)")
    p.add_argument("--dtype", choices=["bf16", "fp16", "fp32"], default="bf16")
    p.add_argument("--device", default="auto", help="auto / cuda / cpu")
    p.add_argument("--outdir", default="outputs/sana", help="output directory")
    p.add_argument("--exact-size", action="store_true", help="disable SANA 32px resolution binning")
    p.add_argument("--lora", default=None, help="optional SANA LoRA dir/weights to load (diffusers format)")
    p.add_argument("--max-seq-len", type=int, default=300, help="Gemma text encoder max sequence length")
    p.add_argument("--no-sidecar", action="store_true", help="skip writing .txt sidecar with params")
    return p.parse_args()


def resolve_model(model: str) -> tuple[str, str | None]:
    """Return (hf_id, default_variant) for a preset name or raw HF id."""
    if model in MODELS:
        hf_id = MODELS[model][0]
        default_variant = (
            "bf16" if "BF16" in hf_id or "SANA1.5" in hf_id or "Sprint" in hf_id else "fp16"
        )
        return hf_id, default_variant
    return model, None


def pick_device(args: argparse.Namespace) -> tuple[str, torch.dtype]:
    dtype = {"bf16": torch.bfloat16, "fp16": torch.float16, "fp32": torch.float32}[args.dtype]
    if args.device == "auto":
        if torch.cuda.is_available():
            return "cuda", dtype
        print("[sana] CUDA not available -> falling back to CPU with fp32", file=sys.stderr)
        return "cpu", torch.float32
    if args.device == "cpu" and dtype not in (torch.float32,):
        print("[sana] CPU requested -> forcing fp32", file=sys.stderr)
        return "cpu", torch.float32
    return args.device, dtype


def load_pipeline(hf_id: str, variant: str | None, dtype: torch.dtype, device: str, args: argparse.Namespace):
    from diffusers import SanaPipeline

    from tokenizer import load_sana_tokenizer

    # Rebuild the Gemma fast tokenizer locally (the repo's tokenizer.json is
    # incompatible with the venv's tokenizers 0.19.1) and inject it, so we
    # don't have to touch the shared venv's pinned versions.
    tokenizer = load_sana_tokenizer(hf_id)

    kwargs = dict(torch_dtype=dtype, tokenizer=tokenizer)
    if variant:
        kwargs["variant"] = variant
    try:
        print(f"[sana] loading {hf_id} (variant={variant or 'default'}, dtype={dtype}) ...")
        pipe = SanaPipeline.from_pretrained(hf_id, **kwargs)
    except (OSError, EnvironmentError) as e:
        if variant:
            print(f"[sana] variant '{variant}' not available ({e}); retrying without variant ...")
            kwargs.pop("variant", None)
            pipe = SanaPipeline.from_pretrained(hf_id, **kwargs)
        else:
            raise
    pipe.to(device)
    # docs pattern: keep text encoder + VAE in fp precision for stability
    pipe.text_encoder.to(dtype)
    pipe.vae.to(dtype)
    if args.lora:
        print(f"[sana] loading LoRA from {args.lora} ...")
        pipe.load_lora_weights(args.lora)
    return pipe


def build_generator(seed: int, device: str) -> tuple[int, torch.Generator]:
    if seed < 0:
        seed = random.randrange(2**31)
    gen = torch.Generator(device=device if device != "cpu" else "cpu")
    gen.manual_seed(seed)
    return seed, gen


def params_sidecar(args: argparse.Namespace, seed: int, hf_id: str, elapsed: float) -> str:
    return "\n".join([
        f"Model: {hf_id}",
        f"Prompt: {args.prompt}",
        f"Negative prompt: {args.negative_prompt}",
        f"Steps: {args.steps}, CFG: {args.cfg}, Seed: {seed}",
        f"Size: {args.width}x{args.height}, Batch: {args.batch}",
        f"LoRA: {args.lora or 'none'}",
        f"Time: {elapsed:.1f}s",
        f"Date: {datetime.now().isoformat(timespec='seconds')}",
    ])


def main() -> int:
    args = parse_args()
    hf_id, default_variant = resolve_model(args.model)
    variant = args.variant or default_variant
    device, dtype = pick_device(args)
    if args.dtype == "fp16":
        print("[sana] note: SANA fp16 models on Blackwell run better as bf16; use --dtype bf16 if quality drops")

    pipe = load_pipeline(hf_id, variant, dtype, device, args)

    # 2K/4K models: enable VAE tiling to avoid OOM (docs recommendation)
    if max(args.width, args.height) >= 2048:
        print("[sana] large resolution -> enabling VAE tiling")
        pipe.vae.enable_tiling(
            tile_sample_min_height=1024, tile_sample_min_width=1024,
            tile_sample_stride_height=896, tile_sample_stride_width=896,
        )

    seed, generator = build_generator(args.seed, device)
    out_dir = Path(args.outdir) / datetime.now().strftime("%Y-%m-%d")
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"[sana] generating {args.batch} image(s) {args.width}x{args.height}, steps={args.steps}, cfg={args.cfg}, seed={seed}")
    t0 = time.time()
    images = pipe(
        prompt=args.prompt,
        negative_prompt=args.negative_prompt,
        num_inference_steps=args.steps,
        guidance_scale=args.cfg,
        num_images_per_prompt=args.batch,
        height=args.height,
        width=args.width,
        generator=generator,
        use_resolution_binning=not args.exact_size,
        max_sequence_length=args.max_seq_len,
        clean_caption=False,
    ).images
    elapsed = time.time() - t0

    stamp = datetime.now().strftime("%H%M%S")
    sidecar = params_sidecar(args, seed, hf_id, elapsed)
    for i, img in enumerate(images):
        name = f"{stamp}_{seed}_{i:02d}.png"
        img.save(out_dir / name)
        if not args.no_sidecar:
            (out_dir / f"{stamp}_{seed}_{i:02d}.txt").write_text(sidecar, encoding="utf-8")
        print(f"[sana] saved {out_dir / name}")

    print(f"[sana] done in {elapsed:.1f}s -> {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
