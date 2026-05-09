# Hires. fix optimization summary: SDP override + VAE decode safeguard

## 1. Quick intro: how Hires. fix works

In txt2img, Hires. fix is a two-phase pipeline:

1. First pass generates a lower-resolution latent/image.
2. Second pass upsamples to a higher target resolution and denoises again (img2img-style) for detail recovery.

In this codebase, the second pass can run as one stage or multiple cascade stages. The expensive part is usually UNet denoising at high resolution, and final image decode (VAE) can also be a peak-memory step.

## 2. Optimization A: Hires-only SDP attention override

### What was changed

A dedicated option was added:

- `hires_force_sdp_attention` (Settings -> Optimizations)

When enabled, Hires second-pass denoising temporarily switches cross-attention to SDP (`sdp - scaled dot product`) and restores the user-selected optimizer after Hires finishes.

### Why it helps

For many cards and model combinations, SDP has better throughput/stability than slower fallback attention backends during high-resolution denoising. Since Hires second pass dominates runtime, improving this section gives the biggest speed-up.

### Why quality is not sacrificed

This changes the attention implementation backend, not the prompt, model weights, seed, denoising strength, or stage schedule. In practice this targets performance path selection rather than generation semantics.

## 3. Optimization B: VAE decode-side safeguard

### What was changed

The temporary Hires SDP override is now restored before final latent decode.

This means:

- Hires denoising still gets the SDP speed benefit.
- Final VAE decode does not inherit the forced SDP path.

### Why it helps

OOM reports at scale 2x were traced to final decode, inside VAE decoder attention, not inside the denoising loop. Keeping SDP forced through final decode could increase peak allocation pressure there. Restoring the original backend before decode reduces that risk.

### Why quality is not sacrificed

This does not alter latent content produced by denoising. It only changes backend selection timing around final decode, preserving the generated result while improving reliability and reducing end-of-pass OOM risk.

## 4. Combined effect

Together, these two fixes target different bottlenecks:

- SDP override: improves Hires denoising performance (the biggest time consumer).
- VAE safeguard: avoids decoder-side peak-memory failures at the end.

Result: faster Hires runs with better completion stability, without changing user-visible generation intent.

## 5. Where this is implemented

- Hires pass logic and restore timing: `modules/processing.py`
- Option definition: `modules/shared_options.py`
- Attention implementations: `modules/sd_hijack_optimizations.py`
