#!/bin/bash

# MailVault macOS Build Script
# Run this on your Mac to build the distributable app

set -e

echo "🚀 MailVault macOS Build Script"
echo "================================"
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to compare versions
version_gte() {
    [ "$(printf '%s\n' "$1" "$2" | sort -V | head -n1)" = "$2" ]
}

# Check and install/update Homebrew (optional but helpful)
echo "📦 Checking package managers..."
if command -v brew &> /dev/null; then
    echo -e "${GREEN}✅ Homebrew found${NC}"
    echo "   Updating Homebrew..."
    brew update --quiet
else
    echo -e "${YELLOW}ℹ️  Homebrew not found (optional)${NC}"
fi

# Check and install/update Rust
echo ""
echo "🦀 Checking Rust..."
if command -v rustc &> /dev/null; then
    RUST_VERSION=$(rustc --version | awk '{print $2}')
    echo -e "${GREEN}✅ Rust found: $RUST_VERSION${NC}"
    echo "   Checking for updates..."
    rustup update stable --quiet 2>/dev/null || true
    NEW_RUST_VERSION=$(rustc --version | awk '{print $2}')
    if [ "$RUST_VERSION" != "$NEW_RUST_VERSION" ]; then
        echo -e "${GREEN}   Updated to: $NEW_RUST_VERSION${NC}"
    else
        echo "   Already up to date"
    fi
else
    echo -e "${YELLOW}⚠️  Rust not found. Installing...${NC}"
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    source "$HOME/.cargo/env"
    echo -e "${GREEN}✅ Rust installed: $(rustc --version | awk '{print $2}')${NC}"
fi

# Ensure cargo is in PATH
if [ -f "$HOME/.cargo/env" ]; then
    source "$HOME/.cargo/env"
fi

# Check and install/update Node.js
echo ""
echo "📗 Checking Node.js..."
MIN_NODE_VERSION="18.0.0"
if command -v node &> /dev/null; then
    NODE_VERSION=$(node --version | sed 's/v//')
    if version_gte "$NODE_VERSION" "$MIN_NODE_VERSION"; then
        echo -e "${GREEN}✅ Node.js found: v$NODE_VERSION${NC}"
    else
        echo -e "${YELLOW}⚠️  Node.js $NODE_VERSION is below minimum v$MIN_NODE_VERSION${NC}"
        if command -v brew &> /dev/null; then
            echo "   Upgrading via Homebrew..."
            brew upgrade node || brew install node
            echo -e "${GREEN}✅ Node.js updated: $(node --version)${NC}"
        else
            echo -e "${RED}❌ Please update Node.js manually: https://nodejs.org${NC}"
            exit 1
        fi
    fi
else
    echo -e "${YELLOW}⚠️  Node.js not found. Installing...${NC}"
    if command -v brew &> /dev/null; then
        brew install node
        echo -e "${GREEN}✅ Node.js installed: $(node --version)${NC}"
    else
        echo -e "${RED}❌ Please install Node.js: https://nodejs.org${NC}"
        exit 1
    fi
fi

# Check and install/update Bun
echo ""
echo "🥟 Checking Bun..."
if command -v bun &> /dev/null; then
    BUN_VERSION=$(bun --version)
    echo -e "${GREEN}✅ Bun found: v$BUN_VERSION${NC}"
    echo "   Checking for updates..."
    bun upgrade --quiet 2>/dev/null || true
    NEW_BUN_VERSION=$(bun --version)
    if [ "$BUN_VERSION" != "$NEW_BUN_VERSION" ]; then
        echo -e "${GREEN}   Updated to: v$NEW_BUN_VERSION${NC}"
    else
        echo "   Already up to date"
    fi
else
    echo -e "${YELLOW}⚠️  Bun not found. Installing...${NC}"
    curl -fsSL https://bun.sh/install | bash
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"
    echo -e "${GREEN}✅ Bun installed: v$(bun --version)${NC}"
fi

# Ensure bun is in PATH
if [ -d "$HOME/.bun/bin" ]; then
    export PATH="$HOME/.bun/bin:$PATH"
fi

# Check Xcode Command Line Tools
echo ""
echo "🔧 Checking Xcode Command Line Tools..."
if xcode-select -p &> /dev/null; then
    echo -e "${GREEN}✅ Xcode CLI tools found${NC}"
else
    echo -e "${YELLOW}⚠️  Xcode CLI tools not found. Installing...${NC}"
    xcode-select --install
    echo "   Please complete the installation dialog, then re-run this script."
    exit 1
fi

# Install/update npm dependencies
echo ""
echo "📦 Checking npm dependencies..."
if [ -d "node_modules" ]; then
    echo "   Updating dependencies..."
    npm update --silent
    echo -e "${GREEN}✅ Dependencies updated${NC}"
else
    echo "   Installing dependencies..."
    npm install --silent
    echo -e "${GREEN}✅ Dependencies installed${NC}"
fi

# Check for Tauri CLI
echo ""
echo "🔧 Checking Tauri CLI..."
if npx tauri --version &> /dev/null; then
    TAURI_VERSION=$(npx tauri --version 2>/dev/null | head -1)
    echo -e "${GREEN}✅ Tauri CLI found: $TAURI_VERSION${NC}"
else
    echo -e "${YELLOW}⚠️  Tauri CLI not found in dependencies${NC}"
    echo "   It should install with npm install. Trying again..."
    npm install @tauri-apps/cli --save-dev
fi

# Check for app icon
echo ""
echo "🎨 Checking app icon..."
if [ -f "src-tauri/icons/icon.icns" ]; then
    echo -e "${GREEN}✅ macOS icon found (icon.icns)${NC}"
elif [ -f "src-tauri/icons/icon.png" ]; then
    echo -e "${GREEN}✅ Icon source found (icon.png)${NC}"
    echo "   Generating icon set..."
    npm run tauri:icon src-tauri/icons/icon.png
    echo -e "${GREEN}✅ Icon set generated${NC}"
else
    echo -e "${YELLOW}⚠️  No app icon found!${NC}"
    echo ""
    echo "   Please generate an icon and place it at:"
    echo "   src-tauri/icons/icon.png (1024x1024 PNG)"
    echo ""
    echo "   Then run: npm run tauri:icon src-tauri/icons/icon.png"
    echo ""
    echo "   See ICON_PROMPT.md for ChatGPT/DALL-E prompts."
    echo ""
    read -p "   Continue with default icon? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# Build the server binary
echo ""
echo "🔨 Building server binary..."
npm run build:server
echo -e "${GREEN}✅ Server binary built${NC}"

# Build the Tauri app
echo ""
echo "🏗️  Building Tauri application (this may take a few minutes)..."
npm run tauri build

echo ""
echo -e "${GREEN}════════════════════════════════════════${NC}"
echo -e "${GREEN}✅ Build complete!${NC}"
echo -e "${GREEN}════════════════════════════════════════${NC}"
echo ""
echo "📦 Output files:"

# Find the actual output files
APP_PATH="src-tauri/target/release/bundle/macos/MailVault.app"
DMG_PATH=$(find src-tauri/target/release/bundle/dmg -name "*.dmg" 2>/dev/null | head -1)

if [ -d "$APP_PATH" ]; then
    APP_SIZE=$(du -sh "$APP_PATH" | awk '{print $1}')
    echo "   App: $APP_PATH ($APP_SIZE)"
fi

if [ -f "$DMG_PATH" ]; then
    DMG_SIZE=$(du -sh "$DMG_PATH" | awk '{print $1}')
    echo "   DMG: $DMG_PATH ($DMG_SIZE)"
fi

echo ""
echo "📋 To install:"
echo "   1. Open the .dmg file"
echo "   2. Drag MailVault to Applications"
echo ""
echo -e "${YELLOW}⚠️  Note: The app is unsigned. On first run:${NC}"
echo "   1. Right-click the app → Open"
echo "   2. Click 'Open' in the security dialog"
echo ""

# Offer to open the output folder
read -p "Open output folder in Finder? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    open "src-tauri/target/release/bundle"
fi
