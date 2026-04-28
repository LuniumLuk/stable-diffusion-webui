param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("hf-diffusers", "direct")]
    [string]$Mode,

    [Parameter(Mandatory = $false)]
    [string]$RepoId,

    [Parameter(Mandatory = $false)]
    [string]$Url,

    [Parameter(Mandatory = $true)]
    [string]$Name,

    [string]$HfEndpoint = "https://hf-mirror.com",
    [string]$PipIndexUrl = "https://pypi.tuna.tsinghua.edu.cn/simple"
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$pythonExe = Join-Path $repoRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $pythonExe)) {
    throw "Local venv not found at .venv. Create it first."
}

$null = New-Item -ItemType Directory -Force -Path "tmp"
$null = New-Item -ItemType Directory -Force -Path "models\Stable-diffusion"

function Install-MinDeps {
    param([string]$Py)

    & $Py -m pip install -U pip -i $PipIndexUrl
    & $Py -m pip install huggingface_hub safetensors "numpy<2" -i $PipIndexUrl

    # Torch is required for diffusers->checkpoint conversion.
    & $Py -m pip install torch==2.1.2 torchvision==0.16.2 -i $PipIndexUrl --extra-index-url https://download.pytorch.org/whl/cu121
}

if ($Mode -eq "hf-diffusers") {
    if ([string]::IsNullOrWhiteSpace($RepoId)) {
        throw "-RepoId is required when -Mode hf-diffusers"
    }

    Install-MinDeps -Py $pythonExe

    $env:HF_ENDPOINT = $HfEndpoint
    $localDir = "models/Diffusers/$Name"
    & $pythonExe -c "from huggingface_hub import snapshot_download; snapshot_download(repo_id='$RepoId', local_dir=r'$localDir'); print('Downloaded to', r'$localDir')"

    $converter = "tmp\convert_diffusers_to_original_sdxl.py"
    Invoke-WebRequest -Uri "https://raw.githubusercontent.com/huggingface/diffusers/main/scripts/convert_diffusers_to_original_sdxl.py" -OutFile $converter

    $outPath = "models\Stable-diffusion\$Name.safetensors"
    & $pythonExe $converter --model_path "models\Diffusers\$Name" --checkpoint_path $outPath --use_safetensors --half

    Write-Host "Done. Checkpoint created:" $outPath
}
elseif ($Mode -eq "direct") {
    if ([string]::IsNullOrWhiteSpace($Url)) {
        throw "-Url is required when -Mode direct"
    }

    $targetPath = "models\Stable-diffusion\$Name"
    Invoke-WebRequest -Uri $Url -OutFile $targetPath
    Write-Host "Done. File downloaded:" $targetPath
}
