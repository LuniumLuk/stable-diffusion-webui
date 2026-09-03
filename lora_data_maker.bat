@echo off
REM ============================================================
REM  lora_data_maker.bat -- LoRA dataset maker (no prompt files)
REM  Runs gemini_workflow\lora_data_maker.py on the workflow venv.
REM ============================================================
REM
REM USAGE:
REM   lora_data_maker.bat --avatar .\tmp\img_chara_rana.png ^
REM     --fullbody .\tmp\body_rana.png .\tmp\outfit_b.png .\tmp\outfit_c.png
REM
REM   avatar alone        -> 3x4 face grid        -> 12 expression images
REM   avatar + fullbody N -> 3x4 upper + 3x4 fullbody grids -> 24 images
REM   (one upper set + one fullbody set per fullbody picture)
REM
REM Sheet schemes (grid x aspect x size), style/scene randomization and
REM weights are all driven by config_states\lora_data_maker.yaml:
REM   avatar_tasks (face grids)  /  outfit_tasks (upper + fullbody grids)
REM Each PANEL of a sheet gets its own random art style + optional random
REM background scene (weighted). Pin styles with --style TAG, reproduce
REM with --seed N.
REM
REM   lora_data_maker.bat --avatar ... --fullbody ... --dry-run  (plan only)
REM   lora_data_maker.bat --selftest                            (offline check)
REM   lora_data_maker.bat --avatar ... --fullbody ... --captions (add .txt tags)
REM
REM RESULT: training_data\lora_<trigger>\  (flat folder of images only)
REM RAW   : outputs\lora_data_maker\YYYY-MM-DD\HHMMSS\ (sheets + manifest)
REM
REM API KEY: GEMINI_API_KEY env, or config_states\gemini_nano_banana.txt
REM ============================================================

setlocal

set SCRIPT_DIR=%~dp0
set WORKFLOW_PYTHON=%SCRIPT_DIR%gemini_workflow\venv\Scripts\python.exe
set WORKFLOW=%SCRIPT_DIR%gemini_workflow\lora_data_maker.py

"%WORKFLOW_PYTHON%" "%WORKFLOW%" %*

endlocal & exit /b %errorlevel%
