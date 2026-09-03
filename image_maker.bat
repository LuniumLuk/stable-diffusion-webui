@echo off
REM ============================================================
REM  image_maker.bat -- merged LoRA data-preparation pipeline
REM  Runs gemini_workflow\image_maker.py on the workflow venv
REM  (google-genai SDK; independent of the webui root venv).
REM ============================================================
REM
REM One entry for the whole LoRA dataset workflow:
REM   plan -> generate character sheet -> split grid -> caption -> collect
REM  into training_data\lora_<trigger>[_<outfit>]\ + manifest.json.
REM
REM USAGE (legacy single stage, still supported):
REM   image_maker.bat --prompt-file .\tmp\lora_face.txt ^
REM     --ref-images .\tmp\images.jpg .\tmp\img_chara_rana.png ^
REM     --variations 1 --grid 3 2 --grid-padding 8 ^
REM     --image-size 2K --aspect-ratio 1:1
REM   image_maker.bat --prompt-file .\tmp\lora_upper.txt ^
REM     --ref-images .\tmp\img_chara_rana.png .\tmp\body_rana.png
REM   image_maker.bat --prompt-file .\tmp\lora_fullbody.txt ^
REM     --ref-images .\tmp\img_chara_rana.png .\tmp\body_rana.png
REM
REM USAGE (merged one-command run, 20 training images per outfit):
REM   image_maker.bat --mode all ^
REM     --avatar .\tmp\img_chara_rana.png ^
REM     --ref-images .\tmp\body_rana.png ^
REM     --outfit casual --outfit-desc "blue sailor uniform, white thighhighs"
REM
REM   image_maker.bat --mode all --dry-run     (plan only, no API calls)
REM   image_maker.bat --selftest               (offline split/parse check)
REM
REM Grids are read from the GRID header of each prompt file when --grid
REM is omitted, so the slice always matches the generated sheet.
REM
REM API KEY: GEMINI_API_KEY env, or config_states\gemini_nano_banana.txt
REM RAW OUT: outputs\image_maker\YYYY-MM-DD\HHMMSS\
REM RESULT : training_data\lora_<trigger>[_<outfit>]\  (images + .txt captions)
REM ============================================================

setlocal

set SCRIPT_DIR=%~dp0
set WORKFLOW_PYTHON=%SCRIPT_DIR%gemini_workflow\venv\Scripts\python.exe
set WORKFLOW=%SCRIPT_DIR%gemini_workflow\image_maker.py

"%WORKFLOW_PYTHON%" "%WORKFLOW%" %*

endlocal & exit /b %errorlevel%
