#!/bin/bash

# Local LLM Chat Startup Script

cd "$(dirname "$0")"

LOCAL_LLM_PORT="${LOCAL_LLM_PORT:-27820}"

echo ""
echo "============================================"
echo "Local LLM Chat Interface - Startup"
echo "============================================"
echo ""

# Check if model exists
if ! ls models/*.gguf 1> /dev/null 2>&1; then
    echo "[WARNING] No .gguf model found in models/ folder"
    echo "Download from: https://hf-mirror.com/HauhauCS/Gemma-4-E2B-Uncensored-HauhauCS-Aggressive"
    echo ""
    read -p "Press Enter to continue..."
fi

echo "Installing dependencies..."
pip install -r requirements.txt -q

echo ""
echo "Starting Flask server..."
echo "Opening http://localhost:${LOCAL_LLM_PORT} in browser"
echo ""

sleep 2

# Try to open browser
if command -v xdg-open &> /dev/null; then
    xdg-open "http://localhost:${LOCAL_LLM_PORT}" &
elif command -v open &> /dev/null; then
    open "http://localhost:${LOCAL_LLM_PORT}" &
fi

python app.py
