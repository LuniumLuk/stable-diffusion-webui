@echo off
REM ============================================================
REM  lora_data_maker.bat -- LoRA dataset maker (no prompt files)
REM  Runs gemini_workflow\lora_data_maker.py on the workflow venv.
REM ============================================================
REM
REM FOR CHARACTER LORAS USE lora_dataset_builder.bat INSTEAD:
REM   it makes one full-resolution image per API call (no contact-sheet
REM   cutting, so no ~580px tiles), covers full body / back / side views,
REM   verifies every image automatically and writes the captions itself.
REM   See README_lora_dataset_builder.md. This script still works and is
REM   kept for sheet-style multi-image variation runs.
REM
REM USAGE:
REM   lora_data_maker.bat --avatar .\tmp\img_chara_rana.png
REM
REM   avatar alone        -> 3x4 face grid        -> 12 expression images
REM
REM VARIATIONS:
REM   --num N               repeat the whole plan N times (default 1), so each
REM                         scheme yields N sheets. --variations N still works
REM                         as an alias. With the default config --num 3 gives
REM                         3 x (12 + 9) = 63 images, every repeat resampling
REM                         panels/styles.
REM
REM   lora_data_maker.bat --avatar .\tmp\img_chara_rana.png --num 3
REM
REM  OUTFIT (upper/fullbody) SHEETS ARE OFF BY DEFAULT: outfit_tasks in the
REM  YAML config ships empty, so only the avatar -> portrait grids above are
REM  generated and --fullbody is ignored (with a note). To re-enable, add
REM  'outfit_tasks' entries (kind: upper|fullbody, grid, aspect, size); then
REM  each fullbody picture adds one upper + one fullbody set again.
REM
REM Sheet schemes (grid x aspect x size), style/scene randomization and
REM weights are all driven by config_states\lora_data_maker.yaml:
REM   avatar_tasks (face grids)  /  outfit_tasks (upper + fullbody grids)
REM Each PANEL of a sheet gets its own random art style + optional random
REM background scene (weighted). Pin styles with --style TAG, reproduce
REM with --seed N.
REM BACKGROUND: pure white (#FFFFFF) in every panel by default - scene
REM randomization is off in the config. Set randomize_panel_scene: true to
REM bring back the per-panel scene/background variation.
REM
REM MAIN STYLE REFERENCE (optional):
REM   --main-style IMG [IMG ...]   one or more art-style reference images,
REM                                usually multi-character illustrations.
REM                                They are attached for the ART STYLE only:
REM                                the prompt explicitly forbids copying their
REM                                characters, faces, outfits and poses.
REM   --main-style-perc N          0-100, default 75: the share of generated
REM                                panels that follow that reference. The rest
REM                                keep the random/pinned styles, so the LoRA
REM                                still sees some style variation.
REM
REM   lora_data_maker.bat --avatar .\tmp\img_chara_rana.png ^
REM     --main-style .\tmp\style_ref.png --main-style-perc 75
REM
REM CUSTOM REQUIREMENTS (optional):
REM   --desc "TEXT"        injects a high-priority USER REQUIREMENTS section
REM                        into every sheet prompt (e.g. clothing details,
REM                        expression rules, or a background you want instead
REM                        of the pure white default). Repeat the flag for
REM                        several points, or write a literal \n between them
REM                        on one line. A REAL newline would break the .bat
REM                        command line, so never paste one in.
REM
REM   lora_data_maker.bat --avatar .\tmp\img_chara_rana.png ^
REM     --desc "she wears a navy sailor uniform" ^
REM     --desc "keep her red hair ribbon on the left side"
REM
REM   lora_data_maker.bat --avatar ... --dry-run                     (plan only)
REM   lora_data_maker.bat --selftest                                (offline check)
REM   lora_data_maker.bat --avatar ... --captions                   (add .txt tags)
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
