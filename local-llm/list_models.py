"""Find available GGUF models in HuggingFace repo."""
import requests
import json

# HuggingFace API to list files
REPO_ID = "DavidAU/GLM-4.7-Flash-Uncensored-Heretic-NEO-CODE-Imatrix-MAX-GGUF"
API_URL = f"https://huggingface.co/api/models/{REPO_ID}"

print(f"Fetching model info from {REPO_ID}...")
print()

try:
    response = requests.get(API_URL)
    response.raise_for_status()
    
    data = response.json()
    
    # List available files
    print("Available files:")
    print()
    
    if 'siblings' in data:
        gguf_files = [f for f in data['siblings'] if f['rfilename'].endswith('.gguf')]
        
        if gguf_files:
            for f in gguf_files:
                filename = f['rfilename']
                size_gb = f['size'] / (1024 ** 3)
                print(f"  • {filename}")
                print(f"    Size: {size_gb:.2f} GB")
                   size_str = f"  Size: {f.get('size', 'N/A')} bytes" if 'size' in f else "  Size: N/A"
                   print(size_str)
                   print()
        else:
            print("  No .gguf files found!")
               print()
    
        # Also try to get file listing via files-and-versions
        print("Attempting direct file listing...")
        files_url = f"https://huggingface.co/api/repos/DavidAU/GLM-4.7-Flash-Uncensored-Heretic-NEO-CODE-Imatrix-MAX-GGUF/file-list"
        try:
            files_response = requests.get(files_url)
            if files_response.status_code == 200:
                files = files_response.json()
                print("\nActual file list:")
                for f in files:
                    if 'type' in f:
                        if f.get('type') == 'file' and f['name'].endswith('.gguf'):
                            print(f"  • {f['name']}")
    
    # Show repo info
    print("Repository Info:")
    print(f"  ID: {data.get('id', 'N/A')}")
    print(f"  Private: {data.get('private', False)}")
    print(f"  Downloads: {data.get('downloads', 'N/A')}")
    
except requests.exceptions.RequestException as e:
    print(f"Error: {e}")
