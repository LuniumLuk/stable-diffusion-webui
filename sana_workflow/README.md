# SANA standalone workflow

Independent txt2img for [NVlabs/SANA](https://github.com/NVlabs/SANA) that runs on
the webui's `.venv` (Python 3.10.6, torch 2.11.0+cu128, diffusers 0.32.2 — which
already ships `SanaPipeline`). SANA is a DiT (linear attention + DC-AE + Gemma
text encoder), so it **cannot** be loaded as a webui checkpoint; it runs here as
a completely separate workflow. The SANA repo itself is vendored as a git
submodule at `repositories/sana` for reference/configs.

## Launchers

| Command | What it does |
|---|---|
| `sana_txt2img.bat --prompt "..."` | CLI txt2img → `outputs/sana/YYYY-MM-DD/` |
| `sana_ui.bat` | Simple Gradio UI at http://127.0.0.1:7861 |

Both set `HTTP(S)_PROXY=http://127.0.0.1:7897` for HuggingFace downloads (verified
working on this machine). To use hf-mirror instead, comment the proxy lines and
uncomment `set HF_ENDPOINT=https://hf-mirror.com` in the `.bat`.

## CLI examples

```bat
sana_txt2img.bat --prompt "a cyberpunk cat with a neon sign" --seed 42
sana_txt2img.bat --prompt "sakura, anime girl" --model sana-1.5-1.6b --steps 20 --cfg 4.5
sana_txt2img.bat --prompt "mountain, 4k" --model sana-2k --width 2048 --height 2048
sana_txt2img.bat --prompt "one shot" --model sprint-1.6b --steps 2
sana_txt2img.bat --prompt "x" --lora "path\to\lora"     # diffusers-format LoRA
sana_txt2img.bat --help
```

## Model presets (`--model`)

| Preset | HF id | Notes |
|---|---|---|
| `sana-1.5-1.6b` (default) | `Efficient-Large-Model/SANA1.5_1.6B_1024px_diffusers` | bf16, ~12GB |
| `sana-1.5-4.8b` | `Efficient-Large-Model/SANA1.5_4.8B_1024px_diffusers` | bf16, ~24GB |
| `sana-1.6b` | `Efficient-Large-Model/Sana_1600M_1024px_diffusers` | fp16 |
| `sana-1.6b-bf16` | `Efficient-Large-Model/Sana_1600M_1024px_BF16_diffusers` | bf16 |
| `sana-0.6b` | `Efficient-Large-Model/Sana_600M_1024px_diffusers` | fp16, ~9GB |
| `sana-2k` | `Efficient-Large-Model/Sana_1600M_2Kpx_BF16_diffusers` | bf16, auto VAE tiling |
| `sana-4k` | `Efficient-Large-Model/Sana_1600M_4Kpx_BF16_diffusers` | bf16, auto VAE tiling |
| `sprint-1.6b` / `sprint-0.6b` | `Efficient-Large-Model/Sana_Sprint_*_1024px_diffusers` | few-step, use `--steps 2..4` |

You can also pass a raw HF id directly (e.g. `--model Efficient-Large-Model/...`).

## Layout

- `sana_workflow/txt2img.py` — CLI backend (diffusers `SanaPipeline`)
- `sana_workflow/ui.py` — Gradio UI (same backend)
- `repositories/sana` — NVlabs/Sana submodule (reference only; its own deps need
  Python ≥ 3.11 + diffusers ≥ 0.37 and are **not** installed into this venv)
