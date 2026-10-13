#!/usr/bin/env bash
# Blitz parity harness job. Runs in a fresh minijob clone on the mini. Logs go
# to stderr; stdout carries only the report as a base64 tar between markers,
# for run-parity.sh to unpack on the dev Mac. Nothing stays on the mini: the
# output dir is inside the clone, which minijob deletes.
set -euo pipefail
OUT="$(pwd)/.blitz-parity-out"
rm -rf "$OUT"
mkdir -p "$OUT"
export SPARKLE_FRAMEWORK_PATH="$PWD/src-tauri"
# minijob has already run npm ci in this clone.
npm run build:e2e >&2
status=0
MV_PARITY=1 MV_PARITY_OUT="$OUT" npx wdio run wdio.conf.js --spec tests/e2e/connected-blitz-parity.test.js >&2 || status=$?
echo "===MV-PARITY-TAR-BEGIN==="
tar -C "$OUT" -czf - . | base64
echo "===MV-PARITY-TAR-END==="
exit "$status"
