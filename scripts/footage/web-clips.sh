#!/usr/bin/env bash
# The website feature-card clips (scenes/web-clips.js), one locale at a time:
# three app boots on the mini, each through testq + minijob, then the web
# clips copied to "~/Movies/MailVault Website Clips/<locale dir>/".
#
#   bash scripts/footage/web-clips.sh record <locale> <work dir> [A] [B] [C]   # default: all three boots
#   bash scripts/footage/web-clips.sh encode <locale> <work dir> [clip ...]    # re-cut collected takes, no boot
#   bash scripts/footage/web-clips.sh publish <locale> <work dir>              # copy mp4 + jpg to ~/Movies
#
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
set -euo pipefail
cmd="${1:?record|encode|publish}"; LOC="${2:?locale}"; WORK="${3:?work dir}"; shift 3
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
D="$WORK/$LOC"; mkdir -p "$D"
PUB="$HOME/Movies/MailVault Website Clips/$LOC"

COMMON=(FOOTAGE_SPEC=web-clips FOOTAGE_THEME=dark FOOTAGE_LOCALE="$LOC" FOOTAGE_WEBCLIP=1 FOOTAGE_BITRATE=20)
boot_env() {
  case "$1" in
    A) echo FOOTAGE_ONLY=archive-delete FOOTAGE_HISTORY=1 FOOTAGE_BODY_DELAY_MS=65 FOOTAGE_EXPECT_TOTAL=2842 ;;
    B) echo FOOTAGE_ONLY=search-50k FOOTAGE_CORPUS_50K=1 FOOTAGE_CORPUS_N=49932 FOOTAGE_EXPECT_TOTAL=82 FOOTAGE_BODY_DELAY_MS=0 FOOTAGE_OPT_LEVEL=3 ;;
    C) echo FOOTAGE_ONLY=unified-inbox,link-safety,trackers,undo-send,time-capsule,scheduled-backups \
            FOOTAGE_HISTORY=1 FOOTAGE_EXTRA_MAIL=1 FOOTAGE_ALIGN_ALL=1 FOOTAGE_BODY_DELAY_MS=0 FOOTAGE_EXPECT_TOTAL=2852 ;;
    *) echo "unknown boot $1" >&2; exit 64 ;;
  esac
}

case "$cmd" in
  record)
    boots=("$@"); [ ${#boots[@]} -gt 0 ] || boots=(A B C)
    for b in "${boots[@]}"; do
      echo "== boot $b ($LOC) $(date +%H:%M:%S)"
      # shellcheck disable=SC2046
      TESTQ_TIMEOUT=14400 ~/.claude/bin/testq --lane mini-e2e ~/.claude/bin/minijob \
        env "${COMMON[@]}" $(boot_env "$b") bash scripts/footage/run.sh > "$D/$b.tar" 2> "$D/$b.log" || echo "boot $b: job exit $?"
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
  publish)
    mkdir -p "$PUB"
    for f in "$D"/web/*.mp4; do
      n="$(basename "$f" .mp4)"
      case "$n" in *-wide) continue ;; esac
      cp "$f" "$PUB/$n.mp4"; cp "$D/web/$n.jpg" "$PUB/$n.jpg"
      echo "$PUB/$n.mp4 ($(stat -f %z "$f") B)"
    done
    ;;
  *) echo "usage: web-clips.sh record|encode|publish <locale> <work dir> [...]"; exit 64 ;;
esac
