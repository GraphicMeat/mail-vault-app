#!/usr/bin/env bash
# The website feature-card clips (scenes/web-clips.js), one locale at a time:
# three app boots on the mini, each through testq + minijob, then the web
# clips copied to "~/Movies/MailVault Website Clips/<locale dir>/".
#
#   bash scripts/footage/web-clips.sh record <locale> <work dir> [A] ... [H]   # default: every boot
#   bash scripts/footage/web-clips.sh encode <locale> <work dir> [clip ...]    # re-cut collected takes, no boot
#   bash scripts/footage/web-clips.sh publish <locale> <work dir>              # copy mp4 + jpg to ~/Movies
#   bash scripts/footage/web-clips.sh hero <locale> <work dir>                 # the 16:10 hero montage, no boot
#
# WEBCLIP_ONLY=clip[,clip] with `record` re-takes only those clips of the boot
# (same env; the boot's setup still runs; collect.sh replaces just those takes);
# with `publish` it copies only those. `publish` never writes over a clip already
# in ~/Movies (or _needs-decision) unless WEBCLIP_REPLACE=clip[,clip] names it.
# <locale>: en, or a website dir (de es fr it ja ko pt-br zh); see lib/locale.js.
# Run from the worktree. Results: <work dir>/<locale>/<boot>.tar + .log, the
# collected takes in <work dir>/<locale>/takes/<clip>/, web clips in
# <work dir>/<locale>/web/. Phase 2 loops the locales over `record` + `publish`.
#
# Boots (env must not be mixed across them):
#   A  archive-delete     deletes 2022 from the mock server; body fetch slowed to 65 ms
#                         so the archive's progress is visible (about 6 s, cut in the clip).
#   B  search-50k         50,000-message vault seeded before boot (49,932 + the demo's 68),
#                         index finished before the take; no history.
#   C  unified-inbox link-safety trackers undo-send time-capsule scheduled-backups
#                         extra mail (the tracker newsletter), every account's clock aligned.
#   D  sender-verification chat-view scheduled-send   (batch 2)
#                         history, every account's clock moved by a fixed -320 min (the chat
#                         list's relative times and the Scheduled row read the same in any run
#                         after 05:52 local); the server is left alone.
#   E  email-cleanup search-local insights views   (batch 2)
#                         history + extra + subscription mail (the cleanup classifier needs the
#                         lists for its Newsletter group); archives that group, then the whole
#                         INBOX (search-local answers from the vault, Insights reads it all,
#                         the Attachments view lists what the vault holds).
#   F  privacy-mode layouts manual-backup custom-fields   (batch 2)
#                         the demo mailbox alone (no history: the manual backup takes seconds),
#                         clocks moved -320 min; backs up to a folder in the run's HOME.
#   G  ai-writing tagging-rules   (batch 2)
#                         FOOTAGE_FM_HELPER=1: Apple Intelligence through the helper (the mini has
#                         it switched on); the demo mailbox alone; one invoice appended over IMAP
#                         while another folder is open (batch 3 retake of tagging-rules).
#   H  quick-actions explorer-view column-layout shortcuts notification-rules templates tags
#      radial-menu snooze focus-session   (batch 3)
#                         the demo mailbox alone, clocks moved -320 min (as F); settings each take
#                         changes are put back after it; snooze moves one row out of the INBOX and
#                         focus-session ends unlocked, so they run last.
#
# THE WAY NOW (one build, every clip; web-clips-job.sh, groups in web-clips.groups.json):
#   bash scripts/footage/web-clips.sh verify <locales> <work dir>   # every take's steps + assertions, no recording
#   bash scripts/footage/web-clips.sh all <locales> <work dir>      # verify, then record + encode + hero + check
#   WEBCLIP_PUB=en-v2 bash scripts/footage/web-clips.sh publish en <work dir>/<run dir>
# <locales>: "en" or a list ("en de fr" / "en,de,fr"): one build, one launch per
# group per locale. Each call gets its own <work dir>/<mode>-<stamp>/ (job.tar,
# job.log, the unpacked results); nothing is merged with an earlier run.
# all refuses to record when a take fails verify (WEBCLIP_FORCE=1 records anyway;
# the failing clips are then held at publish). WEBCLIP_ONLY=clip,clip runs just those.
# `record`, `encode` and `hero` below are the older per-boot path.
set -euo pipefail
cmd="${1:?verify|all|record|encode|publish}"; LOC="${2:?locale}"; WORK="${3:?work dir}"; shift 3
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

case "$cmd" in
  verify|all)
    locs="$(printf '%s' "$LOC" | tr ',' ' ')"
    RUN="$WORK/$cmd-$(date +%Y%m%d-%H%M%S)"; mkdir -p "$RUN"
    ~/.claude/bin/testq --status 2>&1 | tail -5 || true
    echo "== $cmd ($locs) -> $RUN  $(date +%H:%M:%S)"
    t0=$(date +%s)
    rc=0
    # verify: about 25 min per locale; all: about 80 min per locale (one build either way).
    TESTQ_TIMEOUT="${TESTQ_TIMEOUT:-21600}" ~/.claude/bin/testq --lane mini-e2e ~/.claude/bin/minijob \
      env WEBCLIP_MODE="$cmd" WEBCLIP_LOCALES="$locs" ${WEBCLIP_GROUPS:+WEBCLIP_GROUPS="$WEBCLIP_GROUPS"} \
      ${WEBCLIP_ONLY:+WEBCLIP_ONLY="$WEBCLIP_ONLY"} ${WEBCLIP_FORCE:+WEBCLIP_FORCE="$WEBCLIP_FORCE"} ${WEBCLIP_SHIFT_MIN:+WEBCLIP_SHIFT_MIN="$WEBCLIP_SHIFT_MIN"} ${WEBCLIP_ENV:+WEBCLIP_ENV="$WEBCLIP_ENV"} \
      bash scripts/footage/web-clips-job.sh > "$RUN/job.tar" 2> "$RUN/job.log" || rc=$?
    echo "== job exit $rc after $(( $(date +%s) - t0 )) s (log $RUN/job.log)"
    tar -xf "$RUN/job.tar" -C "$RUN" 2>/dev/null || { echo "no tar from the job"; tail -40 "$RUN/job.log"; exit 1; }
    node -e 'const j=require(process.argv[1]); console.log(`builds ${j.builds}, wall ${j.wallSeconds} s, phases ${JSON.stringify(j.phases)}`)' "$RUN/job.json" || true
    for l in $locs; do
      for ph in verify record; do
        [ -f "$RUN/$l/$ph/verify.json" ] || continue
        echo "-- $l $ph"
        node -e 'for (const c of require(process.argv[1]).clips) console.log(`${c.pass ? "PASS" : "FAIL"} ${c.clip.padEnd(20)} ${(c.checks||[]).filter((x)=>x.ok).length}/${(c.checks||[]).length} checks${c.pass ? "" : "  " + (c.error || (c.checks||[]).filter((x) => !x.ok).map((x) => x.name).join("; ")).slice(0, 160)}${c.scanOk === false ? "  [text scan: " + (c.textScan||[]).map((h) => h.text).join(" / ").slice(0, 120) + "]" : ""}`)' "$RUN/$l/$ph/verify.json"
      done
      [ -d "$RUN/$l/web" ] && node scripts/footage/lib/webclipCheck.mjs "$RUN/$l" || true
    done
    echo "results: $RUN"
    exit $rc
    ;;
esac

D="$WORK/$LOC"; mkdir -p "$D"
# WEBCLIP_PUB: the folder under ~/Movies/MailVault Website Clips/ to publish to
# (default the locale). A v2 set goes to its own folder (en-v2); the site copies from en/.
PUB="$HOME/Movies/MailVault Website Clips/${WEBCLIP_PUB:-$LOC}"

COMMON=(FOOTAGE_SPEC=web-clips FOOTAGE_THEME=dark FOOTAGE_LOCALE="$LOC" FOOTAGE_WEBCLIP=1 FOOTAGE_BITRATE=20)
boot_env() {
  case "$1" in
    A) echo FOOTAGE_ONLY=archive-delete FOOTAGE_HISTORY=1 FOOTAGE_BODY_DELAY_MS=65 FOOTAGE_EXPECT_TOTAL=2842 ;;
    B) echo FOOTAGE_ONLY=search-50k FOOTAGE_CORPUS_50K=1 FOOTAGE_CORPUS_N=49932 FOOTAGE_EXPECT_TOTAL=82 FOOTAGE_BODY_DELAY_MS=0 FOOTAGE_OPT_LEVEL=3 ;;
    C) echo FOOTAGE_ONLY=unified-inbox,link-safety,trackers,undo-send,time-capsule,scheduled-backups \
            FOOTAGE_HISTORY=1 FOOTAGE_EXTRA_MAIL=1 FOOTAGE_ALIGN_ALL=1 FOOTAGE_BODY_DELAY_MS=0 FOOTAGE_EXPECT_TOTAL=2852 ;;
    D) echo FOOTAGE_ONLY=sender-verification,chat-view,scheduled-send \
            FOOTAGE_HISTORY=1 FOOTAGE_ALIGN_ALL=1 FOOTAGE_ALIGN_SHIFT_MIN=-320 FOOTAGE_BODY_DELAY_MS=0 FOOTAGE_EXPECT_TOTAL=2842 ;;
    E) echo FOOTAGE_ONLY=email-cleanup,search-local,insights,views \
            FOOTAGE_HISTORY=1 FOOTAGE_EXTRA_MAIL=1 FOOTAGE_UNSUB_MAIL=1 FOOTAGE_ALIGN_ALL=1 FOOTAGE_ALIGN_SHIFT_MIN=-320 \
            FOOTAGE_BODY_DELAY_MS=0 FOOTAGE_EXPECT_TOTAL=2861 ;;
    F) echo FOOTAGE_ONLY=privacy-mode,layouts,manual-backup,custom-fields \
            FOOTAGE_ALIGN_ALL=1 FOOTAGE_ALIGN_SHIFT_MIN=-320 FOOTAGE_BODY_DELAY_MS=0 FOOTAGE_EXPECT_TOTAL=82 ;;
    G) echo FOOTAGE_ONLY=ai-writing,tagging-rules FOOTAGE_FM_HELPER=1 \
            FOOTAGE_ALIGN_ALL=1 FOOTAGE_ALIGN_SHIFT_MIN=-320 FOOTAGE_BODY_DELAY_MS=0 FOOTAGE_EXPECT_TOTAL=82 ;;
    H) echo FOOTAGE_ONLY=quick-actions,explorer-view,column-layout,shortcuts,notification-rules,templates,tags,radial-menu,snooze,focus-session \
            FOOTAGE_ALIGN_ALL=1 FOOTAGE_ALIGN_SHIFT_MIN=-320 FOOTAGE_BODY_DELAY_MS=0 FOOTAGE_EXPECT_TOTAL=82 ;;
    *) echo "unknown boot $1" >&2; exit 64 ;;
  esac
}

case "$cmd" in
  record)
    boots=("$@"); [ ${#boots[@]} -gt 0 ] || boots=(A B C D E F G H)
    for b in "${boots[@]}"; do
      echo "== boot $b ($LOC) $(date +%H:%M:%S)"
      # shellcheck disable=SC2046
      TESTQ_TIMEOUT=14400 ~/.claude/bin/testq --lane mini-e2e ~/.claude/bin/minijob \
        env "${COMMON[@]}" $(boot_env "$b") ${WEBCLIP_ONLY:+FOOTAGE_ONLY=$WEBCLIP_ONLY} bash scripts/footage/run.sh > "$D/$b.tar" 2> "$D/$b.log" || echo "boot $b: job exit $?"
      bash scripts/footage/collect.sh "$D/$b.tar" "$D/takes" "$b"
      if [ -d "$D/takes/_runs/$b/web" ]; then mkdir -p "$D/web"; cp -R "$D/takes/_runs/$b/web/." "$D/web/"; fi
      echo "== boot $b done $(date +%H:%M:%S)"
    done
    ;;
  encode)
    # Re-cut collected takes on the mini without booting the app: the takes ride
    # to the job as untracked files (never committed) and are removed after.
    SRC="$ROOT/.webclip-src"
    rm -rf "$SRC"; mkdir -p "$SRC"
    trap 'rm -rf "$SRC"' EXIT
    clips=("$@")
    if [ ${#clips[@]} -eq 0 ]; then for d in "$D"/takes/*/; do c="$(basename "$d")"; [ "$c" = _runs ] || clips+=("$c"); done; fi
    for c in "${clips[@]}"; do
      cp "$D/takes/$c/$c.mov" "$D/takes/$c/$c.webclip.json" "$D/takes/$c/$c.actions.json" "$SRC/"
    done
    if git check-ignore -q "$SRC/x.mov"; then echo ".webclip-src is ignored; it would not ship"; exit 1; fi
    only="$(IFS=,; echo "${clips[*]}")"
    stamp="$(date +%H%M%S)"
    TESTQ_TIMEOUT=3600 ~/.claude/bin/testq --lane mini-e2e ~/.claude/bin/minijob \
      env FOOTAGE_WEBCLIP_ONLY="$only" bash scripts/footage/webclip-encode.sh .webclip-src --tar > "$D/encode-$stamp.tar" 2> "$D/encode-$stamp.log"
    mkdir -p "$D/web"
    tar -xf "$D/encode-$stamp.tar" -C "$D/web"
    echo "encoded -> $D/web (log $D/encode-$stamp.log)"
    ;;
  hero)
    # The homepage hero: hard cuts between already-recorded takes
    # (scripts/footage/hero-montage.json names each take, its seconds and its
    # 16:10 crop), encoded on the mini at 1440x900 like the cards. Ships the
    # named takes as untracked files (never committed), removed after.
    SRC="$ROOT/.webclip-src"
    rm -rf "$SRC"; mkdir -p "$SRC"
    trap 'rm -rf "$SRC"' EXIT
    for c in $(node -e 'const h=require(process.argv[1]);console.log([...new Set(h.segments.map((s)=>s.take))].join(" "))' "$ROOT/scripts/footage/hero-montage.json"); do
      [ -f "$D/takes/$c/$c.mov" ] || { echo "hero: no take $D/takes/$c/$c.mov"; exit 1; }
      cp "$D/takes/$c/$c.mov" "$SRC/"
    done
    node -e '
      const h = require(process.argv[1]);
      const spec = { ...h, segments: h.segments.map(({ take: t, ...s }) => ({ ...s, src: `${t}.mov` })) };
      let at = 0; spec.inspect = [];
      for (const s of spec.segments) { spec.inspect.push(Number((at + 0.15).toFixed(2)), Number((at + (s.t1 - s.t0) / 2).toFixed(2))); at += s.t1 - s.t0; }
      spec.crop = spec.segments[0].crop;
      spec.durationSeconds = Number(at.toFixed(3));
      require("fs").writeFileSync(process.argv[2], JSON.stringify(spec, null, 2));
      console.log(`hero: ${spec.segments.length} segments, ${at.toFixed(2)} s`);
    ' "$ROOT/scripts/footage/hero-montage.json" "$SRC/hero-montage.webclip.json"
    if git check-ignore -q "$SRC/x.mov"; then echo ".webclip-src is ignored; it would not ship"; exit 1; fi
    stamp="$(date +%H%M%S)"
    TESTQ_TIMEOUT=3600 ~/.claude/bin/testq --lane mini-e2e ~/.claude/bin/minijob \
      env FOOTAGE_WEBCLIP_ONLY=hero-montage bash scripts/footage/webclip-encode.sh .webclip-src --tar > "$D/hero-$stamp.tar" 2> "$D/hero-$stamp.log"
    mkdir -p "$D/web"
    tar -xf "$D/hero-$stamp.tar" -C "$D/web"
    echo "hero -> $D/web/hero-montage.mp4 (log $D/hero-$stamp.log)"
    ;;
  publish)
    [ "${WEBCLIP_PUB:-$LOC}" != "$LOC" ] || [ -n "${WEBCLIP_PUB_SAME:-}" ] || [ ! -d "$PUB" ] || [ -z "$(ls -A "$PUB")" ] \
      || { echo "publish: $PUB already holds a set; publish a new set with WEBCLIP_PUB=<new folder> (WEBCLIP_PUB_SAME=1 adds to it)"; exit 1; }
    mkdir -p "$PUB"
    for f in "$D"/web/*.mp4; do
      n="$(basename "$f" .mp4)"
      case "$n" in *-wide) continue ;; esac
      # WEBCLIP_ONLY=clip,clip publishes just those (the rest of web/ stays unreviewed).
      [ -z "${WEBCLIP_ONLY:-}" ] || [[ ",$WEBCLIP_ONLY," == *",$n,"* ]] || continue
      # search-50k shows the real search time; the website wants under 15 ms
      # (en: 68 ms on the mini). It lands apart until someone decides.
      # WEBCLIP_HOLD="clip:reason,clip:reason" sends reviewed-but-not-approved clips there too
      # (a reason cannot contain a comma).
      hold="$(printf '%s' "${WEBCLIP_HOLD:-}" | tr ',' '\n' | awk -F: -v n="$n" '$1==n { sub(/^[^:]*:/, ""); print; exit }')"
      # A clip the output check failed (lib/webclipCheck.mjs, check.json of this run) is held with its reasons.
      if [ -z "$hold" ] && [ -f "$D/check.json" ]; then
        hold="$(node -e 'const c=require(process.argv[1]).clips.find((x)=>x.clip===process.argv[2]); if (c && !c.ok) console.log("output check: " + c.reasons.join(" | "))' "$D/check.json" "$n")"
      fi
      # Never over a file already handed over (published or held): a re-take that
      # should replace one names it in WEBCLIP_REPLACE=clip,clip after review.
      dest="$PUB"; { [ "$n" = search-50k ] || [ -n "$hold" ]; } && dest="$PUB/_needs-decision"
      if [ -e "$dest/$n.mp4" ] && [[ ",${WEBCLIP_REPLACE:-}," != *",$n,"* ]]; then
        echo "skip $n: $dest/$n.mp4 exists (WEBCLIP_REPLACE=$n to replace)"; continue
      fi
      if [ "$n" = search-50k ] || [ -n "$hold" ]; then
        mkdir -p "$PUB/_needs-decision"; cp "$f" "$D/web/$n.jpg" "$PUB/_needs-decision/"
        [ -n "$hold" ] && printf '%s\n' "$hold" > "$PUB/_needs-decision/$n.reason.txt"
        echo "$PUB/_needs-decision/$n.mp4"; continue
      fi
      cp "$f" "$PUB/$n.mp4"; cp "$D/web/$n.jpg" "$PUB/$n.jpg"
      echo "$PUB/$n.mp4 ($(stat -f %z "$f") B)"
    done
    ;;
  *) echo "usage: web-clips.sh record|encode|hero|publish <locale> <work dir> [...]"; exit 64 ;;
esac
