@echo off
REM ============================================================
REM  Standalone SANA txt2img Launcher
REM  Runs sana_workflow/txt2img.py on the root .venv using
REM  diffusers SanaPipeline (independent of the webui SD pipeline)
REM ============================================================
REM
REM USAGE:
REM   sana_txt2img.bat --prompt "a cyberpunk cat"
REM
REM QUICK EXAMPLES:
REM   sana_txt2img.bat --prompt "a cyberpunk cat with a neon sign" --seed 42
REM   sana_txt2img.bat --prompt "sakura, anime girl" --model sana-1.5-1.6b --steps 20 --cfg 4.5
REM   sana_txt2img.bat --prompt "4k mountain" --model sana-2k --width 2048 --height 2048
REM   sana_txt2img.bat --prompt "fast!" --model sprint-1.6b --steps 2
REM   sana_txt2img.bat --prompt "x" --lora "path\to\lora" --help
REM
REM NOTES:
REM   - Model downloads go through hf-mirror (HF_ENDPOINT below).
REM   - If you prefer direct HuggingFace via the local proxy instead,
REM     comment out the HF_ENDPOINT line and uncomment the proxy lines.
REM   - Output lands in outputs\sana\YYYY-MM-DD\ as PNG + .txt sidecar.
REM ============================================================

setlocal

set SCRIPT_DIR=%~dp0
set VENV_PYTHON=%SCRIPT_DIR%.venv\Scripts\python.exe
set WORKFLOW=%SCRIPT_DIR%sana_workflow\txt2img.py

REM HuggingFace access via local proxy (verified working on this machine)
set HTTP_PROXY=http://127.0.0.1:7897
set HTTPS_PROXY=http://127.0.0.1:7897
REM ---- alternative: hf-mirror (comment proxy lines above, uncomment below) ----
REM set HF_ENDPOINT=https://hf-mirror.com

"%VENV_PYTHON%" "%WORKFLOW%" %*
