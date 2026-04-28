"""Model management with llama-cpp-python."""
import os
import re
from pathlib import Path


# Keep DLL directory handles alive for process lifetime on Windows.
_DLL_DIR_HANDLES = []


def _add_windows_cuda_dll_paths():
    """Ensure CUDA runtime DLL directories are visible to the Python process on Windows."""
    if os.name != "nt" or not hasattr(os, "add_dll_directory"):
        return

    cuda_roots = []
    cuda_path = os.environ.get("CUDA_PATH")
    if cuda_path:
        cuda_roots.append(Path(cuda_path))

    default_cuda_root = Path("C:/Program Files/NVIDIA GPU Computing Toolkit/CUDA")
    if default_cuda_root.exists():
        versions = sorted(default_cuda_root.glob("v*"), reverse=True)
        cuda_roots.extend(versions)

    seen = set()
    path_entries = []
    for root in cuda_roots:
        for candidate in (root / "bin" / "x64", root / "bin"):
            key = str(candidate).lower()
            if candidate.exists() and key not in seen:
                handle = os.add_dll_directory(str(candidate))
                _DLL_DIR_HANDLES.append(handle)
                path_entries.append(str(candidate))
                seen.add(key)

    # Also prepend to PATH for native loaders that rely on PATH lookup.
    if path_entries:
        os.environ["PATH"] = os.pathsep.join(path_entries + [os.environ.get("PATH", "")])


_add_windows_cuda_dll_paths()

import llama_cpp
from llama_cpp import Llama

# Models directory
MODELS_DIR = Path(__file__).parent / "models"
MODELS_DIR.mkdir(exist_ok=True)

# Global model instance
_model = None
_model_meta = {"backend": "unknown", "model_path": None}


def get_model():
    """Get or load the model instance."""
    global _model
    return _model


def _select_model_path(model_name=None):
    """Resolve GGUF model path by explicit name or by newest file in models dir."""
    if model_name:
        candidate = MODELS_DIR / f"{model_name}.gguf"
        if candidate.exists():
            return candidate

    gguf_files = sorted(MODELS_DIR.glob("*.gguf"), key=lambda p: p.stat().st_mtime, reverse=True)
    if gguf_files:
        return gguf_files[0]

    return None


def load_model(model_name=None):
    """Load a GGUF model from models directory."""
    global _model
    global _model_meta

    model_path = _select_model_path(model_name=model_name)
    
    if model_path is None:
        raise FileNotFoundError(
            f"No .gguf model found in {MODELS_DIR}/. "
            "Download from HuggingFace and place the model file in this directory."
        )
    
    print(f"Loading model from {model_path}...")

    # GPU/CPU mode selection via env with safe fallback defaults.
    # LOCAL_LLM_GPU_LAYERS: -1 (all), 0 (cpu), N (partial offload)
    # IQ3_M / Q4_K_M quants are stable at higher offload values.
    requested_gpu_layers = int(os.getenv("LOCAL_LLM_GPU_LAYERS", "35"))
    gpu_supported = bool(llama_cpp.llama_supports_gpu_offload())
    n_gpu_layers = requested_gpu_layers if gpu_supported else 0
    backend = "gpu" if n_gpu_layers != 0 else "cpu"
    
    _model = Llama(
        model_path=str(model_path),
        n_gpu_layers=n_gpu_layers,
        n_ctx=int(os.getenv("LOCAL_LLM_CTX", "2048")),
        n_threads=int(os.getenv("LOCAL_LLM_THREADS", "8")),
        n_batch=int(os.getenv("LOCAL_LLM_BATCH", "512")),
        verbose=False,
    )

    _model_meta = {
        "backend": backend,
        "gpu_supported": gpu_supported,
        "n_gpu_layers": n_gpu_layers,
        "requested_gpu_layers": requested_gpu_layers,
        "model_path": str(model_path),
    }
    
    print(f"Model loaded successfully! backend={backend} n_gpu_layers={n_gpu_layers}")
    return _model


def _clean_response_text(text):
    """Remove obvious reasoning scaffolding while preserving useful content."""
    cleaned = (text or "").strip()
    if not cleaned:
        return cleaned

    lines = []
    for line in cleaned.splitlines():
        s = line.strip()
        if not s:
            continue
        if re.match(r"^\d+\.\s+\*\*", s):
            continue
        if re.match(r"^\d+\.\s*$", s):
            continue
        if re.match(r"^[*#`>-]+\s*$", s):
            continue
        lines.append(s)

    if lines:
        cleaned = " ".join(lines)

    # Collapse repeated spaces and trim noisy trailing punctuation blocks.
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    cleaned = re.sub(r"([;:,.!?])\1{2,}", r"\1", cleaned)
    return cleaned


def generate_response(prompt=None, messages=None, max_tokens=256, system_prompt=None):
    """Generate a response using chat completion with optional message history."""
    model = get_model()
    
    if model is None:
        raise RuntimeError("Model not loaded. Call load_model() first.")
    
    if messages is None:
        messages = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        if prompt:
            messages.append({"role": "user", "content": prompt})

    if not messages:
        raise RuntimeError("No input messages provided.")

    response = model.create_chat_completion(
        messages=messages,
        max_tokens=max_tokens,
        temperature=float(os.getenv("LOCAL_LLM_TEMPERATURE", "0.0")),
        top_p=float(os.getenv("LOCAL_LLM_TOP_P", "1.0")),
        top_k=int(os.getenv("LOCAL_LLM_TOP_K", "1")),
        repeat_penalty=float(os.getenv("LOCAL_LLM_REPEAT_PENALTY", "1.1")),
        frequency_penalty=float(os.getenv("LOCAL_LLM_FREQUENCY_PENALTY", "0.0")),
        presence_penalty=float(os.getenv("LOCAL_LLM_PRESENCE_PENALTY", "0.0")),
    )

    message = response["choices"][0]["message"]["content"]
    return _clean_response_text((message or "").strip())


def get_model_info():
    """Get information about loaded model."""
    model = get_model()
    
    if model is None:
        return {"status": "not_loaded"}
    
    return {
        "status": "loaded",
        "backend": _model_meta.get("backend"),
        "gpu_supported": _model_meta.get("gpu_supported"),
        "n_gpu_layers": _model_meta.get("n_gpu_layers"),
        "requested_gpu_layers": _model_meta.get("requested_gpu_layers"),
        "model_path": _model_meta.get("model_path"),
        "context_size": model.n_ctx(),
        "vocabulary_size": model.n_vocab(),
    }
