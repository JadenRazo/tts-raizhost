# Working on tts-raizhost

Provide reliable PDF speech and saved reading position while protecting private
documents. Read `README.md`, then the affected code and `docs/architecture.md`.
`docs/reliability.md` owns provisional targets and evidence limits; it does not
claim a completed live failover drill or sustained availability.

## Task routes and constraints

- Reader/playback work lives in `apps/web/src/app/read/` and
  `apps/web/src/lib/tts-client-routing.ts`. Preserve cancellation, voice/speed
  selection, local browser synthesis fallback and resource cleanup. A late
  synthesis result must not resume a stopped or superseded playback request.
- Backend routing lives in `tts-backend-state.ts`, `tts-backend-probe.ts` and
  `tts-backend-selector.ts` under `apps/web/src/lib/`. Probes own circuit state:
  three consecutive primary failures select fallback; success restores primary.
  A single request failure must not become the global health decision. Check
  readiness and usable synthesis bytes, not just an HTTP connection.
- CPU/GPU contracts live in `services/kokoro/` and `services/kokoro-gpu/`.
  Keep request bounds, cancellation, concurrency/backpressure and matching
  `contract.py` files. A contract test does not load a model or prove GPU health.
- Book authorization and quotas live in `apps/web/src/lib/books.ts` and the
  books API. Public-book reads differ from owner-only mutation; positions stay
  per user/book with range validation. Preserve transaction and upload limits.
  Test cross-user access and stale saves when changing these paths.
- PDFs, text, audio caches, bookmarks, history, credentials and recovery codes
  are sensitive. Use synthetic documents and isolated data directories in QA;
  never log private content or point migrations, quota resets, seeds or cleanup
  scripts at an existing user database as setup.

## Checks and deployment

`apps/web/package.json` and `.github/workflows/ci.yml` own exact versions and
commands. With dependencies available, run `npm test`, `npm run typecheck` and
`npm run lint` from `apps/web/`. The production build uses CI's synthetic env
shape. From the root, the dependency-light service checks are:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s services/kokoro/tests -p 'test_*.py'
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s services/kokoro-gpu/tests -p 'test_*.py'
cmp services/kokoro/contract.py services/kokoro-gpu/contract.py
kubectl kustomize deploy/k8s
```

Select checks for the changed behavior; prose fixes need source/link review.
Use `docs/exercises/backend-failover.md` only for an authorized isolated drill.
PR/main CI builds and validates without publishing images or deploying. The
manifests depend on external secrets, host networking/storage and local images
with `imagePullPolicy: Never`; do not apply them as a portable deployment recipe.
Environment ownership, immutable releases and live acceptance are separate work.

Write docs and PRs around the user-visible result, reason, checks actually run
and material limits. Link evidence instead of repeating logs. Follow repository
commit conventions, otherwise `type: concrete change` with a short subject.
Report source changes, review, push/PR and deployment state separately.
