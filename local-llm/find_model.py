"""Fetch GGUF models from HuggingFace repo using web scraping."""
import requests
from bs4 import BeautifulSoup
import re

REPO_URL = "https://huggingface.co/DavidAU/GLM-4.7-Flash-Uncensored-Heretic-NEO-CODE-Imatrix-MAX-GGUF"

print(f"Fetching {REPO_URL}...")
print()

try:
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
    response = requests.get(REPO_URL, headers=headers, timeout=10)
    response.raise_for_status()
    
    # Look for download links with .gguf extension
    gguf_pattern = r'href="([^"]*\.gguf[^"]*)"'
    matches = re.findall(gguf_pattern, response.text)
    
    if matches:
        print("Found GGUF files:")
        print()
        for url in matches:
            # Extract filename
            if '/blob/' in url:
                filename = url.split('/')[-1]
                print(f"  • {filename}")
                print(f"    URL: {url}")
                print()
    else:
        print("No .gguf files found in page.")
        print()
        print("Trying to extract from page source...")
        
        # Try alternative method - look for data attributes
        if 'GLM' in response.text:
            print("✓ Repository page loaded successfully")
            print("  Repository appears to exist")
        else:
            print("✗ Repository page not found or empty")

except requests.exceptions.RequestException as e:
    print(f"Error: {e}")
