"""Kokoro v1.0 TTS engine wrapper (GPU, PyTorch + CUDA).

Sibling of services/kokoro/synth.py. Same FastAPI contract, same voice
catalog, same output format — only the underlying inference path
differs:

  services/kokoro/        kokoro-onnx 0.5.0  CPU ONNX Runtime  (VPS, fallback)
  services/kokoro-gpu/    kokoro 0.9.4       PyTorch + CUDA    (home box, primary)

Both produce identical audio because they load the same Kokoro v1.0
weights from huggingface.co/hexgrad/Kokoro-82M.

Designed to run on Windows 11 native Python (no Docker, no WSL2).
NSSM registers it as a LocalSystem service that auto-starts on boot;
see scripts/bootstrap-gpu-host.ps1.

Required env:
  KOKORO_DEVICE        cuda | cpu (default cuda; cpu is for ad-hoc test)
  KOKORO_DTYPE         float16 | float32 (default float32)
  KOKORO_MAX_CONCURRENT_SYNTH   default 1
  KOKORO_QUEUE_TIMEOUT_MS       default 50
  HF_HOME              where to cache Kokoro-82M weights (set to a
                       LocalSystem-readable path by the bootstrap script,
                       typically C:\\ProgramData\\tts-kokoro-gpu\\huggingface)
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
    from kokoro import KPipeline

log = logging.getLogger(__name__)

KOKORO_SAMPLE_RATE = 24000


@dataclass(frozen=True)
class _VoiceSpec:
    id: str
    language: str
    gender: str
    description: str


# Identical to services/kokoro/synth.py:VOICE_CATALOG. Both backends
# advertise the same voices so the cache key
# sha256(voice|speed|sentenceText) is interchangeable.
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


@dataclass(frozen=True)
class VoiceInfo:
    id: str
    language: str
    gender: str


def list_voices() -> list[VoiceInfo]:
    return [VoiceInfo(id=v.id, language=v.language, gender=v.gender) for v in VOICE_CATALOG]


# One KPipeline per misaki language code. Kokoro shares model weights
# across pipelines (same hexgrad/Kokoro-82M repo), but each pipeline
# carries its own G2P (American vs British phonemization) and voice
# embedding cache. Two pipelines for the current 5 voices: 'a' for
# af_*/am_*, 'b' for bf_*.
_pipelines: dict[str, 'KPipeline'] = {}
_load_lock = threading.Lock()
_warmed_up = False


def _lang_code_for_voice(voice_id: str) -> str:
    """Kokoro voice IDs encode language in their first character.
    Map af_*/am_* to 'a' (American English) and bf_*/bm_* to 'b'
    (British English). Wrong code = wrong phonemization, audible.
    """
    return voice_id[:1] if voice_id[:1] in {'a', 'b'} else 'a'


def _device() -> str:
    return os.environ.get('KOKORO_DEVICE', 'cuda').lower()


def _dtype_name() -> str:
    return os.environ.get('KOKORO_DTYPE', 'float32').lower()


def is_loaded() -> bool:
    return len(_pipelines) > 0


def loaded_voice_count() -> int:
    return len(ALLOWED_VOICES) if _pipelines else 0


_synth_semaphore: 'asyncio.Semaphore | None' = None
_synth_semaphore_lock = threading.Lock()
_concurrent_in_flight = 0


class QueueOverflow(RuntimeError):
    """Raised when the synth semaphore can't be acquired in time."""


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
    def __init__(self, metrics: dict | None) -> None:
        self._metrics = metrics
        self._sem = _get_semaphore()
        self._held = False

    async def __aenter__(self) -> '_SynthSlot':
        global _concurrent_in_flight
        started = time.perf_counter()
        try:
            await asyncio.wait_for(self._sem.acquire(), timeout=_queue_timeout_seconds())
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
    try:
        from metrics import queue_saturation
    except Exception:
        return
    cap = max(1, _max_concurrent_synth())
    queue_saturation.set(_concurrent_in_flight / cap)


def synth_slot(metrics: dict | None = None) -> _SynthSlot:
    return _SynthSlot(metrics)


def _load_blocking() -> None:
    """Synchronously construct one KPipeline per language code present
    in the catalog. Called once from the FastAPI startup hook via
    asyncio.to_thread.
    """
    global _pipelines
    with _load_lock:
        if _pipelines:
            return

        from kokoro import KPipeline  # type: ignore[import-not-found]
        import torch

        device = _device()
        if device == 'cuda' and not torch.cuda.is_available():
            log.error('KOKORO_DEVICE=cuda but torch.cuda.is_available()=False; aborting load')
            return

        needed_codes = sorted({_lang_code_for_voice(spec.id) for spec in VOICE_CATALOG})
        cast_fp16 = device == 'cuda' and _dtype_name() == 'float16'

        t0 = time.perf_counter()
        for code in needed_codes:
            try:
                pipeline = KPipeline(
                    lang_code=code,
                    repo_id='hexgrad/Kokoro-82M',
                    device=device,
                )
            except Exception as exc:
                log.exception(
                    'kokoro pipeline load failed',
                    extra={'lang_code': code, 'reason': str(exc)},
                )
                continue

            # Optional fp16 cast. Kokoro is small enough to fit fp32 in
            # 12 GB easily, but fp16 cuts kernel time ~30% on Blackwell
            # with no audible quality loss in practice.
            if cast_fp16 and pipeline.model is not None:
                try:
                    pipeline.model = pipeline.model.to(torch.float16)
                    log.info('kokoro model cast to float16', extra={'lang_code': code})
                except Exception as exc:
                    log.warning(
                        'fp16 cast failed; staying on fp32',
                        extra={'lang_code': code, 'reason': str(exc)},
                    )

            _pipelines[code] = pipeline

        if not _pipelines:
            log.error('no kokoro pipelines loaded; service is unusable')
            return

        load_ms = int((time.perf_counter() - t0) * 1000)
        gpu_name = ''
        if device == 'cuda':
            try:
                gpu_name = torch.cuda.get_device_name(0)
            except Exception:
                pass
        log.info(
            'kokoro pipelines loaded',
            extra={
                'device': device,
                'dtype': _dtype_name(),
                'gpu': gpu_name,
                'sample_rate': KOKORO_SAMPLE_RATE,
                'load_ms': load_ms,
                'lang_codes': list(_pipelines.keys()),
                'voices_advertised': list(ALLOWED_VOICES),
            },
        )

        # Warmup synth — runs one short utterance per advertised voice
        # against its lang-code pipeline so each voice's reference
        # embedding is downloaded (lazy hf_hub_download per-voice) and
        # CUDA kernels are JIT-compiled before user requests arrive.
        for spec in VOICE_CATALOG:
            code = _lang_code_for_voice(spec.id)
            pipeline = _pipelines.get(code)
            if pipeline is None:
                log.warning(
                    'kokoro warmup skipped: missing pipeline',
                    extra={'voice': spec.id, 'lang_code': code},
                )
                continue
            try:
                t1 = time.perf_counter()
                for _result in pipeline('Warming up.', voice=spec.id, speed=1.0):
                    pass
                log.info(
                    'kokoro voice warmed',
                    extra={
                        'voice': spec.id,
                        'lang_code': code,
                        'warmup_ms': int((time.perf_counter() - t1) * 1000),
                    },
                )
            except Exception as exc:
                log.warning(
                    'kokoro warmup failed',
                    extra={'voice': spec.id, 'lang_code': code, 'reason': str(exc)},
                )

        log.info('kokoro ready', extra={'voices_loaded': len(ALLOWED_VOICES)})


async def warmup() -> None:
    if not _pipelines:
        await asyncio.to_thread(_load_blocking)


def voice_sample_rate(voice_id: str) -> int:
    return KOKORO_SAMPLE_RATE


_PCM_CHUNK_SAMPLES = 4096


def _tensor_to_int16_bytes(audio) -> bytes:
    """torch.FloatTensor or np.ndarray (float, [-1, 1]) → little-endian int16 bytes.

    Detaches CUDA tensors to CPU first; if already on CPU or numpy,
    just casts.
    """
    arr: np.ndarray
    if hasattr(audio, 'detach') and hasattr(audio, 'cpu'):
        arr = audio.detach().to('cpu', dtype=None).float().numpy()
    elif isinstance(audio, np.ndarray):
        arr = audio
    else:
        arr = np.asarray(audio, dtype=np.float32)
    clipped = np.clip(arr, -1.0, 1.0)
    return (clipped * 32767.0).astype(np.int16).tobytes()


async def synthesize_stream(text: str, voice: str, speed: float, metrics: dict | None = None):
    """Async generator yielding (sample_rate, int16_pcm_bytes) tuples.

    KPipeline yields per-segment Results synchronously; we wrap the
    iteration in asyncio.to_thread so the event loop stays responsive
    while the GPU runs.
    """
    if voice not in _VOICES_BY_ID:
        raise KeyError(f'voice not in catalog: {voice}')

    pipeline = _pipelines.get(_lang_code_for_voice(voice))
    if pipeline is None:
        raise RuntimeError('kokoro pipeline not loaded')

    started = time.perf_counter()
    first_pcm_ts: float | None = None
    chunks_yielded = 0

    def _iterator():
        return pipeline(text, voice=voice, speed=float(speed))

    try:
        gen = await asyncio.to_thread(_iterator)
        gen_iter = iter(gen)

        while True:
            try:
                result = await asyncio.to_thread(next, gen_iter, _SENTINEL)
            except StopIteration:
                break
            if result is _SENTINEL:
                break

            audio = getattr(result, 'audio', None)
            if audio is None:
                # "quiet" segments (empty phonemes) — skip
                continue
            if hasattr(audio, 'numel') and audio.numel() == 0:
                continue

            full_bytes = _tensor_to_int16_bytes(audio)
            if not full_bytes:
                continue

            # Sub-chunk the byte buffer into ~170ms frames so the
            # encoder starts streaming bytes to the client without
            # waiting for the whole sentence.
            stride = _PCM_CHUNK_SAMPLES * 2  # 2 bytes per int16 sample
            for start in range(0, len(full_bytes), stride):
                pcm_bytes = full_bytes[start:start + stride]
                if not pcm_bytes:
                    continue
                if first_pcm_ts is None:
                    first_pcm_ts = time.perf_counter()
                    if metrics is not None:
                        metrics['ms_to_first_pcm'] = int((first_pcm_ts - started) * 1000)
                chunks_yielded += 1
                yield KOKORO_SAMPLE_RATE, pcm_bytes
    finally:
        if metrics is not None:
            metrics['chunk_count'] = chunks_yielded
            metrics['ms_total_synth'] = int((time.perf_counter() - started) * 1000)


_SENTINEL = object()
