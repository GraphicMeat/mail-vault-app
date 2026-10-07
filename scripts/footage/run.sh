#!/usr/bin/env bash
# One footage run on the mini, end to end: build the app the way the marketing
# screenshot run does, boot it once, record every clip the spec takes, check
# each clip, stream the results back.
#
#   TESTQ_TIMEOUT=14400 ~/.claude/bin/testq --lane mini-e2e ~/.claude/bin/minijob \
#     env FOOTAGE_SPEC=boot-a FOOTAGE_HISTORY=1 FOOTAGE_BODY_DELAY_MS=0 \
#     bash scripts/footage/run.sh > run.tar 2> run.log
#
# stdout is ONLY a tar of the results, per clip: <clip>.mov, <clip>.mov.json
# (recorder accounting), <clip>.actions.json (cursor/camera log),
# <clip>.stats.json (framestats on the finished file), <clip>.census.json (the
# overlays on screen when the take started), frames/<clip>/*.png; plus
# s7-vault-listing.json (the vault this run left on disk), geometry.json and
# logs. Every log line goes to stderr. The job clone is deleted by runjob; this
# script removes its temp dirs and every process it started before the tar
# leaves, so nothing stays behind.
#
# Knobs (env): FOOTAGE_SPEC (scripts/footage/scenes/<spec>.js; FOOTAGE_SCENE is
# the older name), FOOTAGE_ONLY (clips, boot-a), FOOTAGE_HISTORY (0 | 1 |
# "2022:420,..."), FOOTAGE_BODY_DELAY_MS, FOOTAGE_EXPECT_TOTAL, FOOTAGE_S3_YEAR,
# FOOTAGE_WINDOW=1536x928 (web content; the window adds a 32 pt title bar),
# FOOTAGE_CAPTURE=app|window|display|screen, FOOTAGE_THEME=dark|light,
# FOOTAGE_CODEC=hevc|h264, FOOTAGE_BITRATE=80, FOOTAGE_REAL_MOTION=1|0, FOOTAGE_QUERY,
# FOOTAGE_CORPUS_50K=1 (+ optional FOOTAGE_CORPUS_DIR, FOOTAGE_CORPUS_N=49932; the
# 50,000-message search vault, seeded by wdio.footage.conf.js; pair with
# FOOTAGE_EXPECT_TOTAL=82).
set -uo pipefail
exec 3>&1 1>&2

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
SCENE="${FOOTAGE_SPEC:-${FOOTAGE_SCENE:-s4-search}}"
export FOOTAGE_SPEC="$SCENE"
OUT="$(mktemp -d -t mvtake)"
BIN="$(mktemp -d -t mvbin)"
# The app's HOME. Short on purpose: the daemon socket path is capped at 104 bytes.
HOMEDIR="$(mktemp -d -t mvfoot)"
export FOOTAGE_PORT="${FOOTAGE_PORT:-4468}"
export FOOTAGE_WINDOW="${FOOTAGE_WINDOW:-1536x928}"
export FOOTAGE_CAPTURE="${FOOTAGE_CAPTURE:-app}"
# Footage-only capability, written into this job clone only (removed in finish).
FOOTAGE_CAP="$ROOT/src-tauri/capabilities/footage.json"
CAF=""

finish() {
  local status=$?
  pkill -f "tauri-wd-shots --port $FOOTAGE_PORT" 2>/dev/null
  pkill -f "$ROOT/target/" 2>/dev/null        # app, its daemon, the mock IMAP servers
  pkill -f "$BIN/" 2>/dev/null                # recorder
  [ -n "$CAF" ] && kill "$CAF" 2>/dev/null
  sleep 1
  # Ours: anything under this clone or the temp bin, a driver, a mock server.
  pgrep -fl "$ROOT/|$BIN/|tauri-wd|mock-imap" > "$OUT/leftover.txt" 2>&1 || echo "none" > "$OUT/leftover.txt"
  echo "leftover processes after cleanup:"; cat "$OUT/leftover.txt"
  # Not ours, but worth knowing about (another clone's orphaned app or daemon).
  pgrep -fl "mailvault" | grep -v "$ROOT/" > "$OUT/foreign.txt" 2>&1 || true
  find "$HOMEDIR" -name 'daemon*.log' -exec tail -300 {} \; > "$OUT/daemon-tail.log" 2>/dev/null
  scripts/screenshots/prepare-build.sh --revert >/dev/null 2>&1
  rm -f "$FOOTAGE_CAP"
  echo "job exit $status" > "$OUT/exit.txt"
  tar -C "$OUT" -cf - . >&3
  rm -rf "$OUT" "$BIN" "$HOMEDIR"
}
trap finish EXIT

step() { echo; echo "== $* ($(date +%H:%M:%S))"; }

step "preflight"
if pgrep -fl "tauri-wd|mock-imap"; then echo "a driver or mock server is live; one app instance at a time"; exit 1; fi
caffeinate -u -d -i -t 3600 & CAF=$!
osascript -e 'tell application "System Events" to key code 53' 2>&1 || true
echo "front app: $(lsappinfo front | xargs lsappinfo info -only name 2>/dev/null)"

step "compile recorder + framestats"
swiftc -O video/capture/recorder.swift -o "$BIN/recorder" || exit 1
swiftc -O video/capture/tools/framestats.swift -o "$BIN/framestats" || exit 1
swiftc -O video/capture/tools/cursor.swift -o "$BIN/cursor" || exit 1
swiftc -O video/capture/tools/probe.swift -o "$BIN/probe" || exit 1
export FOOTAGE_CURSOR_TOOL="$BIN/cursor"
# The display the take runs on (the virtual display's mode can change between
# Screen Sharing sessions; the take itself refuses a non-2x webview).
"$BIN/probe" > "$OUT/probe.json" && grep -E '"backingScale"|"modePixels"' -A2 "$OUT/probe.json" | tr -d ' \n'; echo

step "build: prepare-build, VITE_E2E frontend, debug daemon staged as the sidecar, app with webdriver"
scripts/screenshots/prepare-build.sh || exit 1
# The native title bar (32 pt, traffic lights) is window chrome drawn in the
# app's appearance, which follows the system (the mini runs Dark). A light take
# sets the app's own appearance through Tauri's window setTheme (lib/scene.js
# prepareWindow; NSApp.appearance for this process only, no system setting).
# Capabilities are compiled in, so this must exist before the cargo build.
cat > "$FOOTAGE_CAP" <<'JSON'
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "footage",
  "description": "Footage builds only - lets the harness set the window appearance (light takes)",
  "windows": ["main"],
  "permissions": ["core:window:allow-set-theme"]
}
JSON
echo "wrote $FOOTAGE_CAP"
npm run build:e2e || exit 1
# The app build copies src-tauri/binaries/mailvault-daemon-<triple> over
# target/debug/mailvault-daemon; build:e2e staged the fresh debug daemon first,
# so the two must be the same file.
if cmp -s target/debug/mailvault-daemon src-tauri/binaries/mailvault-daemon-aarch64-apple-darwin; then
  echo "daemon: target/debug/mailvault-daemon is the freshly staged sidecar"
else
  echo "daemon: STALE sidecar - target/debug/mailvault-daemon differs from the staged one"; exit 1
fi
SPARKLE_FRAMEWORK_PATH="$PWD/src-tauri" cargo build -p mock-imap --bin mock-imap-server || exit 1

# FOOTAGE_FM_HELPER=1 (AI clips, ph-ai): build:e2e skips Tauri's
# beforeBuildCommand, so the Apple Intelligence sidecar is built here, where
# find_fm_helper_binary looks (src-tauri/helpers/ above target/debug), and
# asked once whether the model is available. Off by default.
if [ "${FOOTAGE_FM_HELPER:-0}" = 1 ]; then
  step "Apple FM helper"
  FM="src-tauri/helpers/mailvault-fm-helper"
  bash scripts/build-fm-helper.sh || exit 1
  [ -x "$FM" ] || { echo "fm helper: $FM missing after build"; exit 1; }
  echo '{"id":"1","op":"availability"}' | "$FM" > "$OUT/fm-probe.json" 2>&1
  echo "fm helper availability: $(cat "$OUT/fm-probe.json")"
  grep -q '"available":true' "$OUT/fm-probe.json" || { echo "fm helper: Apple Intelligence not available"; exit 1; }
fi

# Another project's XCUITest run synthesizes real clicks at screen positions; our
# window is pinned on top, so those clicks would land in the take. Let it finish.
step "wait for other UI automation on the display"
for i in $(seq 1 120); do
  pgrep -f "xcodebuild test|XCTRunner|UITests-Runner" >/dev/null || break
  [ "$i" = 1 ] && { echo "UI tests of another project are driving the display, waiting:"; pgrep -fl "xcodebuild test" | cut -c1-160; }
  sleep 5
done

step "spec $SCENE at $FOOTAGE_WINDOW"
export FOOTAGE_SCENE="$SCENE" FOOTAGE_OUT="$OUT" FOOTAGE_RECORDER="$BIN/recorder" FOOTAGE_DATA_DIR="$HOMEDIR"
t0=$(date +%s)
npx wdio run wdio.footage.conf.js > "$OUT/run.log" 2>&1
take=$?
echo "wdio took $(( $(date +%s) - t0 )) s"
grep -E '\[take\]|\[footage\]|\[setup\]|\[recorder\]|Error|error:|passing|failing|pending|✓|✖' "$OUT/run.log" | grep -v '^\s*$' | head -400
echo "take exit $take"

# S7: the vault this run left on disk, before finish() deletes the HOME.
node scripts/footage/lib/vaultListing.mjs "$HOMEDIR" > "$OUT/s7-vault-listing.json" 2>"$OUT/s7-vault-listing.err" \
  && echo "s7 listing: $(node -e 'const j=require(process.argv[1]); console.log(JSON.stringify(j.totals || j.error))' "$OUT/s7-vault-listing.json")"

clips=$(cd "$OUT" && ls *.mov 2>/dev/null | sed 's/\.mov$//')
[ -n "$clips" ] || { echo "no clip"; tail -120 "$OUT/run.log"; exit 1; }

for clip in $clips; do
  step "read $clip back"
  [ -f "$OUT/$clip.actions.json" ] || { echo "$clip: no actions.json (take did not finish)"; continue; }
  # Frames to look at: the first, one just after every move/click/focus/submit/cut, the last.
  PNGS=$(node -e '
    const a = require(process.argv[1]); const f = a.fps || 60; const s = new Set([0]);
    const ev = a.events; const types = ev.filter((e) => e.type === "type" && e.text !== "\n");
    for (const e of ev) if (e.type !== "type" || e.text === "\n") s.add(Math.round(e.t * f) + 6);
    for (const e of ev) if (e.type === "scroll" || e.type === "move") s.add(Math.round((e.t + (e.dur || 0)) * f) + 2);
    if (types.length) { s.add(Math.round(types[0].t * f) + 3); s.add(Math.round(types.at(-1).t * f) + 3); }
    const n = Math.round(a.durationSeconds * f);
    s.add(Math.round(n / 2)); s.add(n - 1);
    console.log([...s].filter((x) => x >= 0 && x < n).sort((x, y) => x - y).join(","));
  ' "$OUT/$clip.actions.json" 2>/dev/null || echo 0)
  echo "png frames: $PNGS"
  mkdir -p "$OUT/frames/$clip"
  "$BIN/framestats" "$OUT/$clip.mov" --rec "$OUT/$clip.mov.json" --actions "$OUT/$clip.actions.json" \
    --png "$PNGS" --png-events --png-width 1600 --outdir "$OUT/frames/$clip" --csv "$OUT/$clip.frames.csv" \
    > "$OUT/$clip.stats.json"
  echo "framestats exit $?"
  node -e '
    const s = require(process.argv[1]); delete s.events;
    console.log(JSON.stringify({ file: s.file, size: [s.width, s.height], frames: s.frames, fps: s.measuredFps, dur: s.durationSeconds,
      distinct: s.distinctPictures, blank: s.blankSuspect, titleBar: s.titleBarCorner, lag: s.eventLagFrames }));
  ' "$OUT/$clip.stats.json"
  # Measured, not assumed: when each click / key first changed the picture.
  node -e '
    const fs = require("fs"); const [a, s] = process.argv.slice(1);
    const A = JSON.parse(fs.readFileSync(a)); const S = JSON.parse(fs.readFileSync(s));
    for (const r of S.events || []) if (r.firstChangedFrame != null) A.events[r.event].shown = r.firstChangedFrame / A.fps;
    fs.writeFileSync(a, JSON.stringify(A, null, 2));
  ' "$OUT/$clip.actions.json" "$OUT/$clip.stats.json" && echo "$clip.actions.json: added shown times"
done
ls -la "$OUT"
du -sh "$OUT"
exit $take
