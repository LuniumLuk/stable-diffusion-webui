# Local LLM Chat Interface

A minimal, self-contained chat UI for running GGUF models locally with full conversation history.

## Features

- ✨ Simple, responsive chat interface
- 💾 Persistent conversation history (SQLite)
- 🚀 GPU-accelerated inference with llama-cpp-python
- 📱 Real-time model status monitoring
- 🎨 Dark theme UI with smooth animations

## Quick Start

### Prerequisites

- Python 3.9+
- CUDA-capable GPU (or CPU fallback)
- ~8-16 GB RAM recommended

### 1. Download the Model

Download a GGUF model from HuggingFace mirror (default downloader target):
- **Repository**: https://hf-mirror.com/HauhauCS/Gemma-4-E2B-Uncensored-HauhauCS-Aggressive
- **Place the `.gguf` file in**: `local-llm/models/`

Example:
```
local-llm/models/Gemma-4-E2B-Uncensored-HauhauCS-Aggressive-Q6_K_P.gguf
```

### 2. Install Dependencies

```bash
cd local-llm
pip install -r requirements.txt
```

**Note**: llama-cpp-python may take a few minutes to compile on first install.

### 3. Run the Server

```bash
python app.py
```

You should see:
```
Starting Local LLM Chat Server...
Open http://localhost:7820 in your browser
✓ Model loaded successfully
```

### 4. Open in Browser

Navigate to: **http://localhost:7820**

## Usage

1. **New Chat**: Click "+ New Chat" to start a conversation
2. **Type Message**: Enter text in the input box
3. **Send**: Press Ctrl+Enter or click Send button
4. **View History**: Left sidebar shows all past conversations
5. **Delete**: Click ✕ to delete a conversation
6. **Switch Model**: Use the model selector in the status bar and click "Switch Model"

## File Structure

```
local-llm/
├── app.py                 # Flask backend & API routes
├── models.py              # llama-cpp-python model loading
├── history.py             # SQLite conversation storage
├── requirements.txt       # Python dependencies
├── models/                # Model storage (add .gguf files here)
├── history.db             # SQLite database (auto-created)
└── static/
    └── index.html         # Chat UI (embedded CSS/JS)
```

## API Endpoints

### Chat

- `POST /api/chat/new` - Create new conversation
- `POST /api/chat/send` - Send message & get response

### History

- `GET /api/history/list` - List all conversations
- `GET /api/history/load/<id>` - Load conversation messages
- `DELETE /api/history/delete/<id>` - Delete conversation

### Status

- `GET /api/status` - Server & model status

## Configuration

### Model Settings (in `models.py`)

- `n_gpu_layers=-1` - Use all GPU layers (set to 20-30 for lower VRAM)
- `n_ctx=2048` - Context window size
- `temperature=0.7` - Response randomness (0.0 = deterministic, 1.0 = creative)
- `top_k=40`, `top_p=0.95` - Sampling parameters

### Server Settings (in `app.py`)

- Port: `5000` (change in `app.run(port=5000)`)
- Host: `0.0.0.0` (accessible from network)

## Troubleshooting

### "Model not found"

Ensure at least one `.gguf` file from the repo is present in `local-llm/models/`.

Example filename:
```
Gemma-4-E2B-Uncensored-HauhauCS-Aggressive-Q6_K_P.gguf
```

### "Slow inference on CPU"

- Reduce `n_ctx` to 512 in `models.py`
- Reduce `max_tokens` to 256 in `app.py`
- Add GPU layers: `n_gpu_layers=32`

### Port already in use

Change port in `app.py` line `app.run(port=5001)`

### CUDA out of memory

Reduce `n_gpu_layers` (try 20 instead of -1) in `models.py`

## Performance Notes

- **First generation**: ~10-30 seconds (model loading + inference)
- **Subsequent generations**: ~5-15 seconds (GPU) or ~30-60s (CPU)
- **Context size**: Larger = better coherence but slower inference
- **Quantization**: GGUF format provides ~4-8x speedup vs full precision

## Next Steps

- Customize system prompts in `generate_response()`
- Add conversation export (Markdown, PDF)
- Implement multi-model support
- Add streaming responses for real-time output

## License

Same as parent repository (stable-diffusion-webui)
