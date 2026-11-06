#!/usr/bin/env bash
# The Plan 1 perf gate on a simulator / emulator. Runs on the Mac mini:
#   ~/.claude/bin/testq ~/.claude/bin/minijob bash scripts/mobile-perf-gate.sh <ios|android>
#
# Builds the mobile shell in release with --features perf-gate, opens mobile.html?perf=1, and
# launches the installed app MV_PERF_LAUNCHES times (default 2). The first launch seeds 10k rows
# (in shell setup, before the page loads) and runs after a fresh install, so it is not comparable;
# the LAST launch's `MV_MOBILE {"perf":…}` line is the number of record. The verdict JSON comes
# from scripts/mobile-perf-verdict.mjs, which recomputes it from the numbers.
#
# Exit 0 pass, 1 fail, 2 no measurement (timeout, build or launch failure, error line, no perf line).
# Environment: MV_MOBILE_WAIT seconds per launch (default 900 iOS, 1800 Android, which renders in
# software); MV_PERF_LAUNCHES; MV_MOBILE_SHOTS (light/dark screenshots, see mobile-run.sh);
# anything else mobile-run.sh reads.
set -uo pipefail

[ $# -eq 1 ] || { echo "usage: $0 <ios|android>" >&2; exit 64; }
platform=$1
case $platform in
    ios) default_wait=900 ;;
    android) default_wait=1800 ;;
    *) echo "usage: $0 <ios|android>" >&2; exit 64 ;;
esac
cd "$(dirname "$0")/.."

launches=${MV_PERF_LAUNCHES:-2}
out=$(mktemp)
trap 'rm -f "$out"' EXIT

# `error` too: a failed mobile.perf.report logs only {"error":…}, which must end the wait.
MV_MOBILE_UNTIL='^MV_MOBILE \{"(perf|seedError|engineError|error)"' \
MV_MOBILE_WAIT=${MV_MOBILE_WAIT:-$default_wait} \
MV_MOBILE_LAUNCHES=$launches \
    bash scripts/mobile-run.sh "$platform" --release --features perf-gate --url-query perf=1 | tee "$out"
run_status=${PIPESTATUS[0]}
echo "mobile-perf-gate: mobile-run.sh exited $run_status" >&2

node scripts/mobile-perf-verdict.mjs --expect "$launches" --run-status "$run_status" < "$out"
