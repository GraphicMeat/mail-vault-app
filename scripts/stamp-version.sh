#!/usr/bin/env bash
# Stamps a version override (e.g. 2.16.0-nightly.abc1234) into package.json,
# tauri.conf.json and the app's Cargo.toml. Portable across BSD (macOS) and
# GNU (Linux, Git Bash on Windows): no `sed -i`.
set -euo pipefail
VERSION="$1"

for f in package.json src-tauri/tauri.conf.json; do
  sed -E "s/^(  \"version\": *\")[^\"]+\"/\1${VERSION}\"/" "$f" > "$f.tmp" && mv "$f.tmp" "$f"
done
# First `version = ` line only (the [package] one).
awk -v new="$VERSION" '!done && /^version = "/ { sub(/^version = "[^"]+"/, "version = \"" new "\""); done=1 } 1' src-tauri/Cargo.toml > src-tauri/Cargo.toml.tmp && mv src-tauri/Cargo.toml.tmp src-tauri/Cargo.toml

echo "package.json:      $(grep -m1 '"version"' package.json)"
echo "tauri.conf.json:   $(grep -m1 '"version"' src-tauri/tauri.conf.json)"
echo "Cargo.toml:        $(grep -m1 '^version = ' src-tauri/Cargo.toml)"
for f in package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml; do
  grep -q "$VERSION" "$f" || { echo "::error::version stamp missed $f"; exit 1; }
done
