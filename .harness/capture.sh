#!/usr/bin/env bash
set -euo pipefail

case ",${HARNESS_SHOTS:-notes-board-after-delete}," in
  *,notes-board-after-delete,*) ;;
  *) exit 0 ;;
esac

out=${HARNESS_SHOTS_OUT:?HARNESS_SHOTS_OUT must be an absolute directory}
mkdir -p "$out"
~/.claude/bin/testq ~/.claude/bin/minijob --artifacts "$out" bash -c \
  'bash scripts/screenshots/prepare-build.sh; trap "bash scripts/screenshots/prepare-build.sh --revert" EXIT; npm run build:e2e && npx wdio run wdio.conf.js --spec tests/e2e/capture-notes-delete.capture.js'
test -s "$out/notes-board-after-delete-light.png"
test -s "$out/notes-board-after-delete-dark.png"
