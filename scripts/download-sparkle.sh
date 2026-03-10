#!/bin/bash
# Download Sparkle 2 framework for macOS updater
set -euo pipefail

SPARKLE_VERSION="2.8.1"
SPARKLE_URL="https://github.com/sparkle-project/Sparkle/releases/download/${SPARKLE_VERSION}/Sparkle-${SPARKLE_VERSION}.tar.xz"
DEST_DIR="src-tauri"

echo "Downloading Sparkle ${SPARKLE_VERSION}..."
cd "$(dirname "$0")/.."

# Download and extract
curl -L "$SPARKLE_URL" -o /tmp/sparkle.tar.xz
mkdir -p /tmp/sparkle-extract
tar -xf /tmp/sparkle.tar.xz -C /tmp/sparkle-extract

# Copy framework to src-tauri
cp -R /tmp/sparkle-extract/Sparkle.framework "$DEST_DIR/"

# Copy signing tools
mkdir -p "$DEST_DIR/sparkle-bin"
cp /tmp/sparkle-extract/bin/generate_keys "$DEST_DIR/sparkle-bin/"
cp /tmp/sparkle-extract/bin/sign_update "$DEST_DIR/sparkle-bin/"

# Cleanup
rm -rf /tmp/sparkle.tar.xz /tmp/sparkle-extract

echo "Sparkle ${SPARKLE_VERSION} installed to ${DEST_DIR}/Sparkle.framework"
echo ""
echo "Next steps:"
echo "  1. Generate EdDSA keys: ./src-tauri/sparkle-bin/generate_keys"
echo "  2. Store the private key as GitHub secret SPARKLE_EDDSA_PRIVATE_KEY"
echo "  3. Add the public key to tauri.conf.json bundle.macOS.infoPlist.SUPublicEDKey"
