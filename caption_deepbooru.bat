@echo off
REM ============================================================
REM  DeepDanbooru Captioning Launcher
REM  Runs kohya_ss/caption_deepbooru.py using the root .venv Python
REM ============================================================
REM
REM USAGE:
REM   caption_deepbooru.bat <image_dir> [options]
REM
REM   All arguments are forwarded directly to caption_deepbooru.py.
REM   Run with --help to see the full option list:
REM     caption_deepbooru.bat --help
REM
REM QUICK EXAMPLES:
REM   caption_deepbooru.bat .\data\characters\1_nezukojiro\ --threshold 0.5 --prefix "wakakimi, nezu kojirou, 1boy, "
REM   caption_deepbooru.bat .\data\characters\1_nezukojiro\ --threshold 0.5 --prefix "wakakimi, nezu kojirou, 1boy, " --exclude "bad anatomy, lowres, ugly"
REM   caption_deepbooru.bat D:\dataset --recursive --skip-existing --exclude "signature, watermark"
REM
REM NOTES:
REM   - Deduplication of repeated tags is ON by default. Use --no-dedup to disable.
REM   - --filter excludes tags at model-inference level (before assembly).
REM   - --exclude removes keywords from the FINAL assembled caption (case-insensitive).
REM   - Captions are written as .txt sidecars next to each image.
REM ============================================================

setlocal

set SCRIPT_DIR=%~dp0
set VENV_PYTHON=%SCRIPT_DIR%.venv\Scripts\python.exe
set CAPTION_SCRIPT=%SCRIPT_DIR%kohya_ss\caption_deepbooru.py

REM --- Check that the Python script exists ---
if not exist "%CAPTION_SCRIPT%" (
    echo ERROR: caption_deepbooru.py not found at: %CAPTION_SCRIPT%
    exit /b 1
)

REM --- Check that .venv Python exists ---
if not exist "%VENV_PYTHON%" (
    echo ERROR: .venv Python not found at: %VENV_PYTHON%
    echo Please ensure the virtual environment is set up in the project root.
    exit /b 1
)

REM --- Forward all arguments to the Python script ---
"%VENV_PYTHON%" "%CAPTION_SCRIPT%" %*

exit /b %ERRORLEVEL%
