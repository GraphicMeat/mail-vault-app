#!/usr/bin/env bash
# Blitz parity harness job. Runs in a fresh minijob clone on the mini. Logs go
# to stderr; stdout carries only the report as a base64 tar between markers,
# for run-parity.sh to unpack on the dev Mac. The output dir (screenshot scratch
# included) is inside the clone, which minijob deletes. (wdio's own testDataDir
# is outside it; the harness no longer writes there.)
set -euo pipefail
OUT="$(pwd)/.blitz-parity-out"
rm -rf "$OUT"
mkdir -p "$OUT"
export SPARKLE_FRAMEWORK_PATH="$PWD/src-tauri"
# minijob has already run npm ci in this clone.
npm run build:e2e >&2
status=0
MV_PARITY=1 MV_PARITY_OUT="$OUT" npx wdio run wdio.conf.js --spec tests/e2e/connected-blitz-parity.test.js >&2 || status=$?
# Screenshot captures are scratch, not report.
rm -rf "$OUT/.tmp"
# A run that wrote no report (skipped, crashed, nothing selected) is a failure.
if [ ! -s "$OUT/report.json" ]; then
  echo "parity-job: no report.json was written" >&2
  [ "$status" -ne 0 ] || status=3
fi
echo "===MV-PARITY-TAR-BEGIN==="
tar -C "$OUT" -czf - . | base64
echo "===MV-PARITY-TAR-END==="
exit "$status"
