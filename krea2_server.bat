@echo off
REM ============================================================
REM  Krea 2 (GGUF) server launcher - stable-diffusion.cpp
REM  Serves the embedded sd.cpp web UI + A1111-compatible API.
REM ============================================================
REM
REM USAGE:
REM   krea2_server.bat                     -> http://127.0.0.1:7864/
REM   krea2_server.bat --listen-port 9999  -> custom port
REM
REM NOTES:
REM   - Model files live in models\Krea-2\ (Krea2 DiT GGUF + Qwen3-VL-4B
REM     text encoder + Wan 2.1 VAE).
REM   - Default weights: Krea 2 Turbo Edit v1.1 uncensored Q4_K_M (GGUF, baked-in
REM     NSFW refusal-reduction LoRAs; ~14s @1024, ~22s @1024x1536 on RTX 5070 Ti);
REM     fallbacks: same merge Q6_K, then official Krea-2-Turbo Q6_K.
REM   - Krea 2 Turbo is distilled: 8 steps at CFG 1.0.
REM   - Reference-image editing (community edit LoRAs): the mmproj vision
REM     projector + "krea2_edit" preset below enable -r refs / API ref_images.
REM   - First run loads ~12.5GB of weights from disk; keep the window open.
REM   - The WebUI tab "Krea 2" can start/stop this server.
REM ============================================================

setlocal

set SCRIPT_DIR=%~dp0
set SD_CPP=%SCRIPT_DIR%sd_cpp
set MODELS=%SCRIPT_DIR%models\Krea-2

set MODEL=%MODELS%\diffusion_models\Krea2_turbo_uncensored_edit_v1.1-Q4_K_M.gguf
if not exist "%MODEL%" set MODEL=%MODELS%\diffusion_models\Krea2_turbo_uncensored_edit-v1.1-Q6_K.gguf
if not exist "%MODEL%" set MODEL=%MODELS%\diffusion_models\Krea-2-Turbo-Q6_K.gguf

"%SD_CPP%\sd-server.exe" ^
  --diffusion-model "%MODEL%" ^
  --vae "%MODELS%\vae\wan_2.1_vae.safetensors" ^
  --llm "%MODELS%\text_encoders\Qwen3VL-4B-Instruct-Q4_K_M.gguf" ^
  --llm_vision "%MODELS%\text_encoders\mmproj-Qwen3VL-4B-Instruct-F16.gguf" ^
  --ref-image-args "preset=krea2_edit" ^
  --steps 8 --cfg-scale 1.0 --sampling-method euler ^
  --diffusion-fa --vae-tiling --vae-tile-size 64x64 ^
  --params-backend "te=cpu,vae=cpu" ^
  --listen-ip 127.0.0.1 --listen-port 7864 %*
