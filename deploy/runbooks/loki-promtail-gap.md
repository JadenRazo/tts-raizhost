# Loki/Promtail gap (2026-04-29)

## What's working
- Promtail DaemonSet is running in `monitoring` (1 pod, healthy)
- Promtail discovers pods via `kubernetes_sd_configs` and finds the
  expected log files at
  `/var/log/pods/tts_tts-web-<hash>_<uid>/web/0.log` etc.
- All Prometheus-backed RUM metrics flow correctly
  (`http://tts-web:3101/api/metrics` is scraped by the ServiceMonitor)
- Tempo trace pipeline is intact (operator-injected OTel SDK,
  `tracecontext` propagator)

## What's NOT working
Loki receives logs from very few pods (only `loki-canary-ds7vs` in our
test). Querying `{pod=~"tts-web-.+"}` returns 0 streams even right
after triggering `/api/healthz` requests that produce log output
(verified via `kubectl logs`). Available Loki labels are limited to
`cluster, hostname, job, node, pod, priority, service_name, stream,
unit` — the `app` / `component` / `namespace` labels that the
promtail config's `relabel_configs` should be setting are missing.

This means **the dashboard's Loki-backed panels** (session timeline,
JS error log tail) won't have data even after we ship Phase 2.1. The
Prometheus aggregates (rate, p95, error counts) are fine because they
go through a different path.

## Hypothesis

Possible causes (need verification):

1. **Promtail positions file stale** — has 7 restarts in 6 days; may be
   tracking container IDs that no longer exist. Fix: delete
   `/run/promtail/positions.yaml` on the node and restart the
   DaemonSet pod.
2. **Relabel rules incomplete** — the visible config maps `app`,
   `instance`, `component`, but doesn't explicitly set `namespace`.
   The labelmap action should backfill it but Loki shows none.
3. **Loki retention pruning** — series with low write rate may have
   been dropped from the index.

## How to debug (next time someone has 30 min)

```bash
# 1. Check promtail's view of targets
kubectl -n monitoring exec promtail-<id> -- \
  wget -qO- http://localhost:3101/targets | grep tts

# 2. Check what labels promtail actually sends
kubectl -n monitoring logs promtail-<id> --tail=500 | grep -i "tts-web"

# 3. Force-restart promtail
kubectl -n monitoring rollout restart ds promtail

# 4. Re-query Loki for tts pods (port-forward 3110 -> svc/loki:3100)
curl -sS -G "http://localhost:3110/loki/api/v1/query_range" \
  --data-urlencode 'query={pod=~"tts-web-.+"}' \
  --data-urlencode "start=$(date -d '5m ago' +%s)000000000" \
  --data-urlencode "end=$(date +%s)000000000"
```

## Workaround for the resume artifact

Until Loki ingestion is fixed:

- **Prometheus dashboard panels** — full-featured. Web Vitals per route,
  funnel conversion, JS error rate, audio stalls, queue saturation,
  cache hit ratio, Apdex/SLO. All RUM metrics flow.
- **Tempo trace correlation** — works end-to-end. Browser RUM events
  carry `trace_id` (logged in the pod's stdout, accessible via
  `kubectl logs deployment/tts-web | grep <trace_id>`). Server-side
  Tempo waterfalls are queryable directly in Grafana once the trace
  ID is known.
- **Per-session timeline** — temporarily replace the Loki panel with
  `kubectl logs deployment/tts-web --tail=500 | grep <sessionId>`
  in a runbook. Not as elegant as a dashboard panel but unblocks
  debugging.

## Why we didn't fix this in Phase 1.6

The fix touches the shared `monitoring` namespace, requires reasoning
about retention/index policies, and risks breaking ingestion for other
apps that DO work (loki-canary, etc.). Saving for Phase 2 when we have
the soak-driven motivation to invest 30+ min in the right fix.
