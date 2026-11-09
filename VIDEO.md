# Video tab (anime short clips)

A fourth generation engine next to SDXL, the Anima DiT sidecar and the Qwen/Krea 2
image sidecars: short, GIF-like clips aimed at anime. Four open-weight models are
wired in, all running locally on one GPU:

| Engine | Model | Modes | Frames | VRAM | Speed (RTX 5070 Ti 16 GB) | Licence |
|---|---|---|---|---|---|---|
| `animatediff` | AnimateDiff v1-5-2 + Lightning 4-step on an SD1.5 anime base (AnyLoRA) | text → video | 8–32 @ 512² | 5–7 GB | ~12 s (512²×16, 4 steps, incl. load) | MIT / Apache-2.0 / CreativeML OpenRAIL-M |
| `cogvideox` | THUDM CogVideoX-2B | text → video | 9–49 @ 480p | 10–14 GB (CPU offload) | ~42 s for 9 frames / 50 steps; 49 frames = minutes | Apache-2.0 |
| `svd` | Stability SVD-XT | image → video | 14 / 25 @ 576p | 5–9 GB | ~2 min for 14 frames (incl. load) | Stability AI Community |
| `ltx` | Lightricks LTX-Video 2B | text → video, **image + prompt** → video | 9–49 @ 512–768p | 9–15 GB (CPU offload) | 26 s (512×768×49, 30 steps, offload; peak 10.7 GB reserved) | OpenRAIL-M (LTX-Video licence) |

AnimateDiff is the anime workhorse: 4 Lightning steps, 16-frame loops, and it reuses
the SD1.5 anime checkpoint you already have in the models folder if you convert it to
a diffusers folder. CogVideoX has the strongest motion/prompt following but is slow on
16 GB. SVD animates one of your existing anime pictures — the classic image → GIF flow.
LTX-Video is the only engine that natively takes *both* a still and a prompt, so it
replaces the SVD + img2img refine trick when you want the prompt to direct the motion.

## Install

```powershell
# from the repo root, with the WebUI venv
python scripts/download_video_models.py            # all four (~31 GB; LTX reuses CogVideoX's T5)
python scripts/download_video_models.py animatediff
python scripts/download_video_models.py --check
```

The script uses the HF mirror (`https://hf-mirror.com`, override with `HF_ENDPOINT`)
and resumes interrupted downloads. If the mirror stalls, fall back to the
Hugging Face CDN through the local proxy:

```powershell
python scripts/download_video_models.py cogvideox --endpoint https://huggingface.co --proxy http://127.0.0.1:7890
```

Files land exactly where the code looks:

```
models/AnimateDiff/motion-adapter-v1-5-2/     motion module (fp16) + config
models/AnimateDiff/lightning/                 AnimateDiff-Lightning 4/8-step
models/Video/bases/AnyLoRA/                   diffusers-format SD1.5 anime checkpoint
models/Video/CogVideoX-2b/                    CogVideoX-2B (diffusers)
models/Video/Stable-Video-Diffusion/          SVD-XT (diffusers, fp16 variant)
models/Video/LTX-Video/                       LTX-Video 2B transformer + VAE + tokenizer + scheduler
```

LTX-Video ships a **bf16 T5-XXL** text encoder that is exactly the model CogVideoX
already downloaded (same config, different dtype), so the download script skips it and
`video_manager._ltx_text_encoder()` loads CogVideoX's copy in bf16. If you install LTX
without CogVideoX, add `models/Video/LTX-Video/text_encoder/` yourself (config +
shards) — otherwise the engine reports the encoder as missing.

The LTX transformer is published as two shards. `diffusers` 0.32 asks accelerate to
dispatch sharded safetensors, and the accelerate pinned here (0.21) predates that call
signature, so the first LTX load merges the shards into
`transformer/diffusion_pytorch_model.safetensors` (~10 s, one extra 7.3 GB, the shards
are kept) and renames the index to `*.index.json.disabled`, which sends diffusers down
the single-file path. That happens once, automatically; nothing to do by hand.

Extra bases: drop any **diffusers-format** SD1.5 checkpoint into
`models/Video/bases/<name>/` (it needs `model_index.json`, `unet/`, `vae/`,
`text_encoder/`, `tokenizer/`, `scheduler/`; the fp16 variant is used when present).
An A1111 single-file `.safetensors` does not have the tokenizer, so it is not picked
up by the AnimateDiff engine — keep those for the normal txt2img tab.

Then restart the WebUI (new Python module) and open the **Video** tab.

## Give it an image and a prompt (one job)

SVD itself is image-conditioned only. To honour a prompt without a second large
model, the Video tab runs a **low-strength SD1.5 img2img pass** (the AnyLoRA base
already used by AnimateDiff) on the init image first, then hands the refined still
to SVD. The refiner is dropped before SVD samples, so the two never compete for VRAM.

- *Prompt guidance* = **0.25** (default): keeps composition and subject, nudges
  weather, lighting, colour and details.
- **0.4–0.6**: the prompt restyles the scene strongly; the subject may be replaced.
- **0**: pure SVD, prompt unused (fastest).

Measured on the 5070 Ti: 14 frames at 576×1024, refine 0.25 → 126 s total
(~8 s of that is the refiner). The same path is on the SD Lite Video screen
(*Prompt guidance* slider in the SVD block).

## Use

- **AnimateDiff** — prompt + CFG 1.5 + 4 steps. Sizes 384² (draft) to 768×512. 16
  frames at 8 fps = a 2 s loop; enable *Ping-pong loop* for a seamless palindrome.
  Lightning is mandatory here: the original v1-5-2 motion module mis-decodes under
  diffusers 0.32's motion-config remap (the sampler collapses to a dark frame), while
  the Lightning modules ship diffusers-native weights. Use the 4-step module for speed
  and the 8-step one for a little more detail (set Steps to match: 4 or 8).
- **CogVideoX** — 720×480, 49 frames, **50 steps**, CFG 6. Below ~20 steps the flow
  sampler returns an almost flat frame, so do not lower it much. First run loads
  ~13 GB; with CPU offload sampling is slow (9 frames took 42 s here, 49 frames
  several minutes), which is expected for a 16 GB card.
- **SVD** — pick an init image, choose 14/25 frames, and (optionally) write a prompt:
  *Prompt guidance* > 0 runs an SD1.5 img2img refine of that image first, so the
  prompt changes weather/style/details before SVD animates it. The prompt does not
  go to SVD itself. *Motion bucket* (1–255) and *noise augment* control how much it
  moves. The source is centre-cropped to 576p.
- **LTX-Video** — the only engine that takes the image *and* the prompt directly.
  Drop an init image on the tab and the same prompt describes the motion
  ("turns toward the camera, hair drifting, slow push-in"); leave the image empty and
  it is pure text → video. Sizes must be multiples of 32 (512×768, 768×512, 512²,
  384×576), frames are `8k+1` (up to 49), and 30 steps at CFG 3 is the default —
  LTX is distilled for low CFG, so 2–3.5 is the useful range. It needs ~15 GB
  resident, so CPU offload turns on automatically on a 16 GB card; expect it to be
  slower than AnimateDiff but to follow the prompt far better than SVD. Measured here:
  25 frames 512×768 / 30 steps = 22 s of sampling (25 s with the load), 49 frames = 26 s,
  peak 10.7 GB reserved — it never comes near the 16 GB ceiling thanks to offload.
  2B detail is softer than SVD or SDXL; for crisp anime frames generate the still in
  SDXL first and use it as the init image. The init
  image is only used for the I2V pipeline: switching between picture and no-picture
  reloads the pipeline (different class, different conditioning path).

Every run writes to `outputs/video/<date>/<time>-<engine>-<seed>/`:

```
<engine>-<seed>.gif      animated GIF (Pillow, always written)
<engine>-<seed>.mp4      H.264 when imageio-ffmpeg is installed, else cv2 mp4v, else absent
<engine>-<seed>-frame1.png
<engine>-<seed>.txt      all parameters
```

SD Lite (`/mlite/`) has the same screen: **Video** in the bottom bar, backed by
`/mlite/api/video` and the shared job strip.

## VRAM: one engine at a time

`modules/vram.py` is the single switchboard. Every engine registers two callables:
*does it hold VRAM?* and *release it*. Before a job starts, the new engine claims the
GPU and every other holder is released:

| Switch | What is released |
|---|---|
| → SDXL / SD1.5 (any txt2img/img2img job) | video pipeline, Qwen sidecar, Krea 2 sidecar, Anima sidecar; checkpoint moved back to the GPU |
| → Anima (DiT) | SD checkpoint to CPU, video pipeline, Qwen/Krea 2 sidecars |
| → Qwen or Krea 2 | SD checkpoint to CPU, video pipeline, the other sd-server |
| → Video | SD checkpoint to CPU, all three sd-server sidecars |

Before this change each call site released only the engines it remembered, so
SDXL → Video → SDXL left the video weights (or a sidecar) resident until something
OOM'd. The coordinator probes each engine instead of trusting a bookkeeping flag, so
a sidecar started by an older WebUI run is handled too (only processes this instance
manages are stopped; an external server is left alone and reported).

Settings → **Video**:

- **Free the previous engine when switching** (`vram_auto_release`, default on) —
  turn it off to keep sidecars warm and accept that two engines may not fit.
- **Unload the video model after each clip** (`vram_release_after_video`, default on)
  — frees 4–14 GB; the next clip pays the reload.
- **Video VRAM policy** (`auto` / `on` / `off`) — `auto` keeps a pipeline on the GPU
  when it fits and otherwise streams modules from RAM (`enable_model_cpu_offload`).
  All pipelines also get VAE slicing/tiling; SVD additionally enables forward
  chunking in the UNet.

The Video tab shows free/total VRAM and which engine is loaded; **Unload video
models** drops the pipeline immediately.

## API

```
GET  /mlite/api/video/status        engines, bases, lightning, loaded engine, VRAM
GET  /mlite/api/video/job           live phase/step/seed/error of the current job
POST /mlite/api/video               run a clip (blocking; same payload as below)
POST /mlite/api/video/unload        drop the loaded pipeline
POST /mlite/api/engine {"engine":"video"}   pre-empt the GPU from the mobile UI
```

`POST /mlite/api/video` payload: `engine`, `prompt`, `negative_prompt`, `width`,
`height`, `frames`, `fps`, `steps`, `guidance`, `seed`, `base`, `lightning`,
`offload`, `init_image` (path or data URL), `refine` (SVD img2img guidance),
`motion_bucket_id`, `noise_aug_strength`, `pingpong`, `save_mp4`, `task_id`. Values
are clamped per engine (frames 4k+1 for CogVideoX, 8k+1 for LTX, multiples of 4 for
AnimateDiff, 14/25 for SVD; LTX width/height snap to multiples of 32).

## Local, unfiltered, your responsibility

No safety checker is loaded (`safety_checker=None`), no prompt filter runs, and
nothing leaves the machine. SVD is not watermarked. The open weights above are
research/personal-use models; each has its own licence (see the table and the
`LICENSE` files in the HF repos) — check it before publishing or commercial use.
You are responsible for what you generate and for the checkpoints you add.

## Known limits

- No audio, no interpolation/upscaling, no video-to-video.
- AnimateDiff has no init-image conditioning (use SVD for image → video); SparseCtrl
  is not wired. SVD's prompt guidance is an img2img pre-pass, not true text
  conditioning.
- CogVideoX-2B at 30 steps on 16 GB is slow (several minutes); it is offloaded by
  design. A 24 GB card can set *VRAM policy* to `off` for the fast path.
- The GIF is a palette conversion of the RGB frames (Pillow); the MP4 keeps full
  colour.
- The tab appears only for the PC UI; SD Lite has its own Video screen.
