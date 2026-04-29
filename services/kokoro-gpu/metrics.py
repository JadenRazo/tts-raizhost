"""Prometheus metrics for the kokoro service.

Hand-rolled with prometheus_client rather than
prometheus-fastapi-instrumentator to keep label cardinality bounded —
the instrumentator's defaults emit per-handler/per-status series for
every endpoint, which we don't want on a streaming /tts route.

Phase 1 only registers the surface; the actual observations are wired
into app.py / synth.py / encode.py in Phase 2.
"""

from __future__ import annotations

from prometheus_client import REGISTRY, Counter, Gauge, Histogram

# Bucket choices favor first-byte latency — most synth requests are <1s
# to first PCM, but warm cold-starts and long sentences extend into 2s+.
SYNTH_TO_FIRST_BYTE_BUCKETS = (0.05, 0.1, 0.15, 0.25, 0.4, 0.7, 1.0, 2.0)
SYNTH_TO_LAST_BYTE_BUCKETS = (0.1, 0.25, 0.5, 1, 2, 5, 10, 20)
QUEUE_WAIT_BUCKETS = (0.001, 0.005, 0.01, 0.05, 0.1, 0.2, 0.5)


synth_to_first_byte = Histogram(
    'tts_kokoro_synth_duration_seconds_to_first_byte',
    'Time from /tts request acceptance to first encoded byte yielded.',
    labelnames=('voice', 'text_len_bucket'),
    buckets=SYNTH_TO_FIRST_BYTE_BUCKETS,
    registry=REGISTRY,
)

synth_to_last_byte = Histogram(
    'tts_kokoro_synth_duration_seconds_to_last_byte',
    'Time from /tts request acceptance to final encoded byte yielded.',
    labelnames=('voice', 'text_len_bucket'),
    buckets=SYNTH_TO_LAST_BYTE_BUCKETS,
    registry=REGISTRY,
)

queue_wait_seconds = Histogram(
    'tts_kokoro_queue_wait_seconds',
    'Time spent waiting to acquire a synth concurrency slot.',
    buckets=QUEUE_WAIT_BUCKETS,
    registry=REGISTRY,
)

queue_saturation = Gauge(
    'tts_kokoro_queue_saturation',
    'Concurrent in-flight syntheses divided by the configured max.',
    registry=REGISTRY,
)

overflow_total = Counter(
    'tts_kokoro_overflow_total',
    '503 responses returned because the synth queue was saturated.',
    labelnames=('voice',),
    registry=REGISTRY,
)

ffmpeg_errors_total = Counter(
    'tts_kokoro_ffmpeg_errors_total',
    'Failures encountered while encoding PCM to Opus via ffmpeg.',
    labelnames=('kind',),
    registry=REGISTRY,
)

synth_inputs_total = Counter(
    'tts_kokoro_synth_inputs_total',
    'Synthesis requests accepted by the service.',
    labelnames=('voice', 'text_len_bucket'),
    registry=REGISTRY,
)


def text_len_bucket(text_length: int) -> str:
    """Bucket sentence length for label cardinality control.

    xs<50, s<200, m<500, l<1000, xl<2000.
    """
    if text_length < 50:
        return 'xs'
    if text_length < 200:
        return 's'
    if text_length < 500:
        return 'm'
    if text_length < 1000:
        return 'l'
    return 'xl'
