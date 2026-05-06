@echo off
REM ============================================================
REM  SDXL LoRA Training Launcher
REM  Uses the root .venv and kohya_ss/sd-scripts
REM ============================================================
REM
REM USAGE:
REM   train_lora_sdxl.bat <dataset_dir> <output_name> [base_model]
REM
REM ARGUMENTS:
REM   dataset_dir   Folder containing images and matching .txt caption files
REM   output_name   Name for the output LoRA (no extension)
REM   base_model    (optional) Path to the SDXL .safetensors checkpoint
REM                 Defaults to: models\Stable-diffusion\animagine-xl-4.0.safetensors
REM
REM EXAMPLE:
REM   train_lora_sdxl.bat "D:\my_images" "my_character_lora"
REM   train_lora_sdxl.bat "D:\my_images" "my_character_lora" "D:\stable-diffusion-webui\models\Stable-diffusion\novaAnimeXL_ilV180.safetensors"
REM
REM OUTPUT:
REM   models\Lora\<output_name>.safetensors  (ready to use in WebUI)
REM
REM CAPTION FORMAT:
REM   Each image must have a sidecar .txt with the same filename:
REM     img001.jpg  ->  img001.txt  (contents: "1girl, blue hair, ...")
REM ============================================================

setlocal

set SCRIPT_DIR=%~dp0
set VENV_PYTHON=%SCRIPT_DIR%.venv\Scripts\python.exe
set SD_SCRIPTS=%SCRIPT_DIR%kohya_ss\sd-scripts
set OUTPUT_DIR=%SCRIPT_DIR%models\Lora

REM --- HuggingFace mirror for model downloads ---
set HF_ENDPOINT=https://hf-mirror.com
set HUGGINGFACE_HUB_VERBOSITY=warning

REM --- Parse arguments ---
if "%~1"=="" (
    echo ERROR: Missing dataset_dir argument.
    echo Usage: train_lora_sdxl.bat ^<dataset_dir^> ^<output_name^> [base_model]
    exit /b 1
)
if "%~2"=="" (
    echo ERROR: Missing output_name argument.
    echo Usage: train_lora_sdxl.bat ^<dataset_dir^> ^<output_name^> [base_model]
    exit /b 1
)

set DATASET_DIR=%~1
set OUTPUT_NAME=%~2

if "%~3"=="" (
    set BASE_MODEL=%SCRIPT_DIR%models\Stable-diffusion\animagine-xl-4.0.safetensors
) else (
    set BASE_MODEL=%~3
)

REM --- Normalize paths to avoid cmd quote issues with trailing backslashes ---
for %%I in ("%DATASET_DIR%") do set DATASET_DIR=%%~fI
for %%I in ("%BASE_MODEL%") do set BASE_MODEL=%%~fI
if "%DATASET_DIR:~-1%"=="\" set DATASET_DIR=%DATASET_DIR:~0,-1%


REM --- Training hyperparameters (edit these as needed) ---
set RESOLUTION=1024,1024
set BATCH_SIZE=1
set MAX_TRAIN_EPOCHS=10
set SAVE_EVERY_N_EPOCHS=2
set LEARNING_RATE=1e-4
set UNET_LR=1e-4
set TEXT_ENCODER_LR=5e-5
set NETWORK_DIM=32
set NETWORK_ALPHA=16
set LR_SCHEDULER=cosine_with_restarts
set LR_WARMUP_STEPS=100
set MIXED_PRECISION=bf16
set SAVE_PRECISION=bf16
set OPTIMIZER=AdamW8bit
set CLIP_SKIP=2
set NOISE_OFFSET=0.0357
set MIN_SNR_GAMMA=5
set ATTENTION_BACKEND=sdpa

echo ============================================================
echo  SDXL LoRA Training
echo ============================================================
echo  Dataset    : %DATASET_DIR%
echo  Output     : %OUTPUT_DIR%\%OUTPUT_NAME%.safetensors
echo  Base model : %BASE_MODEL%
echo  Resolution : %RESOLUTION%
echo  Epochs     : %MAX_TRAIN_EPOCHS%
echo  Network    : dim=%NETWORK_DIM% alpha=%NETWORK_ALPHA%
echo  Optimizer  : %OPTIMIZER%  lr=%LEARNING_RATE%
echo  Precision  : %MIXED_PRECISION%
echo  Attention  : %ATTENTION_BACKEND%
echo ============================================================
echo.

if not exist "%DATASET_DIR%" (
    echo ERROR: Dataset directory not found: %DATASET_DIR%
    exit /b 1
)
if not exist "%BASE_MODEL%" (
    echo ERROR: Base model not found: %BASE_MODEL%
    exit /b 1
)
if not exist "%OUTPUT_DIR%" mkdir "%OUTPUT_DIR%"

REM --- Dependency preflight for kohya sd-scripts ---
"%VENV_PYTHON%" -c "from transformers import SiglipImageProcessor; import diffusers" >nul 2>&1
if errorlevel 1 (
    echo Fixing training dependencies in .venv - transformers/diffusers compatibility...
    "%SCRIPT_DIR%.venv\Scripts\pip.exe" install "transformers==4.44.2" "tokenizers==0.19.1" "diffusers==0.32.2" -i https://pypi.tuna.tsinghua.edu.cn/simple
    if errorlevel 1 (
        echo ERROR: Failed to install required training dependencies.
        exit /b 1
    )

    "%VENV_PYTHON%" -c "from transformers import SiglipImageProcessor; import diffusers" >nul 2>&1
    if errorlevel 1 (
        echo ERROR: Dependency check failed after reinstall. Please check pip output above.
        exit /b 1
    )
)

REM --- Validate sd-scripts dataset layout ---
set HAS_SUBDATA=
for /d %%D in ("%DATASET_DIR%\*") do (
    if exist "%%~fD\*.png" set HAS_SUBDATA=1
    if exist "%%~fD\*.jpg" set HAS_SUBDATA=1
    if exist "%%~fD\*.jpeg" set HAS_SUBDATA=1
    if exist "%%~fD\*.webp" set HAS_SUBDATA=1
    if exist "%%~fD\*.bmp" set HAS_SUBDATA=1
)
if not defined HAS_SUBDATA (
    echo ERROR: No image subfolders found under %DATASET_DIR%
    echo sd-scripts expects this layout:
    echo   %DATASET_DIR%\10_%OUTPUT_NAME%\*.png + *.txt
    echo Please move your images+captions into a subfolder and run again.
    exit /b 1
)

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
    --resolution=%RESOLUTION% ^
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
    --%ATTENTION_BACKEND% ^
    --cache_latents ^
    --cache_latents_to_disk ^
    --persistent_data_loader_workers ^
    --enable_bucket ^
    --min_bucket_reso=512 ^
    --max_bucket_reso=2048

set EXITCODE=%ERRORLEVEL%
if not "%EXITCODE%"=="0" (
    echo.
    echo Training FAILED with error code %EXITCODE%
    exit /b %EXITCODE%
)

dir /b "%OUTPUT_DIR%\%OUTPUT_NAME%*.safetensors" >nul 2>&1
if errorlevel 1 (
    echo.
    echo Training did not produce any output safetensors file.
    echo Check dataset layout and training logs above.
    exit /b 1
)

echo.
echo ============================================================
echo  Training complete!
echo  LoRA saved to: %OUTPUT_DIR%\%OUTPUT_NAME%.safetensors
echo  Use in WebUI with: ^<lora:%OUTPUT_NAME%:0.8^>
echo ============================================================
endlocal
