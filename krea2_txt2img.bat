@echo off
REM ============================================================
REM  Krea 2 (GGUF) CLI txt2img - stable-diffusion.cpp
REM ============================================================
REM
REM USAGE:
REM   krea2_txt2img.bat "prompt" [preset ^| width height] [steps] [seed]
REM   Presets (scale:ratio)  1k:1:1   -^> 1024x1024    1k:2:3   -^> 1024x1536   1k:3:2   -^> 1536x1024
REM                          1.5k:4:5 -^> 1152x1440   1.5k:5:4 -^> 1440x1152
REM   Low-res:               384:1:1  -^> 384x384      512:1:1  -^> 512x512
REM                          512:2:3  -^> 512x768      512:3:2  -^> 768x512
REM                          384:3:4  -^> 384x512      512:4:3  -^> 512x384
REM
REM EXAMPLES:
REM   krea2_txt2img.bat "a lovely cat holding a sign"
REM   krea2_txt2img.bat "portrait of a woman, night market" 1k:2:3
REM   krea2_txt2img.bat "portrait of a woman, night market" 1k:2:3 8 99
REM   set KREA2_REF=photo.png, then: krea2_txt2img.bat "Edit this picture. Change her hair to blue. Keep her face the same." 1k:1:1
REM
REM NOTES:
REM   - Krea 2 Turbo is distilled: default 8 steps, CFG 1.0.
REM   - Set KREA2_REF=<image path> to switch to reference-image editing (the
REM     prompt becomes an edit instruction); uses the mmproj vision projector +
REM     the krea2_edit preset (identity-edit LoRA of the default merge).
REM     Override the preset with KREA2_REF_PRESET (e.g. krea2_ostris_edit).
REM   - Default weights: Krea 2 Turbo Edit v1.1 uncensored Q4_K_M; fallbacks:
REM     same merge Q6_K, then official Krea-2-Turbo Q6_K GGUF.
REM   - Output goes to outputs\krea2\<timestamp>.png
REM     (prompt/settings are embedded in the PNG "parameters" chunk).
REM ============================================================

setlocal

if "%~1"=="" (
  echo Usage: krea2_txt2img.bat "prompt" [preset ^| width height] [steps] [seed]
  echo Presets: 1k:1:1  1k:2:3  1k:3:2  1.5k:4:5  1.5k:5:4    low-res: 384:1:1  512:1:1  512:2:3  512:3:2  384:3:4  512:4:3
  exit /b 1
)

set SCRIPT_DIR=%~dp0
set SD_CPP=%SCRIPT_DIR%sd_cpp
set MODELS=%SCRIPT_DIR%models\Krea-2

set MODEL=%MODELS%\diffusion_models\Krea2_turbo_uncensored_edit_v1.1-Q4_K_M.gguf
if not exist "%MODEL%" set MODEL=%MODELS%\diffusion_models\Krea2_turbo_uncensored_edit-v1.1-Q6_K.gguf
if not exist "%MODEL%" set MODEL=%MODELS%\diffusion_models\Krea-2-Turbo-Q6_K.gguf

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
if /i "%2"=="1.5k:4:5" set W=1152
if /i "%2"=="1.5k:4:5" set H=1440
if /i "%2"=="1.5k:4:5" set PMATCH=1
if /i "%2"=="1.5k:5:4" set W=1440
if /i "%2"=="1.5k:5:4" set H=1152
if /i "%2"=="1.5k:5:4" set PMATCH=1
rem reject unknown preset-like sizes (typos like 1k:9:9). NOTE: cmd does not support
rem substring expansion on positional args (%2:~0,2% expands literally and breaks parsing)
set "HASCOLON="
echo(%2| findstr /c:":" >nul && set "HASCOLON=1"
if not defined PMATCH if defined HASCOLON echo Unknown preset "%2" - valid: 1k:1:1 1k:2:3 1k:3:2 1.5k:4:5 1.5k:5:4 384:1:1 512:1:1 512:2:3 512:3:2 384:3:4 512:4:3
if not defined PMATCH if defined HASCOLON exit /b 1
rem in preset mode steps/seed shift one argument left
if defined PMATCH set STEPS=%3
if defined PMATCH set SEED=%4

if "%W%"=="" set W=1024
if "%H%"=="" set H=1024
if "%STEPS%"=="" set STEPS=8
if "%SEED%"=="" set SEED=42

for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd_HHmmss"') do set TS=%%i

set OUTDIR=%SCRIPT_DIR%outputs\krea2
if not exist "%OUTDIR%" mkdir "%OUTDIR%"

set "REF_ARGS="
set "REF_PRESET=%KREA2_REF_PRESET%"
if "%REF_PRESET%"=="" set "REF_PRESET=krea2_edit"
if not "%KREA2_REF%"=="" set REF_ARGS=-r "%KREA2_REF%" --llm_vision "%MODELS%\text_encoders\mmproj-Qwen3VL-4B-Instruct-F16.gguf" --ref-image-args "preset=%REF_PRESET%"

pushd "%SD_CPP%"
sd-cli.exe ^
  --diffusion-model "%MODEL%" ^
  --vae "%MODELS%\vae\wan_2.1_vae.safetensors" ^
  --llm "%MODELS%\text_encoders\Qwen3VL-4B-Instruct-Q4_K_M.gguf" ^
  -p "%~1" %REF_ARGS% ^
  -W %W% -H %H% --steps %STEPS% --seed %SEED% ^
  --cfg-scale 1.0 --sampling-method euler ^
  --diffusion-fa --vae-tiling --vae-tile-size 64x64 ^
  --params-backend "te=cpu,vae=cpu" ^
  -o "%OUTDIR%\%TS%.png"
set RC=%ERRORLEVEL%
popd
exit /b %RC%
