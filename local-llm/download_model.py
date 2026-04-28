"""Download GLM-4.7 model from HuggingFace."""
import os
import sys
"""Download GLM-4.7 model using HuggingFace Hub API."""
import os
from pathlib import Path
from huggingface_hub import list_repo_files, hf_hub_download

MODELS_DIR = Path(__file__).parent / "models"
MODELS_DIR.mkdir(exist_ok=True)

REPO_ID = "DavidAU/GLM-4.7-Flash-Uncensored-Heretic-NEO-CODE-Imatrix-MAX-GGUF"

print("=" * 70)
print("GLM-4.7 Model Downloader (HuggingFace Hub)")
print("=" * 70)
print()

print(f"Repository: {REPO_ID}")
print()

try:
    # List all files in repo
    print("Fetching available files...")
    files = list_repo_files(repo_id=REPO_ID)
    
    # Filter for GGUF files
    gguf_files = [f for f in files if f.endswith('.gguf')]
    
    print(f"Found {len(gguf_files)} GGUF file(s):")
    print()
    
    for idx, filename in enumerate(gguf_files, 1):
        print(f"  {idx}. {filename}")
    
    print()
    
    if not gguf_files:
        print("✗ No GGUF files found in repository!")
        exit(1)
    
    # Download the first (usually largest/best) GGUF file
    model_filename = gguf_files[0]
    model_path = MODELS_DIR / model_filename
    
    if model_path.exists():
        file_size_gb = model_path.stat().st_size / (1024 ** 3)
        print(f"✓ Model already exists: {model_path}")
        print(f"  Size: {file_size_gb:.2f} GB")
    else:
        print(f"Downloading {model_filename}...")
        print()
        
        # Download with progress
        downloaded_path = hf_hub_download(
            repo_id=REPO_ID,
            filename=model_filename,
            cache_dir=str(MODELS_DIR.parent),
            local_dir=str(MODELS_DIR),
            local_dir_use_symlinks=False
        )
        
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
