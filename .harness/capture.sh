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

# Other cards share this script; each shot has its own flow.
case ",${HARNESS_SHOTS:-}," in
  *,group-inbox-list,*|*,group-folded,*)
    cd "$(dirname "$0")/.."
    out=${HARNESS_SHOTS_OUT:-${1:-$PWD/.artifacts}}
    case "$out" in /*) ;; *) echo 'Shot output must be an absolute directory' >&2; exit 1 ;; esac
    export HARNESS_SHOTS_OUT="$out"
    mkdir -p "$out"
    [ -d node_modules ] || npm ci
    capture_conf=src-tauri/tauri.conf.json
    capture_backup=$(mktemp)
    cp "$capture_conf" "$capture_backup"
    trap 'cp "$capture_backup" "$capture_conf"; rm -f "$capture_backup"' EXIT
    python3 - "$capture_conf" <<'PY'
import json, sys
path = sys.argv[1]
with open(path) as source:
    config = json.load(source)
window = config['app']['windows'][0]
window.update(width=1280, height=1000, minWidth=375, center=True)
with open(path, 'w') as target:
    json.dump(config, target, indent=2)
PY
    npm run build:e2e
    if ! npx wdio run wdio.conf.js --spec tests/e2e/capture-group-inbox.capture.js > "$out/group-inbox-wdio.log" 2>&1; then
      tail -100 "$out/group-inbox-wdio.log" >&2
      exit 1
    fi
    for shot in group-inbox-list group-folded; do
      test -s "$out/$shot.reached" || { echo "capture.sh: $shot not reached" >&2; exit 1; }
      for theme in light dark; do test -s "$out/$shot-$theme.png"; done
    done
    exit 0 ;;
  *,keep-*)
    cd "$(dirname "$0")/.."
    out=${HARNESS_SHOTS_OUT:-${1:-$PWD/.artifacts}}
    case "$out" in /*) ;; *) echo 'Shot output must be an absolute directory' >&2; exit 1 ;; esac
    export HARNESS_SHOTS_OUT="$out"
    mkdir -p "$out"
    [ -d node_modules ] || npm ci
    desktop_shots="keep-reader-kept keep-dock-group-expanded keep-dock-single-hover keep-dock-reopened keep-dock-left keep-dock-narrow keep-thread-reader keep-notes-reader keep-insights-reader"
    for shot in $desktop_shots keep-phone-viewer-group; do
      rm -f "$out/$shot.reached" "$out/$shot-light.png" "$out/$shot-dark.png"
    done
    # Desktop: the window is sized from outside the webview (the spec uses WebDriver setWindowRect).
    capture_conf=src-tauri/tauri.conf.json
    capture_backup=$(mktemp)
    cp "$capture_conf" "$capture_backup"
    trap 'cp "$capture_backup" "$capture_conf"; rm -f "$capture_backup"' EXIT
    python3 - "$capture_conf" <<'PY'
import json, sys
path = sys.argv[1]
with open(path) as source:
    config = json.load(source)
window = config['app']['windows'][0]
window.update(width=1280, height=1000, minWidth=375, center=True)
with open(path, 'w') as target:
    json.dump(config, target, indent=2)
PY
    npm run build:e2e
    if ! npx wdio run wdio.conf.js --spec tests/e2e/capture-keep-dock.capture.js > "$out/keep-wdio.log" 2>&1; then
      tail -100 "$out/keep-wdio.log" >&2
      exit 1
    fi
    cp "$capture_backup" "$capture_conf"
    for shot in $desktop_shots; do
      test -s "$out/$shot.reached" || { echo "capture.sh: $shot not reached" >&2; exit 1; }
      for theme in light dark; do test -s "$out/$shot-$theme.png" || { echo "capture.sh: $shot-$theme.png missing" >&2; exit 1; }; done
    done
    # Phone: the perf-gate build's ?ui=keep hook stages the dock and logs the count's offset from the bubble centre.
    tmp=$(mktemp -d)
    MV_MOBILE_SHOTS="$tmp" MV_MOBILE_UNTIL='^MV_MOBILE \{"demo":"keep"' \
      bash scripts/mobile-run.sh ios --features perf-gate --url-query ui=keep | tee "$out/keep-phone.log"
    node -e '
      const fs = require("fs");
      const line = fs.readFileSync(process.argv[1], "utf8").split("\n").filter(l => l.startsWith("MV_MOBILE {\"demo\":\"keep\"")).pop();
      const demo = line && JSON.parse(line.slice("MV_MOBILE ".length));
      if (!demo || typeof demo.dx !== "number") { console.error("capture.sh: keep-phone-viewer-group: no centre offsets logged"); process.exit(1); }
      console.log("keep centre offset on the phone: dx=" + demo.dx + " dy=" + demo.dy);
      if (Math.abs(demo.dx) > 1 || Math.abs(demo.dy) > 1) { console.error("capture.sh: keep-phone-viewer-group: count is off the bubble centre"); process.exit(1); }
    ' "$out/keep-phone.log"
    for theme in light dark; do
      test -s "$tmp/ios-$theme.png" || { echo "capture.sh: ios-$theme.png missing" >&2; exit 1; }
      cp "$tmp/ios-$theme.png" "$out/keep-phone-viewer-group-$theme.png"
    done
    printf '%s\n' '[data-mv-keep][aria-pressed="true"]' > "$out/keep-phone-viewer-group.reached"
    rm -rf "$tmp"
    exit 0 ;;
  *,reply-joined-reader,*)
    cd "$(dirname "$0")/.."
    out=${HARNESS_SHOTS_OUT:-${1:-$PWD/.artifacts}}
    case "$out" in /*) ;; *) echo 'Shot output must be an absolute directory' >&2; exit 1 ;; esac
    mkdir -p "$out"
    [ -d node_modules ] || npm ci
    rm -f "$out/reply-joined-reader-light.png" "$out/reply-joined-reader-dark.png"
    npm run build:e2e
    MV_BLITZ_SURFACES_OUT="$out" npx wdio run wdio.conf.js --spec tests/e2e/connected-thread-reply.test.js
    for mode in light dark; do
      test -s "$out/reply-joined-reader-$mode.png" || {
        echo "capture.sh: missing $out/reply-joined-reader-$mode.png" >&2
        exit 1
      }
    done
    exit 0 ;;
  *,sidebar-account-groups,*|*,settings-account-group,*|*,settings-account-group-create,*|*,sidebar-collapsed-groups,*|*,settings-view-tags,*)
    cd "$(dirname "$0")/.."
    out=${HARNESS_SHOTS_OUT:-${1:-$PWD/.artifacts}}
    case "$out" in /*) ;; *) echo 'Shot output must be an absolute directory' >&2; exit 1 ;; esac
    export HARNESS_SHOTS_OUT="$out"
    mkdir -p "$out"
    trap 'bash scripts/screenshots/prepare-build.sh --revert' EXIT
    bash scripts/screenshots/prepare-build.sh --narrow
    for shot in sidebar-account-groups settings-account-group settings-account-group-create settings-account-group-mobile sidebar-collapsed-groups settings-view-tags; do
      rm -f "$out/$shot.reached" "$out/$shot-light.png" "$out/$shot-dark.png"
    done
    npm run build:e2e
    npx wdio run wdio.conf.js --spec tests/e2e/capture-account-groups.capture.js
    for shot in sidebar-account-groups settings-account-group settings-account-group-create settings-account-group-mobile sidebar-collapsed-groups settings-view-tags; do
      test -s "$out/$shot.reached" || { echo "capture.sh: missing $shot.reached" >&2; exit 1; }
      for theme in light dark; do test -s "$out/$shot-$theme.png"; done
    done
    exit 0 ;;
  *,notes-board-after-delete,*)
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
    exit 0 ;;
esac

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
