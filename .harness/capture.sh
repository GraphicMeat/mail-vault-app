#!/usr/bin/env bash
set -euo pipefail

case ",${HARNESS_SHOTS:-notes-board-after-delete}," in
  *,notes-board-after-delete,*) ;;
  *) exit 0 ;;
esac

out=${HARNESS_SHOTS_OUT:-${1:-}}
test -n "$out" || { echo 'HARNESS_SHOTS_OUT or $1 must be an absolute directory' >&2; exit 1; }
case "$out" in /*) ;; *) echo 'Shot output must be an absolute directory' >&2; exit 1 ;; esac
export HARNESS_SHOTS_OUT="$out"
mkdir -p "$out"
trap 'bash scripts/screenshots/prepare-build.sh --revert' EXIT
bash scripts/screenshots/prepare-build.sh
npm run build:e2e
npx wdio run wdio.conf.js --spec tests/e2e/capture-notes-delete.capture.js
test -s "$out/notes-board-after-delete-light.png"
test -s "$out/notes-board-after-delete-dark.png"
