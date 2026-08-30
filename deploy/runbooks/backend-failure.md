# TTS backend failure

## Trigger

- primary probe failures increase or `tts_backend_active{backend="cpu"}` becomes `1`
- synthesis overflow/error rate increases
- users report playback that never becomes audible

## Impact

Cached audio remains available. Cache misses should use the CPU backend, but latency and queue shedding can increase. If both backends are unhealthy, new synthesis fails while the rest of the reader may remain usable.

## Triage

1. Confirm whether the failure is limited to the preferred backend, the fallback, or the web routing layer.
2. Inspect `tts_backend_health_probe_total`, `tts_backend_route_total`, queue saturation, first-byte latency, and recent application logs.
3. From a trusted operator network, check the preferred service's `/healthz`; from inside the cluster, check the fallback service's `/healthz`.
4. Verify that the active-backend gauge agrees with probe results.
5. Check CPU/memory pressure, model-load errors, ffmpeg errors, and network reachability without printing credentials or private endpoints into an incident channel.

## Mitigation

- If the preferred backend alone is unhealthy, keep traffic on the CPU fallback and pause bulk prerender work if it competes with interactive requests.
- If fallback capacity is saturated, reduce noninteractive work before raising concurrency; extra concurrency can increase tail latency or memory pressure.
- Restart or roll back a backend only with environment-specific authorization and a known-good artifact.
- Do not bypass authentication or expose a synthesis endpoint publicly as a shortcut.

## Recovery verification

- readiness is healthy and a probe receives a non-empty first synthesis byte
- the selector returns to the preferred backend after a successful probe
- uncached playback completes from a real client
- queue, error, and browser-stall metrics return toward baseline
- no partial cache files or stuck jobs remain

Record actual timestamps and evidence in a dated incident or exercise result. This runbook alone is not proof of a recovery event.
