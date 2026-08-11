@echo off
REM ============================================================
REM  Gemini "Comic Maker" workflow launcher
REM  Runs gemini_workflow\comic_maker.py on the workflow venv
REM  (google-genai SDK; independent of the webui root venv).
REM ============================================================
REM
REM USAGE:
REM   comic_maker.bat --root-prompt-file story.txt --pages 4
REM   comic_maker.bat --root-prompt-file story.txt --pages 6 --ref-dir refs
REM   comic_maker.bat --root-prompt-file story.txt --pages 4 --ref-images refs\char_a.png refs\style.png
REM   comic_maker.bat --root-prompt-file story.txt --pages 4 --variations 2
REM   comic_maker.bat --root-prompt-file story.txt --pages 4 --text-model gemini-3.1-flash --image-model gemini-3.1-flash-image
REM
REM REFERENCE LAYOUT (--ref-dir, optional):
REM   refs\page1\  a.png  b.png     <- references for page 1
REM   refs\page2\  style.png        <- references for page 2
REM   --ref-images: flat list of image files used for ALL pages (overrides --ref-dir).
REM
REM API KEY: GEMINI_API_KEY env, or config_states\gemini_nano_banana.txt
REM OUTPUT:  outputs\comic_maker\YYYY-MM-DD\HHMMSS\  (page_NN_vVV.png + comic_prompts.txt)
REM ============================================================

setlocal

set SCRIPT_DIR=%~dp0
set WORKFLOW_PYTHON=%SCRIPT_DIR%gemini_workflow\venv\Scripts\python.exe
set WORKFLOW=%SCRIPT_DIR%gemini_workflow\comic_maker.py

"%WORKFLOW_PYTHON%" "%WORKFLOW%" %*
