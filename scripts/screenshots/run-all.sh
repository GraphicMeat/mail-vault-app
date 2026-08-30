#!/usr/bin/env bash
# Capture every locale, back to back, on a HiDPI Mac with the screen unlocked.
#
#   scripts/screenshots/run-all.sh              # all nine
#   scripts/screenshots/run-all.sh de ja        # a subset
#
# Build once, shoot nine times. Expect ~2h for the full set.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

LOCALES=("$@")
[ ${#LOCALES[@]} -gt 0 ] || LOCALES=(en de fr es it ja ko zh pt-br)

# capture.js resolves the target window by owner name and windowid.swift returns
# the LARGEST match, so any other MailVault window on this display can be
# photographed instead of ours. Own driver and own port are not enough.
if pgrep -fl 'tauri-wd' >/dev/null 2>&1; then
  echo "a tauri-wd run is live — its MailVault window can be captured instead of ours" >&2
  pgrep -fl 'tauri-wd' >&2
  exit 1
fi

scripts/screenshots/prepare-build.sh
trap 'scripts/screenshots/prepare-build.sh --revert' EXIT

# VITE_E2E=1 is not optional: without src/e2eMotion.js every overlay sits at its
# initial opacity and the run photographs a bare inbox while the DOM says the
# modal is open.
VITE_E2E=1 npm run build
SPARKLE_FRAMEWORK_PATH="$PWD/src-tauri" cargo build -p mailvault --features webdriver

declare -a REPORT=()
failed=0

for loc in "${LOCALES[@]}"; do
  echo "══ $loc ═══════════════════════════════════════════"
  log="$(mktemp -t shots-"$loc")"
  data="$(mktemp -d -t mailvault-shots-"$loc")"
  if SHOTS_LOCALE="$loc" SHOTS_DATA_DIR="$data" \
     npx wdio run wdio.screenshots.conf.js >"$log" 2>&1; then
    skipped=$(grep -c 'SKIPPED' "$log" || true)
    shots=$(grep -c '^\[shot\] ' "$log" || true)
    REPORT+=("$loc: $shots captured, $skipped skipped  ($log)")
    if [ "$skipped" -ne 0 ]; then failed=1; grep 'SKIPPED' "$log" >&2; fi
    if [ "$loc" = "en" ]; then
      scripts/screenshots/responsive.sh en
    else
      scripts/screenshots/responsive.sh "$loc" --prune-png
    fi
  else
    REPORT+=("$loc: RUN FAILED — $log")
    failed=1
    # The log stays on disk: piping a whole run through `tail` throws away the
    # one line that says what broke.
    tail -40 "$log" >&2
  fi
done

printf '\n══ summary ══\n'
printf '%s\n' "${REPORT[@]}"
exit "$failed"
