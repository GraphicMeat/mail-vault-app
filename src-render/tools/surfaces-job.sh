#!/usr/bin/env bash
# Blitz surfaces e2e job. Runs in a fresh minijob clone on the mini. Logs go to
# stderr; stdout carries only the screenshots as a base64 tar between markers,
# for run-surfaces.sh to unpack on the dev Mac. The output dir is inside the
# clone, which minijob deletes.
# Usage (through run-surfaces.sh): surfaces-job.sh <spec> [<spec>...]
set -euo pipefail
OUT="$(pwd)/.blitz-surfaces-out"
rm -rf "$OUT"
mkdir -p "$OUT"
export SPARKLE_FRAMEWORK_PATH="$PWD/src-tauri"
export MV_BLITZ_SURFACES_OUT="$OUT"
# minijob has already run npm ci in this clone.
npm run build:e2e >&2
status=0
args=()
for spec in "$@"; do args+=(--spec "$spec"); done
npx wdio run wdio.blitz.conf.js "${args[@]}" >&2 || status=$?
echo "===MV-SURFACES-TAR-BEGIN==="
tar -C "$OUT" -czf - . | base64
echo "===MV-SURFACES-TAR-END==="
exit "$status"
