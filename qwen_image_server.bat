@echo off
REM ============================================================
REM  Qwen-Image-2.1 (GGUF) server launcher - stable-diffusion.cpp
REM  Serves the embedded sd.cpp web UI + A1111-compatible API.
REM ============================================================
REM
REM USAGE:
REM   qwen_image_server.bat                     -> http://127.0.0.1:7862/
REM   qwen_image_server.bat --listen-port 9999  -> custom port
REM
REM NOTES:
REM   - Models (Q4_K_M DiT + Qwen3VL-8B Q4_K_M text encoder + VAE)
REM     live in models\Qwen-Image-2.1\.
REM   - First run loads ~10GB of weights from disk; keep the window open.
REM   - The WebUI tab "Qwen-Image 2.1" can start/stop this server.
REM ============================================================

setlocal

set SCRIPT_DIR=%~dp0
set SD_CPP=%SCRIPT_DIR%sd_cpp
set MODELS=%SCRIPT_DIR%models\Qwen-Image-2.1

"%SD_CPP%\sd-server.exe" ^
  --diffusion-model "%MODELS%\qwen-image-2.1-Q4_K_M.gguf" ^
  --vae "%MODELS%\vae\qwen_image_2.1_vae_bf16.safetensors" ^
  --llm "%MODELS%\text_encoders\Qwen3VL-8B-Instruct-Q4_K_M.gguf" ^
  --llm_vision "%MODELS%\text_encoders\mmproj-Qwen3VL-8B-Instruct-F16.gguf" ^
  --cfg-scale 6.0 --sampling-method euler ^
  --diffusion-fa --vae-tiling ^
  --listen-ip 127.0.0.1 --listen-port 7862 %*
