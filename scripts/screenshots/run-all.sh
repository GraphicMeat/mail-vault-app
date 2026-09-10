#!/usr/bin/env bash
# Capture every locale, back to back, on a HiDPI Mac with the screen unlocked.
#
#   scripts/screenshots/run-all.sh              # all nine
#   scripts/screenshots/run-all.sh de ja        # a subset
#
# Build once, shoot nine locales in two themes. Expect ~4h for the full set.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

LOCALES=("$@")
[ ${#LOCALES[@]} -gt 0 ] || LOCALES=(en de fr es it ja ko zh pt-br)

# The website serves a light and a dark set, so every locale is shot twice.
# Dark writes the plain base name the pages already point at; light writes a
# `-light` sibling (scripts/screenshots/capture.js).
#
#   SHOTS_THEMES=dark scripts/screenshots/run-all.sh en    # one theme only
read -r -a THEMES <<< "${SHOTS_THEMES:-dark light}"

# SHOTS_TOUR=0 skips the first-run tour pass (six `onboarding-*` shots).
ONBOARDING_PASS="${SHOTS_TOUR:-1}"

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

# One wdio pass. $1 is the label for the report, the rest is the environment.
run_pass() {
  local label="$1" loc="$2" theme="$3" onboarding="$4"
  local log data skipped shots
  log="$(mktemp -t shots-"$loc-$theme-$label")"
  # The data dir becomes the run's HOME, and the daemon's socket is
  # `$HOME/.mailvault/mv.sock`. A macOS unix socket path is capped at 104
  # bytes: `/var/folders/../T/` alone is 48, so a descriptive template
  # ("mailvault-shots-en-dark-app.XXXXXXXX") lands on 106 and the daemon never
  # binds. The app then says "Daemon spawned but socket did not appear within 3
  # seconds" — on the shot, not in the log — and every daemon-backed panel
  # (Cleanup, Time Capsule) photographs an error. Keep this template short.
  data="$(mktemp -d -t mvshots)"
  if SHOTS_LOCALE="$loc" SHOTS_THEME="$theme" SHOTS_DATA_DIR="$data" \
     SHOTS_ONBOARDING="$onboarding" \
     npx wdio run wdio.screenshots.conf.js >"$log" 2>&1; then
    skipped=$(grep -c 'SKIPPED' "$log" || true)
    # wdio prefixes every worker line with "[0-0] ", so an anchored match here
    # counted zero on a run that captured 26.
    shots=$(grep -c '\[shot\] /' "$log" || true)
    REPORT+=("$loc/$theme/$label: $shots captured, $skipped skipped  ($log)")
    if [ "$skipped" -ne 0 ]; then failed=1; grep 'SKIPPED' "$log" >&2; fi
  else
    REPORT+=("$loc/$theme/$label: RUN FAILED — $log")
    failed=1
    # The log stays on disk: piping a whole run through `tail` throws away the
    # one line that says what broke.
    tail -40 "$log" >&2
  fi
}

for loc in "${LOCALES[@]}"; do
  for theme in "${THEMES[@]}"; do
    echo "══ $loc / $theme ══════════════════════════════════"
    run_pass app "$loc" "$theme" ''
    # The first-run tour is a second spec against a mailbox-free profile, so it
    # cannot share a pass with the app set. Its six shots carry their own
    # `onboarding-` prefix and land in the same directory.
    [ "$ONBOARDING_PASS" = "0" ] || run_pass tour "$loc" "$theme" 1
    # Convert once both passes have written their PNGs. English keeps its
    # masters (the README source, and the only thing a re-encode can start
    # from); every other locale ships webp only.
    if [ "$loc" = "en" ]; then
      scripts/screenshots/responsive.sh en
      # English keeps its DARK masters — the README is built from them and a
      # re-encode has to start somewhere. The light ones are marketing-only and
      # nothing reads them again, so they are ~10MB of git for nothing.
      rm -f website/screenshots/*-light.png
    else
      scripts/screenshots/responsive.sh "$loc" --prune-png
    fi
  done
done

printf '\n══ summary ══\n'
printf '%s\n' "${REPORT[@]}"
exit "$failed"
