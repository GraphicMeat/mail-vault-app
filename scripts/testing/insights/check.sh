#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
if [ "${1:-}" != '--queued' ]; then
  exec /Users/Rokas/.claude/bin/testq --lane macmini-e2e bash "$0" --queued "$@"
fi
shift
bash scripts/testing/insights/sync.sh
# Shell-quote each runner argument; none is interpreted as a command fragment.
printf -v arguments ' %q' "$@"
ssh macmini "bash /Users/unicorn/Repos/mv-insights-20260909-01a08694/scripts/testing/insights/remote.sh$arguments"
