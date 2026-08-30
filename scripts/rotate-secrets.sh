#!/usr/bin/env bash
# Rotates the web-app secrets and its PostgreSQL role password.
# Environment-specific identifiers and the env-file path are required;
# nothing about the live host is embedded in this public script.
#
# Run as: bash scripts/rotate-secrets.sh
# Expected output on success: a single line "rotated".

set -euo pipefail

: "${TTS_DB_CONTAINER:?set TTS_DB_CONTAINER}"
: "${TTS_DB_ADMIN_USER:?set TTS_DB_ADMIN_USER}"
: "${TTS_DB_NAME:?set TTS_DB_NAME}"
: "${TTS_DB_USER:?set TTS_DB_USER}"
: "${TTS_ENV_FILE:?set TTS_ENV_FILE to the untracked runtime env file}"

if [[ ! "${TTS_DB_ADMIN_USER}" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]] ||
   [[ ! "${TTS_DB_NAME}" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]] ||
   [[ ! "${TTS_DB_USER}" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]]; then
    echo "database identifiers must contain only letters, digits, and underscores" >&2
    exit 1
fi

if [[ ! -f "${TTS_ENV_FILE}" ]]; then
    echo "env file not found: ${TTS_ENV_FILE}" >&2
    exit 1
fi

grep -q "^DATABASE_URL=postgresql://${TTS_DB_USER}:" "${TTS_ENV_FILE}" || {
    echo "DATABASE_URL does not match TTS_DB_USER" >&2
    exit 1
}
grep -q '^BETTER_AUTH_SECRET=' "${TTS_ENV_FILE}" || {
    echo "BETTER_AUTH_SECRET is missing" >&2
    exit 1
}
grep -q '^AUTH_KMS_KEY=' "${TTS_ENV_FILE}" || {
    echo "AUTH_KMS_KEY is missing" >&2
    exit 1
}

EXPECTED_CONFIRM="rotate:${TTS_DB_CONTAINER}:${TTS_DB_NAME}:${TTS_DB_USER}"
if [[ "${TTS_ROTATE_CONFIRM:-}" != "${EXPECTED_CONFIRM}" ]]; then
    echo "refusing rotation; set TTS_ROTATE_CONFIRM=${EXPECTED_CONFIRM}" >&2
    exit 1
fi

D=$(openssl rand -hex 24)
A=$(openssl rand -hex 32)
K=$(openssl rand -hex 32)

docker exec -i "${TTS_DB_CONTAINER}" \
    psql -U "${TTS_DB_ADMIN_USER}" -d postgres \
    <<<"ALTER ROLE \"${TTS_DB_USER}\" WITH PASSWORD '${D}'" >/dev/null

sed -i "s|^DATABASE_URL=postgresql://${TTS_DB_USER}:[^@]*@|DATABASE_URL=postgresql://${TTS_DB_USER}:${D}@|" "${TTS_ENV_FILE}"
sed -i "s|^BETTER_AUTH_SECRET=.*|BETTER_AUTH_SECRET=${A}|" "${TTS_ENV_FILE}"
sed -i "s|^AUTH_KMS_KEY=.*|AUTH_KMS_KEY=${K}|" "${TTS_ENV_FILE}"

PGPASSWORD="${D}" docker exec -i -e PGPASSWORD "${TTS_DB_CONTAINER}" \
    psql -U "${TTS_DB_USER}" -d "${TTS_DB_NAME}" -h 127.0.0.1 -c "select 1" \
    >/dev/null 2>&1

echo rotated
