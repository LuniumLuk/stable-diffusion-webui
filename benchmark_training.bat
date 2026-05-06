@echo off
REM ============================================================
REM  SDXL LoRA Training Benchmark
REM  Runs 20 training steps, reports steps/sec + VRAM,
REM  then recommends parameters for <1h training.
REM
REM  USAGE: benchmark_training.bat <dataset_dir> [base_model]
REM  Example: benchmark_training.bat "D:\stable-diffusion-webui\data"
REM ============================================================
setlocal

set SCRIPT_DIR=%~dp0
set VENV_PYTHON=%SCRIPT_DIR%.venv\Scripts\python.exe
set SD_SCRIPTS=%SCRIPT_DIR%kohya_ss\sd-scripts
set BENCH_OUTPUT=%TEMP%\sdxl_bench_output

if "%~1"=="" (
    echo ERROR: Missing dataset_dir argument.
    echo Usage: benchmark_training.bat ^<dataset_dir^> [base_model]
    exit /b 1
)

set DATASET_DIR=%~1
if "%~2"=="" (
    set BASE_MODEL=%SCRIPT_DIR%models\Stable-diffusion\animagine-xl-4.0.safetensors
) else (
    set BASE_MODEL=%~2
)

for %%I in ("%DATASET_DIR%") do set DATASET_DIR=%%~fI
for %%I in ("%BASE_MODEL%") do set BASE_MODEL=%%~fI
if "%DATASET_DIR:~-1%"=="\" set DATASET_DIR=%DATASET_DIR:~0,-1%

if not exist "%DATASET_DIR%" (
    echo ERROR: Dataset directory not found: %DATASET_DIR%
    exit /b 1
)
if not exist "%BASE_MODEL%" (
    echo ERROR: Base model not found: %BASE_MODEL%
    exit /b 1
)

if not exist "%BENCH_OUTPUT%" mkdir "%BENCH_OUTPUT%"

set HF_ENDPOINT=https://hf-mirror.com
set HUGGINGFACE_HUB_VERBOSITY=warning

echo ============================================================
echo  SDXL LoRA Training Benchmark
echo  Dataset : %DATASET_DIR%
echo  Model   : %BASE_MODEL%
echo  Steps   : 20 (batch=1 then batch=2 if VRAM allows)
echo ============================================================
echo.

REM --- Run the Python benchmark driver ---
"%VENV_PYTHON%" "%SCRIPT_DIR%kohya_ss\benchmark_helper.py" ^
    --venv_python "%VENV_PYTHON%" ^
    --sd_scripts "%SD_SCRIPTS%" ^
    --dataset_dir "%DATASET_DIR%" ^
    --base_model "%BASE_MODEL%" ^
    --bench_output "%BENCH_OUTPUT%"

endlocal
