@echo off
REM Local LLM Chat Startup Script

cd /d "%~dp0"

if not defined LOCAL_LLM_PORT set LOCAL_LLM_PORT=27820

echo.
echo ============================================
echo Local LLM Chat Interface - Startup
echo ============================================
echo.

REM Check if model exists
if not exist "models\*.gguf" (
    echo [WARNING] No .gguf model found in models/ folder
    echo Download from: https://hf-mirror.com/HauhauCS/Gemma-4-E2B-Uncensored-HauhauCS-Aggressive
    echo.
    pause
)

echo Installing dependencies...
pip install -r requirements.txt -q

echo.
echo Starting Flask server...
echo Opening http://localhost:%LOCAL_LLM_PORT% in browser
echo.
timeout /t 2 /nobreak

start http://localhost:%LOCAL_LLM_PORT%

python app.py
