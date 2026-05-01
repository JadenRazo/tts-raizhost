# GPU host tune: KOKORO concurrency + queue timeout

**Scope.** Runtime env update on the Windows GPU host
(`desktop-7hf36jh`, Tailscale `100.107.3.72`) for the
`tts-kokoro-gpu` NSSM service. The repo's
`scripts/bootstrap-gpu-host.ps1:402-409` is already updated; this runbook
applies the same change to the running service without re-running the
full bootstrap.

**Why.** Single-slot synth on the GPU pod was the binding constraint:
prerender + 2 live readers collided and the 200 ms queue timeout
returned 503s. Two concurrent CUDA sessions on Kokoro-82M fit easily in
12 GB VRAM, double effective live-synth capacity, and 500 ms gives a
queued request enough headroom to survive a single in-flight prerender
slot release.

**Apply** (PowerShell, Administrator, on `desktop-7hf36jh`):

```powershell
# Reset the env block in one shot. AppEnvironmentExtra replaces the
# whole block, so include every existing var even if unchanged.
$svcName  = 'tts-kokoro-gpu'
$ffmpegDir = 'C:\ProgramData\tts-kokoro-gpu\ffmpeg\bin'   # adjust if you customised it
$hfHome    = 'C:\ProgramData\tts-kokoro-gpu\huggingface'
$svcPath   = "$ffmpegDir;$env:Path"

nssm set $svcName AppEnvironmentExtra `
    "HF_HOME=$hfHome" `
    "KOKORO_DEVICE=cuda" `
    "KOKORO_DTYPE=float32" `
    "KOKORO_MAX_CONCURRENT_SYNTH=2" `
    "KOKORO_QUEUE_TIMEOUT_MS=500" `
    "PYTHONUNBUFFERED=1" `
    "PATH=$svcPath"

nssm restart $svcName
Start-Sleep -Seconds 5
Get-Service $svcName    # expect Status: Running
```

**Verify** (from any Tailscale-connected box):

```bash
curl -sS http://100.107.3.72:8000/healthz
# => {"ok":true,"model_loaded":true,"voices_loaded":5}

curl -sS http://100.107.3.72:8000/metrics | grep -E "(kokoro_max|queue_saturation)"
# look for kokoro_max_concurrent_synth=2 (or similar — name depends on services/kokoro-gpu/metrics.py)
```

**Rollback.** Re-run the same `nssm set` block with `=1` and `=200`,
then `nssm restart`. No state on disk is affected.
