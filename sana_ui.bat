@echo off
REM ============================================================
REM  SANA Gradio UI Launcher
REM  Runs sana_workflow/ui.py on the root .venv (diffusers backend)
REM ============================================================
REM
REM USAGE:
REM   sana_ui.bat                -> http://127.0.0.1:7861
REM   sana_ui.bat --port 7862
REM   sana_ui.bat --share        -> public gradio.live link
REM
REM NOTES:
REM   - Model downloads go through hf-mirror (HF_ENDPOINT below).
REM   - First generation triggers model load; keep the window open.
REM ============================================================

setlocal

set SCRIPT_DIR=%~dp0
set VENV_PYTHON=%SCRIPT_DIR%.venv\Scripts\python.exe
set WORKFLOW=%SCRIPT_DIR%sana_workflow\ui.py

REM HuggingFace access via local proxy (verified working on this machine)
set HTTP_PROXY=http://127.0.0.1:7897
set HTTPS_PROXY=http://127.0.0.1:7897
REM ---- alternative: hf-mirror (comment proxy lines above, uncomment below) ----
REM set HF_ENDPOINT=https://hf-mirror.com

"%VENV_PYTHON%" "%WORKFLOW%" %*
