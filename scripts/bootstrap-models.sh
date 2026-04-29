#!/usr/bin/env bash
# Downloads Kokoro v1.0 model files into KOKORO_MODELS_DIR (defaults to
# /var/lib/tts-raizhost/models/kokoro). Idempotent: existing files at the
# expected size are skipped.
#
# Files fetched (from the kokoro-onnx GitHub release, mirrored from
# huggingface.co/hexgrad/Kokoro-82M):
#   kokoro-v1.0.onnx   ~328 MB  the model weights (FP32 ONNX)
#   voices-v1.0.bin    ~28 MB   numpy archive of all 54 voice tensors
#
# We advertise only 4 of the 54 voices via the web API (see
# services/kokoro/synth.py:VOICE_CATALOG) but download the full bin
# because there's no per-voice slice — Kokoro loads the whole tensor
# into RAM and indexes by name.
#
# Run on the k3s node before tts-kokoro pods schedule. The Dockerfile
# expects these files mounted read-only at /models/kokoro; the manifests
# in deploy/k8s/ wire that up via a hostPath PV.
#
# Usage:
#   sudo bash scripts/bootstrap-models.sh
#   KOKORO_MODELS_DIR=./models bash scripts/bootstrap-models.sh   # local dev

set -euo pipefail

KOKORO_MODELS_DIR="${KOKORO_MODELS_DIR:-/var/lib/tts-raizhost/models/kokoro}"

# kokoro-onnx GitHub release tag holding v1.0 model files. This URL is
# stable; the release is "model-files-v1.0" and lives on the upstream
# repo.
RELEASE_BASE='https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0'

# Files + expected sizes (verified 2026-04-29). 5% drift tolerance on
# the size check accommodates upstream republishes.
declare -A FILES=(
    ['kokoro-v1.0.onnx']=325521804
    ['voices-v1.0.bin']=27381346
)

log()  { printf '[bootstrap-models] %s\n' "$*"; }
warn() { printf '[bootstrap-models][warn] %s\n' "$*" >&2; }
die()  { printf '[bootstrap-models][error] %s\n' "$*" >&2; exit 1; }

command -v curl       >/dev/null || die 'curl is required'
command -v sha256sum  >/dev/null || die 'sha256sum is required'

mkdir -p "$KOKORO_MODELS_DIR"

# Returns 0 if $1 exists with size within 5% of $2.
size_ok() {
    local path="$1" expected="$2" actual diff tol
    [[ -f "$path" ]] || return 1
    actual=$(stat -c%s "$path" 2>/dev/null || stat -f%z "$path")
    [[ -n "$actual" ]] || return 1
    diff=$(( actual > expected ? actual - expected : expected - actual ))
    tol=$(( expected / 20 ))
    (( diff <= tol ))
}

fetch_one() {
    local url="$1" dest="$2" expected="${3:-0}" name tmp
    name=$(basename "$dest")

    if [[ -n "$expected" ]] && (( expected > 0 )) && size_ok "$dest" "$expected"; then
        log "$name already present at expected size, skipping"
        printf '  sha256: %s  %s\n' "$(sha256sum "$dest" | awk '{print $1}')" "$dest"
        return 0
    fi

    tmp="${dest}.partial"
    rm -f "$tmp"
    log "downloading $name"
    curl -fL --retry 3 --retry-all-errors --connect-timeout 30 \
        --output "$tmp" "$url"
    mv "$tmp" "$dest"

    if [[ -n "$expected" ]] && (( expected > 0 )) && ! size_ok "$dest" "$expected"; then
        local actual
        actual=$(stat -c%s "$dest" 2>/dev/null || stat -f%z "$dest")
        warn "$name size $actual differs from expected $expected by more than 5%; upstream may have changed"
    fi
    printf '  sha256: %s  %s\n' "$(sha256sum "$dest" | awk '{print $1}')" "$dest"
}

for name in "${!FILES[@]}"; do
    expected_size="${FILES[$name]}"
    url="${RELEASE_BASE}/${name}"
    dest="${KOKORO_MODELS_DIR}/${name}"
    fetch_one "$url" "$dest" "$expected_size"
done

log "kokoro v1.0 model files ready under $KOKORO_MODELS_DIR:"
ls -lh "$KOKORO_MODELS_DIR" | sed 's/^/  /'
