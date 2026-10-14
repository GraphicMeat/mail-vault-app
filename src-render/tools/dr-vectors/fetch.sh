#!/usr/bin/env bash
# Run the vector generator on a runner and store its output as the fixture.
set -euo pipefail
out=src-render/tests/fixtures/dr/vectors.json
mkdir -p "$(dirname "$out")"
log=$(mktemp)
~/.claude/bin/anyjob bash src-render/tools/dr-vectors/job.sh > "$log"
sed -n '/^===DR-VECTORS-BEGIN===$/,/^===DR-VECTORS-END===$/p' "$log" | sed '1d;$d' > "$out"
test -s "$out"
echo "wrote $out ($(wc -c < "$out") bytes)"
