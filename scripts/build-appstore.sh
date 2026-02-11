#!/bin/bash

# MailVault - App Store Build Script
# Use this for submitting to the Mac App Store
#
# Prerequisites:
# 1. Apple Developer Program membership ($99/year)
# 2. "Apple Distribution" certificate installed in Keychain
# 3. "Mac Installer Distribution" certificate installed in Keychain
# 4. Mac App Store provisioning profile
# 5. App record created in App Store Connect
#
# Setup:
# 1. Go to https://developer.apple.com/account/resources/certificates
# 2. Create "Apple Distribution" certificate
# 3. Create "Mac Installer Distribution" certificate
# 4. Go to https://developer.apple.com/account/resources/profiles
# 5. Create a Mac App Store provisioning profile for your app
# 6. Download and double-click to install the profile
# 7. Create your app in App Store Connect

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
echo -e "${BLUE}  MailVault - App Store Build${NC}"
echo -e "${BLUE}════════════════════════════════════════════════════════════${NC}"
echo ""

# Configuration
APP_NAME="MailVault"
BUNDLE_ID="com.mailvault.app"
ENTITLEMENTS="src-tauri/entitlements-appstore.plist"
VERSION=$(grep '"version"' src-tauri/tauri.conf.json | head -1 | sed 's/.*: "\(.*\)".*/\1/')

echo "App: $APP_NAME v$VERSION"
echo "Bundle ID: $BUNDLE_ID"
echo ""

# Check for signing identity (Apple Distribution)
echo -e "${YELLOW}🔍 Looking for Apple Distribution certificate...${NC}"
APP_SIGNING_IDENTITY=$(security find-identity -v -p codesigning | grep "Apple Distribution" | head -1 | sed 's/.*"\(.*\)".*/\1/')

if [ -z "$APP_SIGNING_IDENTITY" ]; then
    # Fall back to 3rd Party Mac Developer Application
    APP_SIGNING_IDENTITY=$(security find-identity -v -p codesigning | grep "3rd Party Mac Developer Application" | head -1 | sed 's/.*"\(.*\)".*/\1/')
fi

if [ -z "$APP_SIGNING_IDENTITY" ]; then
    echo -e "${RED}❌ No 'Apple Distribution' or '3rd Party Mac Developer Application' certificate found!${NC}"
    echo ""
    echo "   To create one:"
    echo "   1. Go to https://developer.apple.com/account/resources/certificates"
    echo "   2. Create an 'Apple Distribution' certificate"
    echo "   3. Download and install it in Keychain Access"
    echo ""
    exit 1
fi

echo -e "${GREEN}✅ Found: $APP_SIGNING_IDENTITY${NC}"

# Check for installer signing identity
echo ""
echo -e "${YELLOW}🔍 Looking for Mac Installer Distribution certificate...${NC}"
INSTALLER_SIGNING_IDENTITY=$(security find-identity -v | grep "Mac Installer Distribution" | head -1 | sed 's/.*"\(.*\)".*/\1/')

if [ -z "$INSTALLER_SIGNING_IDENTITY" ]; then
    # Fall back to 3rd Party Mac Developer Installer
    INSTALLER_SIGNING_IDENTITY=$(security find-identity -v | grep "3rd Party Mac Developer Installer" | head -1 | sed 's/.*"\(.*\)".*/\1/')
fi

if [ -z "$INSTALLER_SIGNING_IDENTITY" ]; then
    echo -e "${RED}❌ No 'Mac Installer Distribution' or '3rd Party Mac Developer Installer' certificate found!${NC}"
    echo ""
    echo "   To create one:"
    echo "   1. Go to https://developer.apple.com/account/resources/certificates"
    echo "   2. Create a 'Mac Installer Distribution' certificate"
    echo "   3. Download and install it in Keychain Access"
    echo ""
    exit 1
fi

echo -e "${GREEN}✅ Found: $INSTALLER_SIGNING_IDENTITY${NC}"

# Check for provisioning profile
echo ""
echo -e "${YELLOW}🔍 Looking for provisioning profile...${NC}"
PROFILE_PATH="$HOME/Library/MobileDevice/Provisioning Profiles"
PROFILE=$(find "$PROFILE_PATH" -name "*.provisionprofile" 2>/dev/null | head -1)

if [ -z "$PROFILE" ]; then
    echo -e "${YELLOW}⚠️  No provisioning profile found${NC}"
    echo ""
    echo "   To create one:"
    echo "   1. Go to https://developer.apple.com/account/resources/profiles"
    echo "   2. Create a 'Mac App Store' distribution profile"
    echo "   3. Select your app ID and distribution certificate"
    echo "   4. Download and double-click to install"
    echo ""
    echo "   Profile should be installed at:"
    echo "   $PROFILE_PATH"
    echo ""
    read -p "   Continue without embedded profile? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
else
    echo -e "${GREEN}✅ Found provisioning profile${NC}"
fi

# Update entitlements for App Store
echo ""
echo -e "${YELLOW}📝 Using App Store entitlements...${NC}"
if [ ! -f "$ENTITLEMENTS" ]; then
    echo -e "${RED}❌ Entitlements file not found: $ENTITLEMENTS${NC}"
    exit 1
fi
echo -e "${GREEN}✅ Entitlements: $ENTITLEMENTS${NC}"

# Build the app
echo ""
echo -e "${YELLOW}🔨 Building the application...${NC}"
npm run build:server

# For App Store, we need to set the entitlements
export TAURI_APPLE_SIGNING_IDENTITY="$APP_SIGNING_IDENTITY"
npm run tauri build

# Paths
APP_PATH="src-tauri/target/release/bundle/macos/${APP_NAME}.app"
PKG_PATH="src-tauri/target/release/bundle/${APP_NAME}-${VERSION}-appstore.pkg"

if [ ! -d "$APP_PATH" ]; then
    echo -e "${RED}❌ App bundle not found at $APP_PATH${NC}"
    exit 1
fi

# Copy provisioning profile into app bundle
if [ -n "$PROFILE" ]; then
    echo ""
    echo -e "${YELLOW}📋 Embedding provisioning profile...${NC}"
    cp "$PROFILE" "$APP_PATH/Contents/embedded.provisionprofile"
    echo -e "${GREEN}✅ Profile embedded${NC}"
fi

# Sign the app for App Store
echo ""
echo -e "${YELLOW}🔏 Signing for App Store...${NC}"

# Sign all nested components
echo "   Signing nested components..."

# Sign the sidecar binary
SIDECAR_PATH="$APP_PATH/Contents/MacOS/mailvault-server"
if [ -f "$SIDECAR_PATH" ]; then
    codesign --force --options runtime --timestamp \
        --entitlements "$ENTITLEMENTS" \
        --sign "$APP_SIGNING_IDENTITY" \
        "$SIDECAR_PATH"
    echo "   ✓ Signed sidecar binary"
fi

# Sign any frameworks
for framework in "$APP_PATH/Contents/Frameworks"/*.framework; do
    if [ -d "$framework" ]; then
        codesign --force --options runtime --timestamp \
            --sign "$APP_SIGNING_IDENTITY" \
            "$framework"
        echo "   ✓ Signed $(basename "$framework")"
    fi
done

# Sign any dylibs
for dylib in "$APP_PATH/Contents/Frameworks"/*.dylib; do
    if [ -f "$dylib" ]; then
        codesign --force --options runtime --timestamp \
            --sign "$APP_SIGNING_IDENTITY" \
            "$dylib"
        echo "   ✓ Signed $(basename "$dylib")"
    fi
done

# Sign the main app bundle
echo "   Signing main app bundle..."
codesign --force --deep --options runtime --timestamp \
    --entitlements "$ENTITLEMENTS" \
    --sign "$APP_SIGNING_IDENTITY" \
    "$APP_PATH"

echo -e "${GREEN}✅ Application signed${NC}"

# Verify signature
echo ""
echo -e "${YELLOW}🔍 Verifying signature...${NC}"
codesign --verify --verbose "$APP_PATH"
echo -e "${GREEN}✅ Signature verified${NC}"

# Create installer package
echo ""
echo -e "${YELLOW}📦 Creating installer package...${NC}"

productbuild --component "$APP_PATH" /Applications \
    --sign "$INSTALLER_SIGNING_IDENTITY" \
    "$PKG_PATH"

echo -e "${GREEN}✅ Installer package created${NC}"

# Validate for App Store
echo ""
echo -e "${YELLOW}🔍 Validating for App Store...${NC}"

# Check if xcrun altool or xcrun notarytool can validate
# Note: Full validation requires uploading to App Store Connect

echo "   Running local validation checks..."

# Check sandboxing
if codesign -d --entitlements :- "$APP_PATH" 2>&1 | grep -q "app-sandbox"; then
    echo -e "   ${GREEN}✓ App sandbox enabled${NC}"
else
    echo -e "   ${YELLOW}⚠️  App sandbox may not be enabled - check entitlements${NC}"
fi

# Check code signature
if codesign --verify --strict "$APP_PATH" 2>&1; then
    echo -e "   ${GREEN}✓ Code signature valid${NC}"
else
    echo -e "   ${RED}✗ Code signature invalid${NC}"
fi

# Summary
echo ""
echo -e "${GREEN}════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Build Complete!${NC}"
echo -e "${GREEN}════════════════════════════════════════════════════════════${NC}"
echo ""
echo "📦 Output:"
echo "   App: $APP_PATH"
echo "   Package: $PKG_PATH"
echo ""
echo "📤 To submit to App Store:"
echo "   1. Open Transporter app (from Mac App Store)"
echo "   2. Sign in with your Apple ID"
echo "   3. Drag the .pkg file to Transporter"
echo "   4. Click 'Deliver'"
echo ""
echo "   Or use xcrun altool:"
if [ -n "$APPLE_ID" ] && [ "$APPLE_ID" != "your@email.com" ]; then
    echo "   xcrun altool --upload-app -f \"$PKG_PATH\" \\"
    echo "     -t macos -u \"$APPLE_ID\" -p \"@keychain:AC_PASSWORD\""
else
    echo "   xcrun altool --upload-app -f \"$PKG_PATH\" \\"
    echo "     -t macos -u \"your@email.com\" -p \"app-specific-password\""
fi
echo ""

# Open output folder
read -p "Open output folder? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    open "src-tauri/target/release/bundle"
fi
