@echo off
REM ============================================================
REM  Google Gemini "Nano Banana" image generation Launcher
REM  Calls scripts\gemini_nano_banana.py (CLI) on the root .venv.
REM  The Gemini API call itself runs in a separate workflow venv
REM  (gemini_workflow\venv) so the webui dependency pins are safe.
REM ============================================================
REM
REM USAGE:
REM   gemini_nano_banana.bat --prompt "a cyberpunk cat"
REM   gemini_nano_banana.bat --prompt "sakura, anime girl" --model gemini-3.1-flash-image
REM   gemini_nano_banana.bat --prompt "4k mountain" --aspect-ratio 16:9 --image-size 2K
REM
REM API KEY:
REM   Set GEMINI_API_KEY env var, or pass --api-key "KEY".
REM   Get one at https://aistudio.google.com/apikey
REM
REM OUTPUT:
REM   outputs\nano-banana\YYYY-MM-DD\ as PNG + .txt sidecar.
REM ============================================================

setlocal

set SCRIPT_DIR=%~dp0
set VENV_PYTHON=%SCRIPT_DIR%.venv\Scripts\python.exe
set SCRIPT=%SCRIPT_DIR%scripts\gemini_nano_banana.py

"%VENV_PYTHON%" "%SCRIPT%" %*
