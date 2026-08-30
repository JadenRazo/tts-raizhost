# Backend failover exercise

## Current proof

CI simulates the decision layer without touching a network or cluster:

- a healthy `/healthz` plus a non-empty `/tts` stream passes the primary probe
- an unhealthy readiness response fails the probe
- an empty synthesis stream fails the probe
- three consecutive failed probes select the CPU fallback
- one successful primary probe restores the preferred backend
- a failed user request does not alter probe-owned circuit state

Run that evidence with `cd apps/web && npm test`.

## Live exercise status

No live or staging execution result is published. Do not present this document as a completed GameDay.

## Safe staging procedure

Use a disposable or explicitly approved staging environment, never an unannounced production outage.

1. Record the active-backend gauge, probe counters, TTS success rate, first-byte latency, and browser play-to-audible baseline.
2. Confirm the CPU fallback is healthy and has capacity.
3. Make the preferred endpoint unreachable through the environment's reversible configuration mechanism.
4. Observe three failed probes, the active-backend gauge transition, and successful uncached synthesis through the fallback.
5. Restore the preferred endpoint and observe one successful probe close the circuit.
6. Check for dropped streams, stuck queue slots, cache corruption, and unexpected user-visible errors.
7. Record timestamps, commands, graphs, actual recovery time, deviations, and corrective actions in a dated result document.

Abort if the fallback is unhealthy, alerts are not visible, or rollback ownership is unclear.
