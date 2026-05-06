@echo off
REM ============================================================
REM  SDXL LoRA Sweep Benchmark
REM  Tests multiple parameter combinations and ranks train speed.
REM
REM  USAGE:
REM    benchmark_sweep_training.bat <dataset_dir> [base_model] [target_epochs] [test_steps]
REM
REM  EXAMPLE:
REM    benchmark_sweep_training.bat "D:\stable-diffusion-webui\data" "" 10 30
REM ============================================================
setlocal

set SCRIPT_DIR=%~dp0
set VENV_PYTHON=%SCRIPT_DIR%.venv\Scripts\python.exe
set SD_SCRIPTS=%SCRIPT_DIR%kohya_ss\sd-scripts
set SWEEP_SCRIPT=%SCRIPT_DIR%kohya_ss\benchmark_sweep.py
set BENCH_OUTPUT=%TEMP%\sdxl_sweep_output

if "%~1"=="" (
    echo ERROR: Missing dataset_dir argument.
    echo Usage: benchmark_sweep_training.bat ^<dataset_dir^> [base_model] [target_epochs] [test_steps]
    exit /b 1
)

set DATASET_DIR=%~1
if "%~2"=="" (
    set BASE_MODEL=%SCRIPT_DIR%models\Stable-diffusion\animagine-xl-4.0.safetensors
) else (
    set BASE_MODEL=%~2
)
if "%~3"=="" (
    set TARGET_EPOCHS=10
) else (
    set TARGET_EPOCHS=%~3
)
if "%~4"=="" (
    set TEST_STEPS=30
) else (
    set TEST_STEPS=%~4
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
if not exist "%VENV_PYTHON%" (
    echo ERROR: Python not found: %VENV_PYTHON%
    exit /b 1
)
if not exist "%SWEEP_SCRIPT%" (
    echo ERROR: Sweep script not found: %SWEEP_SCRIPT%
    exit /b 1
)
if not exist "%BENCH_OUTPUT%" mkdir "%BENCH_OUTPUT%"

set HF_ENDPOINT=https://hf-mirror.com
set HUGGINGFACE_HUB_VERBOSITY=warning

echo ============================================================
echo  SDXL LoRA Sweep Benchmark
echo ============================================================
echo  Dataset       : %DATASET_DIR%
echo  Model         : %BASE_MODEL%
echo  Target epochs : %TARGET_EPOCHS%
echo  Test steps    : %TEST_STEPS% per combo
echo  Batch grid    : 1,2
echo  Dim grid      : 16,32,48
echo  Output        : %BENCH_OUTPUT%
echo ============================================================
echo.

"%VENV_PYTHON%" "%SWEEP_SCRIPT%" ^
    --venv_python "%VENV_PYTHON%" ^
    --sd_scripts "%SD_SCRIPTS%" ^
    --dataset_dir "%DATASET_DIR%" ^
    --base_model "%BASE_MODEL%" ^
    --bench_output "%BENCH_OUTPUT%" ^
    --batch_sizes "1,2" ^
    --network_dims "16,32,48" ^
    --target_epochs %TARGET_EPOCHS% ^
    --test_steps %TEST_STEPS%

set EXITCODE=%ERRORLEVEL%
if not "%EXITCODE%"=="0" (
    echo.
    echo Sweep benchmark FAILED with error code %EXITCODE%
    exit /b %EXITCODE%
)

echo.
echo Sweep benchmark complete.
echo Results CSV : %BENCH_OUTPUT%\bench_sweep_results.csv
echo Results JSON: %BENCH_OUTPUT%\bench_sweep_results.json
echo Fast-train compatibility file: %TEMP%\bench_recommendations.json

endlocal
