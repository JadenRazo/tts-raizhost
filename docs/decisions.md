# Engineering decisions

This is the sanitized decision record for the current tree. An earlier host-discovery notebook and phase plan were removed because they mixed transient infrastructure inventory with application documentation.

| Decision | Rationale | Cost / constraint |
| --- | --- | --- |
| Next.js web application | Keeps UI, authenticated API routes, and server-side orchestration in one deployable unit | One process owns the circuit state; horizontal scaling needs a design change |
| PostgreSQL metadata | Durable relational model for sessions, books, sentences, settings, and position | Requires an independently operated backup and restore process |
| Client-side PDF extraction | Avoids sending documents to a third-party parser | Browser compatibility and large-document resource use need testing |
| Kokoro CPU fallback | Keeps synthesis available when the preferred backend is unreachable | CPU synthesis is capacity-constrained and can shed load |
| Optional private GPU backend | Improves preferred-path capacity without exposing it publicly | Adds a network and host dependency outside the cluster |
| Content-addressed Opus cache | Removes repeat synthesis work and makes cache entries deterministic | Node-local cache is not replicated; invalidation is versioned in code |
| Kustomize manifests | Small, inspectable resource set without a chart abstraction | Environment-specific resources remain external |
| Prometheus + RUM + OTel | Connects service health, queueing, cache behavior, and perceived playback | Dashboards and alert thresholds require traffic-based tuning |
| TOTP enrollment and recovery | Avoids password storage in the application | Enrollment and recovery flows are security-sensitive and require operator discipline |

## Development and verification

Automation and AI-assisted tools were used during implementation and review. Human-owned decisions are kept in code, tests, migration files, runbooks, and this record. A change is not treated as evidence merely because a tool generated it: CI must exercise the relevant contract, and production outcomes must be recorded separately from planned behavior.
