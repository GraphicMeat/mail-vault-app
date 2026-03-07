#!/bin/bash

# MailVault - Developer ID Build & Notarization Script
# Used for both local builds and CI (GitHub Actions)
#
# Usage:
#   Local:  source scripts/signing-config.sh && bash scripts/build-developer-id.sh
#   CI:     Set env vars and run: bash scripts/build-developer-id.sh
#
# Environment variables:
#   BUILD_TARGET        - Tauri build target (e.g. "universal-apple-darwin"). Default: local arch
#   SKIP_SERVER_BUILD   - Set to "true" to skip sidecar build (CI builds it separately)
#   SIGNING_IDENTITY    - Signing identity string (CI). Local uses certificate lookup.
#   CI                  - Set to "true" to skip interactive prompts
#   KEYCHAIN_PATH       - Path to keychain containing signing certificate (CI)

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Change to project directory so relative paths work
cd "$PROJECT_DIR"

# Load signing configuration (local only — CI sets env vars directly)
CONFIG_FILE="$SCRIPT_DIR/signing-config.sh"
if [ -f "$CONFIG_FILE" ]; then
    source "$CONFIG_FILE"
    echo -e "${GREEN}✅ Loaded signing config from $CONFIG_FILE${NC}"
fi

echo ""
echo -e "${BLUE}════════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  MailVault - Developer ID Build & Notarization${NC}"
echo -e "${BLUE}════════════════════════════════════════════════════════════${NC}"
echo ""

# Configuration
APP_NAME="MailVault"
BUNDLE_ID="com.mailvault.app"
ENTITLEMENTS="src-tauri/entitlements.plist"
NOTARYTOOL_PROFILE="${NOTARYTOOL_PROFILE:-notarytool-profile}"

# Get version from package.json
VERSION=$(grep '"version"' package.json | head -1 | sed 's/.*"version": *"\([^"]*\)".*/\1/')

# Determine build target and output paths
if [ -n "$BUILD_TARGET" ]; then
    TAURI_ARGS="--target $BUILD_TARGET"
    TARGET_DIR="src-tauri/target/$BUILD_TARGET/release"
else
    TAURI_ARGS=""
    TARGET_DIR="src-tauri/target/release"
fi

# ── Signing Identity ────────────────────────────────────────────────

echo -e "${YELLOW}🔍 Looking for Developer ID certificates...${NC}"

if [ -n "$SIGNING_IDENTITY" ]; then
    # CI: use provided identity directly
    SIGNING_ID="$SIGNING_IDENTITY"
    echo -e "${GREEN}✅ Using signing identity from environment${NC}"
else
    # Local: find certificate by team ID
    CERT_INFO=$(security find-identity -v -p codesigning | grep "Developer ID Application" | grep "($TEAM_ID)" | head -1)
    SIGNING_ID=$(echo "$CERT_INFO" | awk '{print $2}')
    SIGNING_NAME=$(echo "$CERT_INFO" | sed 's/.*"\(.*\)".*/\1/')

    if [ -z "$SIGNING_ID" ]; then
        echo -e "${RED}❌ No 'Developer ID Application' certificate found!${NC}"
        echo ""
        echo "   To create one:"
        echo "   1. Go to https://developer.apple.com/account/resources/certificates"
        echo "   2. Create a 'Developer ID Application' certificate"
        echo "   3. Download and install it in Keychain Access"
        echo ""
        exit 1
    fi

    echo -e "${GREEN}✅ Found: $SIGNING_NAME${NC}"
    echo -e "   Using certificate hash: ${SIGNING_ID}"
fi

# Build codesign args (add --keychain if specified)
KEYCHAIN_ARG=""
if [ -n "$KEYCHAIN_PATH" ]; then
    KEYCHAIN_ARG="--keychain $KEYCHAIN_PATH"
fi

# ── Tauri Updater Key ──────────────────────────────────────────────

echo ""
echo -e "${YELLOW}🔍 Checking Tauri updater signing key...${NC}"
if [ -n "$TAURI_PRIVATE_KEY" ]; then
    echo -e "${GREEN}✅ TAURI_PRIVATE_KEY is set — updater artifacts will be signed${NC}"
    UPDATER_SIGN=true
else
    echo -e "${YELLOW}⚠️  TAURI_PRIVATE_KEY not set — updater artifacts will NOT be signed${NC}"
    UPDATER_SIGN=false
fi

# ── Notarization Check ─────────────────────────────────────────────

echo ""
echo -e "${YELLOW}🔍 Checking notarization credentials...${NC}"

if [ "$CI" = "true" ]; then
    # CI: use direct credentials (APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID)
    if [ -n "$APPLE_ID" ] && [ -n "$APPLE_PASSWORD" ] && [ -n "$APPLE_TEAM_ID" ]; then
        echo -e "${GREEN}✅ Notarization credentials found (CI direct auth)${NC}"
        NOTARIZE=true
        NOTARIZE_METHOD="direct"
    else
        echo -e "${YELLOW}⚠️  Missing APPLE_ID/APPLE_PASSWORD/APPLE_TEAM_ID — skipping notarization${NC}"
        NOTARIZE=false
    fi
elif xcrun notarytool history --keychain-profile "$NOTARYTOOL_PROFILE" &>/dev/null; then
    echo -e "${GREEN}✅ Notarization credentials found (profile: $NOTARYTOOL_PROFILE)${NC}"
    NOTARIZE=true
    NOTARIZE_METHOD="profile"
else
    echo -e "${YELLOW}⚠️  Notarization credentials not found${NC}"

    # Check if we have credentials in config to set up automatically
    if [ -n "$APPLE_ID" ] && [ "$APPLE_ID" != "your@email.com" ] && \
       [ -n "$TEAM_ID" ] && [ "$TEAM_ID" != "YOUR_TEAM_ID" ] && \
       [ -n "$APP_SPECIFIC_PASSWORD" ] && [ "$APP_SPECIFIC_PASSWORD" != "xxxx-xxxx-xxxx-xxxx" ]; then
        echo ""
        echo "   Found credentials in signing-config.sh"
        read -p "   Set up notarization credentials now? (y/n) " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            echo "   Storing credentials in keychain..."
            xcrun notarytool store-credentials "$NOTARYTOOL_PROFILE" \
                --apple-id "$APPLE_ID" \
                --team-id "$TEAM_ID" \
                --password "$APP_SPECIFIC_PASSWORD"
            echo -e "${GREEN}✅ Credentials stored${NC}"
            NOTARIZE=true
            NOTARIZE_METHOD="profile"
        else
            NOTARIZE=false
        fi
    else
        echo ""
        echo "   To set up notarization:"
        echo "   1. Edit scripts/signing-config.sh with your credentials"
        echo "   2. Run this script again"
        echo ""
        read -p "   Continue without notarization? (y/n) " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            exit 1
        fi
        NOTARIZE=false
    fi
fi

# ── Build ──────────────────────────────────────────────────────────

echo ""
echo -e "${YELLOW}🔨 Building the application...${NC}"

if [ "$SKIP_SERVER_BUILD" != "true" ]; then
    npm run build:server
fi

npm run tauri build -- $TAURI_ARGS

# Remove Tauri's unsigned DMG (we create our own signed DMG below)
rm -f "$TARGET_DIR/bundle/dmg"/*.dmg

# ── Paths ──────────────────────────────────────────────────────────

APP_PATH="$TARGET_DIR/bundle/macos/${APP_NAME}.app"

if [ ! -d "$APP_PATH" ]; then
    echo -e "${RED}❌ App bundle not found at $APP_PATH${NC}"
    exit 1
fi

# ── Sign ───────────────────────────────────────────────────────────

echo ""
echo -e "${YELLOW}🔏 Signing the application...${NC}"

# Sign all nested components first (sidecar binary, frameworks, etc.)
echo "   Signing nested components..."

# Sign any frameworks
for framework in "$APP_PATH/Contents/Frameworks"/*.framework; do
    if [ -d "$framework" ]; then
        codesign --force --options runtime --timestamp \
            --sign "$SIGNING_ID" $KEYCHAIN_ARG \
            "$framework"
        echo "   ✓ Signed $(basename "$framework")"
    fi
done

# Sign any dylibs
for dylib in "$APP_PATH/Contents/Frameworks"/*.dylib; do
    if [ -f "$dylib" ]; then
        codesign --force --options runtime --timestamp \
            --sign "$SIGNING_ID" $KEYCHAIN_ARG \
            "$dylib"
        echo "   ✓ Signed $(basename "$dylib")"
    fi
done

# Sign the sidecar binary with its own entitlements (no app-sandbox — Bun needs JIT)
SIDECAR_PATH="$APP_PATH/Contents/MacOS/mailvault-server"
SIDECAR_ENTITLEMENTS="src-tauri/entitlements-sidecar.plist"
if [ -f "$SIDECAR_PATH" ]; then
    codesign --force --options runtime --timestamp \
        --entitlements "$SIDECAR_ENTITLEMENTS" \
        --sign "$SIGNING_ID" $KEYCHAIN_ARG \
        "$SIDECAR_PATH"
    echo "   ✓ Signed sidecar binary (with sidecar entitlements)"
fi

# Sign the main app bundle (no --deep to preserve sidecar entitlements)
echo "   Signing main app bundle..."
codesign --force --options runtime --timestamp \
    --entitlements "$ENTITLEMENTS" \
    --sign "$SIGNING_ID" $KEYCHAIN_ARG \
    "$APP_PATH"

echo -e "${GREEN}✅ Application signed${NC}"

# Verify signature
echo ""
echo -e "${YELLOW}🔍 Verifying signature...${NC}"
codesign --verify --verbose "$APP_PATH"
echo -e "${GREEN}✅ Signature verified${NC}"

# ── DMG ────────────────────────────────────────────────────────────

echo ""
echo -e "${YELLOW}📦 Creating signed DMG with Applications shortcut...${NC}"

DMG_DIR="$TARGET_DIR/bundle/dmg"
mkdir -p "$DMG_DIR"

SIGNED_DMG="$DMG_DIR/${APP_NAME}-v${VERSION}.dmg"

# Remove old files and ensure clean state
rm -f "$SIGNED_DMG"

# Also eject any mounted MailVault volumes from previous attempts
if diskutil list | grep -q "MailVault"; then
    echo "   Ejecting stale MailVault volume..."
    hdiutil detach "/Volumes/${APP_NAME}" -force 2>/dev/null || true
fi

CREATE_DMG_ARGS=(
    --volname "$APP_NAME"
    --window-pos 100 100
    --window-size 660 400
    --icon-size 96
    --text-size 12
    --icon "${APP_NAME}.app" 180 200
    --app-drop-link 480 200
    --no-internet-enable
    --format UDZO
)

create-dmg "${CREATE_DMG_ARGS[@]}" "$SIGNED_DMG" "$APP_PATH"

if [ ! -f "$SIGNED_DMG" ]; then
    echo -e "${RED}❌ DMG creation failed!${NC}"
    exit 1
fi

# Sign the DMG
codesign --force --timestamp \
    --sign "$SIGNING_ID" $KEYCHAIN_ARG \
    "$SIGNED_DMG"

echo -e "${GREEN}✅ Signed DMG created with styled layout${NC}"

# ── Notarize ───────────────────────────────────────────────────────

if [ "$NOTARIZE" = true ]; then
    echo ""
    echo -e "${YELLOW}📤 Submitting for notarization...${NC}"
    echo "   This may take several minutes..."

    if [ "$NOTARIZE_METHOD" = "direct" ]; then
        xcrun notarytool submit "$SIGNED_DMG" \
            --apple-id "$APPLE_ID" \
            --password "$APPLE_PASSWORD" \
            --team-id "$APPLE_TEAM_ID" \
            --wait
    else
        xcrun notarytool submit "$SIGNED_DMG" \
            --keychain-profile "$NOTARYTOOL_PROFILE" \
            --wait
    fi

    # Staple the notarization ticket
    echo ""
    echo -e "${YELLOW}📎 Stapling notarization ticket...${NC}"
    xcrun stapler staple "$SIGNED_DMG"

    echo -e "${GREEN}✅ Notarization complete!${NC}"

    # Verify notarization
    echo ""
    echo -e "${YELLOW}🔍 Verifying notarization...${NC}"
    spctl --assess --type open --context context:primary-signature -v "$SIGNED_DMG"
    echo -e "${GREEN}✅ Notarization verified${NC}"
fi

# ── Updater Artifacts ──────────────────────────────────────────────

UPDATER_BUNDLE_DIR="$TARGET_DIR/bundle/macos"
UPDATE_TAR_GZ=""
UPDATE_SIG=""

if [ "$UPDATER_SIGN" = true ]; then
    echo ""
    echo -e "${YELLOW}🔄 Processing Tauri updater artifacts...${NC}"

    UPDATE_TAR_GZ="$UPDATER_BUNDLE_DIR/${APP_NAME}.app.tar.gz"

    # Always recreate .tar.gz from the correctly signed app (Tauri's was signed differently)
    echo "   Creating updater archive from signed app..."
    rm -f "$UPDATE_TAR_GZ" "${UPDATE_TAR_GZ}.sig"
    cd "$UPDATER_BUNDLE_DIR"
    tar -czf "${APP_NAME}.app.tar.gz" "${APP_NAME}.app"
    cd "$PROJECT_DIR"

    echo -e "${GREEN}✅ Created updater archive: $(basename "$UPDATE_TAR_GZ")${NC}"

    # Sign with Tauri updater key
    echo "   Signing updater archive..."
    npx @tauri-apps/cli signer sign "$UPDATE_TAR_GZ" \
        --private-key "$TAURI_PRIVATE_KEY" \
        --password "$TAURI_KEY_PASSWORD" 2>&1
    UPDATE_SIG="${UPDATE_TAR_GZ}.sig"

    if [ -f "$UPDATE_SIG" ]; then
        echo -e "${GREEN}✅ Updater signature created${NC}"
    else
        echo -e "${RED}❌ Failed to create updater signature${NC}"
        UPDATER_SIGN=false
    fi

    # Copy updater artifacts next to DMG for easy access
    cp "$UPDATE_TAR_GZ" "$DMG_DIR/"
    cp "$UPDATE_SIG" "$DMG_DIR/" 2>/dev/null

    # Generate latest.json for the updater endpoint
    echo ""
    echo -e "${YELLOW}📝 Generating latest.json updater manifest...${NC}"

    SIGNATURE=$(cat "$UPDATE_SIG" 2>/dev/null || echo "")
    PUB_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    TAR_GZ_NAME=$(basename "$UPDATE_TAR_GZ")

    LATEST_JSON="$DMG_DIR/latest.json"
    cat > "$LATEST_JSON" <<EOJSON
{
  "version": "${VERSION}",
  "notes": "MailVault v${VERSION}",
  "pub_date": "${PUB_DATE}",
  "platforms": {
    "darwin-aarch64": {
      "signature": "${SIGNATURE}",
      "url": "https://github.com/GraphicMeat/mail-vault-app/releases/download/v${VERSION}/${TAR_GZ_NAME}"
    },
    "darwin-x86_64": {
      "signature": "${SIGNATURE}",
      "url": "https://github.com/GraphicMeat/mail-vault-app/releases/download/v${VERSION}/${TAR_GZ_NAME}"
    }
  }
}
EOJSON

    echo -e "${GREEN}✅ latest.json generated${NC}"
fi

# ── Summary ────────────────────────────────────────────────────────

echo ""
echo -e "${GREEN}════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Build Complete!${NC}"
echo -e "${GREEN}════════════════════════════════════════════════════════════${NC}"
echo ""
echo "📦 Output:"
echo "   App:  $APP_PATH"
echo "   DMG:  $SIGNED_DMG"
if [ "$UPDATER_SIGN" = true ] && [ -n "$UPDATE_TAR_GZ" ]; then
    echo "   Update archive:   $DMG_DIR/$(basename "$UPDATE_TAR_GZ")"
    echo "   Update signature: $DMG_DIR/$(basename "$UPDATE_SIG")"
    echo "   Update manifest:  $LATEST_JSON"
fi
echo ""
if [ "$NOTARIZE" = true ]; then
    echo -e "${GREEN}✅ The DMG is signed and notarized - ready for distribution!${NC}"
else
    echo -e "${YELLOW}⚠️  The DMG is signed but NOT notarized.${NC}"
    echo "   Users may see Gatekeeper warnings."
fi
if [ "$UPDATER_SIGN" = true ]; then
    echo -e "${GREEN}✅ Updater artifacts are signed - upload latest.json and .tar.gz to your GitHub release${NC}"
fi
echo ""

# Open output folder (local only)
if [ "$CI" != "true" ]; then
    read -p "Open output folder? (y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        open "$DMG_DIR"
    fi
fi
