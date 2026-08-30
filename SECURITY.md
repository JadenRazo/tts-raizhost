# Security Policy

## Supported code

Only the latest `main` branch is considered for security fixes. This repository does not provide a supported public deployment or availability commitment.

## Reporting

Use GitHub private vulnerability reporting when available. Otherwise contact `contact@jadenrazo.dev` with affected paths, impact, and a minimal reproduction.

Do not open a public issue containing:

- authentication or recovery material
- user PDFs, reading history, or database records
- private network endpoints, cluster inventory, or deployment credentials
- a working exploit against a reachable service

## Scope boundaries

The public tree excludes production secrets and environment-specific front-door/GitOps configuration. Vulnerabilities in Next.js, Paperless/PDF.js, Kokoro, FastAPI, Kubernetes, or another dependency should also be reported to the relevant upstream project.

The manifests are single-node and environment-specific. They are not a hardened general-purpose deployment. Review the exceptions in `docs/architecture.md` before reuse.
