#!/bin/bash
# Builds the unsandboxed helper that claims the macOS `mailto:` default.
# See src-tauri/macos/default-mail-helper/main.m for why it exists at all.
set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
    echo "Not macOS — no default mail helper to build."
    exit 0
fi

cd "$(dirname "${BASH_SOURCE[0]}")/.."

SRC="src-tauri/macos/default-mail-helper"
NAME="MailVault Default Mail Helper"
APP="src-tauri/helpers/${NAME}.app"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"

xcrun clang -fobjc-arc -mmacosx-version-min=11.0 -arch arm64 -arch x86_64 \
    -framework AppKit -framework CoreServices \
    "$SRC/main.m" -o "$APP/Contents/MacOS/$NAME"
cp "$SRC/Info.plist" "$APP/Contents/Info.plist"

# Ad-hoc so a local build launches; the release scripts re-sign with the real
# identity — deliberately without entitlements, since a sandboxed helper is
# refused the very write it exists to make.
codesign --force -s - "$APP"

echo "Built $APP"
