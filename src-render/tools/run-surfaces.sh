#!/usr/bin/env bash
# Queue the Blitz surfaces specs on the mini (mini-e2e lane: wdio pkills by
# process name, so only one e2e run at a time) and unpack their screenshots
# into ~/Movies/_clipwork/blitz-d-surfaces/<date>/.
# Usage: src-render/tools/run-surfaces.sh [spec ...]
# With no spec, runs connected-blitz-surfaces and connected-blitz-preview.
# The job's full output (the [blitzsurf] lines) lands in <dest>/job.stdout.
set -euo pipefail
specs=("$@")
[ "${#specs[@]}" -gt 0 ] || specs=(tests/e2e/connected-blitz-surfaces.test.js tests/e2e/connected-blitz-preview.test.js)
dest="$HOME/Movies/_clipwork/blitz-d-surfaces/$(date +%Y-%m-%d)"
mkdir -p "$dest"
log="$dest/job.stdout"
status=0
TESTQ_TIMEOUT=7200 ~/.claude/bin/testq --lane mini-e2e ~/.claude/bin/minijob \
  bash src-render/tools/surfaces-job.sh "${specs[@]}" > "$log" || status=$?
if grep -q '^===MV-SURFACES-TAR-BEGIN===$' "$log"; then
  sed -n '/^===MV-SURFACES-TAR-BEGIN===$/,/^===MV-SURFACES-TAR-END===$/p' "$log" | sed '1d;$d' | base64 -d | tar -C "$dest" -xzf - || { [ "$status" -ne 0 ] || status=4; }
else
  echo "surfaces: the job printed no screenshots (see $log)" >&2
  [ "$status" -ne 0 ] || status=4
fi
echo "surfaces: screenshots in $dest, log $log (job exit $status)"
exit "$status"
