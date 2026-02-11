<p align="center">
  <img src="src-tauri/icons/icon.png" alt="MailVault" width="128" height="128">
</p>

# MailVault

A modern, cross-platform desktop email client built with Tauri and React. Save your emails locally forever, even after they're deleted from the server.

## Features

### 📧 Full Email Management
- Connect multiple email accounts (Gmail, Outlook, Yahoo, iCloud, or custom IMAP)
- View all mailboxes and folders
- Read, send, and manage emails
- Full attachment support

### 💾 Local Storage
- **Save emails locally** - Preserve emails with all metadata intact
- **Same format as server** - Emails are stored in their original format
- **Visual indicators** - Easily distinguish between server-only and locally saved emails
- **Local-only display** - View emails deleted from server but saved locally
- **Bulk save** - Select multiple emails and save them all at once
- **Export** - Download saved emails as `.eml` files

### 🔄 View Modes
- **All** - See both server and local emails combined
- **Server** - Show only emails currently on the server
- **Local** - Show only locally saved emails

### 🎨 Modern UI
- Light and dark themes with accent colors
- Smooth animations and transitions
- Responsive design
- Clean, intuitive interface

## Tech Stack

- **Desktop**: Tauri (Rust-based native wrapper)
- **Frontend**: React 18, Zustand (state management), Framer Motion (animations)
- **Backend**: Express.js, ImapFlow (IMAP), Nodemailer (SMTP)
- **Storage**: IndexedDB for email data, OS keychain for credentials (via `keyring` crate)
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
cd mail-client
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
3. Enter your email address and password

**Important for Gmail users:**
- If you have 2-Factor Authentication enabled, you need to use an [App Password](https://support.google.com/accounts/answer/185833)
- Go to Google Account → Security → 2-Step Verification → App passwords
- Generate a new app password for "Mail" and use it instead of your regular password

**Important for other providers:**
- Most providers require app-specific passwords when 2FA is enabled
- Check your provider's documentation for IMAP access settings

## Usage Guide

### Saving Emails Locally

**Single email:**
- Hover over an email in the list and click the save icon (💾)
- Or open an email and click "Save Locally" button

**Multiple emails:**
- Check the boxes next to emails you want to save
- Click "Save All" in the toolbar

### Understanding Icons

| Icon | Meaning |
|------|---------|
| 💾 (green HDD) | Email is saved locally |
| ☁️ (blue cloud) | Email exists only on server |
| 🟡 (yellow dot) | Email is local-only (deleted from server) |

### View Modes

Use the view mode toggle in the sidebar:

- **All**: Combined view - shows server emails plus any local-only emails
- **Server**: Only emails currently on the server
- **Local**: Only your locally saved emails

### Exporting Emails

1. Save an email locally first
2. Open the email
3. Click "Export" button
4. Email downloads as `.eml` file (can be opened in any email client)

## Project Structure

```
mail-client/
├── index.html
├── package.json
├── vite.config.js
├── tailwind.config.js
├── postcss.config.js
├── server/
│   └── index.js              # Express backend for IMAP/SMTP
├── src/
│   ├── main.jsx              # App entry point
│   ├── App.jsx               # Main app component
│   ├── components/
│   │   ├── Sidebar.jsx       # Account & folder navigation
│   │   ├── EmailList.jsx     # Email list with local indicators
│   │   ├── EmailViewer.jsx   # Email content viewer
│   │   ├── AccountModal.jsx  # Add account modal
│   │   └── Toast.jsx         # Notification toasts
│   ├── services/
│   │   ├── api.js            # API client for backend
│   │   └── db.js             # IndexedDB + keychain operations
│   ├── stores/
│   │   └── mailStore.js      # Zustand state management
│   └── styles/
│       └── index.css         # Tailwind + custom styles
└── src-tauri/
    ├── Cargo.toml            # Rust dependencies
    ├── tauri.conf.json       # Tauri configuration
    └── src/
        └── main.rs           # Tauri commands (keychain, etc.)
```

## Data Storage

Data is stored locally on your device:

- **Credentials**: Stored securely in your operating system's keychain
  - macOS: Keychain Access
  - Windows: Credential Manager
  - Linux: Secret Service (GNOME Keyring, KWallet)
- **Account Settings**: Email server configurations stored in IndexedDB
- **Emails**: Complete email data including headers, body, and attachments in IndexedDB
- **Saved Index**: Tracks which emails are saved locally

## Security

- **Secure Credential Storage**: Passwords are stored in your operating system's native keychain, protected by your system's security mechanisms.

- **App Passwords**: Always use app-specific passwords instead of your main account password when available.

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
- The email may not have been fully saved - try saving it again

## Contributing

Contributions are welcome! Please feel free to submit issues and pull requests.
