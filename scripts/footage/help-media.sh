#!/usr/bin/env bash
# Capture real localized app workflows on the Mac mini, with one build.
# Run from the checkout: bash scripts/footage/help-media.sh /private/tmp/help-run
# Publish after visual review: python3 scripts/footage/publish-help-media.py /private/tmp/help-run
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
OUT="${1:?usage: help-media.sh <new output directory>}"
mkdir -p "$OUT"
[ ! -e "$OUT/job.tar" ] || { echo "refusing to overwrite an earlier capture" >&2; exit 1; }
TESTQ_TIMEOUT="${TESTQ_TIMEOUT:-14400}" ~/.claude/bin/testq --lane mini-e2e ~/.claude/bin/minijob \
  env WEBCLIP_MODE=record WEBCLIP_LOCALES="en de fr es it ja ko zh pt-br" \
  WEBCLIP_GROUPS=help-media WEBCLIP_ONLY=search-local,privacy-mode,manual-backup FOOTAGE_ALLOW_IDLE_FOREIGN=1 FOOTAGE_GUARD_WAIT_SECONDS=600 \
  bash scripts/footage/web-clips-job.sh > "$OUT/job.tar" 2> "$OUT/job.log"
tar -xf "$OUT/job.tar" -C "$OUT"
echo "New Mac mini captures: $OUT"
