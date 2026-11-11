@echo off
REM ============================================================
REM  lora_dataset_builder.bat -- verified LoRA dataset builder
REM  Runs gemini_workflow\lora_dataset_builder.py on the workflow venv.
REM ============================================================
REM
REM WHY: the old flow (lora_data_maker -> cut contact sheets -> hand-pick ->
REM caption_deepbooru) produced ~580px face-only tiles on pure white, needed
REM a manual delete pass, and captions had to be repaired by hand. This
REM builder makes ONE full-resolution image per call, from an explicit shot
REM plan (face/upper/cowboy/full x front/three-quarter/side/back, mixed
REM backgrounds), then verifies every image and writes the captions itself.
REM
REM USAGE:
REM   lora_dataset_builder.bat --profile mika ^
REM       --face   data\collection\genshin\mika_avatar.png ^
REM       --outfit data\collection\genshin\_refs\mika\character_mika_game.png ^
REM       --out    data\train_data\genshin\mika
REM
REM REFERENCES:
REM   --face IMG [IMG ...]     identity reference(s); the face is copied exactly
REM   --outfit IMG [IMG ...]   outfit reference(s): official art / in-game
REM                            render / figure photo
REM   --no-include-refs        do NOT put the reference images in the dataset
REM                            (they are included by default: real official art
REM                            is the strongest identity anchor a LoRA can get)
REM
REM Fetching official references (writes into data\collection\<game>\_refs):
REM   .venv\Scripts\python.exe tools\fetch_character_refs.py --page Mika ^
REM       --match "^File:Character Mika" --out data\collection\genshin\_refs\mika
REM
REM PLAN / COST:
REM   --shots all|face,upper,cowboy,full   restrict the plan
REM   --max-calls N     hard cap on image-generation calls (default 32). The
REM                     run stops cleanly at the cap, never overruns it.
REM   --retries N       retries per shot on API errors (default 1)
REM   --size 1K|2K      generation size (default 2K; downscaled to the SDXL
REM                     bucket, so detail survives)
REM   --seed N          shuffle the shot order reproducibly
REM   --dry-run         print the full plan, prompts and captions; no API calls
REM   --resume          reuse the shots already in the run folder
REM
REM VERIFICATION (this replaces the manual selection pass):
REM   * local QA (tools\dataset_qa.py, root .venv): decode, size, blur, blank,
REM     left-over white gutter / bad cut, perceptual duplicates.
REM   * judge: the Gemini TEXT model checks every candidate - right character,
REM     one person, what was actually drawn, ahoge visible, outfit correct,
REM     text/watermarks. Text-model calls are NOT image-generation quota.
REM   --no-judge        local QA only
REM   --lenient         ignore ahoge/outfit/style warnings (only hard failures drop)
REM   --min-side N      reject images below N px (default 640)
REM   --blur-threshold N  Laplacian variance floor (default 100)
REM
REM OUTPUT:
REM   dataset <--out>\<repeat>_lora_<trigger>\  img_001.png + img_001.txt ...
REM                     at SDXL bucket sizes. The repeat prefix comes from that
REM                     folder name (that is what sd-scripts reads) and --out is
REM                     exactly what you hand to the training bat. First two
REM                     caption tags are "genshin impact, <character>", so
REM                     --keep_tokens=2 protects the trigger.
REM   raw      outputs\lora_dataset_builder\<date>\<time>\
REM            shots\*.png  candidates\  qa.json  run.json  review.html (open it
REM            once and you are done reviewing - rejects are already excluded)
REM
REM TRAIN:
REM   train_lora_sdxl_pro.bat data\train_data\genshin\mika mika_v4
REM
REM API KEY: GEMINI_API_KEY env, or config_states\gemini_nano_banana.txt
REM ============================================================

setlocal

set SCRIPT_DIR=%~dp0
set WORKFLOW_PYTHON=%SCRIPT_DIR%gemini_workflow\venv\Scripts\python.exe
set WORKFLOW=%SCRIPT_DIR%gemini_workflow\lora_dataset_builder.py

if not exist "%WORKFLOW_PYTHON%" (
    echo ERROR: workflow venv not found at: %WORKFLOW_PYTHON%
    echo Run gemini_nano_banana.bat once to create it.
    exit /b 1
)

"%WORKFLOW_PYTHON%" "%WORKFLOW%" %*

endlocal & exit /b %errorlevel%
