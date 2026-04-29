"""Kokoro v1.0 TTS engine wrapper (CPU, ONNX Runtime).

Loads `kokoro-onnx` once at startup so /healthz can come up while the
load runs in the background. The Kokoro model is a single ONNX file
(~330 MB) plus a voice-tensor archive (`voices-v1.0.bin`, ~28 MB)
holding all 54 voices keyed by name. We only expose 4 English voices to
the web app — the rest stay loaded but unadvertised.

Why ONNX Runtime (CPU) on the VPS:
  - No PyTorch dependency. ~250 MB image instead of 2 GB+.
  - kokoro-onnx 0.5.0 ships an async streaming generator
    (`Kokoro.create_stream`) that yields per-phoneme-batch chunks, so
    long sentences start producing audio before the model finishes.
  - The home-GPU service (services/kokoro-gpu/) uses PyTorch CUDA for
    the perf win; both paths produce identical voices because they
    share the same Kokoro v1.0 weights.

Concurrency model unchanged from Piper era:
  - bounded concurrency via `synth_slot` (CPU-bound inference contends;
    HTTP 503 with Retry-After is the right backpressure).
  - per-stage timing in structured logs.
  - eager model load on startup so the first user request is warm.
"""

from __future__ import annotations

import asyncio
import logging
import os
import threading
import time
from dataclasses import dataclass
from typing import TYPE_CHECKING

import numpy as np

if TYPE_CHECKING:
    from kokoro_onnx import Kokoro

log = logging.getLogger(__name__)

# Kokoro v1.0 native sample rate. Reading from the model would also work
# but the constant is stable across releases and lets encode.py spin up
# ffmpeg without waiting for the first chunk.
KOKORO_SAMPLE_RATE = 24000


# Voice catalog. Keep this in sync with apps/web's ALLOWED_VOICES set —
# the web app validates voice IDs at the edge so a forged ID returns 400
# instead of bouncing off the synth.
@dataclass(frozen=True)
class _VoiceSpec:
    id: str           # external, stable; used in URLs and DB cacheKey
    language: str
    gender: str
    description: str


# Picked from huggingface.co/hexgrad/Kokoro-82M VOICES.md (Apr 2026).
# af_heart and af_bella are the only A-tier English voices. The two males
# are both C+ — Kokoro has weaker male training data overall, so this is
# the ceiling for English males in v1.0.
VOICE_CATALOG: tuple[_VoiceSpec, ...] = (
    _VoiceSpec(
        id='af_heart',
        language='American English',
        gender='female',
        description='Heart (grade A, default)',
    ),
    _VoiceSpec(
        id='af_bella',
        language='American English',
        gender='female',
        description='Bella (grade A-, warm/expressive)',
    ),
    _VoiceSpec(
        id='bf_emma',
        language='British English',
        gender='female',
        description='Emma (grade B-, British)',
    ),
    _VoiceSpec(
        id='am_michael',
        language='American English',
        gender='male',
        description='Michael (grade C+, well-tested)',
    ),
    _VoiceSpec(
        id='am_puck',
        language='American English',
        gender='male',
        description='Puck (grade C+, polished)',
    ),
)

ALLOWED_VOICES: tuple[str, ...] = tuple(v.id for v in VOICE_CATALOG)
_VOICES_BY_ID: dict[str, _VoiceSpec] = {v.id: v for v in VOICE_CATALOG}

DEFAULT_MODELS_DIR = '/models/kokoro'
DEFAULT_MODEL_FILE = 'kokoro-v1.0.onnx'
DEFAULT_VOICES_FILE = 'voices-v1.0.bin'


@dataclass(frozen=True)
class VoiceInfo:
    id: str
    language: str
    gender: str


def list_voices() -> list[VoiceInfo]:
    return [VoiceInfo(id=v.id, language=v.language, gender=v.gender) for v in VOICE_CATALOG]


# Single Kokoro instance per pod. ONNX Runtime sessions are thread-safe;
# bounded concurrency is enforced in the slot wrapper below.
_kokoro: 'Kokoro | None' = None
_load_lock = threading.Lock()
_warmed_up = False


def models_dir() -> str:
    return os.environ.get('KOKORO_MODELS_DIR', DEFAULT_MODELS_DIR)


def model_path() -> str:
    return os.environ.get(
        'KOKORO_MODEL_PATH',
        os.path.join(models_dir(), DEFAULT_MODEL_FILE),
    )


def voices_path() -> str:
    return os.environ.get(
        'KOKORO_VOICES_PATH',
        os.path.join(models_dir(), DEFAULT_VOICES_FILE),
    )


def is_loaded() -> bool:
    return _kokoro is not None


def loaded_voice_count() -> int:
    return len(ALLOWED_VOICES) if _kokoro is not None else 0


# Bounded concurrency. Inference is CPU-bound; without a guard, parallel
# /tts requests all enter ORT and the intra_op pool fights itself. Cap
# concurrent in-flight syntheses at KOKORO_MAX_CONCURRENT_SYNTH (default
# 1). Requests that can't acquire within KOKORO_QUEUE_TIMEOUT_MS get a
# QueueOverflow which app.py turns into HTTP 503 with Retry-After.
_synth_semaphore: 'asyncio.Semaphore | None' = None
_synth_semaphore_lock = threading.Lock()
_concurrent_in_flight = 0


class QueueOverflow(RuntimeError):
    """Raised when the synth semaphore can't be acquired in time. The
    FastAPI handler turns this into HTTP 503 with Retry-After.
    """


def _max_concurrent_synth() -> int:
    raw = os.environ.get('KOKORO_MAX_CONCURRENT_SYNTH', '1')
    try:
        return max(1, min(16, int(raw)))
    except ValueError:
        return 1


def _queue_timeout_seconds() -> float:
    raw = os.environ.get('KOKORO_QUEUE_TIMEOUT_MS', '50')
    try:
        return max(0.0, float(raw)) / 1000.0
    except ValueError:
        return 0.05


def _get_semaphore() -> 'asyncio.Semaphore':
    global _synth_semaphore
    if _synth_semaphore is None:
        with _synth_semaphore_lock:
            if _synth_semaphore is None:
                _synth_semaphore = asyncio.Semaphore(_max_concurrent_synth())
    return _synth_semaphore


class _SynthSlot:
    """Async context manager that acquires the synth semaphore with a
    short timeout. The FastAPI handler enters this *before* sending
    response headers — so QueueOverflow becomes a clean 503 instead of
    a half-streamed dead response.
    """

    def __init__(self, metrics: dict | None) -> None:
        self._metrics = metrics
        self._sem = _get_semaphore()
        self._held = False

    async def __aenter__(self) -> '_SynthSlot':
        global _concurrent_in_flight
        started = time.perf_counter()
        try:
            await asyncio.wait_for(
                self._sem.acquire(),
                timeout=_queue_timeout_seconds(),
            )
        except asyncio.TimeoutError as exc:
            wait_ms = int((time.perf_counter() - started) * 1000)
            if self._metrics is not None:
                self._metrics['queue_wait_ms'] = wait_ms
                self._metrics['queue_overflow'] = True
            raise QueueOverflow('synth queue full') from exc
        self._held = True
        wait_ms = int((time.perf_counter() - started) * 1000)
        _concurrent_in_flight += 1
        _update_saturation_gauge()
        if self._metrics is not None:
            self._metrics['queue_wait_ms'] = wait_ms
            self._metrics['concurrent_in_flight'] = _concurrent_in_flight
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:  # type: ignore[no-untyped-def]
        global _concurrent_in_flight
        if self._held:
            _concurrent_in_flight -= 1
            self._sem.release()
            self._held = False
            _update_saturation_gauge()


def _update_saturation_gauge() -> None:
    """Reflect the current in-flight count into the Prometheus gauge."""
    try:
        from metrics import queue_saturation
    except Exception:
        return
    cap = max(1, _max_concurrent_synth())
    queue_saturation.set(_concurrent_in_flight / cap)


def synth_slot(metrics: dict | None = None) -> _SynthSlot:
    """Acquire a bounded synthesis slot. Use as `async with synth_slot(metrics):`."""
    return _SynthSlot(metrics)


def _ort_thread_count() -> int:
    """Intra-op thread count for ORT. Match the pod's CPU limit so we
    don't oversubscribe; default is conservative so dev boxes don't
    saturate."""
    raw = os.environ.get('ORT_INTRA_OP_THREADS', '2')
    try:
        return max(1, min(16, int(raw)))
    except ValueError:
        return 2


def _build_session_options():
    """Build ONNX Runtime SessionOptions with bounded threading.

    Returned as the `sess_options` for the Kokoro inference session via
    a custom rt.InferenceSession; falls back to defaults if onnxruntime
    isn't importable (which would make the whole service unusable
    anyway, so this is just a safety net).
    """
    try:
        import onnxruntime as ort
    except ImportError:
        return None
    so = ort.SessionOptions()
    so.intra_op_num_threads = _ort_thread_count()
    so.inter_op_num_threads = 1
    so.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    try:
        so.add_session_config_entry('session.intra_op.allow_spinning', '0')
        so.add_session_config_entry('session.inter_op.allow_spinning', '0')
    except Exception:
        pass
    return so


def _load_blocking() -> None:
    """Synchronously construct the Kokoro instance. Called once from the
    FastAPI startup hook via `asyncio.to_thread`.
    """
    global _kokoro, _warmed_up
    with _load_lock:
        if _kokoro is not None:
            return

        from kokoro_onnx import Kokoro  # type: ignore[import-not-found]
        import onnxruntime as ort

        m_path = model_path()
        v_path = voices_path()
        if not os.path.exists(m_path):
            log.error('kokoro model file missing', extra={'expected_path': m_path})
            return
        if not os.path.exists(v_path):
            log.error('kokoro voices file missing', extra={'expected_path': v_path})
            return

        t0 = time.perf_counter()
        try:
            so = _build_session_options()
            if so is not None:
                # Build the session ourselves so we can pass session
                # options; from_session() accepts a pre-built rt session.
                sess = ort.InferenceSession(m_path, sess_options=so, providers=['CPUExecutionProvider'])
                _kokoro = Kokoro.from_session(sess, v_path)
            else:
                _kokoro = Kokoro(m_path, v_path)
        except Exception as exc:
            log.exception('kokoro load failed', extra={'reason': str(exc)})
            return

        load_ms = int((time.perf_counter() - t0) * 1000)
        log.info(
            'kokoro loaded',
            extra={
                'model_path': m_path,
                'voices_path': v_path,
                'sample_rate': KOKORO_SAMPLE_RATE,
                'load_ms': load_ms,
                'voices_advertised': list(ALLOWED_VOICES),
            },
        )

        # Warmup synthesis — runs one short utterance per advertised
        # voice so ORT JIT happens off the user request path. Failures
        # here are logged but don't unload the model.
        for spec in VOICE_CATALOG:
            try:
                t1 = time.perf_counter()
                _ = _kokoro.create('Warming up.', voice=spec.id, speed=1.0, lang=_lang_for_voice(spec.id))
                log.info(
                    'kokoro voice warmed',
                    extra={
                        'voice': spec.id,
                        'warmup_ms': int((time.perf_counter() - t1) * 1000),
                    },
                )
            except Exception as exc:
                log.warning(
                    'kokoro warmup failed',
                    extra={'voice': spec.id, 'reason': str(exc)},
                )

        _warmed_up = True
        log.info('kokoro ready', extra={'voices_loaded': len(ALLOWED_VOICES)})


async def warmup() -> None:
    """Public entry point so app.py can fire load + warmup eagerly."""
    if _kokoro is None:
        await asyncio.to_thread(_load_blocking)


def voice_sample_rate(voice_id: str) -> int:
    """Constant for Kokoro v1.0 — included for API compat with app.py."""
    return KOKORO_SAMPLE_RATE


# Stream-friendly chunk size: 4096 int16 samples = ~170ms at 24kHz.
# Small enough that the encoder pipes bytes to ffmpeg early; large
# enough that we're not making syscalls per sample.
_PCM_CHUNK_SAMPLES = 4096


def _lang_for_voice(voice_id: str) -> str:
    """Map Kokoro voice ID prefix to the espeak-ng locale that
    kokoro-onnx's `lang` parameter expects.

      af_*, am_*  -> American English ('en-us')
      bf_*, bm_*  -> British English  ('en-gb')

    Wrong locale = wrong phonemization (af_heart spoken as if it were
    British, or bf_emma spoken with American vowels). Picking by prefix
    is the contract used by the upstream Kokoro voice registry.
    """
    prefix = voice_id[:1]
    if prefix == 'b':
        return 'en-gb'
    return 'en-us'


def _float32_to_int16_bytes(audio: np.ndarray) -> bytes:
    """Float32 PCM in [-1, 1] → little-endian int16 bytes."""
    clipped = np.clip(audio, -1.0, 1.0)
    return (clipped * 32767.0).astype(np.int16).tobytes()


async def synthesize_stream(text: str, voice: str, speed: float, metrics: dict | None = None):
    """Async generator yielding (sample_rate, int16_pcm_bytes) tuples.

    Caller is responsible for the bounded-concurrency slot — wrap the
    consumption in `async with synth_slot(metrics):` so the queue check
    fires before response headers are sent.

    `metrics`, if given, is mutated in place with timing fields:
      chunk_count, ms_to_first_pcm, ms_total_synth.
    """
    if _kokoro is None:
        raise RuntimeError('kokoro not loaded')
    if voice not in _VOICES_BY_ID:
        raise KeyError(f'voice not in catalog: {voice}')

    started = time.perf_counter()
    first_pcm_ts: float | None = None
    chunks_yielded = 0

    try:
        async for audio_part, sample_rate in _kokoro.create_stream(
            text, voice=voice, speed=float(speed), lang=_lang_for_voice(voice),
        ):
            if audio_part is None or audio_part.size == 0:
                continue

            # Sub-chunk the float32 array into small int16 frames so the
            # encoder can start streaming bytes to the client without
            # waiting for the whole sentence.
            for start in range(0, audio_part.shape[0], _PCM_CHUNK_SAMPLES):
                frame = audio_part[start:start + _PCM_CHUNK_SAMPLES]
                pcm_bytes = _float32_to_int16_bytes(frame)
                if not pcm_bytes:
                    continue
                if first_pcm_ts is None:
                    first_pcm_ts = time.perf_counter()
                    if metrics is not None:
                        metrics['ms_to_first_pcm'] = int((first_pcm_ts - started) * 1000)
                chunks_yielded += 1
                yield int(sample_rate), pcm_bytes
    finally:
        if metrics is not None:
            metrics['chunk_count'] = chunks_yielded
            metrics['ms_total_synth'] = int((time.perf_counter() - started) * 1000)
