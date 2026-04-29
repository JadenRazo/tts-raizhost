# tts.raizhost.com — PLAN (resolved against discovery, 2026-04-28)

A self-hosted PDF reader-aloud service. PDFs in, neural speech out,
reading position remembered across sessions and devices. Passwordless
TOTP login. Runs on the existing k3s cluster, Caddy-fronted at
`tts.raizhost.com`.

This file supersedes the initial plan after Phase 0 discovery. See
`DISCOVERY.md` for the verified state of the live box. The 10 PLAN
conflicts surfaced there are folded in below.

---

## 1. Resolved decisions

| Decision | Value |
|---|---|
| Repo path | `/root/tts-raizhost` |
| Deploy target | **k3s** (via raizhost-infra GitOps), not docker compose |
| Namespace | `tts` (new) |
| Image registry | `ghcr.io/jadenrazo/tts-web:vN`, `ghcr.io/jadenrazo/tts-kokoro:vN` |
| Reverse proxy | Caddy on host, terminates TLS, proxies to k3s Traefik NodePort `:32080` |
| TLS | Wildcard CF Origin cert at `/etc/caddy/ssl/raizhost.crt` (valid to 2041) |
| DNS | Cloudflare A record `tts → <box IP>`, proxied=on |
| Auth | **Better Auth** (Drizzle adapter, sessions, cookies, middleware) + custom credential provider for TOTP-as-primary-factor |
| TOTP lib | `otpauth` (verification only — Better Auth doesn't ship a primary-factor TOTP credential) |
| Database | `tts_raizhost` on shared `shared-postgres` (PG 16.13), dedicated `tts_user` role |
| Pod → DB | k8s Service `shared-postgres` in `tts` namespace with manual Endpoints `172.22.0.3:5432` (fallback: node IP `:5433`) |
| Sessions | Better Auth's `sessions` table; cookie name `__Host-tts.session_token` (Better Auth default with secure prefix) |
| PDF parsing | Client-side `pdfjs-dist` |
| TTS engine | `kokoro-onnx` in Python 3.11, FastAPI front, Opus-encoded via ffmpeg |
| Persistent storage | hostPath PVs on the k3s node at `/var/lib/tts-raizhost/{books,cache,models}` |
| Backups | Auto via existing `/root/scripts/backup-all.sh` (shared-postgres dumped wholesale; PDFs/cache excluded by design) |
| Secrets | bitnami Sealed Secrets, sealed against the cluster's controller, committed in raizhost-infra |
| CI/CD | GitHub Actions: typecheck → build image → push to GHCR → bump tag in raizhost-infra → ArgoCD reconciles |

---

## 2. Architecture

```
                          tts.raizhost.com
                                │
                       ┌────────▼────────┐
                       │  Host Caddy     │  TLS (CF Origin wildcard)
                       └────────┬────────┘
                                │  Host-preserving proxy
                                │  to localhost:32080
                                ▼
                       ┌─────────────────┐
                       │ k3s Traefik     │  ingressClassName: traefik
                       │ (NodePort)      │  host: tts.raizhost.com
                       └────────┬────────┘
                                │
            ┌───────────────────▼─────────────────────┐
            │ Namespace: tts                          │
            │                                         │
            │   ┌──────────────────┐                  │
            │   │ tts-web (Next.js)│  3000            │
            │   │ Better Auth      │                  │
            │   │ replicas: 1      │                  │
            │   └────┬─────────────┘                  │
            │        │                                │
            │        ▼                                │
            │   ┌──────────────────┐                  │
            │   │ tts-kokoro (FastAPI + ONNX)│ 8000  │
            │   │ replicas: 1, GPU n/a       │       │
            │   └──────────────────┘                  │
            │                                         │
            │   Service shared-postgres ──┐           │
            │   (no selector, manual EP)  │           │
            └─────────────────────────────┼───────────┘
                                          │
                            ┌─────────────▼──────────────┐
                            │ shared-postgres            │
                            │ docker bridge 172.22.0.3   │
                            │ DB: tts_raizhost           │
                            └────────────────────────────┘

  Persistent volumes (hostPath on the node, /var/lib/tts-raizhost/):
    books/<user_id>/<book_id>.pdf
    cache/<voice>/<sha256>.opus
    models/kokoro-v1.0.onnx, voices-v1.0.bin
```

---

## 3. Repository layout

```
/root/tts-raizhost/
├── PLAN.md                         (this file)
├── DISCOVERY.md                    (Phase 0 output)
├── README.md
├── apps/
│   └── web/                        (Next.js app)
│       ├── src/{app,components,lib,server}/
│       ├── drizzle/                (migrations)
│       ├── package.json
│       ├── Dockerfile
│       └── .env.example
├── services/
│   └── kokoro/                     (Python TTS service)
│       ├── app.py                  (FastAPI)
│       ├── synth.py
│       ├── requirements.txt
│       └── Dockerfile
├── deploy/
│   └── k8s/                        (mirrored into raizhost-infra/base/apps/tts-raizhost/)
│       ├── namespace.yaml
│       ├── rbac.yaml
│       ├── tts-web-deployment.yaml
│       ├── tts-web-service.yaml
│       ├── tts-kokoro-deployment.yaml
│       ├── tts-kokoro-service.yaml
│       ├── shared-postgres-endpoints.yaml
│       ├── pvcs.yaml
│       ├── ingress.yaml
│       ├── pdb.yaml
│       ├── networkpolicy.yaml
│       └── kustomization.yaml
├── scripts/
│   ├── bootstrap-models.sh         (one-time Kokoro model download to /var/lib/tts-raizhost/models)
│   ├── create-user.ts              (admin user provisioning, runs in-cluster via kubectl run)
│   └── seal-secret.sh              (wraps kubeseal for the tts namespace)
└── .github/
    └── workflows/
        ├── ci.yml                  (typecheck, build, vitest)
        └── deploy.yml              (build+push image, bump tag in raizhost-infra)
```

The k8s manifests live in this repo for review and CI lint, but the
**source of truth ArgoCD watches** is a copy at
`raizhost-infra/base/apps/tts-raizhost/`. The deploy workflow updates
the image tag in the raizhost-infra copy and pushes; ArgoCD reconciles.

---

## 4. Database schema

Drizzle in `apps/web/src/lib/db/schema.ts`. Database `tts_raizhost`
on `shared-postgres`. Better Auth's tables + tts tables:

**Better Auth tables** (managed by Better Auth, follow its schema
exactly so the Drizzle adapter wires up):
- `users` — id, email (nullable, since we're TOTP-only), emailVerified,
  name, image, createdAt, updatedAt + additionalFields:
  - `username` (text, unique, not null) — login handle
  - `displayName` (text)
  - `totpSecretEnc` (text, nullable until enrolled) — encrypted, AES-256-GCM with `AUTH_KMS_KEY`
  - `recoveryCodesEnc` (text, nullable) — JSON array of bcrypt hashes
  - `enrolledAt` (timestamptz, nullable)
  - `isAdmin` (boolean default false)
- `sessions` — Better Auth standard
- `accounts` — Better Auth standard (won't be used for TOTP-only, but the table is required by the adapter; left empty)
- `verifications` — Better Auth standard (used briefly during enrollment)

**Tts tables**:
- `enrollment_tokens` (token pk, userId fk, expiresAt, usedAt) — 24h TTL, single-use
- `books` (id, userId, title, author, originalFilename, filePath, byteSize, pageCount, sentenceCount, textSha256, uploadedAt, lastOpenedAt)
- `book_sentences` ((bookId, idx) pk, page, text)
- `reading_positions` ((userId, bookId) pk, sentenceIdx, charOffset, updatedAt)
- `user_settings` (userId pk, voiceId default 'af_bella', speed default 1.0, lastBookId, theme default 'auto')
- `tts_cache` (cacheKey pk = sha256(voice|speed|sentenceText), voiceId, textHash, audioPath, durationMs, bytes, createdAt, lastHitAt)

Indexes: `users(username)`, `books(userId, lastOpenedAt desc)`,
`sessions(expiresAt)`, `tts_cache(lastHitAt)`.

---

## 5. Auth design (TOTP-only, Better Auth foundation)

### Approach

Better Auth gives us: session table, accounts table, cookie format,
middleware, Drizzle adapter, secure-by-default cookie attrs.

We **don't** use Better Auth's `emailAndPassword`, `magicLink`, or
`twoFactor` plugins as the primary credential — they all assume
either password or email-link.

We instead expose a single custom POST `/api/auth/login` route that:
1. Looks up user by `username`.
2. If enrolled, decrypts `totpSecretEnc` using `AUTH_KMS_KEY`.
3. Verifies the submitted TOTP code with `otpauth.TOTP.validate({ token, secret, window: 1 })`.
4. On success, mints a Better Auth session via `auth.$context.internalAdapter.createSession({...})` (the same path Better Auth's own login handlers use), sets the cookie via `setSessionCookie()`.
5. On failure, constant-time response, log attempt, rate-limit per IP and username.

Logout, session validation, middleware — all handled by Better Auth's
built-ins. No custom session code.

### Enrollment

Same as original plan: admin runs `scripts/create-user.ts` (in-cluster
via `kubectl exec` against the `tts-web` pod), prints
`https://tts.raizhost.com/enroll/<token>`. User opens, scans QR,
submits current TOTP code, server stores `totpSecretEnc` and
8 bcrypt-hashed recovery codes, marks token used, mints session.

### Recovery

Username + recovery code → bcrypt walk → on match, mark consumed,
issue fresh enrollment token in-flow.

### Session lifetime

Sliding 30 days (Better Auth default config: `expiresIn: 30d`,
`updateAge: 1d`). Cookie cache enabled (5 min) for read-perf.

---

## 6. PDF ingestion, TTS playback, caching

These are unchanged from the original plan — see sections 7-9 of
the initial plan in conversation history. Summary:

- Client-side `pdfjs-dist` parse → upload PDF + sentences JSON
  separately to `POST /api/books` and `POST /api/books/:id/sentences`.
- `GET /api/tts?bookId=&idx=` — TTS proxy with content-addressed
  Opus cache (key = `sha256(voice|speed|text)`), files at
  `/var/lib/tts-raizhost/cache/<voice>/<key>.opus`.
- Reader pre-fetches `i, i+1, i+2` in parallel, MediaSource queue,
  position persisted via debounced PUT every 1s of playback.

---

## 7. Kokoro service

`services/kokoro/` — same FastAPI + kokoro-onnx + ffmpeg pipeline
as the original plan. Container exposes port 8000 (k8s-internal),
binds `0.0.0.0:8000` (cluster-internal only via Service ClusterIP).
Models mounted read-only from a hostPath PV at
`/var/lib/tts-raizhost/models`. Resource requests 500m CPU / 1Gi
mem, limits 2 CPU / 2Gi mem.

---

## 8. Kubernetes manifests (high-level)

Mirroring raizhost-marketing's pattern with additions for stateful
storage and the cross-bridge Postgres reach:

- **Namespace** `tts` — created via `base/namespaces` in raizhost-infra
  if that's where namespaces live, otherwise a `namespace.yaml` in
  the app dir.
- **`tts-web` Deployment** — single replica, image `ghcr.io/jadenrazo/tts-web:<tag>`,
  mounts `books-pvc` at `/data/books`, `cache-pvc` at `/data/cache`.
  Probes on `/healthz`. Resources: req 100m/256Mi, limits 1/512Mi.
  securityContext: runAsNonRoot, drop ALL caps, seccomp RuntimeDefault.
- **`tts-kokoro` Deployment** — single replica, image `ghcr.io/jadenrazo/tts-kokoro:<tag>`,
  mounts `models-pvc` at `/models` (RO). Probes on `/healthz`.
  Resources: req 500m/1Gi, limits 2/2Gi.
- **Services** — both ClusterIP. tts-web port 80→3000, tts-kokoro port 8000→8000.
- **`shared-postgres` cross-bridge access** — Service with no selector
  + Endpoints object pointing at `172.22.0.3:5432`. tts-web's DSN
  uses `shared-postgres.tts.svc.cluster.local:5432`. Fallback if
  cross-bridge routing fails: change Endpoints to node IP and 5433
  (the host-side bind).
- **PVCs** — three: `books-pvc` (10Gi), `cache-pvc` (15Gi),
  `models-pvc` (1Gi). All `local-path` storage class (k3s default),
  bound to the single node.
- **Ingress** — host `tts.raizhost.com`, ingressClassName traefik,
  routes `/` to `tts-web:80`. Caddy on host fronts Traefik NodePort
  `:32080` with Host header preserved (mirrors `claude.raizhost.com`'s
  k8s-fronted siblings like `grafana.raizhost.com`).
- **NetworkPolicy** — default-deny ingress, allow only Traefik
  ingress namespace + intra-namespace. Allow egress to DNS, to
  `shared-postgres` Endpoints CIDR, and to the GHCR registry.
- **PodDisruptionBudget** — `minAvailable: 1` for tts-web (single
  replica means PDB doesn't add resilience but it does prevent
  voluntary eviction during node maintenance).
- **ServiceAccount + RBAC** — minimal, no API access (matches
  raizhost-marketing's `automountServiceAccountToken: false`).
- **Sealed Secrets** — `tts-app-sealed.yaml` for env (`AUTH_KMS_KEY`,
  `BETTER_AUTH_SECRET`, `DATABASE_URL`), sealed via `kubeseal`.

---

## 9. Caddy front-door (single block, drop into existing Caddyfile)

After the existing `claude.raizhost.com` block (line ~498):

```caddyfile
tts.raizhost.com {
    tls /etc/caddy/ssl/raizhost.crt /etc/caddy/ssl/raizhost.key

    request_body {
        max_size 200MB
    }

    reverse_proxy localhost:32080 {
        header_up Host {host}
    }
    encode gzip

    header {
        X-Content-Type-Options nosniff
        X-Frame-Options SAMEORIGIN
        Referrer-Policy strict-origin-when-cross-origin
        Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
    }
}
```

Reload: `systemctl reload caddy`.

DNS: add A record `tts → <box IP>` in Cloudflare, proxied=on.

---

## 10. CI/CD pipeline

Two workflows in `.github/workflows/`:

**ci.yml** — on push/PR:
- typecheck (`tsc --noEmit`)
- vitest (apps/web)
- python lint+test (services/kokoro)
- kubeconform / kustomize build dry-run on `deploy/k8s/`

**deploy.yml** — on push to main (after CI green):
- Build `tts-web` image, push to `ghcr.io/jadenrazo/tts-web:sha-<short>`
- Build `tts-kokoro` image, push to `ghcr.io/jadenrazo/tts-kokoro:sha-<short>`
- Checkout raizhost-infra, bump image tags in
  `base/apps/tts-raizhost/kustomization.yaml`, commit and push
- ArgoCD detects the change and reconciles automatically

Image push uses the GHCR PAT in `/root/raizhost-secrets/ghcr-write-token.txt`
(stored as a GH Action secret in this repo).

---

## 11. Phased build order

Each phase ends in a verifiable state.

### Phase 1: scaffold and DB

- `git init` at `/root/tts-raizhost`, `.gitignore`, `README.md`
- Scaffold `apps/web` (Next.js 15, App Router, TS, Tailwind 4, npm)
- Add deps: `better-auth`, `drizzle-orm`, `drizzle-kit`, `pg`, `otpauth`, `pdfjs-dist`, `bcryptjs`, `zod`
- `src/lib/db/schema.ts` from §4
- `drizzle.config.ts`
- Provision `tts_raizhost` DB and `tts_user` role on `shared-postgres` (CREATE DATABASE + CREATE ROLE + GRANT)
- Run `drizzle-kit generate` + `drizzle-kit push` against the new DB
- **Smoke**: `\dt` shows users, sessions, accounts, verifications, books, book_sentences, reading_positions, user_settings, tts_cache, enrollment_tokens

### Phase 2: auth (Better Auth + custom TOTP)

- Wire Better Auth (Drizzle adapter, lazy singleton like raizhost-app)
- Custom `/api/auth/login` route (username + TOTP)
- Enrollment flow `/enroll/:token` (QR + manual secret + 8 recovery codes)
- Recovery flow
- `scripts/create-user.ts` (CLI, run via `npm run create-user -- --username X --display Y`)
- Rate limit middleware (in-memory token bucket per IP and username)
- **Smoke**: create user, walk enrollment URL, log in, hit a protected page; failed login is rate-limited; recovery code works once and only once

### Phase 3: library + PDF upload

- Library list page `/`, upload page `/upload` (client-side parse with pdfjs-dist)
- API: `POST /api/books`, `POST /api/books/:id/sentences`, `GET /api/books`, `GET /api/books/:id`, `GET /api/books/:id/file`, `DELETE /api/books/:id`
- **Smoke**: upload a small PDF, see it in library, sentences row count matches expectation

### Phase 4: Kokoro service

- `services/kokoro/` FastAPI + kokoro-onnx + ffmpeg
- `scripts/bootstrap-models.sh` downloads `kokoro-v1.0.onnx` and `voices-v1.0.bin` to `/var/lib/tts-raizhost/models`
- **Smoke**: `curl -X POST http://localhost:8101/tts -d '{"text":"hello","voice":"af_bella"}' --output test.opus && ffplay test.opus` (run kokoro container locally with port-forward for testing)

### Phase 5: TTS proxy + cache

- `apps/web/src/lib/tts-client.ts` with cache lookup, store, LRU
- API route `GET /api/tts?bookId=&idx=`
- **Smoke**: same sentence requested twice, second hit serves from cache (visible in logs and DB)

### Phase 6: reader UI

- `/read/:bookId` with MediaSource queue, sentence highlight, controls (play, pause, prev/next, speed, voice picker)
- Position persistence (debounced PUT)
- **Smoke**: read a 5-page PDF end to end, refresh mid-read, position resumes within ~1 sentence

### Phase 7: deploy (k3s)

- Build images, push to GHCR
- Write all manifests in `deploy/k8s/`, validate with `kubectl --dry-run=server`
- Mirror manifests into `raizhost-infra/base/apps/tts-raizhost/`, register an ArgoCD `Application` at `raizhost-infra/argocd/applications/tts-app.yaml`
- Test cross-bridge Postgres reach with a temporary alpine pod (`kubectl run --rm -it pgtest --image=postgres:16-alpine -- pg_isready -h shared-postgres -p 5432`)
- Add Caddy block, reload, add Cloudflare A record
- Run `create-user.ts` for the admin account, walk full flow on the live URL
- **Smoke**: `https://tts.raizhost.com` loads, login works, a real PDF reads aloud

### Phase 8: hardening

- Add `tts-raizhost` paths to `/root/scripts/backup-all.sh` (compose-file list, env-file list — but env now in Sealed Secret; the env-file step covers the unsealed secret if backed up out-of-band, otherwise this step is a no-op)
- Cache eviction CronJob (k8s) — nightly delete `tts_cache` rows where `lastHitAt < now() - 60d`, also enforce 10 GiB cap
- Promtail scrape config for tts pods (in raizhost-infra promtail values)
- Per-route metrics (cache hit rate, sentences/min synthesized, login success rate) — `/metrics` endpoint, Prometheus ServiceMonitor in raizhost-infra

---

## 12. Smoke-test checklist (run after Phase 7)

- [ ] Cold load of `tts.raizhost.com` returns under 2s
- [ ] Wrong username + wrong code: same error, same response time as wrong-code-only
- [ ] PDF upload of 50MB book completes, sentences populated, library shows it
- [ ] First playback sentence audible within 1.5s of clicking play (cold cache)
- [ ] Second playback of same book starts within 200ms (warm cache)
- [ ] Close tab mid-sentence, reopen on phone, position is within one sentence of where you left off
- [ ] Recovery code: use one, verify it cannot be reused, verify enrollment regen works
- [ ] Kill `tts-kokoro` pod: tts-web still serves library, reader shows clear error on play, recovers when service is back
- [ ] Hop to a different node IP (if multi-node ever): position state is shared via DB, audio cache is local-path so it'll re-fetch — acceptable for v1

---

## 13. Decisions that should not change without good reason

1. Client-side PDF parsing — keeps backend lean.
2. Sentence-level addressing for positions — page numbers are unreliable across renderers.
3. TOTP-only auth — passwords are out of scope; Better Auth as session backbone.
4. Content-addressed audio cache — re-reads free, voice/speed correctly cached separately.
5. Kokoro via ONNX Runtime — smaller image, no PyTorch.
6. Postgres for everything (incl. cache index, sessions) — no Redis until measured need.
7. k3s + raizhost-infra GitOps — matches the new-world pattern; tts inherits ArgoCD reconciliation, Sealed Secrets, NetworkPolicies, observability for free.

---

## 14. Open questions deferred to in-phase decision

1. CronJob image for cache eviction — psql in alpine vs a custom tool. Default: `postgres:16-alpine` running a one-line SQL.
2. ServiceMonitor: install prometheus-operator CRDs in tts namespace or use existing? Defer to Phase 8.
3. Multi-node HA: out of scope for v1. PVCs are local-path so a node migration would require manual data move. Document but don't engineer.
