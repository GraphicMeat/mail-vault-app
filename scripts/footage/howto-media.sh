#!/usr/bin/env bash
# Record the archive-and-delete how-to takes (scenes/howto-abd.js) on the Mac
# mini, one app launch per website locale, each through testq + minijob.
# Run from the checkout:
#   bash scripts/footage/howto-media.sh <new output directory> [locale ...]
# Default locales: en de fr es it ja ko zh pt-br. Results: <out>/<locale>/ (the
# unpacked run tar). Publish after looking at the frames:
#   python3 scripts/footage/publish-howto-media.py <out>
# The mini display must already be in a 2x mode (see README, "Localized help media").
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
OUT="${1:?usage: howto-media.sh <new output directory> [locale ...]}"
shift || true
LOCALES="${*:-en de fr es it ja ko zh pt-br}"
mkdir -p "$OUT"
for loc in $LOCALES; do
  [ ! -e "$OUT/$loc.tar" ] || { echo "refusing to overwrite $OUT/$loc.tar" >&2; exit 1; }
  echo "== $loc $(date +%T)"
  TESTQ_TIMEOUT="${TESTQ_TIMEOUT:-14400}" ~/.claude/bin/testq --lane mini-e2e ~/.claude/bin/minijob \
    env FOOTAGE_SPEC=howto-abd FOOTAGE_LOCALE="$loc" FOOTAGE_HISTORY=1 FOOTAGE_BODY_DELAY_MS=65 \
    FOOTAGE_EXPECT_TOTAL=2842 FOOTAGE_THEME=dark FOOTAGE_ALIGN_ALL=1 FOOTAGE_ALIGN_SHIFT_MIN=-1760 \
    bash scripts/footage/run.sh > "$OUT/$loc.tar" 2> "$OUT/$loc.log" || true
  mkdir -p "$OUT/$loc"
  tar -xf "$OUT/$loc.tar" -C "$OUT/$loc"
  echo "   $loc: $(cat "$OUT/$loc/exit.txt" 2>/dev/null || echo 'no exit.txt'), $(ls "$OUT/$loc"/*.steps.json 2>/dev/null | wc -l | tr -d ' ') of 4 takes"
done
