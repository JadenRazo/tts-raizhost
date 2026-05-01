# Caddy front-door changes for tts.raizhost.com

The Caddyfile lives on the host at `/etc/caddy/Caddyfile`, not in this
repo. This runbook tracks the diffs we apply during friend-tier rollout
so they're auditable.

## 2026-04-29 — Add CSP + Permissions-Policy

**Why.** Defense-in-depth before exposing the app to invited users. Even
though `pdf.worker.min.mjs` is now self-hosted (was jsDelivr) and the
backend rejects forged voice IDs at the edge, a CSP narrows the blast
radius if any of: a stored-XSS bug ships, a reflected XSS reaches the
DOM, or a third-party CDN ever creeps back in via dependency drift. The
Permissions-Policy disables FLoC / Topics so the host's neutral
ad-tracking stance is documented at the front door.

**Diff** (inside the existing `tts.raizhost.com` block, `header { … }`):

```diff
   header {
     X-Content-Type-Options nosniff
     X-Frame-Options SAMEORIGIN
     Referrer-Policy strict-origin-when-cross-origin
     Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
+    Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; media-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
+    Permissions-Policy "interest-cohort=(), browsing-topics=()"
   }
```

**CSP rationale** per directive:

- `default-src 'self'` — fall-through deny for anything not listed below.
- `script-src 'self' 'unsafe-inline'` — Next.js 15 App Router hydration
  emits inline boot scripts; pure `'self'` would white-screen the app.
  Tighten to nonce-based once we add a Next middleware that injects a
  per-response nonce.
- `style-src 'self' 'unsafe-inline'` — Tailwind 4 emits inline `style`
  attrs in component output.
- `img-src 'self' data:` — `data:` allows the TOTP QR code that the
  enroll page renders inline via the `qrcode` package.
- `worker-src 'self'` — required for `/pdf.worker.min.mjs` (the
  self-hosted pdfjs worker on the upload page).
- `media-src 'self'` — the `<audio>` element on the reader pulls bytes
  from `/api/tts`.
- `connect-src 'self'` — every fetch (RUM beacons, sentence pagination,
  TTS, auth) targets this origin only.
- `frame-ancestors 'none'` — pairs with the existing
  `X-Frame-Options SAMEORIGIN`; modern browsers prefer the CSP form.
- `base-uri 'self'`, `form-action 'self'` — defense against `<base>` and
  form-redirect injection.
- Deliberately omitted: `blob:` (no current consumer), `wasm-unsafe-eval`
  (pdfjs uses inline JS, not Wasm), `report-to` / `report-uri` (we
  don't have a CSP-report ingester yet — wire one to `/api/rum/csp` in
  Phase 1).

**Apply.**
```bash
sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak.$(date +%Y%m%d-%H%M%S)
sudo $EDITOR /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

**Verify.**
```bash
curl -sI https://tts.raizhost.com | grep -iE "(content-security-policy|permissions-policy)"
```

**Rollback.** Restore the timestamped backup and reload:
```bash
sudo cp /etc/caddy/Caddyfile.bak.<timestamp> /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

## 2026-04-30 — Long-lived cache for /_next/static (operator action)

**Why.** Next.js now sets `Cache-Control: public, max-age=31536000, immutable`
on `/_next/static/*` from the app itself (see
`apps/web/next.config.ts` `headers()`). Caddy passes upstream headers
through unchanged, so no Caddy edit is *required* — but if the existing
`tts.raizhost.com` block has any `header /_next/static/*` directive that
would override or strip Cache-Control (e.g. a `header -Cache-Control` or a
catch-all `header * Cache-Control "..."`), it must be removed or scoped
to exclude `/_next/static/*`.

**Verify (no change needed if this passes).**
```bash
curl -sI https://tts.raizhost.com/_next/static/chunks/<any-hashed>.js \
  | grep -i cache-control
# Expect: cache-control: public, max-age=31536000, immutable
```

**Optional belt-and-suspenders.** If a future Caddy change adds a global
header rule, pin the static path explicitly inside the
`tts.raizhost.com` block:

```caddy
@nextstatic path /_next/static/*
header @nextstatic Cache-Control "public, max-age=31536000, immutable"
```

Apply with the same validate + reload flow as above. Do NOT add a
catch-all Cache-Control header at the Caddy layer — `/api/tts` and
`/api/books/*` set their own per-route policies and must not be
overridden.
