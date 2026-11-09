#!/usr/bin/env bash
# Store screenshots of the phone app, light appearance, from the perf-gate build's `?ui=` hooks
# (src/mobile/App.jsx): list, viewer, compose, search, settings, premium.
#   iOS: simulator "iPhone 17 Pro Max" (6.9 inch, 1320x2868)
#   Android: emulator whose screen is 1080x2400 (create the AVD once, see MV_AVD)
# Runs on the Mac mini, through the queue, from a worktree:
#   ~/.claude/bin/testq ~/.claude/bin/minijob bash scripts/mobile-store-shots.sh [ios|android|both] [screen ...]
# Output: ~/Movies/_clipwork/mv-store-shots/<platform>-<screen>.png ON THE MACHINE THAT RUNS IT. A
# minijob run deletes its clone but not this folder; copy the PNGs off the mini before the next
# session wipes anything. Nothing is uploaded; uploading to the stores is the owner's.
#
# Each screen is its own build: the page URL is baked in at build time (scripts/mobile-run.sh
# --url-query), so six screens are six builds per platform. Name the screens to build fewer.
# Environment:
#   MV_IOS_SIM       simulator name (default "iPhone 17 Pro Max")
#   MV_AVD           Android virtual device (default mv-store-1080x2400; make it 1080x2400, any recent
#                    Pixel image; the script checks the size of every PNG and fails on a mismatch)
#   MV_SHOT_QUERY    the search word typed for the search screen (default "report"; pick one the seed
#                    mail or the demo mailbox contains)
#   MV_SHOT_OUT      output folder (default ~/Movies/_clipwork/mv-store-shots)
# Known gap: the premium screen shows the store's products, which the simulator/emulator cannot
# serve to a plain run (iOS needs the app started from Xcode with MailVault.storekit, Android a
# Play-installed test build). Without them the shot shows "Plans aren't available right now."; the
# owner takes that one by hand from a TestFlight / internal-testing build.
set -euo pipefail

cd "$(dirname "$0")/.."
platforms=${1:-both}
[ $# -gt 0 ] && shift
case $platforms in ios | android | both) ;; *) echo "usage: $0 [ios|android|both] [list|viewer|compose|search|settings|premium ...]" >&2; exit 64 ;; esac
screens=("$@")
[ ${#screens[@]} -gt 0 ] || screens=(list viewer compose search settings premium)

out=${MV_SHOT_OUT:-$HOME/Movies/_clipwork/mv-store-shots}
mkdir -p "$out"
export MV_IOS_SIM=${MV_IOS_SIM:-iPhone 17 Pro Max}
export MV_AVD=${MV_AVD:-mv-store-1080x2400}
word=${MV_SHOT_QUERY:-report}
case $word in *[!A-Za-z0-9._-]*) echo "mobile-store-shots: MV_SHOT_QUERY must be one plain word" >&2; exit 64 ;; esac

query_of() {
    case $1 in
        list) echo "" ;;
        viewer) echo "ui=viewer" ;;
        compose) echo "ui=compose" ;;
        search) echo "ui=search&q=$word" ;;
        settings) echo "ui=settings" ;;
        premium) echo "ui=premium" ;;
        *) echo "mobile-store-shots: unknown screen $1" >&2; exit 64 ;;
    esac
}

size_of() { # <platform> <png> -> WxH
    if command -v sips >/dev/null 2>&1; then
        sips -g pixelWidth -g pixelHeight "$2" | awk '/pixelWidth/{w=$2} /pixelHeight/{h=$2} END{print w "x" h}'
    else
        python3 -I -c 'import struct,sys; d=open(sys.argv[1],"rb").read(24); print("%dx%d" % struct.unpack(">II", d[16:24]))' "$2"
    fi
}

shoot() { # <platform> <screen>
    local platform=$1 screen=$2 q png want got
    q=$(query_of "$screen")
    png=$out/$platform-$screen.png
    want=1320x2868; [ "$platform" = android ] && want=1080x2400
    echo "mobile-store-shots: $platform $screen" >&2
    if [ "$platform" = ios ]; then
        xcrun simctl boot "$MV_IOS_SIM" 2>/dev/null || true
        xcrun simctl ui "$MV_IOS_SIM" appearance light 2>/dev/null || true
    fi
    local args=("$platform" --features perf-gate)
    [ -n "$q" ] && args+=(--url-query "$q")
    MV_MOBILE_SHOT=$png bash scripts/mobile-run.sh "${args[@]}" >/dev/null
    got=$(size_of "$platform" "$png")
    if [ "$got" != "$want" ]; then
        echo "mobile-store-shots: $png is $got, the store wants $want" >&2
        return 1
    fi
}

fail=0
for p in ios android; do
    [ "$platforms" = both ] || [ "$platforms" = "$p" ] || continue
    for s in "${screens[@]}"; do shoot "$p" "$s" || fail=1; done
done
echo "mobile-store-shots: wrote $out" >&2
exit $fail
