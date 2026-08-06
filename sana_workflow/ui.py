#!/usr/bin/env python
"""Simple Gradio UI for standalone SANA txt2img.

Uses the same diffusers SanaPipeline backend as txt2img.py, so it runs entirely
on the webui .venv and is independent of the AUTOMATIC1111 pipeline.

Run:
    sana_ui.bat                      # http://127.0.0.1:7861
    .venv\\Scripts\\python.exe sana_workflow\\ui.py --port 7861
"""
from __future__ import annotations

import argparse
import random
import time
from datetime import datetime
from pathlib import Path

import gradio as gr
import torch
from diffusers import SanaPipeline

from txt2img import MODELS, DEFAULT_MODEL, resolve_model

OUTDIR = Path("outputs/sana")
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
DTYPE = torch.bfloat16 if DEVICE == "cuda" else torch.float32

_pipe = None
_pipe_key = None


def _load_pipe(model: str, variant: str | None, lora: str):
    global _pipe, _pipe_key
    key = (model, variant, lora)
    if _pipe is not None and _pipe_key == key:
        return _pipe, False
    hf_id, default_variant = resolve_model(model)
    variant = variant or default_variant
    # rebuild Gemma fast tokenizer locally (repo tokenizer.json needs tokenizers>=0.20)
    from tokenizer import load_sana_tokenizer

    tokenizer = load_sana_tokenizer(hf_id)
    kwargs = {"torch_dtype": DTYPE, "tokenizer": tokenizer}
    if variant:
        kwargs["variant"] = variant
    try:
        pipe = SanaPipeline.from_pretrained(hf_id, **kwargs)
    except (OSError, EnvironmentError, ValueError):
        kwargs.pop("variant", None)
        pipe = SanaPipeline.from_pretrained(hf_id, **kwargs)
    pipe.to(DEVICE)
    pipe.text_encoder.to(DTYPE)
    pipe.vae.to(DTYPE)
    if lora:
        pipe.load_lora_weights(lora)
    _pipe, _pipe_key = pipe, key
    return pipe, True


def generate(prompt, negative, model, variant, width, height, steps, cfg, seed, batch, lora):
    t0 = time.time()
    pipe, freshly_loaded = _load_pipe(model, variant, lora)
    if freshly_loaded:
        status = f"[sana] loaded model '{model}' (fresh load)\n"
    else:
        status = f"[sana] model '{model}' already loaded\n"

    if seed < 0:
        seed = random.randrange(2**31)
    generator = torch.Generator(device=DEVICE).manual_seed(seed)

    if max(width, height) >= 2048:
        pipe.vae.enable_tiling(
            tile_sample_min_height=1024, tile_sample_min_width=1024,
            tile_sample_stride_height=896, tile_sample_stride_width=896,
        )

    images = pipe(
        prompt=prompt,
        negative_prompt=negative,
        num_inference_steps=steps,
        guidance_scale=cfg,
        num_images_per_prompt=batch,
        height=height,
        width=width,
        generator=generator,
        max_sequence_length=300,
        clean_caption=False,
    ).images

    out_dir = OUTDIR / datetime.now().strftime("%Y-%m-%d")
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%H%M%S")
    paths = []
    for i, img in enumerate(images):
        p = out_dir / f"{stamp}_{seed}_{i:02d}.png"
        img.save(p)
        paths.append(str(p))
        status += f"saved {p}\n"

    status += f"done in {time.time() - t0:.1f}s (seed {seed})"
    return paths, status


def build_ui():
    with gr.Blocks(title="SANA txt2img") as demo:
        gr.Markdown("## SANA · standalone txt2img (diffusers, webui venv)\n"
                    "Independent of the webui SD pipeline. Model list: "
                    "https://nvlabs.github.io/Sana/docs/model_zoo/")
        with gr.Row():
            with gr.Column(scale=1):
                model = gr.Dropdown(choices=list(MODELS.keys()), value=DEFAULT_MODEL, label="Model")
                variant = gr.Dropdown(choices=["bf16", "fp16", ""], value="", label="Variant (empty = auto)")
                lora = gr.Textbox(label="LoRA (optional, diffusers format)", placeholder="path or HF id")
                prompt = gr.Textbox(label="Prompt", lines=3, placeholder="a cyberpunk cat with a neon sign")
                negative = gr.Textbox(label="Negative prompt", lines=2)
                with gr.Row():
                    width = gr.Number(value=1024, label="Width", precision=0)
                    height = gr.Number(value=1024, label="Height", precision=0)
                with gr.Row():
                    steps = gr.Slider(1, 50, value=20, step=1, label="Steps (Sprint: 2-4)")
                    cfg = gr.Slider(1.0, 20.0, value=4.5, step=0.5, label="CFG")
                with gr.Row():
                    seed = gr.Number(value=-1, label="Seed (-1 random)", precision=0)
                    batch = gr.Slider(1, 4, value=1, step=1, label="Batch")
                go = gr.Button("Generate", variant="primary")
            with gr.Column(scale=2):
                gallery = gr.Gallery(label="Output", columns=2, height=640)
                status = gr.Textbox(label="Status", lines=6, interactive=False)

        go.click(generate, [prompt, negative, model, variant, width, height, steps, cfg, seed, batch, lora],
                 [gallery, status])
    return demo


def main():
    p = argparse.ArgumentParser(description="SANA txt2img Gradio UI")
    p.add_argument("--port", type=int, default=7861)
    p.add_argument("--share", action="store_true")
    args = p.parse_args()
    print(f"[sana] device={DEVICE} dtype={DTYPE}")
    build_ui().queue().launch(server_name="127.0.0.1", server_port=args.port, share=args.share)


if __name__ == "__main__":
    main()
