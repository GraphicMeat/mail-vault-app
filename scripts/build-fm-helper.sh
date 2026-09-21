#!/bin/bash
# Builds mailvault-fm-helper, the Swift sidecar that talks to Apple's on-device
# Foundation Models. See src-tauri/macos/fm-helper/main.swift for the protocol.
#
# The framework does not exist below macOS 26, and this app still supports 11,
# so the link is weak: the binary loads everywhere and the call site is gated
# with @available. Verify that by running it on an older macOS — it must print
# an "unavailable" line, not fail to launch.
set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
    echo "Not macOS — no Foundation Models helper to build."
    exit 0
fi

cd "$(dirname "${BASH_SOURCE[0]}")/.."

SRC="src-tauri/macos/fm-helper/main.swift"
TRIPLE="$(rustc -vV | awk '/^host:/ {print $2}')"
OUT="src-tauri/binaries/mailvault-fm-helper-${TRIPLE}"

mkdir -p "$(dirname "$OUT")"

case "$TRIPLE" in
    aarch64-*) ARCH_TARGET="arm64-apple-macosx11.0" ;;
    x86_64-*)  ARCH_TARGET="x86_64-apple-macosx11.0" ;;
    *) echo "Unsupported host triple $TRIPLE" >&2; exit 1 ;;
esac

xcrun swiftc -O -target "$ARCH_TARGET" \
    -Xlinker -weak_framework -Xlinker FoundationModels \
    "$SRC" -o "$OUT"

# Ad-hoc so a local build runs it; the release scripts re-sign with the real
# identity alongside the daemon sidecar.
codesign --force -s - "$OUT"

echo "Built $OUT"
