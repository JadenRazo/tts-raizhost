# Raizhost infrastructure discovery — 2026-04-28

Read-only inspection of the live Hetzner box (`USW-32GB-MAIN`,
Ubuntu 6.8.0-90-generic, Linux x86_64, 30 GiB RAM / 8 vCPU, 226 GB
root disk, 75 GB free). No writes to existing Raizhost services were
performed during this phase — only `docker ps`, file reads, `ss`,
`pg_isready`-style queries, and certificate inspection.

The output below replaces every "starting hypothesis" in PLAN.md
Section 0 with verified fact. PLAN conflicts that need to be resolved
before Phase 1 are listed at the end.

## Filesystem

- **Repo convention**: `/root/<project>` for source. Examples:
  `/root/raizhost-app`, `/root/raizhost`, `/root/raizhost-infra`,
  `/root/claude-tracker`, `/root/job-scanner`. `/opt/raizhost`
  exists but only holds a runtime-snapshot of `docker-compose.yml`,
  `.env`, and `schema.sql` for the marketing app — not source.
- **Raizhost source**: `/root/raizhost-app` (Next.js client dashboard,
  Better Auth, Drizzle, Postgres) and `/root/raizhost` (Astro
  marketing site, static-built into `/var/www/raizhost`).
- **GitOps source**: `/root/raizhost-infra` — Kustomize + ArgoCD
  app-of-apps, watched against `JadenRazo/raizhost-infra:main`.
- **Latest "shared-postgres user app" reference**:
  `/root/claude-tracker` (deployed Apr 16). Closest sibling for tts
  in topology — same target shape: small Next.js webapp joined to
  the shared-postgres network. Tts should mirror this layout.
- **Deploy/runtime artifact root**: not used; deploys are in-place
  rebuilds via `docker compose up -d --build`.
- **Free disk on `/`**: 75 GB. Plenty for Kokoro model (~360 MB) and
  the planned 10 GB audio cache.
- **Intended data path** `/var/lib/tts-raizhost`: does not exist yet,
  no path collisions.

## Docker inventory

Selected containers relevant to tts (full set is ~30):

| Container | Image | Host ports | Networks |
|---|---|---|---|
| `raizhost-app` | `raizhost-app-app` (local build) | `127.0.0.1:3100→3000` | `raizhost-app_default` |
| `raizhost-db` | `postgres:17-alpine` | internal `:5432` | `raizhost-app_default` |
| `claude-tracker` | `claude-tracker-claude-tracker` | `127.0.0.1:3200→3000` | `shared-infrastructure_shared_network` |
| `shared-postgres` | `postgres:16-alpine` | `127.0.0.1:5433→5432` | `shared-infrastructure_shared_network` |
| `shared-redis` | `redis:7-alpine` | `127.0.0.1:6380→6379` | `shared-infrastructure_shared_network` |
| `weeniesmp-discord-bot` | `weeniesmp-discord-bot` | — | `shared-infrastructure_shared_network` |

All web services bind to `127.0.0.1` only and are fronted by host
Caddy (see Reverse proxy).

## Networks

- `shared-infrastructure_shared_network` — bridge, subnet
  `172.22.0.0/16`. Compose project `shared-infrastructure`. Hosts
  `shared-postgres` (172.22.0.3), `shared-redis` (172.22.0.2),
  `claude-tracker` (172.22.0.5), `weeniesmp-discord-bot`. **This is
  the network tts-web and tts-kokoro should join** so tts-web can
  reach `shared-postgres:5432` directly without going through the
  host loopback (per memory: host.docker.internal binds 127.0.0.1
  and won't work for shared-postgres because shared-postgres binds
  inside its container).
- `raizhost-app_default` — bridge, hosts `raizhost-app` and
  `raizhost-db`. Not used by tts.
- A k3s cluster also runs on the box (`k3s-server` PID 355067,
  Traefik on host `:32080` NodePort, kube API on `:6443`). Host
  Caddy currently fronts a number of k3s-fronted subdomains
  (`grafana`, `argocd`, `backstage`, `jobs`, `status`,
  `traefik`, `sad-k8s`, `weenie-k8s`). Tts could deploy via either
  pattern — see PLAN conflict #2.

## Postgres

- **Target instance**: `shared-postgres` container,
  `postgres:16-alpine`, **PostgreSQL 16.13**.
- **Reachable from tts containers** at: `shared-postgres:5432` over
  the shared network (preferred), or `127.0.0.1:5433` from the host.
  `host.docker.internal:5433` works only if the container is on a
  network with `host-gateway` extra_hosts AND shared-postgres binds
  on `0.0.0.0` (it doesn't — it binds 127.0.0.1 host-side and
  in-container 0.0.0.0). Do not attempt host.docker.internal.
- **Existing databases**: `claude_tracker`, `portfolio_analytics`,
  `portfolio_auth`, `portfolio_main`, `postgres`, `template[01]`.
  No `tts_raizhost` yet — provision in Phase 1.
- **Existing roles**: `portfolio_admin` is the only login role
  (superuser). Convention to mirror: per-app role with limited
  grants (e.g. `claude_tracker` has its own DB but DSN uses
  `portfolio_admin` directly — not a great pattern; tts should do
  better and create a dedicated `tts_user` with grants only on
  `tts_raizhost`).
- **Auto-discovered by backup**: `/root/scripts/backup-all.sh`
  already runs `pg_dumpall` on `shared-postgres` nightly at 03:00
  UTC. The new `tts_raizhost` database will be picked up
  automatically with no script change.

## Reverse proxy

- **Type**: **Caddy** (host service, `systemd: caddy.service`,
  running since 2026-04-06). Listening on `:80` and `:443`.
- **Config**: `/etc/caddy/Caddyfile` (single file, ~560 lines, with
  `import /etc/caddy/sites.d/*.caddy` for tenant-generated entries
  used by raizhost-app's publish flow).
- **TLS source**: **Cloudflare Origin Certificate** at
  `/etc/caddy/ssl/raizhost.crt` + `.key`. SANs: `*.raizhost.com,
  raizhost.com`. Valid until **2041-03-21**. Issued by "CloudFlare
  Origin SSL Certificate Authority" — only valid for clients that
  trust the CF Origin CA, i.e. only Cloudflare's edge. End users
  hit Cloudflare-issued public TLS at the edge, then Cloudflare
  proxies to origin over the origin cert. **Do not run certbot.**
  Wildcard cert already covers `tts.raizhost.com`.
- **Existing raizhost.com vhost reference** (lines 289-360 of the
  Caddyfile): pattern for `app.raizhost.com` and
  `claude.raizhost.com` is the cleanest sibling — TLS line +
  `reverse_proxy localhost:<port>` + standard security headers +
  `encode gzip`. Tts should mirror this verbatim with port 3101.
- **DNS provider**: **Cloudflare**. The Caddyfile references
  `header CF-Connecting-IP` for IP allowlisting (staging vhost),
  the marketing CSP allows `cloudflareinsights.com`, and the cert
  is a CF Origin cert — all consistent with Cloudflare-proxied DNS.
  A new `tts.raizhost.com` A or CNAME record needs to be added in
  the Cloudflare dashboard, proxied=on.

## Free host ports selected

Verified via `ss -tlnp`. Bound: 22, 25566, 80, 443, 1025, 2019,
3000-3004, 3020, 3050, 3099, 3100, 3200, 3204, 4322, 5433-5435,
6380, 6381, 6443, 6444, 8000, 8025, 8080-8084, 8090, 8182, 9090,
9100, 9101, 10010, 10248-10259, 25566, 32080.

- **tts-web**: **`127.0.0.1:3101`** — free, sequential after
  raizhost-app (3100) and claude-tracker (3200) is fine but 3101
  is the next slot in the 31xx range and unbound.
- **tts-kokoro**: **`127.0.0.1:8101`** — free, internal-only.

## CI/CD

Pattern observed in `raizhost-app` and inferred for tts:

- **Workflow files reviewed**:
  `/root/raizhost-app/.github/workflows/{ci.yml,deploy.yml,deploy-staging.yml}`.
- **Registry**: **none** — images are built on the box during
  deploy. CI only runs typecheck + build to validate.
- **Deploy trigger**: `workflow_run` on successful CI on `main`,
  followed by `appleboy/ssh-action@v1` SSHing to the box, `git pull`
  via deploy SSH key, then `docker compose up -d --build --no-deps app`.
- **Deploy SSH user**: `deploy` (`/home/deploy/.ssh/id_ed25519`),
  with deploy keys at `/root/.deploy/raizhost-deploy_ed25519` (one
  per repo).
- **Health check**: a curl loop against the container's health
  endpoint after deploy (`http://127.0.0.1:3100/login`).
- **Image pull / restart mechanism**: `docker compose up -d --build
  --no-deps <service>`. No registry hop, no Watchtower.
- **Self-hosted runner**: there is a `github-runner` system user;
  `/root/raizhost` is owned by `github-runner`. Used for the Astro
  marketing site builds. Not relevant for tts (its deploy will be
  GitHub-hosted runner SSH-ing to the box, mirroring raizhost-app).
- A separate **k3s GitOps path** (`/root/raizhost-infra`, ArgoCD
  watching `main`) exists for net-new k8s workloads (e.g.
  `raizhost-marketing`, `job-scanner`, `status-page`). Tts could
  go that route — see PLAN conflict #2.

## Secrets channel

- **Mechanism**: `.env` file colocated with the compose file,
  permissions `0640 root:root` or `0600 deploy:deploy`. Examples:
  `/root/raizhost-app/.env`, `/root/claude-tracker/.env`. The
  `.env` is committed in the repo as `.env.example` with
  placeholders; the real `.env` is on the box only and backed up.
- **Out-of-band token store**: `/root/raizhost-secrets/` (700,
  root-owned) holds long-lived tokens (`ghcr-write-token.txt`,
  `github-pat.txt`, `minio-velero-password.txt`,
  `github-oauth.env`). Reuse for any tts-specific tokens that
  shouldn't sit in the repo `.env`.
- **No Vault, no sops, no Docker secrets** — keep it simple,
  match the existing pattern.

## Backups

- **Existing job**: `/root/scripts/backup-all.sh`, scheduled by
  cron daily at 03:00 UTC, log at `/var/log/backup.log`.
- **What it covers**:
  1. `pg_dumpall` against every Postgres container in
     `PG_CONTAINERS` (currently `portfolio_postgres`, `raizhost-db`,
     `shared-postgres`, `tickethacker-postgres`, `detailing-postgres`).
     **`tts_raizhost` will be auto-included once created in
     `shared-postgres`** — no script edit needed.
  2. Redis RDB dumps for `shared-redis`, `tickethacker-redis`,
     `portfolio_redis_secure`.
  3. Configs: `/etc/caddy/Caddyfile`, `/etc/caddy/ssl`,
     fail2ban filters, a curated list of compose files.
  4. `.env` files from a curated list of project roots.
  5. Daily archive → weekly (Sunday) → monthly (1st of month),
     7 days / 4 weeks / 3 months retention.
  6. Discord webhook on success/failure.
- **Plan to extend**: once tts is deployed, add to the script's
  compose-file list (line ~133-140) and env-file list (line ~156-164)
  the paths `/root/tts-raizhost/docker-compose.yml` and
  `/root/tts-raizhost/.env`. This is a one-line-each addition done
  in Phase 8 — no separate cron needed. Postgres dump auto-covered.
- **PDF and audio cache** (`/var/lib/tts-raizhost/books`,
  `/var/lib/tts-raizhost/cache`): **explicitly excluded** from
  backup — PDFs are user-uploadable and the user has the original;
  audio cache is regeneratable from sentences. Phase 8 should
  document this exclusion.

## Logging and monitoring

- **Log driver**: default Docker `json-file`. Match for tts.
- **Caddy access log**: `/var/log/caddy/access.log` (rolling 50MB,
  keep 5, retain 720h). Per-vhost requests already captured here
  for tts.raizhost.com once the vhost block is added.
- **Stack present**:
  - Host-level: `cadvisor` (8080), `prom/prometheus` (9090),
    `grafana/grafana` (3001), `node_exporter` (9100, 9101) — these
    are the **portfolio-website** monitoring stack, scrape configs
    in `project-website_*` networks. Likely not the right target
    for tts metrics.
  - K8s-level: `loki-app`, `monitoring-app`, `promtail-app`,
    `tempo`, `otel-operator-app` are all defined in
    `raizhost-infra/argocd/applications/`. This is the canonical
    new-world observability stack. Tts containers are **not** k8s
    workloads (assuming compose path), but Promtail can still tail
    host log files if pointed at `/var/lib/docker/containers/<id>/*-json.log`
    or at the Caddy access log.
- **Phase 8 decision deferred** to operator: emit /metrics from
  tts-web (Prom-format) and either (a) add a host scrape config to
  the portfolio Prometheus, (b) defer to k8s Prometheus once tts
  graduates to k3s, or (c) skip metrics in v1. See PLAN open
  question #4.

## PLAN.md conflicts found

These are the items where this discovery contradicts PLAN.md.
Each must be resolved (PLAN.md edit) before Phase 1 starts.

1. **Reverse proxy is Caddy, not Nginx.** PLAN Section 11 ships an
   Nginx vhost; rewrite as a Caddy block dropped into
   `/etc/caddy/Caddyfile` after the existing `claude.raizhost.com`
   block (lines 486-498 are the cleanest sibling pattern). No
   certbot. TLS line: `tls /etc/caddy/ssl/raizhost.crt
   /etc/caddy/ssl/raizhost.key`. Concrete replacement block:

   ```caddyfile
   tts.raizhost.com {
       tls /etc/caddy/ssl/raizhost.crt /etc/caddy/ssl/raizhost.key

       reverse_proxy localhost:3101
       encode gzip

       request_body {
           max_size 200MB
       }

       header {
           X-Content-Type-Options nosniff
           X-Frame-Options SAMEORIGIN
           Referrer-Policy strict-origin-when-cross-origin
           Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
       }
   }
   ```

   Reload after edit: `systemctl reload caddy`.

2. **Compose vs k3s/ArgoCD path.** Memory says raizhost-infra
   (k3s GitOps) is "the new base for all hosted projects" but
   `claude-tracker` (Apr 16, freshest sibling) shipped on plain
   docker compose joined to shared-postgres, and the PLAN itself is
   written for compose. Recommended decision: **stay on docker
   compose for v1** to match claude-tracker and ship faster. If/when
   tts grows beyond two services or needs HA, migrate to k3s by
   adding `base/apps/tts-raizhost/` and an ArgoCD `Application`.
   **Operator confirms?** This is open question #2 to address before
   Phase 1.

3. **Repo path is `/root/tts-raizhost`, not `/opt/tts-raizhost`.**
   Convention is `/root/<project>` for source (raizhost-app,
   claude-tracker, raizhost-infra). DISCOVERY.md is already at
   `/root/tts-raizhost/DISCOVERY.md`. Update PLAN repo-layout block
   (Section 4) and every absolute-path reference.

4. **Network is `shared-infrastructure_shared_network`, not
   `raizhost_default`.** PLAN Section 10 names `raizhost_default` as
   the external network to join; the actual external network for
   shared-postgres + new sibling apps is
   `shared-infrastructure_shared_network` (compose alias `shared`).
   Update Section 10 networks block.

5. **Postgres DSN host is `shared-postgres`, not
   `host.docker.internal`.** PLAN `.env.example` uses
   `host.docker.internal:5432`. Reality: shared-postgres binds
   loopback host-side; tts-web must reach it over the docker
   network. Memory has a guardrail for this. Replace with
   `postgresql://tts_user:CHANGE_ME@shared-postgres:5432/tts_raizhost`.

6. **No certbot, no DNS provisioning script.** PLAN Section 11
   ends with `certbot --nginx -d tts.raizhost.com`. Replace with:
   "Add A record `tts → <box IP>` in Cloudflare, proxied=on. TLS
   is already provisioned via the wildcard CF Origin cert at
   `/etc/caddy/ssl/raizhost.crt` (valid until 2041)."

7. **Backup integration is one line, not a new cron.** PLAN
   Section 8 / Phase 8 implies adding a `pg_dump` cron. Reality:
   `/root/scripts/backup-all.sh` already dumps shared-postgres,
   so the new DB is auto-included. The one-line additions are to
   the compose-file and env-file lists in that script. Update
   Phase 8 wording.

8. **Better Auth could replace iron-session + otpauth.** PLAN
   Section 6 picks `iron-session` + `otpauth` for cookies and TOTP.
   Sibling `raizhost-app` already uses **Better Auth** (which has
   first-class TOTP/passkey/passwordless support). Aligning on
   Better Auth would reduce the auth surface area, share helpers
   between projects, and avoid hand-rolled session-revocation logic.
   This is a recommended substitution, not a hard conflict — flag
   for operator decision (open question, not in original Section 16).

9. **Postgres role pattern**: PLAN doesn't specify; convention so
   far is "use portfolio_admin everywhere", which is a superuser —
   that's bad. Recommend tts deviates and creates a dedicated
   `tts_user` with grants only on `tts_raizhost`. No PLAN edit
   required, just a Phase 1 implementation note.

10. **No GitHub container registry hop.** PLAN doesn't specify, but
    the existing convention is "build on the box during deploy" —
    no GHCR push, no Watchtower. Phase 7 should mirror this:
    GitHub Actions CI runs typecheck/build, deploy job SSHes to
    the box and runs `docker compose up -d --build`. No image
    publish step.

## Resource budget summary

- **RAM**: 30 GiB total, 18 GiB available. Kokoro fits in the
  planned 2 GiB cap with ample headroom. tts-web ~512 MiB.
- **Disk**: 75 GiB free on `/`. Allocating ~12 GiB for
  `/var/lib/tts-raizhost` (10 GiB cache + ~360 MiB models +
  PDF storage growth) leaves 63 GiB headroom. Acceptable; revisit
  if cache cap raises.
- **CPU**: 8 vCPU. Kokoro CPU inference at 1× realtime should be
  comfortable on 1-2 cores; concurrent users may need a worker
  pool — defer to a measured bottleneck, not premature.
