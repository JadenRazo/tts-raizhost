# tts-web

The Next.js application for the PDF reader. It owns authentication, book metadata, sentence extraction, reading position, audio-cache orchestration, browser RUM, and routing between TTS backends.

## Prerequisites

- Node.js 22.22.3 or newer in the Node 22 line
- PostgreSQL for interactive use
- a CPU or GPU Kokoro service for synthesis requests

## Setup

```bash
npm ci
cp .env.example .env.local
# Replace every CHANGE_ME value in .env.local.
npm run db:migrate
npm run dev
```

The application is then available at `http://localhost:3000`. Never commit `.env.local` or real user data.

## Checks

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

Unit tests currently cover backend-probe and circuit-transition behavior. CI also tests the Python service contracts and renders the Kubernetes manifests from the repository root.

## Production boundary

This directory does not contain a deployment credential or a complete production environment. See the [root documentation](../../README.md) for architecture, limitations, and release gaps.
