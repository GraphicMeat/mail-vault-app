# Building MailVault Desktop App

This guide explains how to build MailVault as a native desktop application using Tauri.

## Prerequisites

### 1. Install Rust
```bash
# macOS/Linux
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Restart terminal or run:
source $HOME/.cargo/env
```

### 2. Install macOS Dependencies
```bash
# Xcode Command Line Tools
xcode-select --install
```

### 3. Install Node.js Dependencies
```bash
cd mail-client
npm install
```

### 4. Install a Node.js Compiler (for production builds)

Choose one:

**Option A: Bun (Recommended - fastest)**
```bash
curl -fsSL https://bun.sh/install | bash
```

**Option B: pkg**
```bash
npm install -g @yao-pkg/pkg
```

## Development

Run the app in development mode:

```bash
# Terminal 1: Start the backend server
npm run server

# Terminal 2: Start Tauri dev mode
npm run tauri:dev
```

Or run both together (for web development only):
```bash
npm run dev
```

## Building for Production

### Generate App Icons

First, create a 512x512 PNG icon, then generate all sizes:

```bash
npm run tauri:icon path/to/your-icon.png
```

### Build the App

```bash
# Build for current platform
npm run tauri:build
```

This will:
1. Bundle the Node.js server into a native binary
2. Build the React frontend
3. Package everything into a native app

### Output Locations

- **macOS**: `src-tauri/target/release/bundle/`
  - `macos/MailVault.app` - Application bundle
  - `dmg/MailVault_1.0.0_*.dmg` - Disk image for distribution

## Build Troubleshooting

### "sidecar not found" error
Make sure to run the server build first:
```bash
npm run build:server
```

### Rust compilation errors
Update Rust:
```bash
rustup update
```

## Distribution

### Developer ID Distribution (Outside App Store)

For distributing the app outside the Mac App Store with notarization:

#### Prerequisites
1. Apple Developer Program membership ($99/year)
2. "Developer ID Application" certificate
3. "Developer ID Installer" certificate (for pkg)
4. App-specific password for notarization

#### Setup Notarization Credentials
```bash
# Create app-specific password at https://appleid.apple.com
# Then store credentials:
xcrun notarytool store-credentials "notarytool-profile" \
  --apple-id "your@email.com" \
  --team-id "YOUR_TEAM_ID" \
  --password "your-app-specific-password"
```

#### Build & Sign
```bash
npm run build:release
# or
./scripts/build-developer-id.sh
```

This will:
1. Build the app
2. Sign with Developer ID certificate
3. Create signed DMG
4. Notarize with Apple
5. Staple the notarization ticket

### App Store Distribution

For submitting to the Mac App Store:

#### Prerequisites
1. Apple Developer Program membership ($99/year)
2. "Apple Distribution" certificate
3. "Mac Installer Distribution" certificate
4. Mac App Store provisioning profile
5. App record in App Store Connect

#### Build for App Store
```bash
npm run build:appstore
# or
./scripts/build-appstore.sh
```

This will:
1. Build the app with App Store entitlements (sandboxed)
2. Sign with Apple Distribution certificate
3. Create signed .pkg installer
4. Validate for App Store submission

#### Submit to App Store
Use Transporter app (from Mac App Store) or:
```bash
xcrun altool --upload-app -f "path/to/MailVault.pkg" \
  -t macos -u "your@email.com" -p "app-specific-password"
```

### Unsigned Builds (Development Only)

For local testing without signing:
```bash
npm run tauri:build
```

To run unsigned apps:
```bash
# Right-click the app > Open > Click "Open" in dialog
# Or allow apps from anywhere (not recommended):
sudo spctl --master-disable
```

## Architecture

```
┌─────────────────────────────────────────┐
│           Tauri Application             │
├─────────────────────────────────────────┤
│  ┌─────────────────────────────────┐    │
│  │     React Frontend (WebView)    │    │
│  │  - UI Components                │    │
│  │  - Local State (Zustand)        │    │
│  │  - IndexedDB for local storage  │    │
│  └─────────────────────────────────┘    │
│                  │                       │
│                  │ HTTP/localhost:3001   │
│                  ▼                       │
│  ┌─────────────────────────────────┐    │
│  │   Node.js Server (Sidecar)      │    │
│  │  - IMAP connection (imapflow)   │    │
│  │  - SMTP sending (nodemailer)    │    │
│  │  - Email parsing (mailparser)   │    │
│  └─────────────────────────────────┘    │
│                  │                       │
└──────────────────│───────────────────────┘
                   │
                   ▼
           ┌──────────────┐
           │ Email Server │
           │ (IMAP/SMTP)  │
           └──────────────┘
```

## Platform-Specific Notes

### macOS
- Minimum supported version: macOS 10.15 (Catalina)
- Universal binary (Intel + Apple Silicon) can be built with:
  ```bash
  npm run tauri:build -- --target universal-apple-darwin
  ```

### Windows (future)
- Will require Visual Studio Build Tools
- Update `tauri.conf.json` targets to include "msi" or "nsis"

### Linux (future)
- Will require webkit2gtk and related libraries
- Update `tauri.conf.json` targets to include "deb" or "appimage"
