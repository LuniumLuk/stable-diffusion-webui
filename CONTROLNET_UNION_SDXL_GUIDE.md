# ControlNet++ Union SDXL 1.0 — Usage Guide

> Installed 2026-09-07 into this webui fork. Covers everything the model can do and how to use it,
> with a dedicated section on **style repaint** (preserve composition & characteristics).

---

## 1. What was installed

| Piece | Location / state |
|---|---|
| Extension | `extensions/sd-webui-controlnet` — Mikubill extension **pinned to v1.1.454** (local branch `v1.1.454`), the first release with native ControlNet-union support |
| Standard model (6 types) | `models/ControlNet/controlnet_union_sdxl_1.0.safetensors` (~2.34 GB, fp16) |
| ProMax model (8 types) | `models/ControlNet/controlnet_union_sdxl_promax.safetensors` (~2.34 GB, fp16) |
| Annotator (preprocessor) models | auto-downloaded on first use into `extensions/sd-webui-controlnet/annotator/downloads` (via `HF_ENDPOINT=https://hf-mirror.com` in `webui-user.bat`) |

Source: `xinsir/controlnet-union-sdxl-1.0` (Apache-2.0) · Code: `xinsir6/ControlNetPlus`.

Local adjustments made during install:
- `timm<=0.9.5` removed from the extension's `requirements.txt` (this fork needs `timm 1.0.26` for `open-clip-torch`; nothing in the extension imports timm).
- `handrefinerportable` auto-install disabled in `install.py` (its `mediapipe → opencv-contrib-python 5 → numpy>=2` chain conflicts with this fork's `numpy<2` / opencv 4.10 pins). Preprocessors `mediapipe_face` and `hand_refiner` are therefore unavailable — everything else works.
- `opencv-python` pinned to `<=4.10.0.84` in the extension requirements (cv2 4.11+ removed the `CV_8U` constants that `albumentations`/`insightface` need).

---

## 2. Quick start (first generation)

1. In `txt2img`, load an **SDXL checkpoint** (the model is SDXL-only). This fork has `animagine-xl-4.0`, `novaAnimeXL`, `AAM_XL_Anime_Mix`, etc.
2. Set 1024×1024 (or any resolution; bucket training handles aspect ratios, but ~1024px is the sweet spot).
3. Open the **ControlNet** accordion (below the prompt):
   - **Enable** ✓
   - **Control Type**: pick the condition you want, e.g. `Canny`
   - **Preprocessor**: matching preprocessor, e.g. `canny`
   - **Model**: `controlnet_union_sdxl_1.0 [union_sdxl]`
   - **Control Weight**: 0.8–1.0 · **Control Mode**: Balanced · **Pixel Perfect** ✓
4. Upload a control image (photo, sketch, render…) and Generate.

> ⚠️ Do **not** leave the Control Type filter on **All** when a union model is selected —
> the hidden "Union Control Type" is set from the Control Type filter and "All" maps to
> *Unknown*, which raises `Unknown control type cannot be encoded`.

---

## 3. Full capability map

### Control Type → type id → preprocessors

| Control Type filter | Union id | Works with | Use these preprocessors |
|---|---|---|---|
| OpenPose | 0 | standard + promax | `openpose_full`, `openpose_hand` |
| Depth | 1 | standard + promax | `depth_midas`, `depth_zoe`, `depth_anything_v2` |
| Soft Edge (thick lines) | 2 | standard + promax | `softedge_hed`, `softedge_pidinet`, `softedge_teed`, `scribble_hed` |
| Hard Edge (thin lines) | 3 | standard + promax | `canny`, `lineart_realistic`, `lineart_anime`, `mlsd` |
| Normal Map | 4 | standard + promax | `normal_bae`, `normal_midas` |
| Segmentation | 5 | standard + promax | `seg_ufade20k` |
| Tile | 6 | **promax only** | `tile_resample`, `tile_colorfix`, `blur_gaussian` |
| Inpaint (repaint) | 7 | **promax only** | not usable via this extension — see §4 |

### ProMax-only editing features (type ids 6–7)
- **Tile deblur** (`blur_gaussian`) — sharpen/enhance a blurry source.
- **Tile variation** (`tile_resample`) — re-render texture/details while keeping layout.
- **Tile super-resolution** — tile upscale up to 9× pixels via img2img (denoise ~0.5, big target size).
- **Image inpainting / outpainting** — the fused image+mask repaint mode; see §4 notes.

### Model behavior
- One network handles all 12 conditions; **multi-condition fusion was trained in** (ComfyUI exposes it natively; in this extension multiple units stack separately — a known TODO upstream).
- Trained on 10M+ images with detailed CogVLM captions → **write long, descriptive prompts**.
- Compatible with all SDXL checkpoints and SDXL LoRAs.

---

## 4. Style repaint — preserve composition & characteristics ★

Goal: re-render an existing image in a **new style** while keeping its composition, pose and shapes.

### Method A — Structure-locked repaint (recommended)

Best general-purpose approach: let an edge/depth map pin the composition while the diffusion repaints style.

1. **img2img** tab → upload your source image.
2. Width/Height = source resolution (click the ⬇ "send dimensions" button under the image).
3. **Denoising strength 0.55–0.8** — lower = closer to original, higher = stronger style change. Start at 0.65.
4. Prompt: describe the new style + subject in detail (e.g. `masterpiece, best quality, oil painting style, <subject description>`). Use the same subject keywords as the original.
5. **ControlNet unit**:
   - Enable ✓ · Control Type `Canny` (fine detail) or `Depth` (solid shapes) or `Soft Edge`/`Lineart` (anime).
   - Preprocessor: `canny` / `depth_midas` / `softedge_hed` / `lineart_anime` — it runs on the uploaded img2img image automatically.
   - Model: `controlnet_union_sdxl_1.0` · Weight **0.8–1.0** · Control Mode **Balanced** (use **ControlNet is more important** if the composition drifts) · Pixel Perfect ✓.
6. Generate. The control map locks layout/pose; denoising strength dials how much the style shifts.

### Method B — Region repaint (A1111 Inpaint + structural lock)

Repaint only selected areas (e.g. recolor clothes, new sky) and keep everything else untouched.

1. img2img → **Inpaint** sub-tab → upload source → paint the area(s) to repaint.
2. Inpaint area: **Whole picture** (better with ControlNet) · Denoising strength 0.6–0.9.
3. ControlNet unit exactly as Method A (**canny/depth/lineart** of the full image — not the inpaint preprocessors).
4. Generate — only masked regions are re-rendered, in the new style, inside the locked structure.

### Method C — ProMax tile (deblur / variation / super-resolution)

- Select model `controlnet_union_sdxl_promax`, Control Type **Tile**:
  - `blur_gaussian` → deblur/sharpen while preserving content.
  - `tile_resample` → re-render texture ("tile variation").
- For super-resolution: img2img at a larger target resolution, denoise ~0.4–0.6, tile + your prompt. Expect VRAM pressure beyond ~1.5–2× source; enable the unit's **Low VRAM** checkbox if needed.

### About the ProMax "repaint" mode (type 7)

The model's built-in image+mask repaint (inpaint/outpaint) needs a 4-channel image+mask hint, but this
extension version constructs union models with 3-channel inputs — so choosing Control Type `Inpaint`
with an RGBA inpaint preprocessor will fail. Use **Methods A/B** for style repaint in this webui.
If you later want the fused repaint mode, the pinned `diffusers 0.32.2` in this venv already ships
`StableDiffusionXLControlNetUnionInpaintPipeline` for a standalone script.

### Style-repaint tuning cheat sheet

| Symptom | Fix |
|---|---|
| Style changed too little | raise denoising strength; raise prompt style weight (e.g. `(oil painting:1.3)`) |
| Composition drifted | Control Weight → 1.0; Control Mode → "ControlNet is more important"; switch Canny → Depth |
| Too rigid / artifacts | Control Weight 0.7–0.85; add a second unit with a different map at low weight |
| Faces/hands broken | enable your usual face restore; lower denoise to ~0.6 |

---

## 5. Settings

- **Multi-ControlNet**: Settings → ControlNet → *Multi ControlNet: ControlNet unit number* (restart required). Each unit runs the union model independently (stacking, not the native fused forward).
- **Model cache size**: `control_net_model_cache_size` — keep ≥2 when switching between the two union models.
- Low VRAM: per-unit checkbox. This fork's RTX 5070 Ti (16 GB) handles SDXL + union comfortably at 1024².

---

## 6. Troubleshooting & known limits

- **"Unknown control type cannot be encoded"** → Control Type filter is `All`; pick a concrete type.
- **Tile/Inpaint selected with the standard model** → type ids 6/7 don't exist in the 6-type file; use the `_promax` model.
- **Index out of range / shape mismatch on Inpaint preprocessors** → 4-channel hints unsupported (see §4).
- **Annotator download stalls** → preprocessor models come from hf-mirror; if it fails, add
  `set HTTP_PROXY=http://127.0.0.1:7897` / `set HTTPS_PROXY=http://127.0.0.1:7897` to `webui-user.bat` (above the proxy-clearing lines) and restart.
- **Model list empty** → press 🔄 next to the Model dropdown; files must sit directly in `models/ControlNet`.
- **Updating the extension** will drop the v1.1.454 pin and restore `install.py`/`requirements.txt` — if you update, re-apply the two patches in §1 (or stay on the `v1.1.454` branch).
- `mediapipe_face` and `hand_refiner` preprocessors are disabled on this machine (dependency conflict with the fork's numpy<2 pin).

## 7. References

- **How it works under the hood**: [`CONTROLNET_UNION_SDXL_TECHNICAL.md`](./CONTROLNET_UNION_SDXL_TECHNICAL.md) — residual injection, union type embedding, hook mechanics.
- Model: <https://huggingface.co/xinsir/controlnet-union-sdxl-1.0>
- Code & inference scripts: <https://github.com/xinsir6/ControlNetPlus>
- Extension: <https://github.com/Mikubill/sd-webui-controlnet> (union support discussion #2989)
