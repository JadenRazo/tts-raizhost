# Architecture and trust boundaries

## Request path

The browser reaches an access-controlled front door, which forwards application requests to `tts-web`. The web process authenticates the session, reads metadata from PostgreSQL, and serves uploaded PDFs or audio only through user-scoped routes.

For a cache miss, the web process selects a synthesis backend:

1. The preferred backend is considered active at process start.
2. A periodic probe calls `/healthz` and requires the first response byte from `/tts`.
3. Three consecutive primary-probe failures select the CPU fallback.
4. One successful primary probe selects the preferred backend again.
5. A failed user request is retried against the fallback but does not, by itself, change global state.

This state is process-local. Scaling the web deployment above one replica would require shared state or acceptance that replicas can temporarily disagree.

## Data

| Data | Current abstraction | Recovery property |
| --- | --- | --- |
| Users, sessions, book metadata, positions | PostgreSQL | Requires an environment-owned backup and tested restore process |
| Uploaded PDFs | Node-local `hostPath` | Not replicated by these manifests |
| Synthesized audio | Content-addressed node-local cache | Regenerable, but cold misses increase latency and backend load |
| Kokoro model files | Read-only node-local `hostPath` | Re-downloadable when upstream artifact integrity is independently verified |

No backup job or restore evidence is included here. A deployment must define those outside this repository and test them before relying on the service.

## Security boundaries represented in code

- Application and synthesis containers run as fixed non-root users.
- Root filesystems are read-only, Linux capabilities are dropped, and privilege escalation is disabled.
- Kubernetes service-account tokens are not mounted.
- The web app validates user scope on data routes and restricts metrics to loopback/private-address hops.
- TTS input length, voice, and speed are bounded; synthesis concurrency uses backpressure.
- Real secrets are external to the repository.

## Known infrastructure exceptions

- `tts-web` uses `hostNetwork` and a `hostPort` to integrate with host-local services. This expands the network boundary and prevents a namespace-wide `restricted` Pod Security profile.
- The checked-in manifests do not include NetworkPolicies because host-network traffic semantics depend on the cluster CNI. Adding a policy without a tested connectivity matrix could silently break the fallback path.
- `hostPath` volumes and a single web replica tie the workload to one node.
- Local image tags and `imagePullPolicy: Never` are suitable only for the current manual image-loading model; they are not an immutable release contract.
- The secrets object, database service, front-door configuration, monitoring stack, and GitOps controller are external dependencies.
- There is no published restore test, capacity test, or multi-node failover result.

These exceptions should be revisited before treating the workload as a reusable platform component.
