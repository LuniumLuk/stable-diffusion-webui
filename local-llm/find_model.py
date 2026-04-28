"""Fetch GGUF model filenames from the configured Hugging Face endpoint."""
import os

import requests


REPO_ID = "Olak17/Qwen2.5-Coder-1.5B-Unsensored-DPO-i1-GGUF"
HF_ENDPOINT = os.getenv("HF_ENDPOINT", "https://hf-mirror.com").rstrip("/")
API_URL = f"{HF_ENDPOINT}/api/models/{REPO_ID}"

print(f"Fetching model metadata from {REPO_ID}...")
print(f"Endpoint: {HF_ENDPOINT}")
print()

try:
    response = requests.get(API_URL, timeout=20)
    response.raise_for_status()
    data = response.json()

    gguf_files = sorted(
        [f for f in data.get("siblings", []) if f.get("rfilename", "").endswith(".gguf")],
        key=lambda f: f.get("rfilename", "").lower(),
    )

    if not gguf_files:
        print("No .gguf files found in repository metadata.")
    else:
        print(f"Found {len(gguf_files)} GGUF file(s):")
        print()
        for item in gguf_files:
            filename = item.get("rfilename", "")
            size = item.get("size")
            if isinstance(size, int):
                size_text = f"{size / (1024 ** 3):.2f} GB"
            else:
                size_text = "N/A"
            print(f"  - {filename}")
            print(f"    Size: {size_text}")

except requests.exceptions.RequestException as exc:
    print(f"Error: {exc}")
