# DiT backends (Anima)

Runs Anima-family checkpoints (Nova Anime AM and friends) from the normal **txt2img / img2img**
tabs. Jobs whose checkpoint is a DiT model are routed to `sd_cpp/sd-server.exe`
(stable-diffusion.cpp) instead of A1111's UNet/CLIP pipeline; prompts, seeds, batch, infotext,
saving and the gallery all keep working through `processing.process_images()`.

## Requirements

- `sd_cpp/sd-server.exe` and its DLLs — shipped with this fork, nothing to build.
- Model files under `models/Anima/`:

  ```
  models/Anima/
    diffusion_models/  anima-preview3-base-Q4_K_M.gguf      # Anima 2B and finetunes (AM v1-v4)
    text_encoders/     Qwen3-0.6B-Base-Q8_0.gguf
    vae/               qwen_image_vae.safetensors
  ```

  `.safetensors` and `.gguf` both work.

- **Anima 2.9B checkpoints (Nova Anime AM v5.0 / v6.0) are not supported.** stable-diffusion.cpp
  builds the text adapter with a fixed 1024 width, so the 2.9B model (2048-wide adapter,
  40 layers) fails metadata validation at load time. Such files are detected from the tensor
  table and shown as `[Anima] … (unsupported: 2.9B)`; generating with one returns a clear error
  instead of a server crash. Only the 2B line works today.

## Enable

1. Settings → **DiT backends (Anima)**: pick the text encoder and VAE (defaults to the first file
   found), adjust the sidecar port if 7866 is taken.
2. **Restart the WebUI** — the new modules are imported at startup.
3. Select `[Anima] <model>` in the checkpoint dropdown and generate as usual.

## Behaviour

- Size, steps, CFG and sampler come from the UI. Sampler names are mapped to sd.cpp equivalents
  (`Euler a` → `euler_a`, `DPM++ 2M Karras` → `dpmpp_2m` + `karras`, …); unknown names fall back to
  `euler_a`.
- The sidecar starts on the first DiT job and restarts when the selected model files change
  (~0.5 s plus the model load). It is left warm when switching back to an SD checkpoint.
- `Flow shift` is a setting; leave it at `0` (auto). sd.cpp treats an explicit `flow_shift: 0` as
  "no shift" and returns a blank image, so the value is only sent when greater than zero.

## Not implemented yet

- Hires. fix, LoRA, refiner.
- Inpaint mask pass is wired (`image_mask` → `mask_image`) but untested.
- Prompt weighting `(word:1.2)`, textual inversion and other CLIP-era features do not apply: Anima
  uses a Qwen3 text encoder.
- A1111 scripts/extensions hooks (`process_batch`, `postprocess_image`, …) are skipped for DiT jobs.
- The UI does not yet grey out SD-only controls while a DiT checkpoint is selected.

## Files

- `modules/model_registry.py` — finds the files under `models/Anima/`, builds the `[Anima] …` titles.
- `modules/backends/sdcpp_server.py` — sidecar process + job API client.
- `modules/backends/anima.py` — payload mapping and image decoding.
- `modules/backends/runner.py` — the `Processed` pipeline (seeds, infotext, saving).
- `modules/backends/__init__.py` — family registry used by the router.
