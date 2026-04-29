# tts-kokoro-gpu

PyTorch + CUDA build of the Kokoro v1.0 TTS engine. Runs on a user's
home Windows 11 box, reached from the Hetzner VPS over Tailscale.

**Do not deploy this to k3s.** The CPU sibling at `services/kokoro/`
is the cluster workload; this directory is the home-host service.

## Contract

Identical FastAPI surface to `services/kokoro/`:

- `POST /tts` — `{text, voice, speed}` → streaming `audio/ogg` (Opus)
- `GET /healthz` — `{ok, model_loaded, voices_loaded}`
- `GET /voices` — voice catalog for the web app's picker
- `GET /metrics` — Prometheus scrape (proxied through tts-web)

Same voice IDs (`af_heart`, `af_bella`, `am_michael`, `am_puck`).
Same Opus encoding (32 kbps, 24 kHz, 60 ms frames). Same cache key
hashes — meaning audio synthesized here is interchangeable with audio
from the VPS CPU service when stored in `tts_cache`.

## Install

Don't run this manually — use the one-shot installer instead:

```powershell
# In an Administrator PowerShell, after cloning the repo:
powershell -ExecutionPolicy Bypass -File scripts\bootstrap-gpu-host.ps1
```

The bootstrap script handles Python 3.11, NSSM, the cu128 PyTorch wheel
(with nightly fallback for Blackwell), Kokoro-82M model download via
HuggingFace, the Windows firewall (allows port 8000 only on the
Tailscale interface), and the NSSM service registration.

## Required env

| Variable | Default | Purpose |
|---|---|---|
| `KOKORO_DEVICE` | `cuda` | `cuda` or `cpu` (CPU is for ad-hoc smoke tests) |
| `KOKORO_DTYPE` | `float32` | `float16` shaves ~30% kernel time on Blackwell |
| `KOKORO_MAX_CONCURRENT_SYNTH` | `1` | Bounded concurrency cap |
| `KOKORO_QUEUE_TIMEOUT_MS` | `50` | 503 backpressure threshold |
| `HF_HOME` | `~/.cache/huggingface` | Set to a LocalSystem-readable path |

The bootstrap script sets `HF_HOME=C:\ProgramData\tts-kokoro-gpu\huggingface`
so the model cache survives logoff/reboot and is readable by the
LocalSystem service account.

## Verify

```powershell
Get-Service tts-kokoro-gpu                # Status: Running, StartType: Automatic
nvidia-smi                                # python.exe owning ~1-2 GiB VRAM
curl http://localhost:8000/healthz        # {"ok":true,"model_loaded":true,...}

# From the VPS (over tailnet):
curl http://<windows-tailnet-name>:8000/healthz
```

## Logs

NSSM redirects stdout/stderr to:
- `C:\ProgramData\tts-kokoro-gpu\logs\stdout.log`
- `C:\ProgramData\tts-kokoro-gpu\logs\stderr.log`

Both rotate at 10 MiB. They're not shipped to Loki in v1.

## Why this is separate from `services/kokoro/`

The CPU pod runs in k3s on Linux, gets a tiny container image
(no PyTorch), and uses `kokoro-onnx` (ONNX Runtime). This directory
runs on Windows native Python with PyTorch CUDA. They share voice IDs
and the FastAPI contract but no code — the engines are different
implementations of the same model. Don't try to merge them; the
overlap doesn't justify the deployment complexity.
