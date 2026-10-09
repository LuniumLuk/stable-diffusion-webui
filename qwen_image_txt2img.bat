@echo off
REM ============================================================
REM  Qwen-Image-2.1 (GGUF) CLI txt2img - stable-diffusion.cpp
REM ============================================================
REM
REM USAGE:
REM   qwen_image_txt2img.bat "prompt" [preset ^| width height] [steps] [seed]
REM   Presets (scale:ratio)  1k:1:1 -^> 1024x1024   1k:2:3 -^> 1024x1536   1k:3:2 -^> 1536x1024
REM                          2k:1:1 -^> 2048x2048   2k:2:3 -^> 1696x2528   2k:3:2 -^> 2528x1696
REM   Low-res:               384:1:1 -^> 384x384     512:1:1 -^> 512x512    512:2:3 -^> 512x768
REM                          512:3:2 -^> 768x512     384:3:4 -^> 384x512    512:4:3 -^> 512x384
REM
REM EXAMPLES:
REM   qwen_image_txt2img.bat "a lovely cat holding a sign"
REM   qwen_image_txt2img.bat "cyberpunk street, neon, rain" 1k:2:3
REM   qwen_image_txt2img.bat "cyberpunk street, neon, rain" 1k:2:3 24 99
REM   qwen_image_txt2img.bat "cyberpunk street, neon, rain" 1024 1536 20 42
REM
REM NOTES:
REM   - Default when no size given: 1024x1024 (1k:1:1).
REM   - Measured on RTX 5070 Ti (20 steps, 1024x1024): ~27s with EasyCache,
REM     ~48s without; 2K ~3.5-5.5 min.  EasyCache (--cache-mode easycache,
REM     threshold 0.15) adaptively skips redundant DiT steps; drop the two
REM     cache flags for exact-step output.
REM   - Output goes to outputs\qwen-image-2.1\<timestamp>.png
REM     (prompt/settings are embedded in the PNG "parameters" chunk).
REM ============================================================

setlocal

if "%~1"=="" (
  echo Usage: qwen_image_txt2img.bat "prompt" [preset ^| width height] [steps] [seed]
  echo Presets: 1k:1:1  1k:2:3  1k:3:2  2k:1:1  2k:2:3  2k:3:2    low-res: 384:1:1  512:1:1  512:2:3  512:3:2  384:3:4  512:4:3
  exit /b 1
)

set SCRIPT_DIR=%~dp0
set SD_CPP=%SCRIPT_DIR%sd_cpp
set MODELS=%SCRIPT_DIR%models\Qwen-Image-2.1

set W=%2
set H=%3
set STEPS=%4
set SEED=%5

rem --- resolution presets: preset name replaces width+height ---
set "PMATCH="
if /i "%2"=="384:1:1" set W=384
if /i "%2"=="384:1:1" set H=384
if /i "%2"=="384:1:1" set PMATCH=1
if /i "%2"=="512:1:1" set W=512
if /i "%2"=="512:1:1" set H=512
if /i "%2"=="512:1:1" set PMATCH=1
if /i "%2"=="512:2:3" set W=512
if /i "%2"=="512:2:3" set H=768
if /i "%2"=="512:2:3" set PMATCH=1
if /i "%2"=="512:3:2" set W=768
if /i "%2"=="512:3:2" set H=512
if /i "%2"=="512:3:2" set PMATCH=1
if /i "%2"=="384:3:4" set W=384
if /i "%2"=="384:3:4" set H=512
if /i "%2"=="384:3:4" set PMATCH=1
if /i "%2"=="512:4:3" set W=512
if /i "%2"=="512:4:3" set H=384
if /i "%2"=="512:4:3" set PMATCH=1
if /i "%2"=="1k:1:1" set W=1024
if /i "%2"=="1k:1:1" set H=1024
if /i "%2"=="1k:1:1" set PMATCH=1
if /i "%2"=="1k:2:3" set W=1024
if /i "%2"=="1k:2:3" set H=1536
if /i "%2"=="1k:2:3" set PMATCH=1
if /i "%2"=="1k:3:2" set W=1536
if /i "%2"=="1k:3:2" set H=1024
if /i "%2"=="1k:3:2" set PMATCH=1
if /i "%2"=="2k:1:1" set W=2048
if /i "%2"=="2k:1:1" set H=2048
if /i "%2"=="2k:1:1" set PMATCH=1
if /i "%2"=="2k:2:3" set W=1696
if /i "%2"=="2k:2:3" set H=2528
if /i "%2"=="2k:2:3" set PMATCH=1
if /i "%2"=="2k:3:2" set W=2528
if /i "%2"=="2k:3:2" set H=1696
if /i "%2"=="2k:3:2" set PMATCH=1
rem reject unknown preset-like sizes (typos like 1k:9:9). NOTE: cmd does not support
rem substring expansion on positional args (%2:~0,2% expands literally and breaks parsing)
set "HASCOLON="
echo(%2| findstr /c:":" >nul && set "HASCOLON=1"
if not defined PMATCH if defined HASCOLON echo Unknown preset "%2" - valid: 1k:1:1 1k:2:3 1k:3:2 2k:1:1 2k:2:3 2k:3:2 384:1:1 512:1:1 512:2:3 512:3:2 384:3:4 512:4:3
if not defined PMATCH if defined HASCOLON exit /b 1
rem in preset mode steps/seed shift one argument left
if defined PMATCH set STEPS=%3
if defined PMATCH set SEED=%4

if "%W%"=="" set W=1024
if "%H%"=="" set H=1024
if "%STEPS%"=="" set STEPS=20
if "%SEED%"=="" set SEED=42

for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd_HHmmss"') do set TS=%%i

set OUTDIR=%SCRIPT_DIR%outputs\qwen-image-2.1
if not exist "%OUTDIR%" mkdir "%OUTDIR%"

pushd "%SD_CPP%"
sd-cli.exe ^
  --diffusion-model "%MODELS%\qwen-image-2.1-Q4_K_M.gguf" ^
  --vae "%MODELS%\vae\qwen_image_2.1_vae_bf16.safetensors" ^
  --llm "%MODELS%\text_encoders\Qwen3VL-8B-Instruct-Q4_K_M.gguf" ^
  -p "%~1" ^
  -W %W% -H %H% --steps %STEPS% --seed %SEED% ^
  --cfg-scale 6.0 --sampling-method euler ^
  --diffusion-fa --vae-tiling ^
  --cache-mode easycache --cache-option "threshold=0.15" ^
  -o "%OUTDIR%\%TS%.png"
set RC=%ERRORLEVEL%
popd
exit /b %RC%
