# Incident review: application logs absent from Loki

**Observed:** 2026-04-29

**Status:** unresolved in this repository

**Scope:** observability degradation; application request handling remained available

## Summary

Promtail discovered the application pods and the pod logs were readable with `kubectl logs`, but Loki queries returned no application streams. Prometheus metrics and OpenTelemetry traces used separate pipelines and continued to provide aggregate and trace-level signals.

This is intentionally recorded as an unresolved incident review, not a postmortem with a proven root cause.

## Impact

- Grafana panels backed by Loki lacked application events.
- Session-level and JavaScript-error investigation required direct pod-log queries.
- Prometheus alerts and aggregate RUM metrics remained available.
- Trace data remained available, but log correlation was manual.

No user-facing outage or data-loss claim is made from the evidence recorded here.

## Detection

The gap was found while validating a dashboard: recent application actions produced pod log lines, but a matching Loki query returned no streams. The visible Loki label set also lacked expected namespace/component labels.

## Unproven hypotheses

1. stale Promtail positions after repeated restarts
2. incomplete or nonmatching relabel rules
3. Loki indexing or retention behavior

None was confirmed, so none is labeled the root cause.

## Safe investigation sequence

```bash
# Inspect Promtail's discovered targets.
kubectl -n monitoring port-forward daemonset/promtail 3101:3101
curl -fsS http://127.0.0.1:3101/targets

# Compare a known application log event with Promtail output.
kubectl -n tts logs deployment/tts-web --tail=200
kubectl -n monitoring logs daemonset/promtail --tail=500

# Query Loki through an approved local port-forward.
kubectl -n monitoring port-forward service/loki 3110:3100
curl -fsS -G http://127.0.0.1:3110/loki/api/v1/labels
```

Do not delete a positions file or restart the shared logging stack until the effect on other workloads is understood and the operator has approved the change.

## Workaround

- Use Prometheus panels for rates, percentiles, errors, stalls, and queue pressure.
- Use the trace identifier to find the relevant Tempo trace.
- Query the application pod logs directly for a bounded time window.

## Corrective actions

- [ ] reproduce with a timestamped log marker in a safe environment
- [ ] capture the effective Promtail configuration and target labels
- [ ] identify the first pipeline stage where the marker disappears
- [ ] test any relabel/positions change against another known workload
- [ ] add an alert for stale or absent application log ingestion
- [ ] record the verified root cause, recovery time, and regression check

Until those items are complete, the repository must not claim end-to-end Loki log ingestion.
