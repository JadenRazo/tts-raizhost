"""Prometheus metrics for the kokoro service.

Hand-rolled with prometheus_client rather than
prometheus-fastapi-instrumentator to keep label cardinality bounded —
the instrumentator's defaults emit per-handler/per-status series for
every endpoint, which we don't want on a streaming /tts route.

Observations are emitted by app.py, synth.py, and encode.py.
"""

from __future__ import annotations

from prometheus_client import REGISTRY, Counter, Gauge, Histogram

from contract import text_len_bucket

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
