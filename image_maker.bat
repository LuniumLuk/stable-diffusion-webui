@echo off
REM ============================================================
REM  Gemini "Image Maker" workflow launcher
REM  Runs gemini_workflow\image_maker.py on the workflow venv
REM  (google-genai SDK; independent of the webui root venv).
REM ============================================================
REM
REM USAGE:
REM   image_maker.bat --prompt-file prompt.txt
REM   image_maker.bat --prompt-file prompt.txt --variations 2
REM   image_maker.bat --prompt-file prompt.txt --ref-images refs\char.png refs\style.png
REM   image_maker.bat --prompt-file prompt.txt --variations 3 --aspect-ratio 16:9 --image-size 1K
REM   image_maker.bat --prompt-file prompt.txt --image-model gemini-3.1-flash-image --retries 5
REM
REM Unlike comic_maker.bat, the prompt file is used DIRECTLY as the image
REM prompt (no txt2txt page expansion). --ref-images (optional) attaches
REM reference image files to the prompt for editing / style transfer.
REM
REM API KEY: GEMINI_API_KEY env, or config_states\gemini_nano_banana.txt
REM OUTPUT:  outputs\image_maker\YYYY-MM-DD\HHMMSS\  (image_vNN.png + image_prompt.txt)
REM ============================================================

setlocal

set SCRIPT_DIR=%~dp0
set WORKFLOW_PYTHON=%SCRIPT_DIR%gemini_workflow\venv\Scripts\python.exe
set WORKFLOW=%SCRIPT_DIR%gemini_workflow\image_maker.py

"%WORKFLOW_PYTHON%" "%WORKFLOW%" %*
