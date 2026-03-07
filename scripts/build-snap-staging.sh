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

TAURI_BIN="$REPO_ROOT/src-tauri/target/$TAURI_TARGET/release/mail-vault"
SIDECAR_BIN="$REPO_ROOT/src-tauri/binaries/mailvault-server-$TAURI_TARGET"
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
mkdir -p "$STAGING/usr/share/applications"
mkdir -p "$STAGING/usr/share/icons/hicolor/128x128/apps"

# Copy Tauri binary
cp "$TAURI_BIN" "$STAGING/usr/bin/mail-vault"
chmod +x "$STAGING/usr/bin/mail-vault"
echo "Staged: usr/bin/mail-vault"

# Copy sidecar (warn if missing)
if [[ -f "$SIDECAR_BIN" ]]; then
  cp "$SIDECAR_BIN" "$STAGING/usr/bin/mailvault-server"
  chmod +x "$STAGING/usr/bin/mailvault-server"
  echo "Staged: usr/bin/mailvault-server"
else
  echo "WARNING: Sidecar not found at $SIDECAR_BIN — skipping"
fi

# Create .desktop file
cat > "$STAGING/usr/share/applications/mailvault.desktop" <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=MailVault
Comment=Secure desktop email client with local storage
Exec=mailvault
Icon=${SNAP}/usr/share/icons/hicolor/128x128/apps/mailvault.png
Categories=Network;Email;Office;
StartupWMClass=MailVault
Terminal=false
DESKTOP
echo "Staged: usr/share/applications/mailvault.desktop"

# Copy icon
if [[ -f "$ICON_SRC" ]]; then
  cp "$ICON_SRC" "$STAGING/usr/share/icons/hicolor/128x128/apps/mailvault.png"
  echo "Staged: usr/share/icons/hicolor/128x128/apps/mailvault.png"
else
  echo "WARNING: Icon not found at $ICON_SRC — skipping"
fi

# Summary
echo ""
echo "=== Snap staging complete ==="
echo "Directory: $STAGING"
find "$STAGING" -type f | sort | while read -r f; do
  size=$(du -h "$f" | cut -f1)
  echo "  ${f#$STAGING/}  ($size)"
done
