#!/usr/bin/env bash
# Recorder spike without the app: can a minijob-launched process record a window
# with ScreenCaptureKit, how many real pictures per second arrive, and does the
# recorder's START epoch line up with what the frames show?
#
#   ~/.claude/bin/testq ~/.claude/bin/minijob bash video/capture/spike.sh > spike.tar 2> spike.log
#
# stdout is a tar of the results (probe.json, clips, stats, a few PNGs); every
# log line goes to stderr. Nothing is left on the mini: the job clone is deleted
# by runjob, and the temp dirs and helper processes by the trap below.
set -uo pipefail
exec 3>&1 1>&2

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CAP="$ROOT/video/capture"
OUT="$(mktemp -d -t mvcap)"
BIN="$(mktemp -d -t mvbin)"
CAF=""

finish() {
  pkill -f "$BIN/" 2>/dev/null || true
  [ -n "$CAF" ] && kill "$CAF" 2>/dev/null
  tar -C "$OUT" -cf - . >&3
  rm -rf "$OUT" "$BIN"
}
trap finish EXIT

echo "== environment"
sw_vers | tr '\n' ' '; echo; date
caffeinate -u -d -t 600 & CAF=$!
osascript -e 'tell application "System Events" to key code 53' 2>&1 || true
sleep 1
echo "front: $(lsappinfo front | xargs lsappinfo info -only name 2>/dev/null)"
pgrep -fl "mailvault|tauri-wd|mock-imap|recorder|testwin" || echo "no app/driver/recorder processes"

echo "== compile"
for tool in recorder tools/testwin tools/framestats tools/probe tools/cursor; do
  name="$(basename "$tool")"
  if ! swiftc -O "$CAP/$tool.swift" -o "$BIN/$name" 2> "$OUT/compile-$name.log"; then
    echo "COMPILE FAILED: $name"; cat "$OUT/compile-$name.log"
  fi
done
ls -la "$BIN"

echo "== displays"
"$BIN/probe" | tee "$OUT/probe.json"
screencapture -x -t png "$OUT/desktop.png" && echo "desktop capture: $(stat -f %z "$OUT/desktop.png") bytes"
sips -Z 1600 "$OUT/desktop.png" >/dev/null 2>&1 || true

run_case() {
  local codec=$1 mode=$2 secs=$3 tw rec wid i k="$1-$2"
  echo "== case $codec, $mode mode, ${secs}s"
  "$BIN/testwin" $((secs + 8)) > "$OUT/testwin-$k.out" 2> "$OUT/testwin-$k.err" & tw=$!
  wid=""
  for i in $(seq 1 60); do
    wid=$(awk '/^WINDOW/{print $2}' "$OUT/testwin-$k.out")
    [ -n "$wid" ] && break
    sleep 0.1
  done
  if [ -z "$wid" ]; then echo "testwin never reported a window"; cat "$OUT/testwin-$k.err"; kill $tw; return 1; fi
  echo "testwin window: $wid"
  # Park the pointer in the middle of the captured window: frames without it are
  # then evidence of showsCursor = false. Not while another project's UI tests
  # are driving the pointer.
  if pgrep -f "xcodebuild test|XCTRunner" >/dev/null; then echo "UI tests running elsewhere: pointer left alone"
  else "$BIN/cursor" set 960 405; fi
  "$BIN/cursor" | tee "$OUT/cursor-$k.txt"
  "$BIN/recorder" "$wid" "$OUT/testwin-$k.mov" --fps 60 --codec "$codec" --mode "$mode" --bitrate 40 \
    > "$OUT/rec-$k.out" 2> "$OUT/rec-$k.err" & rec=$!
  for i in $(seq 1 120); do
    grep -q '^START' "$OUT/rec-$k.out" 2>/dev/null && break
    kill -0 $rec 2>/dev/null || break
    sleep 0.1
  done
  if ! grep -q '^START' "$OUT/rec-$k.out"; then
    echo "recorder never printed START:"; cat "$OUT/rec-$k.out" "$OUT/rec-$k.err"
    kill -INT $rec 2>/dev/null; wait $rec; echo "recorder exit $?"
    kill $tw 2>/dev/null
    screencapture -x -t png "$OUT/after-fail-$k.png" && sips -Z 1600 "$OUT/after-fail-$k.png" >/dev/null 2>&1
    echo "-- fallback: screencapture -v on the window and on the full screen"
    screencapture -x -v -V 3 -l "$wid" "$OUT/sc-window-$k.mov" 2>&1; echo "screencapture -v -l exit $?"
    screencapture -x -v -V 3 "$OUT/sc-full-$k.mov" 2>&1; echo "screencapture -v exit $?"
    ls -la "$OUT"/sc-*.mov 2>/dev/null
    return 1
  fi
  sleep 1
  echo "-- load while recording"
  ps -o pid,%cpu,rss,command -p "$rec,$tw"
  top -l 2 -s 1 -n 8 -o cpu -stats pid,command,cpu | tail -9
  sleep $((secs > 3 ? secs - 3 : 1))
  "$BIN/cursor" | tee -a "$OUT/cursor-$k.txt"
  kill -INT $rec; wait $rec; echo "recorder exit $?"
  kill $tw 2>/dev/null; wait $tw 2>/dev/null
  cat "$OUT/rec-$k.out" "$OUT/rec-$k.err"
  "$BIN/framestats" "$OUT/testwin-$k.mov" --rec "$OUT/testwin-$k.mov.json" --barcode \
    --png 0,1,2,60,61,180 --png-width 960 --outdir "$OUT/frames-$k" --csv "$OUT/frames-$k.csv" \
    > "$OUT/stats-$k.json" 2> "$OUT/stats-$k.err"
  echo "framestats exit $?"; cat "$OUT/stats-$k.json" "$OUT/stats-$k.err"
}

run_case hevc app 5
run_case h264 window 5

echo "== after"
pgrep -fl "recorder|testwin" || echo "no recorder/testwin left"
ls -laR "$OUT" | head -60
