#!/bin/bash

# MailVault - Developer ID Build & Notarization Script
# Use this for distributing the app outside the Mac App Store
#
# Prerequisites:
# 1. Apple Developer Program membership ($99/year)
# 2. "Developer ID Application" certificate installed in Keychain
# 3. "Developer ID Installer" certificate (for pkg) installed in Keychain
# 4. App-specific password for notarization
#
# Setup:
# 1. Create an app-specific password at https://appleid.apple.com
# 2. Store it in keychain:
#    xcrun notarytool store-credentials "notarytool-profile" \
#      --apple-id "your@email.com" \
#      --team-id "YOUR_TEAM_ID" \
#      --password "app-specific-password"

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

# Load signing configuration
CONFIG_FILE="$SCRIPT_DIR/signing-config.sh"
if [ -f "$CONFIG_FILE" ]; then
    source "$CONFIG_FILE"
    echo -e "${GREEN}✅ Loaded signing config from $CONFIG_FILE${NC}"
else
    echo -e "${YELLOW}⚠️  No signing config found at $CONFIG_FILE${NC}"
    echo "   Copy the example and fill in your credentials:"
    echo "   cp scripts/signing-config.example.sh scripts/signing-config.sh"
    echo ""
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

# Check for signing identity - use hash to avoid ambiguity with duplicate certificates
echo -e "${YELLOW}🔍 Looking for Developer ID certificates...${NC}"
# Filter by TEAM_ID from signing config to get the correct certificate
CERT_INFO=$(security find-identity -v -p codesigning | grep "Developer ID Application" | grep "($TEAM_ID)" | head -1)
SIGNING_HASH=$(echo "$CERT_INFO" | awk '{print $2}')
SIGNING_NAME=$(echo "$CERT_INFO" | sed 's/.*"\(.*\)".*/\1/')

if [ -z "$SIGNING_HASH" ]; then
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
echo -e "   Using certificate hash: ${SIGNING_HASH}"

# Check for notarytool credentials
echo ""
echo -e "${YELLOW}🔍 Checking notarization credentials...${NC}"
if xcrun notarytool history --keychain-profile "$NOTARYTOOL_PROFILE" &>/dev/null; then
    echo -e "${GREEN}✅ Notarization credentials found (profile: $NOTARYTOOL_PROFILE)${NC}"
    NOTARIZE=true
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
        else
            NOTARIZE=false
        fi
    else
        echo ""
        echo "   To set up notarization:"
        echo "   1. Edit scripts/signing-config.sh with your credentials"
        echo "   2. Run this script again"
        echo ""
        echo "   Or manually run:"
        echo "      xcrun notarytool store-credentials \"$NOTARYTOOL_PROFILE\" \\"
        echo "        --apple-id \"your@email.com\" \\"
        echo "        --team-id \"YOUR_TEAM_ID\" \\"
        echo "        --password \"your-app-specific-password\""
        echo ""
        read -p "   Continue without notarization? (y/n) " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            exit 1
        fi
        NOTARIZE=false
    fi
fi

# Build the app
echo ""
echo -e "${YELLOW}🔨 Building the application...${NC}"
npm run build:server
npm run tauri build

# Paths
APP_PATH="src-tauri/target/release/bundle/macos/${APP_NAME}.app"

if [ ! -d "$APP_PATH" ]; then
    echo -e "${RED}❌ App bundle not found at $APP_PATH${NC}"
    exit 1
fi

# Sign the app
echo ""
echo -e "${YELLOW}🔏 Signing the application...${NC}"

# Sign all nested components first (sidecar binary, frameworks, etc.)
echo "   Signing nested components..."

# Sign the sidecar binary
SIDECAR_PATH="$APP_PATH/Contents/MacOS/mailvault-server"
if [ -f "$SIDECAR_PATH" ]; then
    codesign --force --options runtime --timestamp \
        --entitlements "$ENTITLEMENTS" \
        --sign "$SIGNING_HASH" \
        "$SIDECAR_PATH"
    echo "   ✓ Signed sidecar binary"
fi

# Sign any frameworks
for framework in "$APP_PATH/Contents/Frameworks"/*.framework; do
    if [ -d "$framework" ]; then
        codesign --force --options runtime --timestamp \
            --sign "$SIGNING_HASH" \
            "$framework"
        echo "   ✓ Signed $(basename "$framework")"
    fi
done

# Sign any dylibs
for dylib in "$APP_PATH/Contents/Frameworks"/*.dylib; do
    if [ -f "$dylib" ]; then
        codesign --force --options runtime --timestamp \
            --sign "$SIGNING_HASH" \
            "$dylib"
        echo "   ✓ Signed $(basename "$dylib")"
    fi
done

# Sign the main app bundle
echo "   Signing main app bundle..."
codesign --force --deep --options runtime --timestamp \
    --entitlements "$ENTITLEMENTS" \
    --sign "$SIGNING_HASH" \
    "$APP_PATH"

echo -e "${GREEN}✅ Application signed${NC}"

# Verify signature
echo ""
echo -e "${YELLOW}🔍 Verifying signature...${NC}"
codesign --verify --verbose "$APP_PATH"
echo -e "${GREEN}✅ Signature verified${NC}"

# Create a signed DMG with Applications folder
echo ""
echo -e "${YELLOW}📦 Creating signed DMG with Applications shortcut...${NC}"

# Create the DMG output directory if it doesn't exist (Tauri no longer creates it)
mkdir -p "src-tauri/target/release/bundle/dmg"

SIGNED_DMG="src-tauri/target/release/bundle/dmg/${APP_NAME}-v${VERSION}.dmg"
DMG_TEMP="src-tauri/target/release/bundle/dmg/dmg-temp"

# Remove old files and ensure clean state
rm -f "$SIGNED_DMG"
rm -rf "$DMG_TEMP"

# Also eject any mounted MailVault volumes from previous attempts
if diskutil list | grep -q "MailVault"; then
    echo "   Ejecting stale MailVault volume..."
    hdiutil detach "/Volumes/MailVault" -force 2>/dev/null || true
fi

# Create temp folder with app and Applications symlink
mkdir -p "$DMG_TEMP"
cp -R "$APP_PATH" "$DMG_TEMP/"
ln -s /Applications "$DMG_TEMP/Applications"

# Create new DMG (add -quiet to reduce verbose output)
echo "   Creating DMG image..."
if ! hdiutil create -volname "$APP_NAME" \
    -srcfolder "$DMG_TEMP" \
    -ov -format UDZO \
    "$SIGNED_DMG" 2>&1; then
    echo ""
    echo -e "${RED}❌ DMG creation failed!${NC}"
    echo ""
    echo "   This is often caused by Terminal not having Full Disk Access."
    echo "   To fix:"
    echo "   1. Open System Settings → Privacy & Security → Full Disk Access"
    echo "   2. Add Terminal (or your IDE) to the list"
    echo "   3. Restart Terminal and try again"
    echo ""
    rm -rf "$DMG_TEMP"
    exit 1
fi

# Clean up temp folder
rm -rf "$DMG_TEMP"

# Sign the DMG
codesign --force --timestamp \
    --sign "$SIGNING_HASH" \
    "$SIGNED_DMG"

echo -e "${GREEN}✅ Signed DMG created with Applications shortcut${NC}"

# Notarize
if [ "$NOTARIZE" = true ]; then
    echo ""
    echo -e "${YELLOW}📤 Submitting for notarization...${NC}"
    echo "   This may take several minutes..."

    xcrun notarytool submit "$SIGNED_DMG" \
        --keychain-profile "$NOTARYTOOL_PROFILE" \
        --wait

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

# Summary
echo ""
echo -e "${GREEN}════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Build Complete!${NC}"
echo -e "${GREEN}════════════════════════════════════════════════════════════${NC}"
echo ""
echo "📦 Output:"
echo "   App: $APP_PATH"
echo "   DMG: $SIGNED_DMG"
echo ""
if [ "$NOTARIZE" = true ]; then
    echo -e "${GREEN}✅ The DMG is signed and notarized - ready for distribution!${NC}"
else
    echo -e "${YELLOW}⚠️  The DMG is signed but NOT notarized.${NC}"
    echo "   Users may see Gatekeeper warnings."
fi
echo ""

# Open output folder
read -p "Open output folder? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    open "src-tauri/target/release/bundle/dmg"
fi
