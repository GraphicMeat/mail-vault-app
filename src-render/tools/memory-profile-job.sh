#!/usr/bin/env bash
# One Blitz-off and one Blitz-on run of the memory spec with the WebContent profile (vmmap/footprint + page counts).
#   ~/.claude/bin/testq --lane mini-e2e ~/.claude/bin/minijob bash src-render/tools/memory-profile-job.sh
set -uo pipefail
export SPARKLE_FRAMEWORK_PATH="$PWD/src-tauri"
npm run build:e2e >&2
status=0
for mode in web blitz; do
  log="$(mktemp)"
  MV_MEM_PROFILE=1 MV_MEM_MODE="$mode" npx wdio run wdio.blitz.conf.js --spec tests/e2e/connected-blitz-memory.test.js >"$log" 2>&1 || status=$?
  grep -a '\[blitzmem\]' "$log" | sed 's/^.*\[blitzmem\]/[blitzmem]/'
  grep -aE 'passing|failing|✖' "$log" >&2 || true
done
exit "$status"
