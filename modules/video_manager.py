"""Small, fast anime-oriented video generation for the Video tab.

Three engines, picked because they are the lightest credible open-weight
text/image-to-video models that still run on a single 16 GB card:

* ``animatediff`` - AnimateDiff v1-5-2 motion module (+ AnimateDiff-Lightning for
  4/8 steps) on top of a diffusers-format anime SD1.5 checkpoint.  ~5-7 GB,
  16-32 frames, a clip in seconds.  This is the anime workhorse.
* ``cogvideox`` - THUDM CogVideoX-2B.  ~10-14 GB with CPU offload, 6 second
  480p clips, much stronger prompt following and motion than SD1.5.
* ``svd`` - Stable Video Diffusion XT, image-to-video: animate an existing
  anime still.  ~5-9 GB, 14/25 frames at 576p.

Everything runs locally.  No safety checker or prompt filter is loaded or
applied here - the models' own licences govern what you may generate and
redistribute.

VRAM: one engine is cached at a time, and the switch releases the SD
checkpoint and every sd-server sidecar first (see ``modules.vram``).  The
pipeline is dropped again after the job unless the user asked to keep it warm.
"""

from __future__ import annotations

import base64
import dataclasses
import datetime
import io
import os
import random
import threading
import time

from modules import devices, paths, shared

# --------------------------------------------------------------------- layout
ADAPTER_DIR = os.path.join(paths.models_path, "AnimateDiff", "motion-adapter-v1-5-2")
LIGHTNING_DIR = os.path.join(paths.models_path, "AnimateDiff", "lightning")
BASES_DIR = os.path.join(paths.models_path, "Video", "bases")
COGVIDEO_DIR = os.path.join(paths.models_path, "Video", "CogVideoX-2b")
SVD_DIR = os.path.join(paths.models_path, "Video", "Stable-Video-Diffusion")
LTX_DIR = os.path.join(paths.models_path, "Video", "LTX-Video")
OUTPUT_DIR = os.path.join(paths.data_path, "outputs", "video")

ENGINE_IDS = ("animatediff", "cogvideox", "svd", "ltx")

ENGINE_INFO = {
    "animatediff": {
        "title": "AnimateDiff · Lightning (anime SD1.5)",
        "blurb": "Fast anime loops on an SD1.5 checkpoint. 4-step Lightning, 16-32 frames, ~5-7 GB.",
        "modes": ("t2v",),
    },
    "cogvideox": {
        "title": "CogVideoX-2B",
        "blurb": "6 second 480p clips, best prompt following. Needs CPU offload on 16 GB; slow.",
        "modes": ("t2v",),
    },
    "svd": {
        "title": "Stable Video Diffusion XT (image → video)",
        "blurb": "Animates a still image: 14 or 25 frames at 576p. Give it an anime picture.",
        "modes": ("i2v",),
    },
    "ltx": {
        "title": "LTX-Video 2B (image + prompt)",
        "blurb": "One model for text→video and image+prompt→video: 2B, 30 steps, 512-768p. Needs CPU offload on 16 GB.",
        "modes": ("t2v", "i2v"),
    },
}

DEFAULTS = {
    "animatediff": {"width": 512, "height": 512, "frames": 16, "fps": 8, "steps": 4, "guidance": 1.5},
    "cogvideox": {"width": 720, "height": 480, "frames": 49, "fps": 8, "steps": 50, "guidance": 6.0},
    "svd": {"width": 1024, "height": 576, "frames": 25, "fps": 7, "steps": 25, "guidance": 1.0},
    "ltx": {"width": 512, "height": 768, "frames": 49, "fps": 12, "steps": 30, "guidance": 3.0},
}


class VideoError(RuntimeError):
    pass


class VideoCancelled(VideoError):
    pass


# --------------------------------------------------------------------- helpers
def _free_gb() -> float:
    try:
        from modules import vram

        free, _total = vram.free_total()
        return free / (1024 ** 3)
    except Exception:
        return 0.0


def _first_existing(*paths_: str) -> str:
    for path in paths_:
        if path and os.path.exists(path):
            return path
    return ""


def _adapter_variant() -> str:
    return "fp16" if os.path.isfile(os.path.join(ADAPTER_DIR, "diffusion_pytorch_model.fp16.safetensors")) else ""


def _lightning_path(which: str) -> str:
    which = (which or "").strip().lower()
    if which in ("", "auto", "none", "off"):
        candidates = ("4", "8", "2", "1")
    else:
        candidates = (which.replace("step", ""),)
    for steps in candidates:
        path = os.path.join(LIGHTNING_DIR, f"animatediff_lightning_{steps}step_diffusers.safetensors")
        if os.path.isfile(path):
            return path
    return ""


def _lightning_choices() -> list[str]:
    found = []
    for steps in ("4", "8", "2", "1"):
        if os.path.isfile(os.path.join(LIGHTNING_DIR, f"animatediff_lightning_{steps}step_diffusers.safetensors")):
            found.append(f"{steps}step")
    return found


def lightning_choices() -> list[str]:
    """Public alias for the UI (a job may run while the tab is built)."""
    return _lightning_choices()


def list_bases() -> list[dict]:
    """Diffusers-format SD1.5 checkpoints usable by the AnimateDiff engine."""
    bases = []
    if not os.path.isdir(BASES_DIR):
        return bases
    for name in sorted(os.listdir(BASES_DIR)):
        folder = os.path.join(BASES_DIR, name)
        if not os.path.isdir(folder):
            continue
        if not os.path.isfile(os.path.join(folder, "model_index.json")):
            continue
        if not os.path.isfile(os.path.join(folder, "unet", "config.json")):
            continue
        bases.append({"path": folder, "title": name})
    return bases


def default_base() -> str:
    bases = list_bases()
    return bases[0]["path"] if bases else ""


def _missing(engine: str) -> list[str]:
    missing = []
    if engine == "animatediff":
        if not os.path.isfile(os.path.join(ADAPTER_DIR, "config.json")):
            missing.append(os.path.join(ADAPTER_DIR, "config.json"))
        if not _first_existing(
            os.path.join(ADAPTER_DIR, "diffusion_pytorch_model.fp16.safetensors"),
            os.path.join(ADAPTER_DIR, "diffusion_pytorch_model.safetensors"),
        ):
            missing.append(os.path.join(ADAPTER_DIR, "diffusion_pytorch_model.safetensors"))
        if not _lightning_path("auto"):
            missing.append(os.path.join(LIGHTNING_DIR, "animatediff_lightning_4step_diffusers.safetensors"))
        if not list_bases():
            missing.append(os.path.join(BASES_DIR, "<anime SD1.5 diffusers folder>"))
    elif engine == "cogvideox":
        for rel in ("model_index.json", "transformer/config.json", "transformer/diffusion_pytorch_model.safetensors",
                    "text_encoder/config.json", "text_encoder/model.safetensors.index.json",
                    "tokenizer/spiece.model", "vae/config.json", "scheduler/scheduler_config.json"):
            if not os.path.isfile(os.path.join(COGVIDEO_DIR, rel)):
                missing.append(os.path.join(COGVIDEO_DIR, rel))
    elif engine == "svd":
        for rel in ("model_index.json", "unet/config.json", "unet/diffusion_pytorch_model.fp16.safetensors",
                    "vae/config.json", "vae/diffusion_pytorch_model.fp16.safetensors",
                    "image_encoder/config.json", "scheduler/scheduler_config.json"):
            if not os.path.isfile(os.path.join(SVD_DIR, rel)):
                missing.append(os.path.join(SVD_DIR, rel))
    elif engine == "ltx":
        merged = os.path.join(LTX_DIR, "transformer", "diffusion_pytorch_model.safetensors")
        shards = [
            os.path.join(LTX_DIR, "transformer", f"diffusion_pytorch_model-0000{index}-of-00002.safetensors")
            for index in (1, 2)
        ]
        needed = ["scheduler/scheduler_config.json", "tokenizer/spiece.model", "transformer/config.json",
                  "vae/config.json", "vae/diffusion_pytorch_model.safetensors"]
        for rel in needed:
            if not os.path.isfile(os.path.join(LTX_DIR, rel)):
                missing.append(os.path.join(LTX_DIR, rel))
        index_file = os.path.join(LTX_DIR, "transformer", "diffusion_pytorch_model.safetensors.index.json")
        if not (os.path.isfile(merged) or (os.path.isfile(index_file) and all(map(os.path.isfile, shards)))):
            missing.append(merged)
        if not _ltx_text_encoder()[0]:
            missing.append(os.path.join(LTX_DIR, "text_encoder", "config.json"))
    return missing


def _ltx_text_encoder() -> tuple[str, str]:
    """Directory + subfolder holding the T5-XXL encoder (LTX's own or CogVideoX's)."""
    for root in (LTX_DIR, COGVIDEO_DIR):
        if os.path.isfile(os.path.join(root, "text_encoder", "config.json")):
            return root, "text_encoder"
    return "", ""


def install_hint(engine: str) -> str:
    if engine == "animatediff":
        return (
            "python scripts/download_video_models.py animatediff\n"
            "  -> AnimateDiff/motion-adapter-v1-5-2, AnimateDiff/lightning and Video/bases/AnyLoRA"
        )
    if engine == "cogvideox":
        return "python scripts/download_video_models.py cogvideox  -> Video/CogVideoX-2b (~13 GB)"
    if engine == "ltx":
        return (
            "python scripts/download_video_models.py ltx  -> Video/LTX-Video (~9 GB; reuses the "
            "CogVideoX T5 if installed, otherwise add Video/LTX-Video/text_encoder)"
        )
    return "python scripts/download_video_models.py svd  -> Video/Stable-Video-Diffusion (~4.3 GB)"


def _clamp(value, low, high):
    try:
        value = int(value)
    except (TypeError, ValueError):
        value = low
    return max(low, min(high, value))


def _clamp_dim(value, low=256, high=1024, step=8):
    value = _clamp(value, low, high)
    return max(low, int(round(value / step)) * step)


def _frames_for(engine: str, frames) -> int:
    frames = _clamp(frames, 8, 49)
    if engine == "svd":
        # SVD-XT ships two temporal buckets; anything else is resampled badly.
        return 14 if frames < 20 else 25
    if engine == "animatediff":
        # the v1-5-2 motion module was trained on 16 frames in strides of 4
        frames = _clamp(frames, 8, 32)
        return max(8, frames - frames % 4)
    if engine == "ltx":
        # LTX compresses time by 8 -> valid lengths are 8k + 1
        frames = 8 * ((frames - 1) // 8) + 1
        return _clamp(frames, 9, 49)
    # CogVideoX compresses time by 4 -> valid lengths are 4k + 1
    frames = 4 * ((frames - 1) // 4) + 1
    return _clamp(frames, 9, 49)


# --------------------------------------------------------------------- request
@dataclasses.dataclass
class VideoRequest:
    engine: str = "animatediff"
    prompt: str = ""
    negative_prompt: str = ""
    width: int = 512
    height: int = 512
    frames: int = 16
    fps: int = 8
    steps: int = 4
    guidance: float = 1.5
    seed: int = -1
    base: str = ""
    lightning: str = "auto"
    offload: str = "auto"
    decode_chunk: int = 8
    motion_bucket_id: int = 127
    noise_aug_strength: float = 0.02
    init_image: str = ""
    refine: float = 0.25
    pingpong: bool = False
    save_mp4: bool = True
    task_id: str = ""

    def cache_key(self) -> tuple:
        mode = "i2v" if self.init_image else "t2v"
        return (self.engine, os.path.abspath(self.base) if self.base else "", self.lightning, self.offload, mode)


def parse_request(payload: dict) -> VideoRequest:
    payload = dict(payload or {})
    engine = str(payload.get("engine") or "animatediff").strip().lower()
    if engine not in ENGINE_IDS:
        raise VideoError(f"unknown engine {engine!r}; expected one of {', '.join(ENGINE_IDS)}")

    req = VideoRequest(engine=engine)
    req.prompt = str(payload.get("prompt") or "").strip()
    req.negative_prompt = str(payload.get("negative_prompt") or "").strip()
    req.seed = _clamp(payload.get("seed", -1), -1, 2 ** 31 - 1)
    if payload.get("seed") in (None, ""):
        req.seed = -1

    defaults = DEFAULTS[engine]
    step = {"cogvideox": 16, "ltx": 32}.get(engine, 8)  # CogVideoX 2x2 patches / LTX 32 px VAE
    req.width = _clamp_dim(payload.get("width", defaults["width"]), step=step)
    req.height = _clamp_dim(payload.get("height", defaults["height"]), step=step)
    if engine == "svd":
        # SVD was trained at one aspect; keep the closest orientation.
        req.width, req.height = (1024, 576) if req.width >= req.height else (576, 1024)
    req.frames = _frames_for(engine, payload.get("frames", defaults["frames"]))
    req.fps = _clamp(payload.get("fps", defaults["fps"]), 1, 30)
    req.steps = _clamp(payload.get("steps", defaults["steps"]), 1, 100)
    try:
        req.guidance = max(1.0, min(20.0, float(payload.get("guidance", defaults["guidance"]))))
    except (TypeError, ValueError):
        req.guidance = float(defaults["guidance"])

    req.base = str(payload.get("base") or "").strip()
    if engine == "animatediff" and not req.base:
        req.base = default_base()
    req.lightning = str(payload.get("lightning") or "auto").strip().lower()
    req.offload = str(payload.get("offload") or getattr(shared.opts, "video_offload", "auto")).strip().lower()
    if req.offload not in ("auto", "on", "off"):
        req.offload = "auto"
    req.decode_chunk = _clamp(payload.get("decode_chunk", 8), 1, 24)
    req.motion_bucket_id = _clamp(payload.get("motion_bucket_id", 127), 1, 255)
    try:
        req.noise_aug_strength = max(0.0, min(1.0, float(payload.get("noise_aug_strength", 0.02))))
    except (TypeError, ValueError):
        req.noise_aug_strength = 0.02
    req.init_image = str(payload.get("init_image") or "").strip()
    try:
        req.refine = max(0.0, min(0.9, float(payload.get("refine", 0.25))))
    except (TypeError, ValueError):
        req.refine = 0.25
    req.pingpong = bool(payload.get("pingpong", False))
    req.save_mp4 = bool(payload.get("save_mp4", True))
    req.task_id = str(payload.get("task_id") or "").strip()

    if not req.prompt and engine != "svd":
        raise VideoError("a prompt is required")
    if engine == "svd" and not req.init_image:
        raise VideoError("SVD needs an init image (choose one on the Video tab)")
    if engine == "svd" and not req.prompt:
        req.refine = 0.0  # nothing to guide with
    return req


# ------------------------------------------------------------------- pipelines
def _offload(req: VideoRequest, need_gb: float) -> bool:
    if req.offload == "on":
        return True
    if req.offload == "off":
        return False
    return _free_gb() < need_gb


def _load_pil(source: str):
    from PIL import Image

    if not source:
        raise VideoError("an init image is required")
    if source.startswith("data:"):
        _header, _, encoded = source.partition(",")
        try:
            return Image.open(io.BytesIO(base64.b64decode(encoded))).convert("RGB")
        except Exception as error:
            raise VideoError(f"could not decode the init image: {error}") from error
    if not os.path.isfile(source):
        raise VideoError(f"init image not found: {source}")
    return Image.open(source).convert("RGB")


def _fit(image, width: int, height: int):
    from PIL import Image

    scale = max(width / max(1, image.width), height / max(1, image.height))
    resized = image.resize((max(1, round(image.width * scale)), max(1, round(image.height * scale))), Image.LANCZOS)
    left = max(0, (resized.width - width) // 2)
    top = max(0, (resized.height - height) // 2)
    return resized.crop((left, top, left + width, top + height))


def _refine_init(image, req: "VideoRequest", progress):
    """Nudge an init image toward the prompt before SVD animates it.

    SVD is image-conditioned only; a low-strength SD1.5 img2img pass is the cheapest
    way to honour the prompt without a second large model.  Same AnyLoRA base as the
    AnimateDiff engine, ~3 s, and the refiner is dropped before SVD samples so the
    two never rent VRAM at the same time during sampling.
    """
    import torch
    from diffusers import StableDiffusionImg2ImgPipeline
    from PIL import Image

    progress("prompt-refining the init image")
    base = default_base()
    if not base:
        raise VideoError(
            f"prompt guidance needs an SD1.5 base under {BASES_DIR}; install AnyLoRA "
            "(scripts/download_video_models.py animatediff) or set Prompt guidance to 0"
        )
    # SD1.5 is trained around 512 px; refine at <=768 on the long side, then SVD resizes
    scale = min(1.0, 768 / max(1, max(image.width, image.height)))
    target = (
        max(64, round(image.width * scale / 8) * 8),
        max(64, round(image.height * scale / 8) * 8),
    )
    small = image.resize(target, Image.LANCZOS)

    refiner = StableDiffusionImg2ImgPipeline.from_pretrained(
        base,
        torch_dtype=torch.float16,
        variant="fp16",
        safety_checker=None,
        requires_safety_checker=False,
    )
    refiner.set_progress_bar_config(disable=True)
    try:
        refiner.enable_vae_slicing()
        if _offload(req, need_gb=7.0):
            refiner.enable_model_cpu_offload()
        else:
            refiner.to(devices.device)
        refined = refiner(
            prompt=req.prompt,
            negative_prompt=req.negative_prompt or None,
            image=small,
            strength=req.refine,
            guidance_scale=6.5,
            num_inference_steps=20,
            generator=torch_generator(req.seed),
        ).images[0]
    finally:
        del refiner
        devices.torch_gc()
    return _fit(refined, req.width, req.height)


class _Engine:
    id = ""

    def __init__(self):
        self.pipe = None

    def load(self, req, progress):
        raise NotImplementedError

    def unload(self):
        pipe, self.pipe = self.pipe, None
        if pipe is not None:
            try:
                pipe.remove_all_hooks()
            except Exception:
                pass
            del pipe
        devices.torch_gc()


class AnimateDiffEngine(_Engine):
    id = "animatediff"

    def load(self, req, progress):
        import torch
        from diffusers import AnimateDiffPipeline, EulerDiscreteScheduler, MotionAdapter
        from safetensors.torch import load_file

        base = req.base or default_base()
        if not base or not os.path.isdir(base):
            raise VideoError(f"no SD1.5 base found under {BASES_DIR}")

        # Lightning is the only motion module that survives diffusers 0.32's config
        # remap: the original v1-5-2 adapter's GEGLU setting is dropped and the
        # denoiser collapses to a dark frame. Lightning ships diffusers-native weights.
        lightning = _lightning_path(req.lightning)
        if not lightning:
            raise VideoError(
                "AnimateDiff needs an AnimateDiff-Lightning module; install "
                "animatediff_lightning_4step_diffusers.safetensors under "
                f"{LIGHTNING_DIR} (scripts/download_video_models.py animatediff)"
            )

        progress("loading motion adapter")
        adapter_kwargs = {"torch_dtype": torch.float16}
        variant = _adapter_variant()
        if variant:
            adapter_kwargs["variant"] = variant
        adapter = MotionAdapter.from_pretrained(ADAPTER_DIR, **adapter_kwargs)
        progress(f"loading {os.path.basename(base)}")
        pipe = AnimateDiffPipeline.from_pretrained(
            base,
            motion_adapter=adapter,
            torch_dtype=torch.float16,
            variant="fp16",
        )
        # the Lightning recipe: Euler with trailing timesteps and the linear betas
        pipe.scheduler = EulerDiscreteScheduler.from_config(
            pipe.scheduler.config,
            beta_schedule="linear",
            timestep_spacing="trailing",
        )

        progress(f"applying {os.path.basename(lightning)}")
        state = load_file(lightning, device="cpu")
        missing, unexpected = pipe.unet.load_state_dict(state, strict=False)
        if unexpected:
            print(f"video: Lightning state dict mismatch (unexpected {len(unexpected)})")
        if len(missing) == len(pipe.unet.state_dict()) - len(state):
            print(f"video: applied {len(state)} Lightning tensors, base UNet kept ({len(missing)} tensors)")

        pipe.set_progress_bar_config(disable=True)
        pipe.enable_vae_slicing()
        pipe.enable_vae_tiling()
        if _offload(req, need_gb=6.5):
            progress("CPU offload enabled")
            pipe.enable_model_cpu_offload()
        else:
            pipe.to(devices.device)
        self.pipe = pipe

    def generate(self, req, progress, cancel):
        steps = req.steps
        generator = torch_generator(req.seed)

        def on_step(_pipe, index, _timestep, kwargs):
            if cancel():
                raise VideoCancelled("cancelled")
            progress("sampling", index + 1, steps)
            return kwargs

        result = self.pipe(
            prompt=req.prompt,
            negative_prompt=req.negative_prompt or None,
            num_frames=req.frames,
            height=req.height,
            width=req.width,
            num_inference_steps=steps,
            guidance_scale=req.guidance,
            generator=generator,
            output_type="pil",
            callback_on_step_end=on_step,
        )
        return result.frames[0]


class CogVideoXEngine(_Engine):
    id = "cogvideox"

    def load(self, req, progress):
        import torch
        from diffusers import CogVideoXPipeline

        progress("loading CogVideoX-2B (bf16)")
        pipe = CogVideoXPipeline.from_pretrained(COGVIDEO_DIR, torch_dtype=torch.bfloat16)
        pipe.set_progress_bar_config(disable=True)
        try:
            pipe.vae.enable_tiling()
            pipe.vae.enable_slicing()
        except Exception:
            pass
        # 13 GB of weights + activations never fit next to anything else on 16 GB:
        # auto offloads unless the card is big enough to hold the whole pipeline
        if _offload(req, need_gb=16.0):
            progress("CPU offload enabled")
            pipe.enable_model_cpu_offload()
        else:
            pipe.to(devices.device)
        self.pipe = pipe

    def generate(self, req, progress, cancel):
        steps = req.steps
        generator = torch_generator(req.seed)

        def on_step(_pipe, index, _timestep, kwargs):
            if cancel():
                raise VideoCancelled("cancelled")
            progress("sampling", index + 1, steps)
            return kwargs

        result = self.pipe(
            prompt=req.prompt,
            negative_prompt=req.negative_prompt or None,
            height=req.height,
            width=req.width,
            num_frames=req.frames,
            num_inference_steps=steps,
            guidance_scale=req.guidance,
            generator=generator,
            output_type="pil",
            callback_on_step_end=on_step,
        )
        return result.frames[0]


class SvdEngine(_Engine):
    id = "svd"

    def load(self, req, progress):
        from diffusers import StableVideoDiffusionPipeline
        import torch

        progress("loading SVD-XT (fp16)")
        pipe = StableVideoDiffusionPipeline.from_pretrained(SVD_DIR, torch_dtype=torch.float16, variant="fp16")
        pipe.set_progress_bar_config(disable=True)
        try:
            pipe.unet.enable_forward_chunking()
        except Exception:
            pass
        try:
            pipe.enable_vae_slicing()
        except Exception:
            pass
        if _offload(req, need_gb=9.0):
            progress("CPU offload enabled")
            pipe.enable_model_cpu_offload()
        else:
            pipe.to(devices.device)
        self.pipe = pipe

    def generate(self, req, progress, cancel):
        steps = req.steps
        image = _fit(_load_pil(req.init_image), req.width, req.height)
        if req.refine > 0 and req.prompt:
            if cancel():
                raise VideoCancelled("cancelled")
            image = _refine_init(image, req, progress)
        generator = torch_generator(req.seed)

        def on_step(_pipe, index, _timestep, kwargs):
            if cancel():
                raise VideoCancelled("cancelled")
            progress("sampling", index + 1, steps)
            return kwargs

        result = self.pipe(
            image=image,
            height=req.height,
            width=req.width,
            num_frames=req.frames,
            decode_chunk_size=req.decode_chunk,
            motion_bucket_id=req.motion_bucket_id,
            noise_aug_strength=req.noise_aug_strength,
            num_inference_steps=steps,
            generator=generator,
            output_type="pil",
            callback_on_step_end=on_step,
        )
        return result.frames[0]


def _merge_safetensors_shards(folder: str, prefix: str, total: int, out_name: str) -> None:
    """Concatenate ``<prefix>-0000N-of-0000M.safetensors`` into one checkpoint."""
    from safetensors.torch import load_file, save_file

    merged = {}
    for index in range(1, total + 1):
        shard = os.path.join(folder, f"{prefix}-{index:05d}-of-{total:05d}.safetensors")
        merged.update(load_file(shard))
    tmp = os.path.join(folder, out_name + ".partial")
    save_file(merged, tmp, metadata={"format": "pt"})
    del merged
    os.replace(tmp, os.path.join(folder, out_name))


def _load_ltx_transformer(dtype, progress):
    """Load the LTX transformer, merging its shards first when it is split.

    diffusers 0.32 hands sharded safetensors to ``accelerate.load_checkpoint_and_dispatch``
    with ``force_hooks``, an argument this environment's accelerate (0.21) predates. A
    single-file checkpoint takes the meta-device path instead, so the two shards are
    merged once (~10 s, one extra 7 GB file, the shards stay as the download source).
    """
    from diffusers import LTXVideoTransformer3DModel

    folder = os.path.join(LTX_DIR, "transformer")
    single = os.path.join(folder, "diffusion_pytorch_model.safetensors")
    index = os.path.join(folder, "diffusion_pytorch_model.safetensors.index.json")
    if os.path.isfile(index):
        if not os.path.isfile(single):
            progress("merging LTX transformer shards (one time, ~7 GB)")
            _merge_safetensors_shards(folder, "diffusion_pytorch_model", 2, "diffusion_pytorch_model.safetensors")
        # the index alone forces diffusers onto the sharded (accelerate) path
        os.replace(index, index + ".disabled")
    return LTXVideoTransformer3DModel.from_pretrained(LTX_DIR, subfolder="transformer", torch_dtype=dtype)


class LtxEngine(_Engine):
    """LTX-Video: DiT that takes a prompt and, optionally, a conditioning frame."""

    id = "ltx"

    def load(self, req, progress):
        import torch
        from diffusers import (
            AutoencoderKLLTXVideo,
            FlowMatchEulerDiscreteScheduler,
            LTXImageToVideoPipeline,
            LTXPipeline,
        )
        from transformers import T5EncoderModel, T5TokenizerFast

        te_root, te_sub = _ltx_text_encoder()
        if not te_root:
            raise VideoError(
                "LTX-Video needs a T5-XXL text encoder: install CogVideoX or add "
                f"{os.path.join(LTX_DIR, 'text_encoder')}"
            )

        dtype = torch.bfloat16 if devices.dtype in (torch.float16, torch.bfloat16) else torch.float32
        progress("loading LTX-Video transformer (7.3 GB)")
        transformer = _load_ltx_transformer(dtype, progress)
        progress("loading LTX VAE")
        # the pipeline decodes bf16 latents straight into the VAE, so dtypes must agree
        vae = AutoencoderKLLTXVideo.from_pretrained(LTX_DIR, subfolder="vae", torch_dtype=dtype)
        try:
            vae.enable_tiling()
        except Exception:
            pass
        scheduler = FlowMatchEulerDiscreteScheduler.from_pretrained(LTX_DIR, subfolder="scheduler")
        progress(f"loading T5-XXL text encoder from {te_root}")
        text_encoder = T5EncoderModel.from_pretrained(te_root, subfolder=te_sub, torch_dtype=dtype)
        tokenizer = T5TokenizerFast.from_pretrained(LTX_DIR, subfolder="tokenizer")

        cls = LTXImageToVideoPipeline if req.init_image else LTXPipeline
        pipe = cls(
            scheduler=scheduler,
            vae=vae,
            text_encoder=text_encoder,
            tokenizer=tokenizer,
            transformer=transformer,
        )
        pipe.set_progress_bar_config(disable=True)
        # 7.3 GB transformer + 9.2 GB bf16 T5 + 1.6 GB VAE: never fits beside anything
        if _offload(req, need_gb=18.0):
            progress("CPU offload enabled")
            pipe.enable_model_cpu_offload()
        else:
            pipe.to(devices.device)
        self.pipe = pipe

    def generate(self, req, progress, cancel):
        steps = req.steps
        generator = torch_generator(req.seed)

        def on_step(_pipe, index, _timestep, kwargs):
            if cancel():
                raise VideoCancelled("cancelled")
            progress("sampling", index + 1, steps)
            return kwargs

        kwargs = dict(
            prompt=req.prompt,
            negative_prompt=req.negative_prompt or None,
            height=req.height,
            width=req.width,
            num_frames=req.frames,
            frame_rate=req.fps,
            num_inference_steps=steps,
            guidance_scale=req.guidance,
            generator=generator,
            output_type="pil",
            callback_on_step_end=on_step,
        )
        if req.init_image:
            kwargs["image"] = _fit(_load_pil(req.init_image), req.width, req.height)
        result = self.pipe(**kwargs)
        return result.frames[0]


def torch_generator(seed: int):
    """A zero-based generator on the compute device (CPU mode still works)."""

    import torch

    device = "cuda" if devices.device.type == "cuda" else "cpu"
    generator = torch.Generator(device=device)
    generator.manual_seed(int(seed) & 0x7FFFFFFF)
    return generator


_ENGINE_CLASSES = {
    "animatediff": AnimateDiffEngine,
    "cogvideox": CogVideoXEngine,
    "svd": SvdEngine,
    "ltx": LtxEngine,
}


# ------------------------------------------------------------------ engine cache
_engine_lock = threading.RLock()
_current = {"id": None, "key": None, "instance": None}


def loaded_engine() -> str | None:
    with _engine_lock:
        return _current["id"] if _current["instance"] is not None else None


def unload_engine(reason: str = "") -> bool:
    with _engine_lock:
        instance = _current["instance"]
        _current.update({"id": None, "key": None, "instance": None})
    if instance is None:
        return False
    if reason:
        print(f"video: unloading {instance.id} ({reason})")
    try:
        instance.unload()
    except Exception as error:
        print(f"video: unload failed: {error}")
    devices.torch_gc()
    return True


def _get_engine(req: VideoRequest, progress) -> _Engine:
    with _engine_lock:
        if _current["instance"] is not None and _current["key"] == req.cache_key():
            return _current["instance"]
        unload_engine(reason="engine switch")
        instance = _ENGINE_CLASSES[req.engine]()
        instance.load(req, progress)
        devices.torch_gc()
        _current.update({"id": req.engine, "key": req.cache_key(), "instance": instance})
        return instance


# ---------------------------------------------------------------------- output
def _write_gif(frames, path: str, fps: int, pingpong: bool) -> None:
    from PIL import Image

    sequence = list(frames)
    if pingpong and len(sequence) > 2:
        sequence = sequence + sequence[-2:0:-1]
    duration = max(20, int(round(1000 / max(1, fps))))
    # one shared palette keeps the loop from flickering between frames
    palette = [frame.convert("RGB").quantize(colors=256, method=Image.MEDIANCUT, dither=Image.NONE) for frame in sequence]
    palette[0].save(
        path,
        save_all=True,
        append_images=palette[1:],
        duration=duration,
        loop=0,
        optimize=False,
        disposal=2,
    )


def _write_mp4(frames, path: str, fps: int) -> bool:
    try:
        import imageio.v2 as imageio
        import numpy as np

        imageio.mimsave(
            path,
            [np.asarray(frame.convert("RGB")) for frame in frames],
            fps=fps,
            codec="libx264",
            quality=8,
            macro_block_size=1,
        )
        return True
    except Exception:
        pass
    try:
        import cv2
        import numpy as np

        height, width = frames[0].height, frames[0].width
        writer = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*"mp4v"), fps, (width, height))
        try:
            for frame in frames:
                writer.write(cv2.cvtColor(np.asarray(frame.convert("RGB")), cv2.COLOR_RGB2BGR))
        finally:
            writer.release()
        return os.path.getsize(path) > 0
    except Exception:
        return False


def _save_outputs(frames, req: VideoRequest, seed: int, elapsed: float, released: bool) -> dict:
    stamp = datetime.datetime.now()
    folder = os.path.join(
        OUTPUT_DIR,
        stamp.strftime("%Y-%m-%d"),
        f"{stamp.strftime('%H-%M-%S')}-{req.engine}-{seed}",
    )
    os.makedirs(folder, exist_ok=True)

    stem = f"{req.engine}-{seed}"
    gif_path = os.path.join(folder, f"{stem}.gif")
    frames = [frame.convert("RGB") for frame in frames]
    _write_gif(frames, gif_path, req.fps, req.pingpong)

    mp4_path = os.path.join(folder, f"{stem}.mp4") if req.save_mp4 else ""
    if mp4_path and not _write_mp4(frames, mp4_path, req.fps):
        mp4_path = ""

    preview_path = os.path.join(folder, f"{stem}-frame1.png")
    frames[0].save(preview_path)

    info = {
        "engine": req.engine,
        "prompt": req.prompt,
        "negative_prompt": req.negative_prompt,
        "width": req.width,
        "height": req.height,
        "frames": len(frames),
        "fps": req.fps,
        "steps": req.steps,
        "guidance": req.guidance,
        "seed": seed,
        "pingpong": req.pingpong,
        "base": os.path.basename(req.base) if req.base else "",
        "lightning": req.lightning,
        "offload": req.offload,
        "seconds": round(elapsed, 2),
        "vram_released": released,
    }
    if req.engine == "svd":
        info["motion_bucket_id"] = req.motion_bucket_id
        info["noise_aug_strength"] = req.noise_aug_strength
        info["refine"] = req.refine
    with open(os.path.join(folder, f"{stem}.txt"), "w", encoding="utf-8") as handle:
        for key, value in info.items():
            handle.write(f"{key}: {value}\n")

    return {
        "folder": folder,
        "gif": gif_path,
        "mp4": mp4_path,
        "preview": preview_path,
        "info": info,
    }


# ------------------------------------------------------------------------- job
_job_lock = threading.RLock()
_job = {
    "task_id": None,
    "phase": None,  # idle | loading | generating | saving | done | failed | cancelled
    "engine": None,
    "detail": "",
    "step": 0,
    "steps": 0,
    "started": 0.0,
    "seconds": 0.0,
    "seed": None,
    "error": None,
    "result": None,
}


def _set_job(**fields) -> None:
    with _job_lock:
        _job.update(fields)


def _progress(detail: str, step: int | None = None, total: int | None = None) -> None:
    fields = {"detail": detail}
    if step is not None:
        fields["step"] = step
    if total is not None:
        fields["steps"] = total
    _set_job(**fields)
    shared.state.textinfo = f"video: {detail}"


def job_status() -> dict:
    with _job_lock:
        return dict(_job)


def status() -> dict:
    engines = []
    for engine_id in ENGINE_IDS:
        missing = _missing(engine_id)
        engines.append({
            "id": engine_id,
            "title": ENGINE_INFO[engine_id]["title"],
            "blurb": ENGINE_INFO[engine_id]["blurb"],
            "modes": list(ENGINE_INFO[engine_id]["modes"]),
            "installed": not missing,
            "missing": [os.path.relpath(path, paths.models_path) for path in missing],
            "hint": "" if not missing else install_hint(engine_id),
        })
    return {
        "engines": engines,
        "bases": [{"path": base["path"], "title": base["title"]} for base in list_bases()],
        "lightning": _lightning_choices(),
        "defaults": {engine: dict(values) for engine, values in DEFAULTS.items()},
        "loaded": loaded_engine(),
        "job": job_status(),
    }


def busy() -> bool:
    with _job_lock:
        return _job["phase"] in ("loading", "generating", "saving")


def cancel() -> dict:
    if busy():
        shared.state.interrupt()
        return {"ok": True, "message": "cancelling the video job"}
    return {"ok": False, "message": "no video job is running"}


def generate(req: VideoRequest, progress=None) -> dict:
    """Run one video job.  Serialised with A1111 through ``queue_lock``."""
    from modules import vram
    from modules.call_queue import queue_lock

    if busy():
        raise VideoError("a video job is already running")

    with _job_lock:
        if _job["phase"] in ("loading", "generating", "saving"):
            raise VideoError("a video job is already running")
        seed = req.seed if req.seed >= 0 else random.randint(0, 2 ** 31 - 1)
        _job.update({
            "task_id": req.task_id or None,
            "phase": "loading",
            "engine": req.engine,
            "detail": "waiting for the GPU",
            "step": 0,
            "steps": req.steps,
            "started": time.time(),
            "seconds": 0.0,
            "seed": seed,
            "error": None,
            "result": None,
        })

    progress = progress or _progress
    with queue_lock:
        # a previous cancel (or an A1111 interrupt) must not abort this job at step 0
        shared.state.interrupted = False
        shared.state.skipped = False
        vram.claim(vram.VIDEO, reason=f"video ({req.engine})")
        shared.state.begin(job="video")
        started = time.perf_counter()
        try:
            missing = _missing(req.engine)
            if missing:
                raise VideoError(
                    "missing model files: "
                    + ", ".join(os.path.relpath(path, paths.models_path) for path in missing[:4])
                    + (f" (+{len(missing) - 4} more)" if len(missing) > 4 else "")
                    + f". Run: {install_hint(req.engine).splitlines()[0]}"
                )

            _set_job(phase="loading")
            engine = _get_engine(req, progress)

            _set_job(phase="generating")
            progress("sampling", 0, req.steps)
            frames = engine.generate(req, progress, lambda: shared.state.interrupted)
            if not frames:
                raise VideoError("the model returned no frames")

            _set_job(phase="saving")
            progress("encoding GIF/MP4")
            released = bool(getattr(shared.opts, "vram_release_after_video", True))
            result = _save_outputs(frames, req, seed, time.perf_counter() - started, released)
            if released:
                unload_engine(reason="job finished (vram_release_after_video)")
            devices.torch_gc()

            _set_job(
                phase="done",
                detail=f"{len(frames)} frames",
                step=req.steps,
                seconds=round(time.perf_counter() - started, 2),
                result=result,
            )
            return {"ok": True, "seed": seed, **result}
        except VideoCancelled:
            _set_job(phase="cancelled", error="cancelled", seconds=round(time.perf_counter() - started, 2))
            return {"ok": False, "cancelled": True, "error": "cancelled"}
        except Exception as error:
            print(f"video: {req.engine} job failed: {error}")
            _set_job(phase="failed", error=str(error), seconds=round(time.perf_counter() - started, 2))
            return {"ok": False, "error": str(error)}
        finally:
            shared.state.end()
            try:
                # a failed/cancelled job must not leave 5-14 GB parked (usually the
                # reason it failed was VRAM); keep the engine only after a good run
                if (
                    bool(getattr(shared.opts, "vram_release_after_video", True))
                    and job_status()["phase"] in ("failed", "cancelled")
                ):
                    unload_engine(reason="job did not complete")
            except Exception:
                pass
            if not busy():
                shared.state.textinfo = ""
            devices.torch_gc()


# ------------------------------------------------------------------ status view
