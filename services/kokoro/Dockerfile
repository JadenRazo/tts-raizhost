# syntax=docker/dockerfile:1.7

# --- Stage 1: build the venv --------------------------------------------------
FROM python:3.11-slim AS builder

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# Build deps for any wheel that needs to compile. piper-phonemize ships
# manylinux wheels for cp311; this is a safety net for transitive deps.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /build
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# --- Stage 2: runtime ---------------------------------------------------------
FROM python:3.11-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/opt/venv/bin:$PATH" \
    KOKORO_MODELS_DIR=/models/kokoro

# ffmpeg for libopus encoding. tini gives us a real PID 1 so SIGTERM
# actually reaches uvicorn when k8s rolls the pod. espeak-ng is the
# G2P backend kokoro-onnx uses for English fallback phonemization;
# misaki ships pure-python G2P for some langs but English routes
# through espeak-ng.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        ffmpeg \
        espeak-ng \
        tini \
 && rm -rf /var/lib/apt/lists/*

COPY --from=builder /opt/venv /opt/venv

# Non-root user. UID/GID 10001 matches the rest of raizhost-infra's
# pod security baseline (runAsNonRoot, no privilege escalation).
RUN groupadd --system --gid 10001 app \
 && useradd --system --uid 10001 --gid 10001 --no-create-home --shell /sbin/nologin app

WORKDIR /app
COPY app.py synth.py encode.py ./
RUN chown -R 10001:10001 /app

USER 10001:10001
EXPOSE 8000

ENTRYPOINT ["/usr/bin/tini", "--"]
# Explicit loop/http impls. uvloop's libuv-backed event loop and
# httptools' C parser are noticeably faster than the asyncio +
# h11 defaults — both are pulled in by `uvicorn[standard]`.
CMD ["uvicorn", "app:app", \
     "--host", "0.0.0.0", \
     "--port", "8000", \
     "--workers", "1", \
     "--loop", "uvloop", \
     "--http", "httptools", \
     "--no-access-log"]
