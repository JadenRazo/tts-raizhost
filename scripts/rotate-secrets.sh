#!/usr/bin/env bash
# Rotates the three openssl-generated secrets in apps/web/.env and
# the matching tts_user password in shared-postgres. Values never
# touch stdout or argv (postgres ALTER goes via stdin; verify uses
# PGPASSWORD env). Local shell vars D/A/K are in the subshell
# this script runs in, so they're gone when it exits.
#
# Run as: bash scripts/rotate-secrets.sh
# Expected output on success: a single line "rotated".

set -euo pipefail

D=$(openssl rand -hex 24)
A=$(openssl rand -hex 32)
K=$(openssl rand -hex 32)

docker exec -i shared-postgres psql -U portfolio_admin -d postgres \
    <<<"ALTER ROLE tts_user WITH PASSWORD '$D'" >/dev/null

ENV=/root/tts-raizhost/apps/web/.env
sed -i "s|^DATABASE_URL=postgresql://tts_user:[^@]*@|DATABASE_URL=postgresql://tts_user:$D@|" "$ENV"
sed -i "s|^BETTER_AUTH_SECRET=.*|BETTER_AUTH_SECRET=$A|" "$ENV"
sed -i "s|^AUTH_KMS_KEY=.*|AUTH_KMS_KEY=$K|" "$ENV"

PGPASSWORD="$D" docker exec -i -e PGPASSWORD shared-postgres \
    psql -U tts_user -d tts_raizhost -h 127.0.0.1 -c "select 1" \
    >/dev/null 2>&1

echo rotated
