#!/usr/bin/env bash
# Blitz memory comparison job. Runs in a fresh minijob clone on the mini:
#   ~/.claude/bin/testq --lane mini-e2e ~/.claude/bin/minijob bash src-render/tools/memory-job.sh
# Runs tests/e2e/connected-blitz-memory.test.js on a fresh app launch per mode,
# web, blitz, blitz-gpu, twice (MV_MEM_MODES overrides), and prints every `[blitzmem]` line on stdout. Logs go
# to stderr (the job clone is deleted afterwards, so stdout is the only record).
set -uo pipefail
export SPARKLE_FRAMEWORK_PATH="$PWD/src-tauri"
# minijob has already run npm ci in this clone.
npm run build:e2e >&2
status=0
for mode in ${MV_MEM_MODES:-web blitz blitz-gpu web blitz blitz-gpu}; do
  log="$(mktemp)"
  MV_MEM_MODE="$mode" npx wdio run wdio.blitz.conf.js --spec tests/e2e/connected-blitz-memory.test.js >"$log" 2>&1 || status=$?
  grep -a '\[blitzmem\]' "$log" | sed 's/^.*\[blitzmem\]/[blitzmem]/'
  grep -aE 'passing|failing|✖' "$log" >&2 || true
done
exit "$status"
