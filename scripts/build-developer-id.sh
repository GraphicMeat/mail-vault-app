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

# Check for Tauri updater signing key
echo ""
echo -e "${YELLOW}🔍 Checking Tauri updater signing key...${NC}"
if [ -n "$TAURI_PRIVATE_KEY" ]; then
    echo -e "${GREEN}✅ TAURI_PRIVATE_KEY is set — updater artifacts will be signed${NC}"
    UPDATER_SIGN=true
else
    echo -e "${YELLOW}⚠️  TAURI_PRIVATE_KEY not set — updater artifacts will NOT be signed${NC}"
    echo "   To enable, add your signing key to scripts/signing-config.sh"
    echo "   or generate one with: npx @tauri-apps/cli signer generate -w ~/.tauri/mailvault.key"
    UPDATER_SIGN=false
fi

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

# Sign the sidecar binary with its own entitlements (no app-sandbox — Bun needs JIT)
SIDECAR_PATH="$APP_PATH/Contents/MacOS/mailvault-server"
SIDECAR_ENTITLEMENTS="src-tauri/entitlements-sidecar.plist"
if [ -f "$SIDECAR_PATH" ]; then
    codesign --force --options runtime --timestamp \
        --entitlements "$SIDECAR_ENTITLEMENTS" \
        --sign "$SIGNING_HASH" \
        "$SIDECAR_PATH"
    echo "   ✓ Signed sidecar binary (with sidecar entitlements)"
fi

# Sign the main app bundle (no --deep to preserve sidecar entitlements)
echo "   Signing main app bundle..."
codesign --force --options runtime --timestamp \
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
DMG_RW="src-tauri/target/release/bundle/dmg/${APP_NAME}-rw.dmg"

# Remove old files and ensure clean state
rm -f "$SIGNED_DMG" "$DMG_RW"
rm -rf "$DMG_TEMP"

# Also eject any mounted MailVault volumes from previous attempts
if diskutil list | grep -q "MailVault"; then
    echo "   Ejecting stale MailVault volume..."
    hdiutil detach "/Volumes/${APP_NAME}" -force 2>/dev/null || true
fi

# Create temp folder with app and Applications symlink
mkdir -p "$DMG_TEMP"
cp -R "$APP_PATH" "$DMG_TEMP/"
ln -s /Applications "$DMG_TEMP/Applications"

# Create a read-write DMG first so we can style it
echo "   Creating DMG image..."
DMG_SIZE_MB=$(du -sm "$DMG_TEMP" | awk '{print $1}')
DMG_SIZE_MB=$((DMG_SIZE_MB + 20))

if ! hdiutil create -volname "$APP_NAME" \
    -srcfolder "$DMG_TEMP" \
    -ov -format UDRW \
    -size "${DMG_SIZE_MB}m" \
    "$DMG_RW" 2>&1; then
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

# Mount the R/W DMG and style it
echo "   Styling DMG layout..."
MOUNT_DIR=$(hdiutil attach -readwrite -noverify -noautoopen "$DMG_RW" | grep '/Volumes/' | awk -F'\t' '{print $NF}')

if [ -d "$MOUNT_DIR" ]; then
    # Extract the actual volume name from the mount path
    VOL_NAME=$(basename "$MOUNT_DIR")
    echo "   Mounted at: $MOUNT_DIR (volume: $VOL_NAME)"

    # Wait for Finder to register the volume
    sleep 2

    # Use AppleScript to set Finder window appearance (matches Tauri's styled DMG)
    osascript <<APPLESCRIPT
tell application "Finder"
    tell disk "${VOL_NAME}"
        open
        set current view of container window to icon view
        set toolbar visible of container window to false
        set statusbar visible of container window to false
        set bounds of container window to {100, 100, 640, 480}
        set theViewOptions to icon view options of container window
        set arrangement of theViewOptions to not arranged
        set icon size of theViewOptions to 128
        set text size of theViewOptions to 13
        set background color of theViewOptions to {5140, 5140, 5654}
        set position of item "${APP_NAME}.app" of container window to {150, 195}
        set position of item "Applications" of container window to {390, 195}
        close
        open
        update without registering applications
        delay 1
        close
    end tell
end tell
APPLESCRIPT
    sync
    hdiutil detach "$MOUNT_DIR" -quiet
else
    echo -e "${YELLOW}⚠️  Could not mount DMG for styling, continuing with unstyled layout${NC}"
fi

# Convert to compressed read-only DMG
hdiutil convert "$DMG_RW" -format UDZO -o "$SIGNED_DMG" -quiet
rm -f "$DMG_RW"

# Sign the DMG
codesign --force --timestamp \
    --sign "$SIGNING_HASH" \
    "$SIGNED_DMG"

echo -e "${GREEN}✅ Signed DMG created with styled layout${NC}"

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

# Tauri updater artifacts
UPDATER_BUNDLE_DIR="src-tauri/target/release/bundle/macos"
UPDATE_TAR_GZ=""
UPDATE_SIG=""

if [ "$UPDATER_SIGN" = true ]; then
    echo ""
    echo -e "${YELLOW}🔄 Processing Tauri updater artifacts...${NC}"

    # Find the updater .tar.gz (created by tauri build when createUpdaterArtifacts is true)
    UPDATE_TAR_GZ=$(find "$UPDATER_BUNDLE_DIR" -name "*.tar.gz" -not -name "*.sig" 2>/dev/null | head -1)
    UPDATE_SIG=$(find "$UPDATER_BUNDLE_DIR" -name "*.tar.gz.sig" 2>/dev/null | head -1)

    if [ -n "$UPDATE_TAR_GZ" ] && [ -f "$UPDATE_TAR_GZ" ]; then
        echo -e "${GREEN}✅ Found updater archive: $(basename "$UPDATE_TAR_GZ")${NC}"

        if [ -n "$UPDATE_SIG" ] && [ -f "$UPDATE_SIG" ]; then
            echo -e "${GREEN}✅ Found updater signature: $(basename "$UPDATE_SIG")${NC}"
        else
            echo -e "${YELLOW}⚠️  No .sig file found — signing manually...${NC}"
            npx @tauri-apps/cli signer sign "$UPDATE_TAR_GZ" --private-key "$TAURI_PRIVATE_KEY" --password "$TAURI_KEY_PASSWORD" 2>&1
            UPDATE_SIG="${UPDATE_TAR_GZ}.sig"
            if [ -f "$UPDATE_SIG" ]; then
                echo -e "${GREEN}✅ Updater signature created${NC}"
            else
                echo -e "${RED}❌ Failed to create updater signature${NC}"
                UPDATER_SIGN=false
            fi
        fi

        # Copy updater artifacts next to DMG for easy access
        UPDATER_OUTPUT_DIR="src-tauri/target/release/bundle/dmg"
        cp "$UPDATE_TAR_GZ" "$UPDATER_OUTPUT_DIR/"
        cp "$UPDATE_SIG" "$UPDATER_OUTPUT_DIR/" 2>/dev/null

        # Generate latest.json for the updater endpoint
        echo ""
        echo -e "${YELLOW}📝 Generating latest.json updater manifest...${NC}"

        SIGNATURE=$(cat "$UPDATE_SIG" 2>/dev/null || echo "")
        PUB_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
        TAR_GZ_NAME=$(basename "$UPDATE_TAR_GZ")
        ARCH=$(uname -m)

        # Map architecture to Tauri target triple
        if [ "$ARCH" = "arm64" ]; then
            PLATFORM="darwin-aarch64"
        else
            PLATFORM="darwin-x86_64"
        fi

        LATEST_JSON="$UPDATER_OUTPUT_DIR/latest.json"
        cat > "$LATEST_JSON" <<EOJSON
{
  "version": "${VERSION}",
  "notes": "MailVault v${VERSION}",
  "pub_date": "${PUB_DATE}",
  "platforms": {
    "${PLATFORM}": {
      "signature": "${SIGNATURE}",
      "url": "https://github.com/GraphicMeat/mail-vault-app/releases/download/v${VERSION}/${TAR_GZ_NAME}"
    }
  }
}
EOJSON

        echo -e "${GREEN}✅ latest.json generated${NC}"
    else
        echo -e "${YELLOW}⚠️  No updater .tar.gz found in $UPDATER_BUNDLE_DIR${NC}"
        echo "   Ensure 'createUpdaterArtifacts' is set to true in tauri.conf.json"
        UPDATER_SIGN=false
    fi
fi

# Summary
echo ""
echo -e "${GREEN}════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Build Complete!${NC}"
echo -e "${GREEN}════════════════════════════════════════════════════════════${NC}"
echo ""
echo "📦 Output:"
echo "   App:  $APP_PATH"
echo "   DMG:  $SIGNED_DMG"
if [ "$UPDATER_SIGN" = true ] && [ -n "$UPDATE_TAR_GZ" ]; then
    echo "   Update archive:   $UPDATER_OUTPUT_DIR/$(basename "$UPDATE_TAR_GZ")"
    echo "   Update signature: $UPDATER_OUTPUT_DIR/$(basename "$UPDATE_SIG")"
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

# Open output folder
read -p "Open output folder? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    open "src-tauri/target/release/bundle/dmg"
fi
