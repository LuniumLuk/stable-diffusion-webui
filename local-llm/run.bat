@echo off
REM Local LLM Chat Startup Script

cd /d "%~dp0"

echo.
echo ============================================
echo Local LLM Chat Interface - Startup
echo ============================================
echo.

REM Check if model exists
if not exist "models\*.gguf" (
    echo [WARNING] No .gguf model found in models/ folder
    echo Download from: https://huggingface.co/DavidAU/GLM-4.7-Flash-Uncensored-Heretic-NEO-CODE-Imatrix-MAX-GGUF
    echo.
    pause
)

echo Installing dependencies...
pip install -r requirements.txt -q

echo.
echo Starting Flask server...
echo Opening http://localhost:5000 in browser
echo.
timeout /t 2 /nobreak

start http://localhost:5000

python app.py
