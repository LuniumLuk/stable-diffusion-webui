@echo off
REM ============================================================
REM  SDXL LoRA Fast Trainer  (optimized for <1h training)
REM
REM  Reads bench_recommendations.json if present (run
REM  benchmark_training.bat first), otherwise uses defaults
REM  tuned for ~23 images on RTX 5070 Ti 16GB.
REM
REM  USAGE: train_lora_sdxl_fast.bat <dataset_dir> <output_name> [base_model]
REM ============================================================
setlocal EnableDelayedExpansion

set SCRIPT_DIR=%~dp0
set VENV_PYTHON=%SCRIPT_DIR%.venv\Scripts\python.exe
set SD_SCRIPTS=%SCRIPT_DIR%kohya_ss\sd-scripts
set OUTPUT_DIR=%SCRIPT_DIR%models\Lora

set HF_ENDPOINT=https://hf-mirror.com
set HUGGINGFACE_HUB_VERBOSITY=warning

if "%~1"=="" (
    echo ERROR: Missing dataset_dir.
    echo Usage: train_lora_sdxl_fast.bat ^<dataset_dir^> ^<output_name^> [base_model]
    exit /b 1
)
if "%~2"=="" (
    echo ERROR: Missing output_name.
    exit /b 1
)

set DATASET_DIR=%~1
set OUTPUT_NAME=%~2
if "%~3"=="" (
    set BASE_MODEL=%SCRIPT_DIR%models\Stable-diffusion\animagine-xl-4.0.safetensors
) else (
    set BASE_MODEL=%~3
)

for %%I in ("%DATASET_DIR%") do set DATASET_DIR=%%~fI
for %%I in ("%BASE_MODEL%") do set BASE_MODEL=%%~fI
if "%DATASET_DIR:~-1%"=="\" set DATASET_DIR=%DATASET_DIR:~0,-1%

if not exist "%DATASET_DIR%" ( echo ERROR: Dataset dir not found: %DATASET_DIR% & exit /b 1 )
if not exist "%BASE_MODEL%"  ( echo ERROR: Base model not found: %BASE_MODEL%   & exit /b 1 )
if not exist "%OUTPUT_DIR%"  mkdir "%OUTPUT_DIR%"

REM ---- Default parameters (optimized for 23 imgs, RTX 5070 Ti 16GB) ----
REM  23 images x 10 repeats = 230 steps/epoch
REM  batch=2 + grad_ckpt  -> 115 steps/epoch x 10 epochs = 1150 steps
REM  At ~0.8 steps/sec -> ~24 min
set BATCH_SIZE=2
set MAX_TRAIN_EPOCHS=10
set SAVE_EVERY_N_EPOCHS=2
set NETWORK_DIM=64
set NETWORK_ALPHA=32
set LR_WARMUP_STEPS=100
set GRADIENT_CHECKPOINTING=1

REM ---- Override with benchmark results if available ----
set BENCH_JSON=%TEMP%\bench_recommendations.json
if exist "%BENCH_JSON%" (
    echo Found benchmark recommendations: %BENCH_JSON%
    "%VENV_PYTHON%" -c ^
        "import json,sys; d=json.load(open(sys.argv[1])); [print(k+'='+str(v)) for k,v in d.items()]" ^
        "%BENCH_JSON%" > "%TEMP%\bench_vars.tmp" 2>nul
    if not errorlevel 1 (
        REM Parse key values we care about
        for /f "tokens=1,2 delims==" %%A in ("%TEMP%\bench_vars.tmp") do (
            if "%%A"=="batch"              set BATCH_SIZE=%%B
            if "%%A"=="epochs"            set MAX_TRAIN_EPOCHS=%%B
            if "%%A"=="network_dim"       set NETWORK_DIM=%%B
            if "%%A"=="network_alpha"     set NETWORK_ALPHA=%%B
            if "%%A"=="lr_warmup_steps"   set LR_WARMUP_STEPS=%%B
            if "%%A"=="save_every_n_epochs" set SAVE_EVERY_N_EPOCHS=%%B
            if "%%A"=="gradient_checkpointing" (
                if "%%B"=="True"  set GRADIENT_CHECKPOINTING=1
                if "%%B"=="False" set GRADIENT_CHECKPOINTING=0
            )
        )
        del "%TEMP%\bench_vars.tmp" 2>nul
    )
)

set LEARNING_RATE=1e-4
set UNET_LR=1e-4
set TEXT_ENCODER_LR=5e-5
set LR_SCHEDULER=cosine_with_restarts
set MIXED_PRECISION=bf16
set SAVE_PRECISION=bf16
set OPTIMIZER=AdamW8bit
set CLIP_SKIP=2
set NOISE_OFFSET=0.0357
set MIN_SNR_GAMMA=5

echo ============================================================
echo  SDXL LoRA Fast Training
echo ============================================================
echo  Dataset    : %DATASET_DIR%
echo  Output     : %OUTPUT_DIR%\%OUTPUT_NAME%.safetensors
echo  Base model : %BASE_MODEL%
echo  Batch size : %BATCH_SIZE%  (grad_ckpt=%GRADIENT_CHECKPOINTING%)
echo  Epochs     : %MAX_TRAIN_EPOCHS%
echo  Network    : dim=%NETWORK_DIM%  alpha=%NETWORK_ALPHA%
echo  LR warmup  : %LR_WARMUP_STEPS% steps
echo ============================================================
echo.

REM --- Dependency preflight ---
"%VENV_PYTHON%" -c "from transformers import SiglipImageProcessor; import diffusers" >nul 2>&1
if errorlevel 1 (
    echo Fixing training dependencies...
    "%SCRIPT_DIR%.venv\Scripts\pip.exe" install "transformers==4.44.2" "tokenizers==0.19.1" "diffusers==0.32.2" -i https://pypi.tuna.tsinghua.edu.cn/simple
    if errorlevel 1 ( echo ERROR: Dependency fix failed. & exit /b 1 )
)

REM --- Validate dataset layout ---
set HAS_SUBDATA=
for /d %%D in ("%DATASET_DIR%\*") do (
    if exist "%%~fD\*.png"  set HAS_SUBDATA=1
    if exist "%%~fD\*.jpg"  set HAS_SUBDATA=1
    if exist "%%~fD\*.jpeg" set HAS_SUBDATA=1
    if exist "%%~fD\*.webp" set HAS_SUBDATA=1
)
if not defined HAS_SUBDATA (
    echo ERROR: No image subfolders found under %DATASET_DIR%
    echo Expected layout: %DATASET_DIR%\10_CharName\*.png + *.txt
    exit /b 1
)

REM --- Build gradient checkpointing flag ---
set GC_FLAG=
if "%GRADIENT_CHECKPOINTING%"=="1" set GC_FLAG=--gradient_checkpointing

"%SCRIPT_DIR%.venv\Scripts\accelerate.exe" launch ^
    --num_processes=1 ^
    --num_machines=1 ^
    --dynamo_backend=no ^
    --num_cpu_threads_per_process=2 ^
    --mixed_precision=%MIXED_PRECISION% ^
    "%SD_SCRIPTS%\sdxl_train_network.py" ^
    --pretrained_model_name_or_path="%BASE_MODEL%" ^
    --train_data_dir="%DATASET_DIR%" ^
    --output_dir="%OUTPUT_DIR%" ^
    --output_name="%OUTPUT_NAME%" ^
    --network_module=networks.lora ^
    --network_dim=%NETWORK_DIM% ^
    --network_alpha=%NETWORK_ALPHA% ^
    --caption_extension=.txt ^
    --resolution=1024,1024 ^
    --train_batch_size=%BATCH_SIZE% ^
    --max_train_epochs=%MAX_TRAIN_EPOCHS% ^
    --save_every_n_epochs=%SAVE_EVERY_N_EPOCHS% ^
    --learning_rate=%LEARNING_RATE% ^
    --unet_lr=%UNET_LR% ^
    --text_encoder_lr=%TEXT_ENCODER_LR% ^
    --lr_scheduler=%LR_SCHEDULER% ^
    --lr_warmup_steps=%LR_WARMUP_STEPS% ^
    --optimizer_type=%OPTIMIZER% ^
    --mixed_precision=%MIXED_PRECISION% ^
    --save_precision=%SAVE_PRECISION% ^
    --clip_skip=%CLIP_SKIP% ^
    --noise_offset=%NOISE_OFFSET% ^
    --min_snr_gamma=%MIN_SNR_GAMMA% ^
    --sdpa ^
    --cache_latents ^
    --cache_latents_to_disk ^
    --enable_bucket ^
    --min_bucket_reso=512 ^
    --max_bucket_reso=2048 ^
    %GC_FLAG%

set EXITCODE=%ERRORLEVEL%
if not "%EXITCODE%"=="0" (
    echo.
    echo Training FAILED with error code %EXITCODE%
    exit /b %EXITCODE%
)

dir /b "%OUTPUT_DIR%\%OUTPUT_NAME%*.safetensors" >nul 2>&1
if errorlevel 1 (
    echo Training did not produce an output file.
    exit /b 1
)

echo.
echo ============================================================
echo  Training complete!
echo  LoRA saved to: %OUTPUT_DIR%\%OUTPUT_NAME%.safetensors
echo  Use in WebUI:  ^<lora:%OUTPUT_NAME%:0.8^>
echo ============================================================
endlocal
