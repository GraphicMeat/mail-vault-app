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

## Development

Run the app in development mode:

```bash
# Full desktop app
npm run tauri:dev

# Frontend only (web preview at http://localhost:5173/app.html)
npm run dev
```

The Rust Tauri process handles IMAP/SMTP/OAuth2 directly — no Node.js sidecar to start separately.

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
1. Cargo-build the `mailvault-daemon` sidecar and copy it into `src-tauri/binaries/`
2. Build the React frontend with Vite
3. Compile the Rust Tauri process and package everything into a native app

### Output Locations

- **macOS**: `src-tauri/target/release/bundle/`
  - `macos/MailVault.app` - Application bundle
  - `dmg/MailVault_1.0.0_*.dmg` - Disk image for distribution

## Build Troubleshooting

### "daemon sidecar not found" error
Make sure to run the daemon build first:
```bash
npm run build:daemon
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
4. Mac App Store provisioning profile (downloaded + installed under `~/Library/MobileDevice/Provisioning Profiles/`)
5. App record in App Store Connect with bundle id `com.mailvault.app`
6. **In-app purchase product** registered in App Store Connect with product id `com.mailvault.app.backups` (non-consumable). This gates the external backup folder feature.

#### How a MAS build differs from Developer ID

| | Developer ID | Mac App Store |
|---|---|---|
| Cargo features | `default` (includes `sparkle`) | `--no-default-features --features custom-protocol,appstore` |
| Sparkle auto-updater | Bundled (`Sparkle.framework`) | Removed; updates ship through the App Store |
| Cargo deps | `tauri-plugin-sparkle-updater` | `objc2-store-kit` for IAP |
| Frontend flag | `VITE_MV_APPSTORE` unset | `VITE_MV_APPSTORE=1` (hides Sparkle UI, shows IAP paywall in BackupConfig) |
| Entitlements | `entitlements.plist` (sandbox + Sparkle XPC) | `entitlements-appstore.plist` (sandbox only) |
| Backup folders | Always enabled | Gated behind StoreKit non-consumable IAP `com.mailvault.app.backups` |
| Output | `.dmg` + `.app` | `.pkg` (installer-signed) |
| Tauri overlay | none | `--config src-tauri/tauri.appstore.conf.json` |

The conditional code lives in `src-tauri/src/iap.rs` (StoreKit bridge via `objc2-store-kit`, NSUserDefaults-backed entitlement persistence) and `src-tauri/src/main.rs` (Sparkle plugin + menu item gated on `feature = "sparkle"`).

#### Build for App Store
```bash
npm run build:appstore
# or directly
./scripts/build-appstore.sh
```

This will:
1. Read the appstore overlay (`tauri.appstore.conf.json`) — drops Sparkle.framework and the `dmg` target
2. Build with `--no-default-features --features custom-protocol,appstore` and `VITE_MV_APPSTORE=1`
3. Sign the daemon binary and any frameworks with the Apple Distribution cert and the app-store entitlements
4. Embed the provisioning profile
5. Sign the main bundle and create a `productbuild`-signed `.pkg`
6. Run local sandbox validation checks

#### CI

The `Release (Mac App Store)` workflow (`.github/workflows/release-appstore.yml`) automates all of the above on `macos-latest`. Trigger via `gh workflow run release-appstore.yml -f version=2.6.0 -f upload=true`. Required secrets:

| Secret | Purpose |
|---|---|
| `APPLE_APPSTORE_CERT` | Apple Distribution cert (.p12 base64) |
| `APPLE_APPSTORE_CERT_PASSWORD` | .p12 password |
| `APPLE_INSTALLER_CERT` | Mac Installer Distribution cert (.p12 base64) |
| `APPLE_INSTALLER_CERT_PASSWORD` | .p12 password |
| `APPLE_PROVISIONING_PROFILE` | MAS provisioning profile (.provisionprofile base64) |
| `APPLE_TEAM_ID` | 10-char team identifier |
| `APP_STORE_CONNECT_API_KEY` | `.p8` private key contents |
| `APP_STORE_CONNECT_API_KEY_ID` | API key id |
| `APP_STORE_CONNECT_API_ISSUER` | API issuer uuid |

Generate `.p12` exports from Keychain Access → My Certificates → right-click → Export. Use `base64 -i cert.p12 | pbcopy` to encode for GitHub Secrets.

#### Submit to App Store
The workflow's `upload: true` step uploads via `xcrun altool` with App Store Connect API key. Local equivalent:
```bash
xcrun altool --upload-app -f "path/to/MailVault.pkg" -t macos \
  --apiKey "$API_KEY_ID" --apiIssuer "$API_ISSUER"
# Or use the Transporter app from the Mac App Store.
```

#### Known gotchas

- **IAP entitlement persistence**. `iap_is_entitled` reads from `NSUserDefaults`. Receipt-based validation against `Bundle.appStoreReceiptURL` is a stronger guarantee and should be added before launch.
- **Developer override**. Set `MV_IAP_DEV_ENTITLE=1` in the environment to bypass the paywall locally — works in MAS builds too, but only when launched from a shell that inherits the env var (not the Finder).
- **Bundle id collision**. The MAS build keeps `com.mailvault.app` for keychain compatibility with the Developer ID build — installing both side-by-side on the same Mac will cause keychain prompts.


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
│                  │ tauri::invoke()       │
│                  ▼                       │
│  ┌─────────────────────────────────┐    │
│  │   Rust Tauri Process (main)     │    │
│  │  - IMAP (async-imap)            │    │
│  │  - SMTP (lettre)                │    │
│  │  - OAuth2 + loopback callback   │    │
│  │  - StoreKit IAP (MAS builds)    │    │
│  └─────────────────────────────────┘    │
│                  │                       │
│                  │ Unix socket JSON-RPC  │
│                  ▼                       │
│  ┌─────────────────────────────────┐    │
│  │  mailvault-daemon (Rust sidecar)│    │
│  │  - Maildir I/O                  │    │
│  │  - Contacts index               │    │
│  │  - Background sync              │    │
│  └─────────────────────────────────┘    │
└──────────────────│───────────────────────┘
                   │
                   ▼
           ┌──────────────┐
           │ Email Server │
           │ (IMAP/SMTP)  │
           └──────────────┘
```

> The legacy Bun-compiled `mailvault-server` Node sidecar was removed in 2026-05. All IMAP/SMTP/OAuth2 logic now lives in the Rust Tauri process (`src-tauri/src/commands.rs`, `src-tauri/src/oauth2.rs`). The daemon owns local Maildir state.

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
