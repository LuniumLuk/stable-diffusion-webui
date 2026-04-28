"""List available GGUF models in the configured Hugging Face repository."""
import os

import requests


REPO_ID = "Olak17/Qwen2.5-Coder-1.5B-Unsensored-DPO-i1-GGUF"
HF_ENDPOINT = os.getenv("HF_ENDPOINT", "https://hf-mirror.com").rstrip("/")
API_URL = f"{HF_ENDPOINT}/api/models/{REPO_ID}"

print(f"Fetching model info from {REPO_ID}...")
print(f"Endpoint: {HF_ENDPOINT}")
print()

try:
    response = requests.get(API_URL, timeout=20)
    response.raise_for_status()

    data = response.json()
    siblings = data.get("siblings", [])
    gguf_files = sorted(
        [item for item in siblings if item.get("rfilename", "").endswith(".gguf")],
        key=lambda item: item.get("rfilename", "").lower(),
    )

    print("Available files:")
    print()

    if gguf_files:
        for item in gguf_files:
            filename = item.get("rfilename", "")
            size_bytes = item.get("size")
            if isinstance(size_bytes, int):
                size_text = f"{size_bytes / (1024 ** 3):.2f} GB"
            else:
                size_text = "N/A"
            print(f"  - {filename}")
            print(f"    Size: {size_text}")
    else:
        print("  No .gguf files found!")

    print()
    print("Repository Info:")
    print(f"  ID: {data.get('id', 'N/A')}")
    print(f"  Private: {data.get('private', False)}")
    print(f"  Downloads: {data.get('downloads', 'N/A')}")

except requests.exceptions.RequestException as exc:
    print(f"Error: {exc}")
