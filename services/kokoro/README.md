# tts-kokoro

FastAPI front for `kokoro-onnx`. Takes `{ text, voice, speed }`, runs
ONNX inference on CPU, pipes the resulting 24 kHz mono float32 PCM
through ffmpeg → libopus, and returns the encoded bytes.

## Endpoints

| Method | Path       | Purpose                                                                |
|--------|------------|------------------------------------------------------------------------|
| POST   | `/tts`     | Synthesize. Body `{ text, voice, speed }`. Returns `audio/ogg` (Opus). |
| GET    | `/healthz` | k8s liveness/readiness. Reports model load state and voice count.      |
| GET    | `/voices`  | Voice catalog for the web app's picker.                                |

The model + voices bundle are not baked into the image (≈ 350 MB
combined). They are downloaded once per node by
`scripts/bootstrap-models.sh` into `/var/lib/tts-raizhost/models` and
mounted read-only at `/models` inside the container.

## Local smoke test

```bash
# 1. Pull the models locally (cached after first run).
MODELS_DIR=./models ../../scripts/bootstrap-models.sh

# 2. Build and run.
docker build -t tts-kokoro:dev .
docker run --rm -p 8000:8000 -v "$(pwd)/models:/models:ro" tts-kokoro:dev

# 3. In another shell — synthesize.
curl -X POST http://localhost:8000/tts \
  -H 'content-type: application/json' \
  -d '{"text":"Hello world. This is the Kokoro service speaking.","voice":"af_bella","speed":1.0}' \
  --output hello.opus

# 4. Confirm the file is real Opus and play it.
ffprobe hello.opus 2>&1 | head -5    # should report codec_name=opus
ffplay hello.opus                     # or any player

# 5. Health and voice catalog.
curl -s http://localhost:8000/healthz | jq
curl -s http://localhost:8000/voices  | jq
```

The first `/tts` call after container start triggers the lazy model
load (~1-3s on CPU). Subsequent calls reuse the loaded session.
`/healthz` will return `{ ok: true, model_loaded: false }` until the
first synth completes — that's intentional and what k8s probes use.

## Configuration

| Env                   | Default                          | Notes                              |
|-----------------------|----------------------------------|------------------------------------|
| `KOKORO_MODEL_PATH`   | `/models/kokoro-v1.0.onnx`       | Override for non-standard mounts.  |
| `KOKORO_VOICES_PATH`  | `/models/voices-v1.0.bin`        | Same.                              |

## Layout

```
services/kokoro/
├── app.py            FastAPI app, structured JSON logging
├── synth.py          Lazy-loaded Kokoro singleton, voice catalog
├── encode.py         Async ffmpeg wrapper (PCM → Opus)
├── requirements.txt
├── Dockerfile        Multi-stage; final image is python:3.11-slim + ffmpeg
└── README.md         (this file)
```

## Operational notes

- Single replica is the deploy target. The model is held in process
  memory; restart the pod to free it.
- The web app's `/api/tts` proxy is the only intended caller and owns
  the on-disk Opus cache. This service emits `Cache-Control: no-store`
  and never writes audio to disk.
- We log text length, voice id, speed, and synthesis/encode timings.
  We never log the input text — it can contain user-uploaded book
  content. Don't add it to logs.
