# bootstrap-gpu-host.ps1 - one-shot Windows installer for tts-kokoro-gpu.
#
# Run as Administrator from the repo root:
#   powershell -ExecutionPolicy Bypass -File .\scripts\bootstrap-gpu-host.ps1
#
# What it does (idempotent - safe to re-run):
#   1.  Verifies Administrator privileges, GPU presence, and >=10 GiB free disk.
#   2.  Installs Python 3.11 via winget (skipped if already installed).
#   3.  Installs NSSM via winget (skipped if already installed).
#   4.  Verifies Tailscale is installed (warns if not).
#   5.  Creates Python venv at .\.venv and installs torch (cu128 stable, with
#       nightly fallback if the stable wheel doesn't support Blackwell sm_120).
#   6.  Installs services\kokoro-gpu\requirements.txt into the venv.
#   7.  Creates C:\ProgramData\tts-kokoro-gpu\{huggingface,logs}.
#   8.  Pre-caches Kokoro-82M model weights (downloads ~360 MB once).
#   9.  Configures Windows Firewall: TCP 8000 inbound on Tailscale interface only.
#  10.  Registers NSSM service `tts-kokoro-gpu`, auto-start, LocalSystem account.
#  11.  Starts the service and verifies it answers /healthz.
#
# Verbose output throughout so you can see what step is happening. Failures
# print red and exit non-zero.

$ErrorActionPreference = 'Stop'
$InformationPreference = 'Continue'

function Write-Step($msg) {
    Write-Host ""
    Write-Host "==> $msg" -ForegroundColor Cyan
}
function Write-Ok($msg)   { Write-Host "    [ok] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "    [warn] $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "    [err] $msg" -ForegroundColor Red }

# -----------------------------------------------------------------------------
# 0. Preflight: admin, GPU, disk space, repo layout
# -----------------------------------------------------------------------------
Write-Step "Preflight checks"

$principal = New-Object Security.Principal.WindowsPrincipal(
    [Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Err "Run this script from an Administrator PowerShell."
    exit 1
}
Write-Ok "Administrator privileges confirmed"

# GPU sanity check.
try {
    $gpu = (& nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader 2>$null)
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($gpu)) {
        throw "nvidia-smi failed"
    }
    Write-Ok "GPU detected: $gpu"
} catch {
    Write-Err "nvidia-smi not found or returned no GPU. Install the latest NVIDIA driver first."
    exit 1
}

# Free disk space - torch cu128 wheel is ~2.5 GB, model weights ~360 MB,
# headroom for venv + cache. Refuse to install on <10 GiB free.
$freeBytes = (Get-PSDrive -Name C).Free
$freeGiB = [math]::Round($freeBytes / 1GB, 1)
if ($freeGiB -lt 10) {
    Write-Err "Only $freeGiB GiB free on C:\. Need >=10 GiB."
    exit 1
}
Write-Ok "Disk free on C:\: $freeGiB GiB"

# Repo root: directory containing this script's parent (scripts\..)
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$gpuDir   = Join-Path $repoRoot 'services\kokoro-gpu'
if (-not (Test-Path $gpuDir)) {
    Write-Err "Expected services\kokoro-gpu under $repoRoot - wrong directory?"
    exit 1
}
Write-Ok "Repo root: $repoRoot"

# -----------------------------------------------------------------------------
# 1. Python 3.11
# -----------------------------------------------------------------------------
Write-Step "Python 3.11"

function Find-Python311 {
    foreach ($cmd in @('py', 'python3.11', 'python')) {
        try {
            $exe = Get-Command $cmd -ErrorAction SilentlyContinue
            if ($null -eq $exe) { continue }
            $versionOutput = if ($cmd -eq 'py') {
                (& py -3.11 --version 2>&1)
            } else {
                (& $cmd --version 2>&1)
            }
            if ($versionOutput -match '3\.11\.\d+') {
                if ($cmd -eq 'py') {
                    return @{ Cmd = 'py'; Args = @('-3.11') }
                }
                return @{ Cmd = $exe.Source; Args = @() }
            }
        } catch {}
    }
    return $null
}

$python = Find-Python311
if ($null -eq $python) {
    Write-Host "    Installing Python 3.11 via winget..."
    winget install --id Python.Python.3.11 --silent --accept-source-agreements --accept-package-agreements
    if ($LASTEXITCODE -ne 0) {
        Write-Err "winget failed to install Python 3.11. Install manually from python.org."
        exit 1
    }
    # Refresh PATH so the new python becomes visible without a new shell.
    $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                [System.Environment]::GetEnvironmentVariable('Path', 'User')
    $python = Find-Python311
    if ($null -eq $python) {
        Write-Err "Python 3.11 still not found after install. Open a new shell and re-run."
        exit 1
    }
}
$pythonExe = if ($python.Cmd -eq 'py') { 'py' } else { $python.Cmd }
$pythonArgs = $python.Args
Write-Ok "Python 3.11 found: $pythonExe $($pythonArgs -join ' ')"

# -----------------------------------------------------------------------------
# 2. NSSM
# -----------------------------------------------------------------------------
Write-Step "NSSM"

if ($null -eq (Get-Command nssm -ErrorAction SilentlyContinue)) {
    Write-Host "    Installing NSSM via winget..."
    winget install --id NSSM.NSSM --silent --accept-source-agreements --accept-package-agreements
    if ($LASTEXITCODE -ne 0) {
        Write-Err "winget failed to install NSSM. Install manually from nssm.cc."
        exit 1
    }
    $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                [System.Environment]::GetEnvironmentVariable('Path', 'User')
}
if ($null -eq (Get-Command nssm -ErrorAction SilentlyContinue)) {
    Write-Err "nssm still not on PATH. Open a new shell and re-run."
    exit 1
}
Write-Ok "NSSM available"

# -----------------------------------------------------------------------------
# 2b. ffmpeg (libopus encoder for the PCM -> Opus pipeline in encode.py)
# -----------------------------------------------------------------------------
Write-Step "ffmpeg"

if ($null -eq (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    Write-Host "    Installing ffmpeg via winget..."
    winget install --id Gyan.FFmpeg --silent --scope machine --accept-source-agreements --accept-package-agreements
    if ($LASTEXITCODE -ne 0) {
        Write-Err "winget failed to install ffmpeg. Install manually from ffmpeg.org."
        exit 1
    }
    $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                [System.Environment]::GetEnvironmentVariable('Path', 'User')
}
if ($null -eq (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    Write-Err "ffmpeg still not on PATH after install. Open a new shell and re-run."
    exit 1
}
# Capture the directory so we can pin it on the service env (NSSM
# captures PATH at install time; explicit AppEnvironmentExtra is safer).
$ffmpegExe = (Get-Command ffmpeg).Source
$ffmpegDir = Split-Path -Parent $ffmpegExe
Write-Ok "ffmpeg available at $ffmpegExe"

# -----------------------------------------------------------------------------
# 3. Tailscale presence check (warning only - install is owned by user)
# -----------------------------------------------------------------------------
Write-Step "Tailscale"

$tailscaleExe = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
if (-not (Test-Path $tailscaleExe)) {
    Write-Warn "Tailscale not installed at $tailscaleExe."
    Write-Warn "The service will still run, but the VPS won't be able to reach it."
    Write-Warn "Install via the MSI from https://tailscale.com/download/windows"
} else {
    $tsStatus = & $tailscaleExe status 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Ok "Tailscale is up"
    } else {
        Write-Warn "Tailscale installed but not logged in. Sign in via the system tray."
    }
}

# -----------------------------------------------------------------------------
# 4. venv + torch (cu128 stable, nightly fallback)
# -----------------------------------------------------------------------------
Write-Step "Python venv"

$venvDir = Join-Path $repoRoot '.venv'
if (-not (Test-Path (Join-Path $venvDir 'Scripts\python.exe'))) {
    Write-Host "    Creating venv at $venvDir"
    & $pythonExe @pythonArgs -m venv $venvDir
    if ($LASTEXITCODE -ne 0) { Write-Err "venv creation failed."; exit 1 }
}
$venvPython = Join-Path $venvDir 'Scripts\python.exe'
$venvPip    = Join-Path $venvDir 'Scripts\pip.exe'
& $venvPython -m pip install --upgrade pip --quiet
Write-Ok "venv ready"

Write-Step "Installing PyTorch (CUDA 12.8)"

$cuIndexStable  = 'https://download.pytorch.org/whl/cu128'
$cuIndexNightly = 'https://download.pytorch.org/whl/nightly/cu128'

# Try stable first.
& $venvPip install --index-url $cuIndexStable "torch>=2.6.0"
if ($LASTEXITCODE -ne 0) {
    Write-Warn "Stable cu128 wheel install failed; trying nightly"
    & $venvPip install --pre --upgrade --index-url $cuIndexNightly torch
    if ($LASTEXITCODE -ne 0) {
        Write-Err "Both stable and nightly torch installs failed."
        exit 1
    }
}

# Verify CUDA actually works on this card. Blackwell (RTX 5070, sm_120)
# silently falls back to CPU on too-old PyTorch. Run a real op.
#
# We write the check to a temp .py file rather than using `python -c
# <heredoc>` because PowerShell 5.1 strips embedded double quotes when
# invoking native exes, which mangles `device="cuda"` into `device=cuda`
# and produces a NameError. Reading from a file sidesteps the parser.
$cudaCheckPy = Join-Path $env:TEMP "tts-cuda-check-$PID.py"
@'
import torch, sys
ok = (
    torch.cuda.is_available()
    and torch.zeros(1, device='cuda').add(1).sum().item() == 1.0
)
print('CUDA_OK' if ok else 'CUDA_BROKEN')
print('torch', torch.__version__, 'cuda', torch.version.cuda)
sys.exit(0 if ok else 2)
'@ | Set-Content -Path $cudaCheckPy -Encoding ASCII

$cudaCheck = & $venvPython $cudaCheckPy
$cudaExit  = $LASTEXITCODE
if ($cudaExit -ne 0) {
    Write-Warn "CUDA op failed on stable wheel. Falling back to nightly..."
    & $venvPip install --pre --upgrade --index-url $cuIndexNightly torch
    if ($LASTEXITCODE -ne 0) { Write-Err "Nightly install failed."; exit 1 }

    $cudaCheck = & $venvPython $cudaCheckPy
    if ($LASTEXITCODE -ne 0) {
        Remove-Item $cudaCheckPy -Force -ErrorAction SilentlyContinue
        Write-Err "CUDA still broken after nightly install. GPU may need a newer driver."
        exit 1
    }
}
Remove-Item $cudaCheckPy -Force -ErrorAction SilentlyContinue
Write-Ok "PyTorch CUDA verified working"
$cudaCheck | ForEach-Object { Write-Host "       $_" }

# -----------------------------------------------------------------------------
# 5. Install requirements.txt (kokoro, fastapi, etc.)
# -----------------------------------------------------------------------------
Write-Step "Installing kokoro-gpu requirements"

$reqFile = Join-Path $gpuDir 'requirements.txt'
& $venvPip install -r $reqFile
if ($LASTEXITCODE -ne 0) { Write-Err "pip install -r requirements.txt failed."; exit 1 }
Write-Ok "Dependencies installed"

# -----------------------------------------------------------------------------
# 6. ProgramData dirs + HF cache
# -----------------------------------------------------------------------------
Write-Step "Service data directories"

$dataDir   = 'C:\ProgramData\tts-kokoro-gpu'
$hfHome    = Join-Path $dataDir 'huggingface'
$logDir    = Join-Path $dataDir 'logs'
foreach ($d in @($dataDir, $hfHome, $logDir)) {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}
# LocalSystem must read these. Default ACLs already allow that, but ensure
# we don't accidentally lock them down.
Write-Ok "Created $dataDir"

# -----------------------------------------------------------------------------
# 7. Pre-cache Kokoro-82M weights
# -----------------------------------------------------------------------------
Write-Step "Pre-caching Kokoro-82M weights"

$env:HF_HOME = $hfHome
# Same temp-file pattern as the CUDA check: dodge PowerShell quote
# stripping on native-exe invocations.
$prefetchPy = Join-Path $env:TEMP "tts-kokoro-prefetch-$PID.py"
$prefetchSrc = @"
import os
os.environ['HF_HOME'] = r'$hfHome'
from kokoro import KPipeline
print('Downloading Kokoro-82M weights into ' + os.environ['HF_HOME'] + '...')
# Two pipelines: 'a' for American (af_*, am_*), 'b' for British (bf_*).
# Voice IDs encode the language in their first character, so the wrong
# pipeline = wrong G2P = wrong vowels.
pipelines = {
    'a': KPipeline(lang_code='a', repo_id='hexgrad/Kokoro-82M', device='cuda'),
    'b': KPipeline(lang_code='b', repo_id='hexgrad/Kokoro-82M', device='cuda'),
}
voices = [
    ('a', 'af_heart'),
    ('a', 'af_bella'),
    ('b', 'bf_emma'),
    ('a', 'am_michael'),
    ('a', 'am_puck'),
]
for code, v in voices:
    pipelines[code].load_voice(v)
print('Done.')
"@
$prefetchSrc | Set-Content -Path $prefetchPy -Encoding ASCII
& $venvPython $prefetchPy
$prefetchExit = $LASTEXITCODE
Remove-Item $prefetchPy -Force -ErrorAction SilentlyContinue
if ($prefetchExit -ne 0) { Write-Err "Kokoro pre-cache failed."; exit 1 }
Write-Ok "Kokoro weights cached"

# -----------------------------------------------------------------------------
# 8. Windows Firewall: allow 8000 inbound on Tailscale interface only
# -----------------------------------------------------------------------------
Write-Step "Windows Firewall rules"

# Rule 1: allow inbound TCP 8000 on the Tailscale interface (alias usually
# 'Tailscale' but some installs name it 'tailscale0' - we look it up).
$tsAdapter = Get-NetAdapter | Where-Object {
    $_.InterfaceAlias -match '^Tailscale' -or $_.InterfaceDescription -match 'Tailscale'
} | Select-Object -First 1

if ($null -eq $tsAdapter) {
    Write-Warn "Tailscale interface not found; skipping firewall rules."
    Write-Warn "If Tailscale is installed but not yet logged in, log in then re-run this step."
} else {
    $alias = $tsAdapter.InterfaceAlias
    Write-Host "       Tailscale adapter: $alias"

    # Remove any prior rules from a previous run.
    Get-NetFirewallRule -DisplayName 'tts-kokoro-gpu*' -ErrorAction SilentlyContinue |
        Remove-NetFirewallRule -ErrorAction SilentlyContinue

    New-NetFirewallRule `
        -DisplayName 'tts-kokoro-gpu (Tailscale only)' `
        -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8000 `
        -InterfaceAlias $alias -Profile Any | Out-Null

    Write-Ok "Allowed TCP 8000 inbound on $alias"
}

# -----------------------------------------------------------------------------
# 9. NSSM service registration
# -----------------------------------------------------------------------------
Write-Step "NSSM service"

$svcName = 'tts-kokoro-gpu'

# Stop and remove any prior service so we can re-install cleanly.
$existing = Get-Service -Name $svcName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "    Removing existing $svcName service"
    nssm stop    $svcName confirm  | Out-Null
    nssm remove  $svcName confirm  | Out-Null
    Start-Sleep -Seconds 2
}

$uvicornArgs = @(
    '-m', 'uvicorn', 'app:app',
    '--host', '0.0.0.0',
    '--port', '8000',
    '--workers', '1',
    '--no-access-log'
) -join ' '

nssm install $svcName $venvPython $uvicornArgs | Out-Null
nssm set     $svcName AppDirectory  $gpuDir | Out-Null
nssm set     $svcName Start         SERVICE_AUTO_START | Out-Null
nssm set     $svcName ObjectName    LocalSystem | Out-Null
nssm set     $svcName AppStdout     (Join-Path $logDir 'stdout.log') | Out-Null
nssm set     $svcName AppStderr     (Join-Path $logDir 'stderr.log') | Out-Null
nssm set     $svcName AppRotateFiles 1 | Out-Null
nssm set     $svcName AppRotateBytes 10485760 | Out-Null
nssm set     $svcName AppThrottle   5000 | Out-Null
nssm set     $svcName AppExit Default Restart | Out-Null
nssm set     $svcName AppRestartDelay 2000 | Out-Null
# Pin ffmpeg's directory at the front of PATH so encode.py's
# subprocess.create_subprocess_exec('ffmpeg', ...) finds it without
# relying on the inherited NSSM-captured PATH.
$svcPath = "$ffmpegDir;$env:Path"
nssm set     $svcName AppEnvironmentExtra `
    "HF_HOME=$hfHome" `
    "KOKORO_DEVICE=cuda" `
    "KOKORO_DTYPE=float32" `
    "KOKORO_MAX_CONCURRENT_SYNTH=1" `
    "KOKORO_QUEUE_TIMEOUT_MS=200" `
    "PYTHONUNBUFFERED=1" `
    "PATH=$svcPath" | Out-Null

Write-Ok "Service $svcName registered"

# -----------------------------------------------------------------------------
# 10. Start + verify
# -----------------------------------------------------------------------------
Write-Step "Starting $svcName"

nssm start $svcName | Out-Null
Start-Sleep -Seconds 5

$svc = Get-Service -Name $svcName
Write-Host "       Status:    $($svc.Status)"
Write-Host "       StartType: $($svc.StartType)"

if ($svc.Status -ne 'Running') {
    Write-Err "Service did not enter Running state. Check $logDir\stderr.log"
    exit 1
}

# Health check - model load is async on startup, so we poll for up to 60s.
$healthOk = $false
for ($i = 0; $i -lt 30; $i++) {
    try {
        $r = Invoke-WebRequest -Uri 'http://127.0.0.1:8000/healthz' -TimeoutSec 3 -UseBasicParsing
        if ($r.StatusCode -eq 200) { $healthOk = $true; break }
    } catch {}
    Start-Sleep -Seconds 2
}

if (-not $healthOk) {
    Write-Warn "/healthz didn't answer within 60s. Service is running but model may still be loading."
    Write-Warn "Watch $logDir\stdout.log to see when 'kokoro ready' is logged."
} else {
    Write-Ok "/healthz responded 200 OK"
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host " tts-kokoro-gpu setup complete" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "Service: $svcName"
Write-Host "Logs:    $logDir"
Write-Host "Listens: 0.0.0.0:8000 (firewall-restricted to Tailscale interface)"
Write-Host ""
Write-Host "From the VPS over Tailscale:"
Write-Host "  curl http://<this-host-tailnet-name>:8000/healthz"
Write-Host ""
