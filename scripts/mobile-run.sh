#!/usr/bin/env bash
# Build the mobile shell (src-tauri-mobile), boot a simulator/emulator, install, launch, and print
# the app's `MV_MOBILE <json>` log lines to stdout. Runs on the Mac mini:
#   ~/.claude/bin/testq ~/.claude/bin/minijob bash scripts/mobile-run.sh <ios|android> [--release] [--url-query q] [--features f] [--probe host:port]
#
# --url-query q   open the window at mobile.html?q (merged into the Tauri config at build time)
# --features f    cargo features for the shell, e.g. perf-gate (10k seeded rows, mobile.perf.report)
# --probe h:p     perf-gate builds: the app resolves h, makes a TLS handshake to h:p through core
#                 and round-trips a dummy secret, then logs one MV_MOBILE {"probe":…} line, which
#                 ends the wait (adds probe=h:p to the URL query)
# Environment:
#   MV_MOBILE_UNTIL   ERE that ends the tail once a log line matches it
#                     (default: the first ping, error or engineError line)
#   MV_MOBILE_WAIT    seconds to wait for that line (default 180); exit 1 on timeout
#   MV_MOBILE_LAUNCHES  launch the installed app this many times (default 1), waiting for the
#                     line each time; app data (the perf-gate seed) survives between launches
#   MV_MOBILE_BUILD_ONLY  directory: build (Android release: also sign), copy the .app / .apk
#                     there and exit 0 without booting anything
#   MV_MOBILE_SHOT    write a PNG screenshot here once the line arrived
#   MV_MOBILE_SHOTS   directory: after the last launch, write <platform>-light.png and
#                     <platform>-dark.png (system appearance switched, restored on exit; Android
#                     screen set to 375x750 px at its 160 dpi, i.e. 375 dp wide)
#   MV_MOBILE_THEN    shell command run after the screenshots, before anything is stopped, with
#                     MV_UDID (iOS simulator) or MV_ADB (Android: the adb binary) set; for a check
#                     that drives the running app, e.g. pressing Back
#   MV_IOS_SIM        simulator name or UDID (default: first available iPhone)
#   MV_AVD            Android virtual device (default mv-mobile)
#   MV_EMU_BOOT_WAIT  seconds to wait for the emulator to boot (default 300); exit 3 on timeout
# Everything this script starts (app, simulator, emulator, log tail) is stopped on exit.
set -euo pipefail

usage() { echo "usage: $0 <ios|android> [--release] [--url-query q] [--features f] [--probe host:port]" >&2; exit 64; }
[ $# -ge 1 ] || usage
platform=$1; shift
case $platform in ios|android) ;; *) usage ;; esac
release=; query=; features=; probe=
while [ $# -gt 0 ]; do
    case $1 in
        --release) release=1 ;;
        --url-query) [ $# -ge 2 ] || usage; query=$2; shift ;;
        --features) [ $# -ge 2 ] || usage; features=$2; shift ;;
        --probe) [ $# -ge 2 ] || usage; probe=$2; shift ;;
        *) usage ;;
    esac
    shift
done

cd "$(dirname "$0")/.."
# shellcheck source=scripts/mobile-env.sh
source scripts/mobile-env.sh
# The repo has two Tauri apps. `npm run mobile:tauri` sets TAURI_APP_PATH=src-tauri-mobile itself,
# and the generated Xcode/Gradle projects call back through the same script, so nothing here relies
# on an inherited value. Drop any stray one so a wrong value cannot leak in either.
unset TAURI_APP_PATH

BUNDLE_ID=com.mailvault.app
if [ -n "$probe" ]; then
    case $probe in *[!A-Za-z0-9.:-]* | *: | :*) echo "mobile-run: --probe wants host:port" >&2; exit 64 ;; esac
    query=${query:+$query&}probe=$probe
    UNTIL=${MV_MOBILE_UNTIL:-'^MV_MOBILE \{"(probe|engineError)"'}
else
    UNTIL=${MV_MOBILE_UNTIL:-'^MV_MOBILE \{"(ping|error|engineError)"'}
fi
WAIT=${MV_MOBILE_WAIT:-180}
LAUNCHES=${MV_MOBILE_LAUNCHES:-1}
case $LAUNCHES in '' | *[!0-9]* | 0) echo "mobile-run: MV_MOBILE_LAUNCHES must be a positive integer" >&2; exit 64 ;; esac
work=$(mktemp -d)
log=$work/app.log
: > "$log"

tauri_args=()
if [ -n "$query" ]; then
    tauri_args+=(--config "{\"app\":{\"windows\":[{\"label\":\"main\",\"url\":\"mobile.html?$query\",\"title\":\"MailVault\"}]}}")
fi
if [ -n "$features" ]; then tauri_args+=(--features "$features"); fi
# A perf-gate build also bundles the page's perf-gate-only code (vite.mobile.config.js); anything
# else is a shipping bundle without it.
case ",$features," in
    *,perf-gate,*) export MV_PERF_GATE=1 ;;
    *) unset MV_PERF_GATE ;;
esac
if [ -z "$release" ]; then tauri_args+=(--debug); mode=debug; else mode=release; fi

cleanup_cmds=()
cleanup() {
    local i
    for ((i = ${#cleanup_cmds[@]} - 1; i >= 0; i--)); do eval "${cleanup_cmds[i]}" >/dev/null 2>&1 || true; done
    rm -rf "$work"
}
trap cleanup EXIT

# Prints MV_MOBILE lines from $log as they arrive; returns 0 once one matches $UNTIL, 1 on timeout.
tail_log() {
    local seen=0 deadline=$((SECONDS + WAIT)) n line
    while [ $SECONDS -lt $deadline ]; do
        n=$(wc -l < "$log" | tr -d ' ')
        while [ "$seen" -lt "$n" ]; do
            seen=$((seen + 1))
            line=$(sed -n "${seen}p" "$log" | tr -d '\r')
            case $line in *'MV_MOBILE '*) ;; *) continue ;; esac
            line="MV_MOBILE ${line#*MV_MOBILE }"
            echo "$line"
            if printf '%s\n' "$line" | grep -Eq "$UNTIL"; then return 0; fi
        done
        sleep 1
    done
    echo "mobile-run: no line matching '$UNTIL' within ${WAIT}s; app log tail:" >&2
    tail -n 40 "$log" >&2
    return 1
}

run_ios() {
    # Swift 6.4's default `swift build` engine (swiftbuild) ignores `--sdk` when tauri's build script
    # (swift-rs) compiles the Tauri Swift package for iOS, and scans against the macOS SDK. The
    # native engine still honours it, so a `swift` on PATH for this run selects it.
    if swift build --help 2>/dev/null | grep -Eq '^ +native +-'; then
        local real_swift
        real_swift=$(xcrun -f swift)
        mkdir -p "$work/bin"
        printf '#!/bin/bash\nif [ "$1" = build ]; then shift; exec "%s" build --build-system native "$@"; fi\nexec "%s" "$@"\n' \
            "$real_swift" "$real_swift" > "$work/bin/swift"
        chmod +x "$work/bin/swift"
        export PATH="$work/bin:$PATH"
    fi

    echo "mobile-run: building iOS (simulator, $mode)" >&2
    npm run mobile:tauri -- ios build --target aarch64-sim ${tauri_args[@]+"${tauri_args[@]}"} >&2

    local app
    app=$(find src-tauri-mobile/gen/apple/build -type d -name '*.app' -path '*sim*' 2>/dev/null | head -n 1)
    [ -n "$app" ] || app=$(find src-tauri-mobile/gen/apple/build -type d -name '*.app' 2>/dev/null | head -n 1)
    [ -n "$app" ] || { echo "mobile-run: no .app under src-tauri-mobile/gen/apple/build" >&2; exit 2; }
    echo "mobile-run: app $app" >&2
    if [ -n "${MV_MOBILE_BUILD_ONLY:-}" ]; then
        mkdir -p "$MV_MOBILE_BUILD_ONLY" && cp -R "$app" "$MV_MOBILE_BUILD_ONLY/"
        return 0
    fi

    local udid state
    if [ -n "${MV_IOS_SIM:-}" ]; then
        udid=$(xcrun simctl list devices available | grep -F "${MV_IOS_SIM}" | grep -oE '[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}' | head -n 1)
    else
        udid=$(xcrun simctl list devices available | grep -E '^ +iPhone' | grep -oE '[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}' | head -n 1)
    fi
    [ -n "$udid" ] || { echo "mobile-run: no available iPhone simulator" >&2; exit 2; }
    state=$(xcrun simctl list devices | grep -F "$udid" | grep -oE '\((Booted|Shutdown)\)' | head -n 1)
    echo "mobile-run: simulator $udid $state" >&2
    if [ "$state" != "(Booted)" ]; then
        xcrun simctl boot "$udid"
        cleanup_cmds+=("xcrun simctl shutdown $udid")
    fi
    xcrun simctl bootstatus "$udid" -b >&2

    xcrun simctl install "$udid" "$app"
    cleanup_cmds+=("xcrun simctl uninstall $udid $BUNDLE_ID")
    cleanup_cmds+=("xcrun simctl terminate $udid $BUNDLE_ID")

    local rc=0 n stream_pid
    for ((n = 1; n <= LAUNCHES; n++)); do
        # Stop the previous launch before this launch's stream starts, so a late line from launch
        # n-1 cannot land in launch n's log.
        if [ "$n" -gt 1 ]; then xcrun simctl terminate "$udid" "$BUNDLE_ID" >/dev/null 2>&1 || true; fi
        # A fresh log per launch, so tail_log's line counter starts at its first line.
        log=$work/app-$n.log
        : > "$log"
        # The shell writes its lines to the unified log (syslog, see src-tauri-mobile/src/lib.rs).
        xcrun simctl spawn "$udid" log stream --style compact --predicate 'process == "MailVault"' > "$log" 2>&1 &
        stream_pid=$!
        cleanup_cmds+=("kill $stream_pid")
        sleep 1
        echo "mobile-run: launch $n of $LAUNCHES" >&2
        xcrun simctl launch --terminate-running-process "$udid" "$BUNDLE_ID" >&2
        tail_log || { rc=$?; break; }
        kill "$stream_pid" 2>/dev/null || true
    done
    if [ -n "${MV_MOBILE_SHOT:-}" ]; then
        sleep 2
        xcrun simctl io "$udid" screenshot "$MV_MOBILE_SHOT" >&2 || rc=1
    fi
    if [ $rc -eq 0 ] && [ -n "${MV_MOBILE_SHOTS:-}" ]; then
        local was mode
        was=$(xcrun simctl ui "$udid" appearance 2>/dev/null || echo light)
        cleanup_cmds+=("xcrun simctl ui $udid appearance $was")
        mkdir -p "$MV_MOBILE_SHOTS"
        for mode in light dark; do
            xcrun simctl ui "$udid" appearance "$mode"
            sleep 3
            xcrun simctl io "$udid" screenshot "$MV_MOBILE_SHOTS/ios-$mode.png" >&2 || rc=1
        done
    fi
    if [ $rc -eq 0 ] && [ -n "${MV_MOBILE_THEN:-}" ]; then
        MV_UDID=$udid bash -c "$MV_MOBILE_THEN" >&2 || rc=1
    fi
    return $rc
}

run_android() {
    local adb="$ANDROID_HOME/platform-tools/adb" emulator="$ANDROID_HOME/emulator/emulator"
    local avd=${MV_AVD:-mv-mobile} boot_wait=${MV_EMU_BOOT_WAIT:-300}

    echo "mobile-run: building Android (aarch64, $mode)" >&2
    npm run mobile:tauri -- android build --apk --target aarch64 ${tauri_args[@]+"${tauri_args[@]}"} >&2

    local apk
    apk=$(find src-tauri-mobile/gen/android/app/build/outputs/apk -name '*.apk' 2>/dev/null | head -n 1)
    [ -n "$apk" ] || { echo "mobile-run: no .apk under gen/android/app/build/outputs/apk" >&2; exit 2; }
    if [ -n "$release" ]; then
        # An unsigned release APK will not install; sign it with a throwaway key made for this run
        # (emulator use only; nothing is written outside the run's temp dir).
        local bt signed=$work/app-release-signed.apk ks=$work/run.keystore
        bt=$(ls -d "$ANDROID_HOME"/build-tools/*/ | sort | tail -n 1)
        keytool -genkeypair -keystore "$ks" -storepass android -keypass android -alias run \
            -dname "CN=MailVault run,O=MailVault,C=US" -keyalg RSA -validity 30 >&2
        "$bt/zipalign" -f 4 "$apk" "$work/aligned.apk"
        "$bt/apksigner" sign --ks "$ks" --ks-pass pass:android --out "$signed" "$work/aligned.apk"
        apk=$signed
    fi
    echo "mobile-run: apk $apk" >&2
    if [ -n "${MV_MOBILE_BUILD_ONLY:-}" ]; then
        mkdir -p "$MV_MOBILE_BUILD_ONLY" && cp "$apk" "$MV_MOBILE_BUILD_ONLY/mailvault-$mode.apk"
        return 0
    fi

    if ! "$adb" devices | grep -q '^emulator-'; then
        echo "mobile-run: booting emulator $avd (headless)" >&2
        "$emulator" -avd "$avd" -no-window -no-audio -no-boot-anim -no-snapshot -gpu swiftshader_indirect \
            > "$work/emulator.log" 2>&1 &
        local emu_pid=$!
        cleanup_cmds+=("kill $emu_pid; sleep 2; kill -9 $emu_pid")
        cleanup_cmds+=("$adb emu kill")
        local deadline=$((SECONDS + boot_wait)) booted=
        while [ $SECONDS -lt $deadline ]; do
            if ! kill -0 "$emu_pid" 2>/dev/null; then break; fi
            if [ "$("$adb" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ]; then booted=1; break; fi
            sleep 3
        done
        if [ -z "$booted" ]; then
            echo "mobile-run: emulator did not boot within ${boot_wait}s; emulator log tail:" >&2
            tail -n 60 "$work/emulator.log" >&2
            "$adb" devices -l >&2 || true
            exit 3
        fi
        echo "mobile-run: emulator booted after $((SECONDS - deadline + boot_wait))s" >&2
    fi
    # Software rendering (swiftshader) makes frame times say little about a phone: show which.
    echo "mobile-run: ro.hardware.egl=$("$adb" shell getprop ro.hardware.egl 2>/dev/null | tr -d '\r')" >&2
    "$adb" shell dumpsys SurfaceFlinger 2>/dev/null | tr -d '\r' | grep -m 1 -E '^GLES:' | sed 's/^/mobile-run: /' >&2 || true

    # A copy left by an earlier run may carry another signature, which `install -r` refuses.
    "$adb" uninstall "$BUNDLE_ID" >/dev/null 2>&1 || true
    "$adb" install -r "$apk" >&2
    cleanup_cmds+=("$adb uninstall $BUNDLE_ID")
    cleanup_cmds+=("$adb shell am force-stop $BUNDLE_ID")

    local rc=0 n logcat_pid
    for ((n = 1; n <= LAUNCHES; n++)); do
        "$adb" shell am force-stop "$BUNDLE_ID"
        "$adb" logcat -c
        log=$work/app-$n.log
        : > "$log"
        # The shell writes its lines to logcat under the MailVault tag (see src-tauri-mobile/src/lib.rs).
        "$adb" logcat -v raw -s MailVault:I > "$log" 2>&1 &
        logcat_pid=$!
        cleanup_cmds+=("kill $logcat_pid")
        echo "mobile-run: launch $n of $LAUNCHES" >&2
        "$adb" shell am start -W -n "$BUNDLE_ID/.MainActivity" >&2
        tail_log || { rc=$?; break; }
        kill "$logcat_pid" 2>/dev/null || true
    done
    if [ -n "${MV_MOBILE_SHOT:-}" ]; then
        sleep 2
        "$adb" exec-out screencap -p > "$MV_MOBILE_SHOT" || rc=1
    fi
    if [ $rc -eq 0 ] && [ -n "${MV_MOBILE_SHOTS:-}" ]; then
        local was mode
        was=$("$adb" shell cmd uimode night 2>/dev/null | tr -d '\r' | sed -n 's/^Night mode: //p')
        cleanup_cmds+=("$adb shell cmd uimode night ${was:-no}")
        cleanup_cmds+=("$adb shell wm size reset")
        mkdir -p "$MV_MOBILE_SHOTS"
        # The activity handles screenSize and uiMode changes itself (AndroidManifest configChanges),
        # so neither restarts the app; density would, so it stays at the AVD's 160 dpi.
        "$adb" shell wm size 375x750
        for mode in light dark; do
            if [ "$mode" = dark ]; then "$adb" shell cmd uimode night yes; else "$adb" shell cmd uimode night no; fi
            sleep 4
            "$adb" exec-out screencap -p > "$MV_MOBILE_SHOTS/android-$mode.png" || rc=1
        done
    fi
    if [ $rc -eq 0 ] && [ -n "${MV_MOBILE_THEN:-}" ]; then
        MV_ADB=$adb bash -c "$MV_MOBILE_THEN" >&2 || rc=1
    fi
    if [ $rc -ne 0 ]; then "$adb" logcat -d -t 80 >&2 || true; fi
    return $rc
}

"run_$platform"
