"""tts FastAPI service (Kokoro v1.0, ONNX Runtime CPU).

Endpoints:
  POST /tts       — synthesize text to Opus audio
  GET  /healthz   — k8s liveness/readiness probe
  GET  /voices    — voice catalog for the web app's picker

Engine: Kokoro v1.0 (https://huggingface.co/hexgrad/Kokoro-82M) via
the kokoro-onnx package. CPU path; the home-GPU service in
services/kokoro-gpu/ uses PyTorch CUDA for the perf win and shares the
same model weights so voices are identical across backends.

The service is consumed only by the in-cluster Next.js web app's
`/api/tts` proxy. It is never directly exposed to the public internet,
so we don't bother with auth or CORS here. If that changes, add a
shared-secret header check before exposing it.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import sys
import time
from typing import Any

from fastapi import FastAPI, HTTPException, Response
from fastapi.responses import JSONResponse, StreamingResponse
from prometheus_client import CONTENT_TYPE_LATEST, REGISTRY, generate_latest
from pydantic import BaseModel, Field, ValidationError

from encode import encode_opus_stream
from metrics import (
    overflow_total,
    queue_wait_seconds,
    synth_inputs_total,
    synth_to_first_byte,
    synth_to_last_byte,
    text_len_bucket,
)
from synth import (
    ALLOWED_VOICES,
    QueueOverflow,
    is_loaded,
    list_voices,
    loaded_voice_count,
    synth_slot,
    synthesize_stream,
    warmup,
)

# OTel manual spans. The k8s OpenTelemetry Operator injects the SDK at
# pod start (deploy/k8s/instrumentation.yaml — parentbased_traceidratio
# 5%, exporter -> Tempo), so by the time this import runs the API is
# already wired to a real tracer. We fall back to a no-op tracer if the
# SDK isn't present (dev shells, unit tests).
try:
    from opentelemetry import trace as _otel_trace  # type: ignore[import-not-found]
    _otel_tracer = _otel_trace.get_tracer('tts-kokoro')
    _OTEL_OK = True
except Exception:  # pragma: no cover
    _otel_tracer = None
    _OTEL_OK = False


class _NoSpan:
    def set_attribute(self, *args, **kwargs) -> None: pass  # noqa: E704
    def record_exception(self, *args, **kwargs) -> None: pass  # noqa: E704
    def set_status(self, *args, **kwargs) -> None: pass  # noqa: E704
    def end(self, *args, **kwargs) -> None: pass  # noqa: E704


def _span(name: str, **attrs: Any):
    if not _OTEL_OK or _otel_tracer is None:
        return _NoSpan()
    span = _otel_tracer.start_span(name)
    for k, v in attrs.items():
        if v is None:
            continue
        try:
            span.set_attribute(k, v)
        except Exception:
            pass
    return span

# Structured-JSON logging. Emit one object per line so the cluster's log
# pipeline (Promtail in Phase 8) can index without a custom parser.
class _JsonFormatter(logging.Formatter):
    _RESERVED = {
        'name', 'msg', 'args', 'levelname', 'levelno', 'pathname', 'filename',
        'module', 'exc_info', 'exc_text', 'stack_info', 'lineno', 'funcName',
        'created', 'msecs', 'relativeCreated', 'thread', 'threadName',
        'processName', 'process', 'message', 'asctime', 'taskName',
    }

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            'level': record.levelname,
            'logger': record.name,
            'msg': record.getMessage(),
            'ts': self.formatTime(record, '%Y-%m-%dT%H:%M:%S%z'),
        }
        for key, value in record.__dict__.items():
            if key in self._RESERVED or key.startswith('_'):
                continue
            payload[key] = value
        if record.exc_info:
            payload['exc'] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


def _configure_logging() -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(_JsonFormatter())
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(logging.INFO)
    # Quiet noisy uvicorn access logs — we log per-request below.
    logging.getLogger('uvicorn.access').setLevel(logging.WARNING)


_configure_logging()
log = logging.getLogger('tts-kokoro')


app = FastAPI(title='tts-kokoro', version='1', docs_url=None, redoc_url=None)


@app.on_event('startup')
async def _on_startup() -> None:
    # Eager model load + per-pool-member warmup synthesis. Runs in the
    # background so the HTTP server is up immediately and /healthz can
    # answer (with model_loaded=false) while the pool finishes
    # initializing. The first request that arrives after warmup
    # completes pays no cold-start cost.
    asyncio.create_task(warmup())


class TTSRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=2000)
    voice: str = Field(...)
    speed: float = Field(..., ge=0.5, le=2.0)


# Last-mile defensive sanitizer for synth input. The web app's
# text-cleanup module (apps/web/src/lib/text-cleanup.ts) already runs at
# upload time and again at the sentence-insert API; this is a final
# safety net for any sentence that slipped through (legacy data, future
# clients, manual DB edits). Keep it minimal and idempotent — Kokoro
# handles ordinary punctuation and unicode quotes fine, so we only
# normalize whitespace and strip control characters.
_KOKORO_CONTROL_CHARS = re.compile(r'[\x00-\x08\x0b-\x1f\x7f]')
# Unicode whitespace via explicit escapes — a literal range like
# [\u200a-\u202f] would swallow em-dash (\u2014) and en-dash (\u2013).
_KOKORO_UNICODE_WS = re.compile(
    '[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]'
)
_KOKORO_INVISIBLES = re.compile(
    '[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]'
)


def sanitize_for_synth(text: str) -> str:
    s = _KOKORO_CONTROL_CHARS.sub('', text)
    s = _KOKORO_INVISIBLES.sub('', s)
    s = _KOKORO_UNICODE_WS.sub(' ', s)
    s = re.sub(r'[ \t]+', ' ', s).strip()
    return s


@app.exception_handler(ValidationError)
async def _on_validation_error(_request, exc: ValidationError):  # type: ignore[no-untyped-def]
    return JSONResponse(status_code=400, content={'error': 'validation', 'detail': exc.errors()})


@app.get('/healthz')
async def healthz() -> Response:
    # Reflect readiness in the status code so the k8s readiness probe
    # and the web app's circuit breaker treat a half-up service as
    # down. 200-headers-then-broken-stream is worse than 503.
    loaded = is_loaded()
    body = {
        'ok': loaded,
        'model_loaded': loaded,
        'voices_loaded': loaded_voice_count(),
    }
    return JSONResponse(status_code=200 if loaded else 503, content=body)


@app.get('/metrics', include_in_schema=False)
async def metrics() -> Response:
    return Response(generate_latest(REGISTRY), media_type=CONTENT_TYPE_LATEST)


@app.get('/voices')
async def voices() -> dict[str, Any]:
    return {
        'voices': [
            {'id': v.id, 'language': v.language, 'gender': v.gender}
            for v in list_voices()
        ]
    }


@app.post('/tts')
async def tts(req: TTSRequest) -> Response:
    if req.voice not in ALLOWED_VOICES:
        # Don't echo the supplied voice in the error body — clients can
        # consult /voices for the canonical list.
        raise HTTPException(status_code=400, detail='unknown voice')

    synth_text = sanitize_for_synth(req.text)
    if not synth_text:
        # Sentence collapsed to nothing under the sanitizer — caller sent
        # only control characters or invisible whitespace. Treat as a 400
        # rather than feeding empty input to the model.
        raise HTTPException(status_code=400, detail='empty after sanitize')
    text_len = len(synth_text)
    len_bucket = text_len_bucket(text_len)
    started = time.perf_counter()
    metrics: dict[str, Any] = {}
    synth_inputs_total.labels(voice=req.voice, text_len_bucket=len_bucket).inc()

    # Acquire the bounded-concurrency slot up-front. If the queue is
    # already saturated this raises QueueOverflow synchronously (well,
    # within PIPER_QUEUE_TIMEOUT_MS), so we can return a clean 503
    # before any response headers are sent. The slot stays held for the
    # entire stream lifetime via the context manager below.
    queue_span = _span(
        'kokoro.queue_wait',
        **{
            'kokoro.voice': req.voice,
            'kokoro.text_len_bucket': len_bucket,
            'kokoro.text_length': text_len,
        },
    )
    slot = synth_slot(metrics)
    try:
        await slot.__aenter__()
    except QueueOverflow:
        wait_ms = metrics.get('queue_wait_ms')
        if isinstance(wait_ms, (int, float)):
            queue_wait_seconds.observe(wait_ms / 1000.0)
        overflow_total.labels(voice=req.voice).inc()
        queue_span.set_attribute('kokoro.queue_wait_ms', wait_ms if isinstance(wait_ms, (int, float)) else 0)
        queue_span.set_attribute('kokoro.overflow', True)
        queue_span.end()
        log.warning(
            'tts queue overflow',
            extra={
                'voice': req.voice, 'speed': req.speed,
                'text_length': text_len,
                'queue_wait_ms': wait_ms,
            },
        )
        raise HTTPException(
            status_code=503,
            detail='busy',
            headers={'Retry-After': '1'},
        )

    wait_ms = metrics.get('queue_wait_ms')
    if isinstance(wait_ms, (int, float)):
        queue_wait_seconds.observe(wait_ms / 1000.0)
    queue_span.set_attribute(
        'kokoro.queue_wait_ms',
        wait_ms if isinstance(wait_ms, (int, float)) else 0,
    )
    queue_span.set_attribute(
        'kokoro.concurrent_in_flight',
        metrics.get('concurrent_in_flight', 0),
    )
    queue_span.end()

    async def stream():
        first_byte_ms: int | None = None
        bytes_out = 0
        synth_span = _span(
            'kokoro.synth',
            **{
                'kokoro.voice': req.voice,
                'kokoro.text_len_bucket': len_bucket,
                'kokoro.text_length': text_len,
                'kokoro.speed': req.speed,
            },
        )
        try:
            pcm = synthesize_stream(synth_text, req.voice, req.speed, metrics)
            async for chunk in encode_opus_stream(pcm):
                if first_byte_ms is None:
                    first_byte_ms = int((time.perf_counter() - started) * 1000)
                    synth_to_first_byte.labels(
                        voice=req.voice, text_len_bucket=len_bucket,
                    ).observe(first_byte_ms / 1000.0)
                    synth_span.set_attribute('kokoro.ms_to_first_byte', first_byte_ms)
                bytes_out += len(chunk)
                yield chunk
        except AssertionError as exc:
            synth_span.record_exception(exc)
            synth_span.set_attribute('kokoro.outcome', 'rejected')
            log.warning(
                'synth rejected input',
                extra={
                    'voice': req.voice, 'speed': req.speed,
                    'text_length': text_len, 'reason': str(exc),
                },
            )
            raise
        except Exception as exc:
            synth_span.record_exception(exc)
            synth_span.set_attribute('kokoro.outcome', 'error')
            log.exception(
                'tts stream failed',
                extra={'voice': req.voice, 'speed': req.speed, 'text_length': text_len},
            )
            raise
        else:
            total_ms = int((time.perf_counter() - started) * 1000)
            synth_to_last_byte.labels(
                voice=req.voice, text_len_bucket=len_bucket,
            ).observe(total_ms / 1000.0)
            synth_span.set_attribute('kokoro.ms_total', total_ms)
            synth_span.set_attribute('kokoro.bytes_out', bytes_out)
            synth_span.set_attribute('kokoro.outcome', 'ok')
            log.info(
                'tts stream ok',
                extra={
                    'voice': req.voice,
                    'speed': req.speed,
                    'text_length': text_len,
                    'ms_to_first_byte': first_byte_ms,
                    'ms_total': total_ms,
                    'bytes_out': bytes_out,
                    **metrics,
                },
            )
        finally:
            synth_span.end()
            await slot.__aexit__(None, None, None)

    return StreamingResponse(
        stream(),
        media_type='audio/ogg',
        headers={'Cache-Control': 'no-store'},
    )
