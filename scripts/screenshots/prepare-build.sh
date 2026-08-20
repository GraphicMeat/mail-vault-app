#!/usr/bin/env bash
# Prepare a LOCAL screenshot build. Never commit what this writes.
#
# Two changes the shipping app has no business carrying:
#   1. the main window opens at 1440x900 — the aspect the website set uses;
#   2. a capability granting the front end control of its own window, so the
#      harness can raise it and pin it on top.
#
# The second one is what makes captures trustworthy on a machine somebody else
# is using: an occluded WKWebView stops repainting, and `screencapture` then
# happily writes a stale frame — every shot after the first covered window shows
# the same wrong screen, with nothing in the log to say so.
#
#   scripts/screenshots/prepare-build.sh          # apply
#   scripts/screenshots/prepare-build.sh --revert # undo
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CONF="$ROOT/src-tauri/tauri.conf.json"
CAP="$ROOT/src-tauri/capabilities/screenshots.json"
BACKUP="$CONF.screenshots-backup"

if [ "${1:-}" = "--revert" ]; then
  [ -f "$BACKUP" ] && mv "$BACKUP" "$CONF" && echo "restored $CONF"
  rm -f "$CAP" && echo "removed $CAP"
  exit 0
fi

[ -f "$BACKUP" ] || cp "$CONF" "$BACKUP"

python3 - "$CONF" <<'PY'
import json, sys
path = sys.argv[1]
conf = json.load(open(path))
win = conf["app"]["windows"][0]
win["width"], win["height"] = 1440, 900
json.dump(conf, open(path, "w"), indent=2)
print(f"window: {win['width']}x{win['height']}")
PY

cat > "$CAP" <<'JSON'
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "screenshots",
  "description": "Local screenshot builds only — lets the harness size, raise and pin the window",
  "windows": ["main"],
  "permissions": [
    "core:window:allow-set-size",
    "core:window:allow-center",
    "core:window:allow-set-focus",
    "core:window:allow-set-always-on-top"
  ]
}
JSON
echo "wrote $CAP"
echo "now: cargo build -p mailvault --features webdriver"
