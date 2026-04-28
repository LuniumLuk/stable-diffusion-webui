#!/bin/bash

# Local LLM Chat Startup Script

cd "$(dirname "$0")"

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
echo "Opening http://localhost:5000 in browser"
echo ""

sleep 2

# Try to open browser
if command -v xdg-open &> /dev/null; then
    xdg-open http://localhost:5000 &
elif command -v open &> /dev/null; then
    open http://localhost:5000 &
fi

python app.py
