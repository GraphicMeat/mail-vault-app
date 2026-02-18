#!/bin/bash
# Run post-build smoke tests against the built app bundle
# Requires: app built via build-developer-id.sh, .env.test with credentials

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

APP_BUNDLE="$ROOT_DIR/src-tauri/target/release/bundle/macos/MailVault.app"

if [ ! -d "$APP_BUNDLE" ]; then
  echo "Error: App bundle not found at $APP_BUNDLE"
  echo "Run 'bash scripts/build-developer-id.sh' first."
  exit 1
fi

echo "Running post-build smoke tests..."
npx vitest run tests/integration/dmg-smoke.test.js
