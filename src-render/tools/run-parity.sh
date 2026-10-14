#!/usr/bin/env bash
# Queue the Blitz parity harness on the mini (mini-e2e lane: wdio pkills by
# process name, so only one e2e run at a time) and unpack its report into
# ~/Movies/_clipwork/blitz-parity/<date>/<modes>/.
# Usage: src-render/tools/run-parity.sh light|dark|light,dark [fixture-id,...]
# MV_PARITY_DIR=<name> unpacks into <date>/<name> instead of <date>/<modes>, so a
# rerun does not mix into an earlier run's folder.
set -euo pipefail
modes=${1:?usage: run-parity.sh light|dark|light,dark [ids]}
only=${2:-}
dest="$HOME/Movies/_clipwork/blitz-parity/$(date +%Y-%m-%d)/${MV_PARITY_DIR:-${modes//,/-}}"
mkdir -p "$dest"
log="$dest/job.stdout"
status=0
TESTQ_TIMEOUT=7200 ~/.claude/bin/testq --lane mini-e2e ~/.claude/bin/minijob \
  env MV_PARITY_MODES="$modes" MV_PARITY_ONLY="$only" MV_PARITY_SHOTS=1 \
  bash src-render/tools/parity-job.sh > "$log" || status=$?
if grep -q '^===MV-PARITY-TAR-BEGIN===$' "$log"; then
  sed -n '/^===MV-PARITY-TAR-BEGIN===$/,/^===MV-PARITY-TAR-END===$/p' "$log" | sed '1d;$d' | base64 -d | tar -C "$dest" -xzf - || { [ "$status" -ne 0 ] || status=4; }
else
  echo "parity: the job printed no report (see $log)" >&2
  [ "$status" -ne 0 ] || status=4
fi
echo "parity report: $dest/report.json (job exit $status)"
exit "$status"
