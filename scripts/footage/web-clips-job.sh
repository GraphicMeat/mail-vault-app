#!/usr/bin/env bash
# Every website clip of one or more locales in ONE mini job, from ONE build:
# compile the Swift tools, prepare-build, `npm run build:e2e` and the mock IMAP
# server once; then per locale and per launch group (web-clips.groups.json) a
# fresh short HOME, the group's seed env and one app launch that runs the
# group's takes; the app, its daemon and the mock servers are stopped before
# the next launch. Started by scripts/footage/web-clips.sh (verify | all),
# through testq + minijob; never run it on a desktop Mac.
#
#   WEBCLIP_MODE=verify|record|all WEBCLIP_LOCALES="en de" [WEBCLIP_GROUPS="history mail demo"] \
#     bash scripts/footage/web-clips-job.sh > job.tar 2> job.log
#
# verify: every take's steps and assertions, no recorder, no encode.
# record: the takes recorded, read back (framestats), every clip and the hero
#         montage encoded, the output checked.
# all:    verify, then record only when every take passed (WEBCLIP_FORCE=1
#         records anyway; failing clips are then held by the output check).
#
# stdout is ONLY a tar:
#   job.json                                  phases, timings, builds (always 1)
#   <locale>/verify/verify.json, <group>/...  verify phase (per group: run.log, facts, verify)
#   <locale>/record/verify.json, <group>/...  record phase, same, plus the takes' assertions
#   <locale>/takes/<clip>.mov|.actions.json|.webclip.json|.textscan.json|.stats.json|...
#   <locale>/takes/frames/<clip>/*.png        framestats frames of the take
#   <locale>/web/<clip>.mp4|.jpg|.report.json, web/frames/<clip>/*.jpg   (hero-montage too)
#   <locale>/check.json                       lib/webclipCheck.mjs
set -uo pipefail
exec 3>&1 1>&2

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
MODE="${WEBCLIP_MODE:-all}"
LOCALES="$(printf '%s' "${WEBCLIP_LOCALES:-en}" | tr ',' ' ')"
GROUPS_JSON="$ROOT/scripts/footage/web-clips.groups.json"
CLIP_GROUPS="${WEBCLIP_GROUPS:-$(node -e 'console.log(require(process.argv[1]).default.join(" "))' "$GROUPS_JSON")}"
CLIP_GROUPS="$(printf '%s' "$CLIP_GROUPS" | tr ',' ' ')"
OUT="$(mktemp -d -t mvall)"
BIN="$(mktemp -d -t mvbin)"
HOMEDIR=""
export FOOTAGE_PORT="${FOOTAGE_PORT:-4468}"
export FOOTAGE_WINDOW="${FOOTAGE_WINDOW:-1536x928}"
export FOOTAGE_CAPTURE="${FOOTAGE_CAPTURE:-app}"
FOOTAGE_CAP="$ROOT/src-tauri/capabilities/footage.json"
CAF=""
JOB0=$(date +%s)
DAY0="$(date +%F)"
PHASES=()   # "name seconds" lines for job.json

phase() { PHASES+=("$1 $2"); }
step() { echo; echo "== $* ($(date +%H:%M:%S))"; }

# Ours: the driver on our port, anything under this clone's target/ (app,
# daemon, mock servers) or our temp bin (recorder).
stop_app() {
  pkill -f "tauri-wd-shots --port $FOOTAGE_PORT" 2>/dev/null
  pkill -f "$ROOT/target/" 2>/dev/null
  pkill -f "$BIN/" 2>/dev/null
  for _ in $(seq 1 20); do
    pgrep -f "$ROOT/target/|tauri-wd-shots --port $FOOTAGE_PORT|$BIN/" >/dev/null || return 0
    sleep 0.5
  done
  pkill -9 -f "$ROOT/target/|tauri-wd-shots --port $FOOTAGE_PORT|$BIN/" 2>/dev/null
  sleep 1
  pgrep -fl "$ROOT/target/|tauri-wd-shots --port $FOOTAGE_PORT|$BIN/" && echo "stop_app: processes survived SIGKILL"
  return 0
}

write_job_json() {
  node -e '
    const [out, mode, locales, groups, t0, builds, ...ph] = process.argv.slice(1);
    const phases = Object.fromEntries(ph.map((l) => { const [n, s] = l.split(" "); return [n, Number(s)]; }));
    require("fs").writeFileSync(`${out}/job.json`, JSON.stringify({ mode, locales: locales.split(" "), groups: groups.split(" "),
      builds: Number(builds), wallSeconds: Math.round(Date.now() / 1000 - Number(t0)), phases, host: require("os").hostname(),
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone, startedLocal: new Date(Number(t0) * 1000).toString() }, null, 2));
  ' "$OUT" "$MODE" "$LOCALES" "$CLIP_GROUPS" "$JOB0" "${BUILDS:-0}" "${PHASES[@]}"
}

finish() {
  local status=$?
  stop_app
  [ -n "$CAF" ] && kill "$CAF" 2>/dev/null
  pgrep -fl "mailvault" | grep -v "$ROOT/" > "$OUT/foreign.txt" 2>&1 || true
  scripts/screenshots/prepare-build.sh --revert >/dev/null 2>&1
  rm -f "$FOOTAGE_CAP"
  echo "job exit $status" > "$OUT/exit.txt"
  write_job_json
  tar -C "$OUT" -cf - . >&3
  rm -rf "$OUT" "$BIN"
  [ -n "$HOMEDIR" ] && rm -rf "$HOMEDIR"
}
trap finish EXIT

disk_ok() {
  local free
  free=$(df -g / | awk 'NR==2 {print $4}')
  echo "disk: ${free} GB free"
  if [ "${free:-0}" -lt 15 ]; then echo "disk: under 15 GB free; stopping (never delete anything else)"; return 1; fi
}

# ── Preflight ───────────────────────────────────────────────────────────────
step "preflight: mode $MODE, locales $LOCALES, groups $CLIP_GROUPS, $(date), TZ $(date +%Z)"
live="$(pgrep -fl "tauri-wd|mock-imap-server" | grep -vE "runjob\.sh|lockf|minijob" || true)"
if [ -n "$live" ]; then echo "$live"; echo "a driver or mock server is live; one app instance at a time"; exit 1; fi
disk_ok || exit 1
caffeinate -u -d -i -t 21600 & CAF=$!
osascript -e 'tell application "System Events" to key code 53' 2>&1 || true

# ── Build, once ─────────────────────────────────────────────────────────────
t=$(date +%s)
step "compile recorder, framestats, cursor, probe, webclip"
for tool in video/capture/recorder.swift video/capture/tools/framestats.swift video/capture/tools/cursor.swift \
            video/capture/tools/probe.swift video/capture/tools/webclip.swift; do
  swiftc -O "$tool" -o "$BIN/$(basename "$tool" .swift)" || exit 1
done
export FOOTAGE_CURSOR_TOOL="$BIN/cursor"
"$BIN/probe" > "$OUT/probe.json" && grep -E '"backingScale"|"modePixels"' -A2 "$OUT/probe.json" | tr -d ' \n'; echo

step "build: prepare-build, VITE_E2E frontend, debug daemon as the sidecar, app with webdriver, mock IMAP"
scripts/screenshots/prepare-build.sh || exit 1
cat > "$FOOTAGE_CAP" <<'JSON'
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "footage",
  "description": "Footage builds only - lets the harness set the window appearance (light takes)",
  "windows": ["main"],
  "permissions": ["core:window:allow-set-theme"]
}
JSON
npm run build:e2e || exit 1
if cmp -s target/debug/mailvault-daemon src-tauri/binaries/mailvault-daemon-aarch64-apple-darwin; then
  echo "daemon: target/debug/mailvault-daemon is the freshly staged sidecar"
else
  echo "daemon: STALE sidecar"; exit 1
fi
SPARKLE_FRAMEWORK_PATH="$PWD/src-tauri" cargo build -p mock-imap --bin mock-imap-server || exit 1
# Apple Intelligence (ai-writing, tagging-rules): the FM helper sidecar, where
# find_fm_helper_binary looks. Built once whatever the group list; its probe
# only decides whether those takes can pass.
if node -e 'const g=require(process.argv[1]); process.exit(process.argv.slice(2).some((n)=>g.groups[n]?.fmHelper)?0:1)' "$GROUPS_JSON" $CLIP_GROUPS; then
  bash scripts/build-fm-helper.sh || exit 1
  echo '{"id":"1","op":"availability"}' | src-tauri/helpers/mailvault-fm-helper > "$OUT/fm-probe.json" 2>&1
  echo "fm helper availability: $(cat "$OUT/fm-probe.json")"
fi
BUILDS=1
phase build $(( $(date +%s) - t ))
echo "build done in $(( $(date +%s) - t )) s (the only build of this job)"

for i in $(seq 1 120); do
  pgrep -f "xcodebuild test|XCTRunner|UITests-Runner" >/dev/null || break
  [ "$i" = 1 ] && echo "UI tests of another project are driving the display, waiting"
  sleep 5
done

# ── One launch ──────────────────────────────────────────────────────────────
# run_group <locale> <phase dir name> <group> <verify 0|1>
run_group() {
  local loc="$1" ph="$2" group="$3" verify="$4"
  local G="$OUT/$loc/$ph/$group"
  mkdir -p "$G"
  if [ "$(date +%F)" != "$DAY0" ] && [ "$verify" = 0 ]; then
    echo "group $group: the local date moved past midnight since the job started; its weekday and relative labels would not match the rest" | tee "$G/refused.txt"
    return 1
  fi
  disk_ok || return 1
  # Short on purpose: the daemon socket is $HOME/.mailvault/mv.sock, capped at 104 bytes.
  HOMEDIR="$(mktemp -d -t mvf)"
  local envs clips
  envs="$(node -e '
    const g = require(process.argv[1]); const x = g.groups[process.argv[2]];
    if (!x) { console.error(`no group ${process.argv[2]}`); process.exit(1); }
    // WEBCLIP_SHIFT_MIN: another fixed clock for a pipeline trial outside the recording hours (never for a set to publish).
    const shift = process.env.WEBCLIP_SHIFT_MIN ? { FOOTAGE_ALIGN_SHIFT_MIN: process.env.WEBCLIP_SHIFT_MIN } : {};
    // WEBCLIP_ENV="FOOTAGE_X=1 FOOTAGE_Y=2": extra knobs for every launch (a trial of one take path).
    const extra = Object.fromEntries((process.env.WEBCLIP_ENV || "").split(/[\s,]+/).filter((kv) => /^FOOTAGE_[A-Z0-9_]+=/.test(kv)).map((kv) => [kv.split("=")[0], kv.slice(kv.indexOf("=") + 1)]));
    console.log(Object.entries({ ...g.common, ...x.env, ...shift, ...extra }).map(([k, v]) => `${k}=${v}`).join("\n"));
  ' "$GROUPS_JSON" "$group")" || return 1
  # WEBCLIP_ONLY=clip,clip: just those, each in its own group's launch (the rest of the group is skipped).
  clips="$(node -e '
    const only = (process.env.WEBCLIP_ONLY || "").split(",").filter(Boolean);
    const c = require(process.argv[1]).groups[process.argv[2]].clips.filter((x) => !only.length || only.includes(x));
    console.log(c.join(","));' "$GROUPS_JSON" "$group")"
  [ -n "$clips" ] || { echo "group $group: nothing of WEBCLIP_ONLY in it"; rmdir "$G" 2>/dev/null; return 0; }
  step "$ph $loc/$group: $clips (HOME $HOMEDIR)"
  local t0; t0=$(date +%s)
  # shellcheck disable=SC2046
  env $(printf '%s\n' "$envs" | tr '\n' ' ') \
    FOOTAGE_LOCALE="$loc" FOOTAGE_ONLY="$clips" FOOTAGE_VERIFY="$verify" \
    FOOTAGE_ALIGN_STRICT="$([ "$verify" = 1 ] && echo 0 || echo 1)" \
    FOOTAGE_SCENE=web-clips FOOTAGE_OUT="$G" FOOTAGE_RECORDER="$BIN/recorder" FOOTAGE_DATA_DIR="$HOMEDIR" \
    npx wdio run wdio.footage.conf.js > "$G/run.log" 2>&1
  local rc=$?
  echo "wdio exit $rc in $(( $(date +%s) - t0 )) s"
  grep -E '\[verify\]|\[check\] .*FAIL|\[footage\] demo clock|Error:|failing|passing' "$G/run.log" | head -80
  stop_app
  find "$HOMEDIR" -name 'daemon.log*' -exec tail -400 {} \; > "$G/daemon-tail.log" 2>/dev/null
  rm -rf "$HOMEDIR"; HOMEDIR=""
  phase "$ph-$loc-$group" $(( $(date +%s) - t0 ))
  [ -f "$G/web-clips.verify.json" ] || echo "{\"clips\":[],\"error\":\"group $group wrote no verify report (wdio exit $rc)\"}" > "$G/web-clips.verify.json"
  return 0
}

# Merge the groups' reports into <locale>/<phase>/verify.json; exit 1 when any clip failed or never ran.
merge_verify() {
  node -e '
    const fs = require("fs"); const [dir, groupsJson, ...groups] = process.argv.slice(1);
    const g = require(groupsJson); const clips = [];
    for (const n of groups) {
      let r = {}; try { r = JSON.parse(fs.readFileSync(`${dir}/${n}/web-clips.verify.json`, "utf8")); } catch {}
      const want = (process.env.WEBCLIP_ONLY || "").split(",").filter(Boolean);
      for (const c of g.groups[n].clips.filter((x) => !want.length || want.includes(x))) clips.push({ group: n, ...((r.clips || []).find((x) => x.clip === c) || { clip: c, pass: false, error: r.error || "no result", checks: [] }) });
    }
    fs.writeFileSync(`${dir}/verify.json`, JSON.stringify({ clips }, null, 2));
    for (const c of clips) console.log(`${c.pass ? "PASS" : "FAIL"} ${c.group.padEnd(8)} ${c.clip.padEnd(20)} ${c.seconds ?? "-"} s  ${c.pass ? "" : (c.error || c.checks.filter((x) => !x.ok).map((x) => x.name).join("; ")).slice(0, 200)}${c.scanOk === false ? `  [text scan: ${(c.textScan || []).map((h) => h.text).join(" / ").slice(0, 160)}]` : ""}`);
    process.exit(clips.every((c) => c.pass) ? 0 : 1);
  ' "$1" "$GROUPS_JSON" $CLIP_GROUPS
}

# Read a recorded take back: framestats frames and the measured "shown" times (as run.sh).
readback() {
  local dir="$1" clip="$2"
  [ -f "$dir/$clip.actions.json" ] || { echo "$clip: no actions.json (take did not finish)"; return; }
  local PNGS
  PNGS=$(node -e '
    const a = require(process.argv[1]); const f = a.fps || 60; const s = new Set([0]);
    const ev = a.events; const types = ev.filter((e) => e.type === "type" && e.text !== "\n");
    for (const e of ev) if (e.type !== "type" || e.text === "\n") s.add(Math.round(e.t * f) + 6);
    for (const e of ev) if (e.type === "scroll" || e.type === "move") s.add(Math.round((e.t + (e.dur || 0)) * f) + 2);
    if (types.length) { s.add(Math.round(types[0].t * f) + 3); s.add(Math.round(types.at(-1).t * f) + 3); }
    const n = Math.round(a.durationSeconds * f);
    s.add(Math.round(n / 2)); s.add(n - 1);
    console.log([...s].filter((x) => x >= 0 && x < n).sort((x, y) => x - y).join(","));
  ' "$dir/$clip.actions.json" 2>/dev/null || echo 0)
  mkdir -p "$dir/frames/$clip"
  "$BIN/framestats" "$dir/$clip.mov" --rec "$dir/$clip.mov.json" --actions "$dir/$clip.actions.json" \
    --png "$PNGS" --png-events --png-width 1600 --outdir "$dir/frames/$clip" --csv "$dir/$clip.frames.csv" \
    > "$dir/$clip.stats.json"
  node -e '
    const fs = require("fs"); const [a, s] = process.argv.slice(1);
    const A = JSON.parse(fs.readFileSync(a)); const S = JSON.parse(fs.readFileSync(s));
    for (const r of S.events || []) if (r.firstChangedFrame != null) A.events[r.event].shown = r.firstChangedFrame / A.fps;
    fs.writeFileSync(a, JSON.stringify(A, null, 2));
    console.log(`${A.scene}: ${S.frames} frames, ${S.distinctPictures} distinct, blank ${S.blankSuspect}`);
  ' "$dir/$clip.actions.json" "$dir/$clip.stats.json"
}

VERIFY_OK=1
# ── Verify ──────────────────────────────────────────────────────────────────
if [ "$MODE" = verify ] || [ "$MODE" = all ]; then
  t=$(date +%s)
  for loc in $LOCALES; do
    for group in $CLIP_GROUPS; do run_group "$loc" verify "$group" 1; done
    step "verify $loc"
    merge_verify "$OUT/$loc/verify" || VERIFY_OK=0
  done
  phase verify $(( $(date +%s) - t ))
fi

if [ "$MODE" = verify ]; then exit $(( 1 - VERIFY_OK )); fi
if [ "$MODE" = all ] && [ "$VERIFY_OK" != 1 ] && [ "${WEBCLIP_FORCE:-0}" != 1 ]; then
  echo "verify failed: nothing recorded (WEBCLIP_FORCE=1 records anyway)"; exit 2
fi

# ── Record, read back, encode, check ────────────────────────────────────────
t=$(date +%s)
for loc in $LOCALES; do
  for group in $CLIP_GROUPS; do run_group "$loc" record "$group" 0; done
  step "record $loc: assertions"
  merge_verify "$OUT/$loc/record"
  T="$OUT/$loc/takes"; mkdir -p "$T/frames"
  for group in $CLIP_GROUPS; do
    G="$OUT/$loc/record/$group"
    for mov in "$G"/*.mov; do
      [ -e "$mov" ] || continue
      clip="$(basename "$mov" .mov)"
      step "read back $loc/$clip"
      readback "$G" "$clip"
      for f in "$G/$clip".*; do mv "$f" "$T/"; done
      [ -d "$G/frames/$clip" ] && mv "$G/frames/$clip" "$T/frames/$clip"
    done
  done
  phase "readback-$loc" $(( $(date +%s) - t ))
  te=$(date +%s)
  step "encode $loc"
  WEBCLIP_BIN="$BIN/webclip" bash scripts/footage/webclip-encode.sh "$T" "$OUT/$loc/web" || echo "encode reported a failure"
  step "hero montage $loc"
  if node scripts/footage/lib/heroSpec.mjs scripts/footage/hero-montage.json "$T" > "$T/hero-montage.webclip.json"; then
    WEBCLIP_BIN="$BIN/webclip" FOOTAGE_WEBCLIP_ONLY=hero-montage bash scripts/footage/webclip-encode.sh "$T" "$OUT/$loc/web" || echo "hero encode failed"
  else
    rm -f "$T/hero-montage.webclip.json"; echo "hero: not built (a take or segment is missing)"
  fi
  phase "encode-$loc" $(( $(date +%s) - te ))
  step "output check $loc"
  node scripts/footage/lib/webclipCheck.mjs "$OUT/$loc" || echo "output check: some clips fail (held at publish)"
done
phase record $(( $(date +%s) - t ))
du -sh "$OUT"
exit 0
