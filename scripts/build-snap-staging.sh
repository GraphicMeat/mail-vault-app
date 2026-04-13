#!/usr/bin/env bash
set -euo pipefail

# Build snap-staging directory layout for snapcraft dump plugin.
# Requires TAURI_TARGET env var (e.g. x86_64-unknown-linux-gnu).

if [[ -z "${TAURI_TARGET:-}" ]]; then
  echo "ERROR: TAURI_TARGET env var is required (e.g. x86_64-unknown-linux-gnu)"
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGING="$REPO_ROOT/snap-staging"

TAURI_BIN="$REPO_ROOT/target/$TAURI_TARGET/release/mailvault"
SIDECAR_BIN="$REPO_ROOT/src-tauri/binaries/mailvault-server-$TAURI_TARGET"
DAEMON_BIN="$REPO_ROOT/src-tauri/binaries/mailvault-daemon-$TAURI_TARGET"
ICON_SRC="$REPO_ROOT/src-tauri/icons/128x128.png"

# Verify Tauri binary exists
if [[ ! -f "$TAURI_BIN" ]]; then
  echo "ERROR: Tauri binary not found at $TAURI_BIN"
  echo "       Build with: npm run tauri build -- --target $TAURI_TARGET"
  exit 1
fi

# Clean and recreate staging directory
rm -rf "$STAGING"
mkdir -p "$STAGING/usr/bin"

# Copy Tauri binary
cp "$TAURI_BIN" "$STAGING/usr/bin/mailvault"
chmod +x "$STAGING/usr/bin/mailvault"
echo "Staged: usr/bin/mailvault"

# Copy sidecar (warn if missing)
if [[ -f "$SIDECAR_BIN" ]]; then
  cp "$SIDECAR_BIN" "$STAGING/usr/bin/mailvault-server"
  chmod +x "$STAGING/usr/bin/mailvault-server"
  echo "Staged: usr/bin/mailvault-server"
else
  echo "WARNING: Sidecar not found at $SIDECAR_BIN — skipping"
fi

# Copy daemon (warn if missing)
if [[ -f "$DAEMON_BIN" ]]; then
  cp "$DAEMON_BIN" "$STAGING/usr/bin/mailvault-daemon"
  chmod +x "$STAGING/usr/bin/mailvault-daemon"
  echo "Staged: usr/bin/mailvault-daemon"
else
  echo "WARNING: Daemon not found at $DAEMON_BIN — skipping"
fi

# Desktop file and icon are in snap/gui/ — snapd handles them automatically.
# snap/gui/mailvault.desktop → meta/gui/mailvault.desktop (with Icon=${SNAP}/meta/gui/mailvault.png)
# snap/gui/mailvault.png → meta/gui/mailvault.png

# Summary
echo ""
echo "=== Snap staging complete ==="
echo "Directory: $STAGING"
find "$STAGING" -type f | sort | while read -r f; do
  size=$(du -h "$f" | cut -f1)
  echo "  ${f#$STAGING/}  ($size)"
done
