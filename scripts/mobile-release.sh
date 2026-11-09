#!/usr/bin/env bash
# Build the store artifact of the phone app: an .ipa (iOS) or an .aab (Android) in dist-release/.
# Never uploads anything; the owner sends the file to App Store Connect / Play Console by hand.
#   bash scripts/mobile-release.sh <ios|android> [--dry-run]
#
# --dry-run   print the version, build number, file it would produce and which env is missing; build nothing
# Environment:
#   MV_BUILD                       0..99, default 0. Added to the build number (MAJOR*1000000 + MINOR*10000
#                                  + PATCH*100) for CFBundleVersion and versionCode. Raise it to re-send a
#                                  rejected upload of the same version.
#   iOS (macOS only):
#     APPLE_TEAM_ID                developer team id, injected into the export options. Required to build.
#   Android:
#     MV_ANDROID_KEYSTORE          path to the upload keystore
#     MV_ANDROID_KEYSTORE_PASSWORD
#     MV_ANDROID_KEY_ALIAS
#     MV_ANDROID_KEY_PASSWORD      all four set: signed .aab. Any missing: unsigned .aab, said so below.
set -euo pipefail

usage() { echo "usage: $0 <ios|android> [--dry-run]" >&2; exit 64; }
[ $# -ge 1 ] || usage
platform=$1; shift
case $platform in ios|android) ;; *) usage ;; esac
dry=
while [ $# -gt 0 ]; do
    case $1 in
        --dry-run) dry=1 ;;
        *) usage ;;
    esac
    shift
done

cd "$(dirname "$0")/.."
version=$(grep -m1 '"version"' package.json | sed 's/.*"version": *"\([^"]*\)".*/\1/')
IFS=. read -r major minor patch <<< "$version"
build=${MV_BUILD:-0}
case $build in
    '' | *[!0-9]*) echo "mobile-release: MV_BUILD must be an integer from 0 to 99" >&2; exit 64 ;;
esac
if [ "$build" -gt 99 ]; then echo "mobile-release: MV_BUILD must be an integer from 0 to 99" >&2; exit 64; fi
number=$((major * 1000000 + minor * 10000 + patch * 100 + 10#$build))
out=dist-release
if [ "$platform" = ios ]; then ext=ipa; else ext=aab; fi
artifact="$out/MailVault-$version-$number.$ext"

signed=1
if [ "$platform" = ios ]; then
    [ -n "${APPLE_TEAM_ID:-}" ] || signed=0
else
    for v in MV_ANDROID_KEYSTORE MV_ANDROID_KEYSTORE_PASSWORD MV_ANDROID_KEY_ALIAS MV_ANDROID_KEY_PASSWORD; do
        [ -n "${!v:-}" ] || signed=0
    done
fi

if [ -n "$dry" ]; then
    echo "mobile-release: dry run ($platform)"
    echo "  version       $version"
    echo "  build number  $number (MV_BUILD=$build)"
    echo "  would produce $artifact"
    if [ "$platform" = ios ]; then
        echo "  export method app-store-connect (src-tauri-mobile/gen/apple/ExportOptions.appstore.plist)"
        [ "$signed" = 1 ] || echo "  missing env   APPLE_TEAM_ID (a real build stops without it)"
    else
        if [ "$signed" = 1 ]; then echo "  signing       release keystore from MV_ANDROID_KEYSTORE*"
        else echo "  signing       UNSIGNED (MV_ANDROID_KEYSTORE, _PASSWORD, MV_ANDROID_KEY_ALIAS, _KEY_PASSWORD not all set)"; fi
    fi
    exit 0
fi

# shellcheck source=scripts/mobile-env.sh
source scripts/mobile-env.sh
# `npm run mobile:tauri` sets TAURI_APP_PATH itself; a stray inherited value must not win.
unset TAURI_APP_PATH
mkdir -p "$out"

if [ "$platform" = ios ]; then
    [ "$(uname -s)" = Darwin ] || { echo "mobile-release: the iOS build needs macOS" >&2; exit 2; }
    [ -n "${APPLE_TEAM_ID:-}" ] || { echo "mobile-release: set APPLE_TEAM_ID to build the iOS app" >&2; exit 2; }
    echo "mobile-release: archiving iOS $version ($number)" >&2
    APPLE_DEVELOPMENT_TEAM=$APPLE_TEAM_ID npm run mobile:tauri -- ios build --target aarch64 \
        --build-number "$number" --archive-only >&2
    archive=$(find src-tauri-mobile/gen/apple/build -type d -name '*.xcarchive' | head -n 1)
    [ -n "$archive" ] || { echo "mobile-release: no .xcarchive under src-tauri-mobile/gen/apple/build" >&2; exit 2; }
    work=$(mktemp -d)
    trap 'rm -rf "$work"' EXIT
    cp src-tauri-mobile/gen/apple/ExportOptions.appstore.plist "$work/ExportOptions.plist"
    /usr/libexec/PlistBuddy -c "Add :teamID string $APPLE_TEAM_ID" "$work/ExportOptions.plist"
    xcodebuild -exportArchive -archivePath "$archive" -exportOptionsPlist "$work/ExportOptions.plist" \
        -exportPath "$work/export" -allowProvisioningUpdates >&2
    ipa=$(find "$work/export" -name '*.ipa' | head -n 1)
    [ -n "$ipa" ] || { echo "mobile-release: export produced no .ipa" >&2; exit 2; }
    cp "$ipa" "$artifact"
else
    if [ "$signed" = 0 ]; then
        echo "mobile-release: MV_ANDROID_KEYSTORE* not all set: building an UNSIGNED .aab (the Play Console will refuse it)" >&2
    fi
    echo "mobile-release: building Android $version ($number)" >&2
    npm run mobile:tauri -- android build --aab --target aarch64 >&2
    aab=$(find src-tauri-mobile/gen/android/app/build/outputs/bundle -name '*.aab' | head -n 1)
    [ -n "$aab" ] || { echo "mobile-release: no .aab under gen/android/app/build/outputs/bundle" >&2; exit 2; }
    cp "$aab" "$artifact"
fi
echo "mobile-release: wrote $artifact"
echo "$artifact"
