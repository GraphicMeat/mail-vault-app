#!/bin/bash
# Builds mailvault-fm-helper, the Swift sidecar that talks to Apple's on-device
# Foundation Models. See src-tauri/macos/fm-helper/main.swift for the protocol.
#
# The framework does not exist below macOS 26, and this app still supports 11,
# so the link is weak: the binary loads everywhere and the call site is gated
# with @available. Verify that by running it on an older macOS — it must print
# an "unavailable" line, not fail to launch.
#
# Output is one universal binary. `bundle.macOS.files` in tauri.conf.json puts
# it next to the daemon (Contents/MacOS), where `find_fm_helper_binary` looks.
set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
    echo "Not macOS — no Foundation Models helper to build."
    exit 0
fi

cd "$(dirname "${BASH_SOURCE[0]}")/.."

SRC="src-tauri/macos/fm-helper/main.swift"
OUT="src-tauri/helpers/mailvault-fm-helper"

# Without the framework in the SDK `canImport` is silently false and the helper
# only ever answers "Built without FoundationModels" — never ship that.
if [ ! -d "$(xcrun --show-sdk-path)/System/Library/Frameworks/FoundationModels.framework" ]; then
    if [ -n "${CI:-}" ]; then
        echo "SDK has no FoundationModels.framework — select Xcode 26 or newer." >&2
        exit 1
    fi
    echo "warning: SDK has no FoundationModels.framework; the helper will report itself unavailable." >&2
fi

if [ "$OUT" -nt "$SRC" ]; then
    echo "$OUT is up to date"
    exit 0
fi

mkdir -p "$(dirname "$OUT")"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

for ARCH in arm64 x86_64; do
    xcrun swiftc -O -target "${ARCH}-apple-macosx11.0" \
        -Xlinker -weak_framework -Xlinker FoundationModels \
        "$SRC" -o "$TMP/$ARCH"
done
lipo -create "$TMP/arm64" "$TMP/x86_64" -output "$OUT"

# Ad-hoc so a local build runs it; the release scripts re-sign with the real
# identity alongside the daemon sidecar.
codesign --force -s - "$OUT"

echo "Built $OUT"
