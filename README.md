<p align="center">
  <img src="src-tauri/icons/icon.png" alt="MailVault" width="128" height="128">
</p>

# MailVault

A modern, cross-platform desktop email client built with Tauri and React. Save your emails locally forever, even after they're deleted from the server.

## Features

### 📧 Full Email Management
- Connect multiple email accounts (Gmail, Outlook, Yahoo, iCloud, or custom IMAP)
- **Google OAuth2** — Sign in with Google for Gmail accounts (no app password needed)
- **Microsoft 365 OAuth2** — Sign in with Microsoft for Outlook/Hotmail/Live accounts (no app password needed)
- View all mailboxes and folders
- Read, send, and manage emails with From account selector
- Full attachment support

### 💾 Local Storage (Maildir + EML)
- **Maildir format** - Emails stored as individual `.eml` files on disk, one file per message
- **Standard EML files** - Industry-standard format readable by any email client
- **Full fidelity** - Headers, body, inline images, and attachments all preserved in a single file
- **Visual indicators** - Easily distinguish between server-only and locally saved emails
- **Local-only display** - View emails deleted from server but saved locally
- **Bulk save** - Select multiple emails and archive them all at once
- **Portable** - Back up, move, or open your `.eml` files with any tool

### 🔄 View Modes
- **All** - See both server and local emails combined
- **Server** - Show only emails currently on the server
- **Local** - Show only locally saved emails

### 🎨 Modern UI
- Light and dark themes with accent colors
- Collapsible sidebar (full or icon-only mode)
- Default or compact email list layout
- Per-account avatar colors (auto-assigned or custom)
- Smooth animations and transitions

## Tech Stack

- **Desktop**: Tauri v2 (Rust-based native wrapper)
- **Frontend**: React 18, Zustand (state management), Framer Motion (animations)
- **IMAP/SMTP**: Native Rust — `async-imap` for IMAP, `lettre` for SMTP, custom OAuth2 PKCE flow — all running in-process via Tauri `invoke()` commands
- **Storage**: Maildir format (`.eml` files on disk), OS keychain for credentials (via `keyring` crate), JSON file cache for email headers
- **Styling**: Tailwind CSS
- **Build**: Vite

## Getting Started

### Prerequisites

- Node.js 18+
- Rust (for Tauri)
- npm or yarn

### Installation

1. Clone the project:
```bash
git clone <repo-url>
cd mail-vault-app
```

2. Install dependencies:
```bash
npm install
```

3. Run in development mode:
```bash
npm run tauri dev
```

4. Build for production:
```bash
npm run tauri build
```

### Adding an Email Account

1. Click "Add Your First Account" or the "Add Account" button
2. Select your email provider (Gmail, Outlook, Yahoo, iCloud, or Custom)
3. Authenticate:
   - **Gmail**: Click "Sign in with Google" (recommended) — opens your browser for secure OAuth2 login. No app password needed, works with 2FA/MFA.
   - **Outlook / Microsoft 365**: Click "Sign in with Microsoft" (recommended) — opens your browser for secure OAuth2 login. No app password needed, works with 2FA/MFA.
   - **Other providers**: Enter your email address and password/app password.

**Gmail fallback (if not using OAuth2):**
- If you have 2-Factor Authentication enabled, you need to use an [App Password](https://support.google.com/accounts/answer/185833)
- Go to Google Account → Security → 2-Step Verification → App passwords
- Generate a new app password for "Mail" and use it instead of your regular password

**Important for other providers:**
- Most providers require app-specific passwords when 2FA is enabled
- Check your provider's documentation for IMAP access settings

## Usage Guide

### Archiving Emails Locally

Emails are saved as `.eml` files in Maildir format on your disk.

**Single email:**
- Hover over an email in the list and click the archive icon
- Or open an email and click "Archive" button

**Multiple emails:**
- Check the boxes next to emails you want to archive
- Click "Archive All" in the toolbar

### Understanding Icons

| Icon | Meaning |
|------|---------|
| 🖥️ (green HDD) | Email is archived locally |
| ☁️ (blue cloud) | Email exists only on server |
| 🖥️ (yellow HDD) | Email is local-only (deleted from server) |

### View Modes

Use the view mode toggle in the sidebar:

- **All**: Combined view - shows server emails plus any local-only emails
- **Server**: Only emails currently on the server
- **Local**: Only your locally saved emails

### Exporting Emails

Archived emails are already stored as `.eml` files. You can:

1. Open an archived email and click "Show in Finder" / "Open File" to access the `.eml` directly
2. Copy `.eml` files from the Maildir directory for backup or transfer
3. Open any `.eml` file with other email clients (Thunderbird, Apple Mail, etc.)
4. Import `.eml` files into Apple Mail via the mbox trick:
   1. Place the `.eml` files in a directory (e.g., `In`)
   2. Add an `.mbox` extension to the directory (`In.mbox`)
   3. In Mail, choose **File → Import Mailboxes…**, select **Apple Mail** as the format, and click **Continue**
   4. Browse to and select the `In.mbox` directory → **Choose → Continue → Done**

   Confirmed working through macOS Tahoe. The "Items to import" window may list every email under each folder, but the import still completes correctly. Credit: [@tinyapps](https://tinyapps.org/blog/202206140700_mail_app_export.html).

## Project Structure

```
mail-vault-app/
├── app.html                   # Tauri window entry point
├── package.json
├── vite.config.js
├── tailwind.config.js
├── src/
│   ├── main.jsx               # App entry point
│   ├── App.jsx                # Main app component
│   ├── components/
│   │   ├── Sidebar.jsx        # Account & folder navigation
│   │   ├── EmailList.jsx      # Email list with local indicators
│   │   ├── EmailViewer.jsx    # Email content viewer
│   │   ├── AccountModal.jsx   # Add account modal
│   │   └── Toast.jsx          # Notification toasts
│   ├── services/
│   │   ├── api.js             # Tauri invoke() API client
│   │   └── db.js              # Maildir + keychain operations
│   ├── stores/
│   │   └── mailStore.js       # Zustand state management
│   └── styles/
│       └── index.css          # Tailwind + custom styles
└── src-tauri/
    ├── Cargo.toml             # Rust dependencies
    ├── tauri.conf.json        # Tauri configuration
    └── src/
        ├── main.rs            # Tauri commands (keychain, Maildir, EML parsing)
        ├── imap/
        │   ├── mod.rs         # IMAP operations (connect, fetch, search, flags)
        │   └── pool.rs        # Two-pool connection manager (background + priority)
        ├── smtp.rs            # SMTP send via lettre
        ├── oauth2.rs          # Microsoft OAuth2 PKCE flow
        ├── commands.rs        # Tauri command wrappers for IMAP/SMTP/OAuth2
        └── archive.rs         # Bulk email archiving (concurrent, cancellable)
```

## Data Storage

All data is stored locally on your device — nothing is sent to third-party servers.

- **Credentials**: Stored securely in your operating system's native keychain
  - macOS: Keychain Access
  - Windows: Credential Manager
  - Linux: Secret Service (GNOME Keyring, KWallet)
- **Account Settings**: Saved as JSON in the app's data directory
- **Emails**: Stored as individual `.eml` files using Maildir format
  - Each email is a self-contained `.eml` file with headers, body, inline images, and attachments
  - Organized by account and mailbox: `Maildir/<account-id>/<mailbox>/cur/<uid>.eml`
  - Flags (read, archived, etc.) encoded in the filename per Maildir convention
  - Files are standard RFC 5322 format — portable and readable by any email client
- **Email Header Cache**: JSON files for fast inbox loading without re-fetching from server

## Security

- **Secure Credential Storage**: Passwords and OAuth2 tokens are stored in your operating system's native keychain, protected by your system's security mechanisms.

- **OAuth2 for Microsoft**: Outlook/Microsoft 365 accounts use secure OAuth2 (XOAUTH2) authentication with PKCE. Your Microsoft password is never stored — only short-lived access tokens and refresh tokens, encrypted in the system keychain.

- **App Passwords**: For other providers, use app-specific passwords instead of your main account password when available.

- **Native IMAP/SMTP**: All email operations run natively in Rust within the Tauri process — no intermediate HTTP server, no sidecar binary, no localhost networking. Your credentials never leave the app process.

- **Local Storage**: Emails saved locally include all content and attachments. Be mindful of what you save on shared computers.

## Troubleshooting

### Connection Failed
- Verify your email and password are correct
- For Gmail/Yahoo/iCloud, make sure you're using an App Password
- Check that IMAP is enabled in your email provider's settings

### Emails Not Loading
- Click the refresh button to reload emails
- Check the browser console for error messages
- Verify your internet connection

### Local Emails Not Showing
- Make sure you're in "All" or "Local" view mode
- The email may not have been fully archived — try archiving it again
- Check the Maildir directory in your app data folder for the `.eml` files

## Contributing

Contributions are welcome! Please feel free to submit issues and pull requests.
