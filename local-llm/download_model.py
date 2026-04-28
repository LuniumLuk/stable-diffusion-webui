"""Download a GGUF model using HuggingFace Hub API."""
import os
from pathlib import Path
import requests
from huggingface_hub import list_repo_files, hf_hub_download

MODELS_DIR = Path(__file__).parent / "models"
MODELS_DIR.mkdir(exist_ok=True)

REPO_ID = os.getenv("HF_REPO_ID", "HauhauCS/Gemma-4-E2B-Uncensored-HauhauCS-Aggressive")
HF_ENDPOINT = os.getenv("HF_ENDPOINT", "https://hf-mirror.com").rstrip("/")
os.environ.setdefault("HF_ENDPOINT", HF_ENDPOINT)


def _list_gguf_files(repo_id):
    """List GGUF files with compatibility across huggingface_hub versions."""
    # Prefer the explicit endpoint argument when available.
    try:
        files = list_repo_files(repo_id=repo_id, endpoint=HF_ENDPOINT)
    except TypeError:
        # Older huggingface_hub builds don't support endpoint=.
        # Fall back to mirror REST API so downloads still use hf-mirror.com.
        api_url = f"{HF_ENDPOINT}/api/models/{repo_id}"
        response = requests.get(api_url, timeout=30)
        response.raise_for_status()
        data = response.json()
        files = [item.get("rfilename", "") for item in data.get("siblings", [])]

    return [name for name in files if name.endswith(".gguf")]


def _download_file(repo_id, filename):
    """Download model file with compatibility fallback for endpoint support."""
    try:
        return hf_hub_download(
            repo_id=repo_id,
            filename=filename,
            endpoint=HF_ENDPOINT,
            cache_dir=str(MODELS_DIR.parent),
            local_dir=str(MODELS_DIR),
            local_dir_use_symlinks=False,
        )
    except TypeError:
        # Older huggingface_hub builds don't support endpoint=. Download directly.
        url = f"{HF_ENDPOINT}/{repo_id}/resolve/main/{filename}?download=true"
        target_path = MODELS_DIR / filename
        with requests.get(url, stream=True, timeout=60) as response:
            response.raise_for_status()
            with open(target_path, "wb") as out_file:
                for chunk in response.iter_content(chunk_size=1024 * 1024):
                    if chunk:
                        out_file.write(chunk)
        return str(target_path)


def _pick_default_model(gguf_files):
    """Prefer practical quant files when multiple variants are available."""
    priority_tags = ("Q6_K_P", "Q6_K", "Q5_K_M", "Q4_K_M", "Q8_0")
    upper_map = {name: name.upper() for name in gguf_files}

    for tag in priority_tags:
        for name, upper_name in upper_map.items():
            if tag in upper_name:
                return name

    return gguf_files[0]

print("=" * 70)
print("Local LLM Model Downloader (HuggingFace Hub)")
print("=" * 70)
print()

print(f"Repository: {REPO_ID}")
print(f"Endpoint:   {HF_ENDPOINT}")
print()

try:
    # List all files in repo
    print("Fetching available files...")
    gguf_files = _list_gguf_files(REPO_ID)
    
    print(f"Found {len(gguf_files)} GGUF file(s):")
    print()
    
    for idx, filename in enumerate(gguf_files, 1):
        print(f"  {idx}. {filename}")
    
    print()
    
    if not gguf_files:
        print("✗ No GGUF files found in repository!")
        exit(1)
    
    requested_filename = os.getenv("LOCAL_LLM_MODEL_FILE")
    if requested_filename:
        if requested_filename not in gguf_files:
            print(f"✗ LOCAL_LLM_MODEL_FILE not found in repo: {requested_filename}")
            exit(1)
        model_filename = requested_filename
    else:
        model_filename = _pick_default_model(gguf_files)

    model_path = MODELS_DIR / model_filename
    
    if model_path.exists():
        file_size_gb = model_path.stat().st_size / (1024 ** 3)
        print(f"✓ Model already exists: {model_path}")
        print(f"  Size: {file_size_gb:.2f} GB")
    else:
        print(f"Downloading {model_filename}...")
        print()
        
        downloaded_path = _download_file(REPO_ID, model_filename)
        
        file_size_gb = Path(downloaded_path).stat().st_size / (1024 ** 3)
        print()
        print(f"✓ Download complete!")
        print(f"  File: {downloaded_path}")
        print(f"  Size: {file_size_gb:.2f} GB")

except Exception as e:
    print(f"✗ Error: {e}")
    import traceback
    traceback.print_exc()
    exit(1)
