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
    loras/             rda-3.safetensors                    # optional, see "LoRA" below
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
- A sidecar left behind by a previous WebUI run keeps the port warm. Because it was started with the
  old arguments (no LoRA folder, for instance), the new job refuses to adopt it and says so; stop it
  with `scripts/kill-webuis.ps1` or pick another port in the DiT settings.
- `Flow shift` is a setting; leave it at `0` (auto). sd.cpp treats an explicit `flow_shift: 0` as
  "no shift" and returns a blank image, so the value is only sent when greater than zero.

## Performance

Cost follows the **pixel count**, not either side length. 832x1216 (1.01 MPx) and 1024x1024
(1.05 MPx) are the same amount of work — the 832x1216 recommendation is about the bucketing the
model was trained on, not about speed. 512x768 is 0.39 MPx, i.e. a bit over a third of the job.

Measured on a 2B Anima checkpoint (AM v4.0) / RTX 5070 Ti, 20 steps, Euler a, CFG 4, total job
time (warm sidecar, first run excluded):

| size      | MPx  | before flags | with `--diffusion-fa --vae-conv-direct` |
|-----------|------|--------------|------------------------------------------|
| 512x768   | 0.39 | 8.5 s        | 5.6 s                                    |
| 832x1216  | 1.01 | 27.9 s       | 16.0 s                                   |
| 1024x1024 | 1.05 | 28.5 s       | 16.6 s                                   |

Two further things dominate the numbers:

- **CFG > 1 doubles the sampling time** — sd.cpp runs a negative and a positive pass per step.
  The same 1024x1024 job at CFG 1.0 takes 15.1 s where CFG 4.0 takes 28.5 s (before the flags).
  Negative prompts only work above 1.0, so this is the main quality/speed dial.
- **Attention** was the reason the per-pixel cost used to climb with resolution: without
  `--diffusion-fa` a 1 MP job paid ~30% more per pixel than a 0.4 MP one. With it the rise is
  down to ~10% (and ~2% with `--sage-attn`), so resolution changes stay predictable.

The sidecar always asks for `--diffusion-fa` (flash attention in the DiT) and
`--vae-conv-direct` (direct VAE convolutions, ~60% off the decode). Both are numerics-preserving:
against a no-flag run at 1 step the difference is 0.5/255 mean, i.e. below sampler noise. The
flags are only passed when `sd-server.exe --help` lists them, so an older sidecar binary still
runs (just slower). `--sage-attn` (int8 attention, another ~13%) is available in this build but
is not enabled because it is measurably lossier — 1.96/255 at 1 step; add it to `PERF_FLAGS` in
`modules/backends/sdcpp_server.py` to try it.

## LoRA

Put Anima LoRAs in `models/Anima/loras` (`.safetensors`, `.pt`, `.ckpt`), not in
`models/Lora` — those are SD UNet adapters and A1111 would try to load them into a
checkpoint that has no matching tensors.

- **PC**: Extra Networks → **Anima LoRA** shows the folder with previews; clicking a card
  appends `<lora:<file stem>:<weight>>` to the prompt.
- **Mobile / SD Lite**: the prompt card grows an **Anima LoRA** fold with one chip per file
  while an Anima checkpoint is selected; a chip appends the same tag.
- The tag can also be typed by hand. The Anima runner strips the tags from the text sent to
  sd.cpp and applies the adapters through the sidecar's runtime LoRA list, so a missing or
  mistyped name fails the job with the list of installed LoRAs instead of silently doing
  nothing. Weights are the first number of the tag; `<lora:name:0.8:0.6>` uses `0.8`.

## Not implemented yet

- Hires. fix, refiner.
- Inpaint mask pass is wired (`image_mask` → `mask_image`) but untested.
- Prompt weighting `(word:1.2)`, textual inversion and other CLIP-era features do not apply: Anima
  uses a Qwen3 text encoder.
- A1111 scripts/extensions hooks (`process_batch`, `postprocess_image`, …) are skipped for DiT jobs.
- The UI does not yet grey out SD-only controls while a DiT checkpoint is selected.

## Files

- `modules/model_registry.py` — finds the files under `models/Anima/`, builds the `[Anima] …` titles.
- `modules/backends/sdcpp_server.py` — sidecar process + job API client.
- `modules/backends/anima.py` — payload mapping (including the `<lora:…>` tags) and image decoding.
- `modules/backends/runner.py` — the `Processed` pipeline (seeds, infotext, saving).
- `modules/backends/__init__.py` — family registry used by the router.
- `modules/ui_extra_networks_anima.py` — the Extra Networks page for `models/Anima/loras`.
