#!/bin/bash

# Generate (once) a project-scoped Sparkle EdDSA signing key, export the
# private key to keys/sparkle_ed25519.key (gitignored), and write the matching
# public key into src-tauri/Info.plist (SUPublicEDKey).
#
# Run this once on a trusted machine. The private key never leaves keys/
# (gitignored) and the macOS Keychain. Afterwards:
#   1. Commit the updated src-tauri/Info.plist (the public key is safe to commit).
#   2. Set the CI secret used by the release workflows:
#        gh secret set SPARKLE_EDDSA_PRIVATE_KEY < keys/sparkle_ed25519.key
#
# build-developer-id.sh auto-loads keys/sparkle_ed25519.key when the
# SPARKLE_EDDSA_PRIVATE_KEY env var is not already set.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

ACCOUNT="mailvault"
GEN="./src-tauri/sparkle-bin/generate_keys"
KEY_DIR="keys"
KEY_FILE="$KEY_DIR/sparkle_ed25519.key"
INFO_PLIST="src-tauri/Info.plist"

if [ ! -x "$GEN" ]; then
    echo "❌ $GEN not found. Run scripts/download-sparkle.sh first." >&2
    exit 1
fi

mkdir -p "$KEY_DIR"

# Generate the key in the Keychain if it doesn't exist yet (idempotent).
if "$GEN" --account "$ACCOUNT" -p >/dev/null 2>&1; then
    echo "✅ Existing Sparkle key found for account '$ACCOUNT'"
else
    echo "🔑 Generating new Sparkle key for account '$ACCOUNT' (approve the Keychain prompt)…"
    "$GEN" --account "$ACCOUNT" >/dev/null
fi

# Export the private key to the repo (gitignored) so builds don't need the Keychain.
rm -f "$KEY_FILE"
"$GEN" --account "$ACCOUNT" -x "$KEY_FILE"
chmod 600 "$KEY_FILE"
echo "✅ Private key exported to $KEY_FILE (gitignored)"

# Read the public key and write it into Info.plist.
PUB="$("$GEN" --account "$ACCOUNT" -p)"
if [ -z "$PUB" ]; then
    echo "❌ Failed to read public key from Keychain" >&2
    exit 1
fi
plutil -replace SUPublicEDKey -string "$PUB" "$INFO_PLIST"
echo "✅ SUPublicEDKey written to $INFO_PLIST"
echo "   $PUB"

echo ""
echo "Next steps:"
echo "  1. Commit the updated $INFO_PLIST (the public key is safe to commit)."
echo "  2. Set the CI secret:"
echo "       gh secret set SPARKLE_EDDSA_PRIVATE_KEY < $KEY_FILE"
