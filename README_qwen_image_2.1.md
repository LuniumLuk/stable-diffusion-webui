# Qwen-Image-2.1 (GGUF) in this WebUI checkout

Qwen-Image-2.1 (7B DiT, text-to-image + editing, Qwen3-VL-8B text encoder) running as a
standalone **stable-diffusion.cpp** sidecar. A1111 cannot load GGUF DiT models natively,
so `sd-server` is managed like the local-llm / SANA sidecars and embedded via a
WebUI tab.

## Layout

| Path | What |
|---|---|
| `sd_cpp/` | stable-diffusion.cpp binaries (`sd-cli.exe`, `sd-server.exe`, ggml + CUDA runtime DLLs), release `master-890-74988b2` |
| `models/Qwen-Image-2.1/qwen-image-2.1-Q4_K_M.gguf` | DiT, 4.6GB (repo-recommended quant) |
| `models/Qwen-Image-2.1/text_encoders/Qwen3VL-8B-Instruct-Q4_K_M.gguf` | text encoder, 5.0GB (GGUF, from `Qwen/Qwen3-VL-8B-Instruct-GGUF`) |
| `models/Qwen-Image-2.1/text_encoders/mmproj-Qwen3VL-8B-Instruct-F16.gguf` | vision projector (mmproj), 1.16GB — required for reference-image editing |
| `models/Qwen-Image-2.1/vae/qwen_image_2.1_vae_bf16.safetensors` | VAE, 676MB |
| `qwen_image_server.bat` | sd-server launcher (web UI + A1111-compatible API on 127.0.0.1:7862) |
| `qwen_image_txt2img.bat` | one-shot CLI txt2img → `outputs/qwen-image-2.1/` |
| `modules/qwen_image_manager.py` | start/stop/restart/status of the sd-server process |
| `scripts/qwen_image_tab.py` + `javascript/qwenImageTab.js` | WebUI tab "Qwen-Image 2.1" (iframe + process controls) |

All files were downloaded through **hf-mirror.com** (`HF_ENDPOINT=https://hf-mirror.com`
equivalent URLs, direct connection, no proxy) and verified against the published
SHA256 checksums in `models/Qwen-Image-2.1/SHA256SUMS`.

## Launchers

```bat
qwen_image_server.bat                :: web UI at http://127.0.0.1:7862/
qwen_image_txt2img.bat "prompt"      :: 1024x1024, 20 steps, seed 42
qwen_image_txt2img.bat "prompt" 1024 1024 20 123
```

Reference-image editing: use the server web UI (add a reference image next to the
prompt) or the API, e.g. `POST /sdapi/v1/img2img` with `init_images: [base64]`. For CLI
editing, call sd-cli directly with `-r ref.png` plus the `--llm_vision` flag (see the
full argument set in `qwen_image_server.bat`).

The WebUI tab **Qwen-Image 2.1** has Start/Stop/Restart/Refresh buttons (managed
subprocess) and embeds the sd-server web UI in an iframe.

## Generation settings (verified working)

- `--cfg-scale 6.0 --sampling-method euler`, 20 steps (flow schedule is chosen
  automatically; resolutions must be divisible by 32).
- `--diffusion-fa` (flash attention in the DiT) — keeps the model fully in VRAM.
- `--vae-tiling` — required at ≥1024px: without it the VAE decode OOMs at 1024 on 16GB
  and only succeeds via the automatic tiled retry (with error spam). Do NOT add
  `--offload-to-cpu` for the default config; it is ~40% slower (69s vs 46s sampling at
  1024) and only needed if other processes hold VRAM.

### Measured on RTX 5070 Ti 16GB (Q4_K_M + Q4_K_M TE)

| Resolution | Steps | Config | Sampling | Total |
|---|---|---|---|---|
| 512×512 | 20 | default | 13.1s (1.71 it/s) | ~17s |
| 1024×1024 | 20 | `--diffusion-fa --vae-tiling` | 45.3s | ~51s |
| 1024×1024 | 20 | `--offload-to-cpu` | 68.8s | ~73s |
| 2048×2048 | 20 | `--diffusion-fa --vae-tiling` | 296.7s | ~5.3 min |
| 1696×2528 | 20 | `--diffusion-fa --vae-tiling` | 313.2s | ~5.5 min |
| 2528×1696 | 20 | `--diffusion-fa --vae-tiling` | 290.5s | ~5.2 min |

## Resolution presets (verified on RTX 5070 Ti, 20 steps, cfg 6.0 euler)

| Preset | Size (W×H) | Time |
|---|---|---|
| `1k:1:1` | 1024×1024 | ~51s |
| `1k:2:3` | 1024×1536 | ~82s |
| `1k:3:2` | 1536×1024 | ~83s |
| `2k:1:1` | 2048×2048 | ~5.3 min |
| `2k:2:3` | 1696×2528 | ~5.5 min |
| `2k:3:2` | 2528×1696 | ~5.2 min |

All sizes are divisible by 32 (required by sd.cpp); the 2K sizes are the model's native
2048-class training buckets. CLI: `qwen_image_txt2img.bat "prompt" 1k:2:3 [steps] [seed]`
(preset name replaces width/height). In the server web UI set width/height to the pair
directly — the Qwen-Image 2.1 tab shows this preset strip above the embedded UI.

## Notes / gotchas

- **int8-convrot TE does not work in this build**: `qwen3vl_8b_int8_convrot.safetensors`
  (ComfyUI format, kept in `models/Qwen-Image-2.1/text_encoders/`) crashes
  `master-890` with `GGML_ASSERT(scale_nelements == 1 || scale_nelements == out_features)`
  and auto-disables the vision projector. Use the GGUF text encoder instead. Retry the
  int8 TE after sd.cpp updates (it would save RAM and enable the accelerated CUDA int8
  path).
- Reference-image editing is enabled: `--llm_vision mmproj-Qwen3VL-8B-Instruct-F16.gguf`
  (F16, from `Qwen/Qwen3-VL-8B-Instruct-GGUF`) is passed by both the .bat launcher and
  the WebUI manager. Verified end-to-end (CLI + `/sdapi/v1/img2img`): the reference is
  preserved and the prompt change is applied; ~7s for a 512px / 12-step edit.
  Without the mmproj the request fails with
  "Qwen Image 2.1 editing requires Qwen3-VL vision weights; provide --llm_vision".
- Output PNGs embed an **A1111-compatible** `parameters` infotext (`Steps/CFG/Seed/
  Size/...` + a `SDCPP:` JSON blob), so the endorsed-gallery param parsing works if the
  output dir is added to its scan list (`scripts/endorsed_gallery.py::_get_output_dirs`).
- The embedded sd.cpp web UI is served by sd-server itself; `/sdapi/v1/...` mirrors the
  A1111 API on the same port.
- License: Qwen Research License (research/personal use).
