param(
    [int[]]$Ports = @(7860, 7861, 7862, 7863, 7864),
    [switch]$DryRun,
    [switch]$VerboseOutput
)

$ErrorActionPreference = "Stop"

function Write-Info {
    param([string]$Message)
    Write-Host "[kill-webuis] $Message"
}

function Add-Pid {
    param(
        [System.Collections.Generic.HashSet[int]]$Set,
        [int]$ProcessId
    )

    if ($ProcessId -gt 0) {
        [void]$Set.Add($ProcessId)
    }
}

$pidSet = [System.Collections.Generic.HashSet[int]]::new()

# 1) Gather PIDs by listening WebUI ports.
foreach ($port in $Ports) {
    try {
        $listeners = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
        foreach ($listener in $listeners) {
            Add-Pid -Set $pidSet -Pid ([int]$listener.OwningProcess)
        }
    }
    catch {
        # Ignore transient socket query failures.
    }
}

# 2) Gather PIDs by command line signatures used by A1111/WebUI launch.
$signature = 'launch.py|webui.py|webui\.bat|webui-user\.bat|stable-diffusion-webui'
try {
    $procs = Get-CimInstance Win32_Process -ErrorAction Stop
    foreach ($proc in $procs) {
        $cmd = [string]$proc.CommandLine
        if (-not [string]::IsNullOrWhiteSpace($cmd) -and $cmd -match $signature) {
            Add-Pid -Set $pidSet -Pid ([int]$proc.ProcessId)
        }
    }
}
catch {
    throw "Failed to enumerate running processes: $($_.Exception.Message)"
}

if ($pidSet.Count -eq 0) {
    Write-Info "No running WebUI process found."
    exit 0
}

$targets = @()
foreach ($targetPid in $pidSet) {
    $proc = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
    if ($null -ne $proc) {
        $targets += $proc
    }
}

if ($targets.Count -eq 0) {
    Write-Info "Matched PIDs are already gone."
    exit 0
}

Write-Info "Found $($targets.Count) WebUI-related process(es)."

foreach ($target in $targets | Sort-Object -Property Id -Unique) {
    if ($VerboseOutput) {
        Write-Info "PID=$($target.Id) Name=$($target.ProcessName)"
    }

    if ($DryRun) {
        Write-Info "[dry-run] Would stop PID=$($target.Id) ($($target.ProcessName))"
        continue
    }

    try {
        Stop-Process -Id $target.Id -Force -ErrorAction Stop
        Write-Info "Stopped PID=$($target.Id) ($($target.ProcessName))"
    }
    catch {
        Write-Info "Failed to stop PID=$($target.Id): $($_.Exception.Message)"
    }
}

if ($DryRun) {
    Write-Info "Dry run complete."
}
else {
    Write-Info "Done."
}
