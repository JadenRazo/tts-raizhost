# tts.raizhost.com

Self-hosted PDF reader-aloud. Upload a PDF, hear it in a high-quality
neural voice, resume across sessions and devices. Passwordless TOTP
auth.

See [`PLAN.md`](PLAN.md) for the build plan and [`DISCOVERY.md`](DISCOVERY.md)
for the verified state of the host this deploys onto.

## Layout

```
apps/web/         Next.js 15 + TypeScript + Tailwind 4 + Better Auth + Drizzle
services/kokoro/  Python FastAPI + kokoro-onnx + ffmpeg
deploy/k8s/       Kustomize manifests (mirrored into raizhost-infra for ArgoCD)
scripts/          create-user, bootstrap-models, seal-secret
```

## Local dev

Postgres is reused from `shared-postgres` on the box. The `tts_raizhost`
DB and `tts_user` role are provisioned in Phase 1.

```bash
cd apps/web
npm install
npm run db:push      # apply schema
npm run dev
```

## Deploy

GitHub Actions builds and pushes images to GHCR, then bumps the image
tag in `raizhost-infra/base/apps/tts-raizhost/`. ArgoCD reconciles
into the `tts` namespace on the k3s cluster. Caddy on the host fronts
the Traefik ingress at `tts.raizhost.com`.
