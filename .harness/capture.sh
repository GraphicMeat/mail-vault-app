#!/usr/bin/env bash
# Harness screenshots for the Contacts view: <shot>-light.png and <shot>-dark.png.
#
#   bash .harness/capture.sh [out_dir]
#
# The out dir is $1, else $HARNESS_SHOTS_OUT, else .artifacts/ in the clone: minijob --artifacts <dir>
# unpacks that directory into <dir> after the job.
# HARNESS_SHOTS (comma separated) names the shots expected; the default is the three below.
# Runs on a Mac with a HiDPI screen, from a job clone:
#   ~/.claude/bin/testq ~/.claude/bin/minijob --artifacts <dir> bash .harness/capture.sh
# Unsigned debug build, no signing keys. Theme is seeded into the app, so the
# system appearance is never touched. Leaves nothing outside the clone and $TMPDIR.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
OUT="${1:-${HARNESS_SHOTS_OUT:-$ROOT/.artifacts}}"
IFS=',' read -r -a SHOTS <<< "${HARNESS_SHOTS:-contacts-this-email,contacts-all-senders,contacts-favorites}"
mkdir -p "$OUT"

# capture.js photographs the largest MailVault window; a live driver may own another.
if pgrep -fl tauri-wd >/dev/null 2>&1; then
  echo "a tauri-wd run is live, its MailVault window can be captured instead of ours:" >&2
  pgrep -fl tauri-wd >&2
  exit 1
fi

[ -d node_modules ] || npm ci

scripts/screenshots/prepare-build.sh
trap 'scripts/screenshots/prepare-build.sh --revert' EXIT

npm run build:e2e

if command -v tauri-wd-shots >/dev/null 2>&1; then SHOTS_TAURI_WD=tauri-wd-shots; else SHOTS_TAURI_WD=tauri-wd; fi
export SHOTS_TAURI_WD

declare -a FAILED=()
for theme in dark light; do
  # The data dir is the run's HOME and the daemon socket path is capped at 104
  # bytes: keep the template short (scripts/screenshots/run-all.sh).
  data="$(mktemp -d -t mvshots)"
  raw="$OUT/.raw-$theme"
  log="$OUT/wdio-$theme.log"
  if ! SHOTS_SPEC=contacts SHOTS_THEME="$theme" SHOTS_DATA_DIR="$data" SHOTS_OUT="$raw" \
       npx wdio run wdio.screenshots.conf.js >"$log" 2>&1; then
    tail -60 "$log" >&2
    FAILED+=("$theme run failed (log $log)")
  fi
  for shot in "${SHOTS[@]}"; do
    for file in "$raw/$shot.png" "$raw/$shot-light.png"; do
      [ -f "$file" ] && mv "$file" "$OUT/$shot-$theme.png"
    done
  done
  rm -rf "$data" "$raw"
done

missing=()
for shot in "${SHOTS[@]}"; do
  for theme in light dark; do
    [ -f "$OUT/$shot-$theme.png" ] || missing+=("$shot-$theme")
  done
done
if [ ${#missing[@]} -gt 0 ] || [ ${#FAILED[@]} -gt 0 ]; then
  [ ${#missing[@]} -eq 0 ] || echo "missing shots: ${missing[*]}" >&2
  [ ${#FAILED[@]} -eq 0 ] || printf '%s\n' "${FAILED[@]}" >&2
  exit 1
fi
echo "shots in $OUT"
