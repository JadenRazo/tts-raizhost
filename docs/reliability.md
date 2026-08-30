# Reliability contract

## Evidence status

The values below are **provisional service targets**, not a claim of historical attainment. This repository does not publish a continuous SLO report or a completed live failure exercise.

What is currently inspectable:

- unit tests for probe success/failure and circuit transitions
- readiness and liveness behavior in service code and manifests
- bounded synthesis concurrency and explicit 503 backpressure
- Prometheus recording surfaces and alert definitions
- operator runbooks and an unresolved logging-pipeline incident review

## Proposed user-facing objectives

| Objective | SLI | Provisional target | Window |
| --- | --- | ---: | --- |
| Reader availability | successful eligible web requests / eligible requests | 99.5% | rolling 30 days |
| Synthesis success | non-cancelled TTS requests that deliver audio / accepted TTS requests | 99.0% | rolling 30 days |
| Playback responsiveness | browser RUM play-to-audible latency | p95 ≤ 3 seconds | rolling 7 days |

Eligibility rules, bot filtering, planned maintenance, and low-traffic handling must be defined before these become enforceable SLOs. A target without a trustworthy denominator is not an SLO report.

## Error-budget response

- More than 50% of a monthly budget consumed: review top error and latency contributors before feature work.
- More than 75% consumed: freeze reliability-risking changes and run a rollback/restore exercise.
- Budget exhausted: prioritize recovery controls and reduce change rate until the rolling window recovers.

These are intended operating rules. There is no public evidence yet that they have been exercised over a full window.

## Alert coverage

`deploy/k8s/prometheusrule.yaml` covers target availability, synthesis overflow, cache-miss latency, synthesis first-byte latency, cache hit ratio, browser stalls, and play-to-audible latency. Alerts are starting hypotheses and require a low-traffic tuning review; they are not proof that Alertmanager routing is configured.

The backend-failure runbook is [deploy/runbooks/backend-failure.md](../deploy/runbooks/backend-failure.md). The safe exercise plan is [docs/exercises/backend-failover.md](exercises/backend-failover.md).
