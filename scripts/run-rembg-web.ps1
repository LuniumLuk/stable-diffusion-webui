$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$pythonExe = Join-Path $repoRoot ".venv\Scripts\python.exe"

if (-not (Test-Path $pythonExe)) {
    throw "Local venv not found at .venv."
}

$env:HF_ENDPOINT = "https://hf-mirror.com"
& $pythonExe (Join-Path $PSScriptRoot "rembg_web.py") --host 127.0.0.1 --port 7862
