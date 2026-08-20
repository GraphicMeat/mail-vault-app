<p align="center">
  <img src="src-tauri/icons/icon.png" width="128" alt="MailVault icon">
</p>

<h1 align="center">MailVault</h1>

<p align="center">
  <b>Read your mail. Keep your mail.</b><br>
  A local-first email client that files every message on your own disk as a plain <code>.eml</code> — and keeps it after the server lets go.
</p>

<p align="center">
  macOS 11+ · Linux · IMAP, Gmail, Microsoft 365 · Rust + Tauri · Free core, no account<br>
  <a href="https://mailvaultapp.com">mailvaultapp.com</a>
</p>

---

![Inbox with the reading pane open](.github/images/01-inbox.webp)

MailVault is a full email client with a vault behind it. You read, search, thread and reply the way you would in any client — and every message you keep is written to your own disk as a standard `.eml` file in a Maildir tree, readable by anything. When the provider deletes it, expires it, or asks you to pay for storage, your copy does not care.

No account to create. No sync service in the middle. No telemetry.

## Features

### Mail, properly

- **One-click sign-in** — Google and Microsoft 365 OAuth2, plus Microsoft Graph for Outlook.com. Everything else is plain IMAP, with server auto-detection from SRV records, Mozilla autoconfig and MX fallback.
- **Threaded conversations** — JWZ threading, quote folding, signature folding, oldest- or newest-first.
- **Compose that behaves** — templates, contacts picker, attachments, undo send from 15 seconds to 5 minutes, and an outbox that stages locally so a failed send is recoverable rather than lost.
- **Search with filters** — sender, date range, attachments, folder, with history and suggestions.

### The vault

![Per-message state icons: on the server, in the vault, or local-only](.github/images/02-vault.webp)

- **Maildir + `.eml`** — one standard RFC 5322 file per message: headers, body, inline images, attachments. Readable by Thunderbird, Apple Mail, `grep`, or anything else you own.
- **Per-message state, on the row** — whether a message is on the server, in the vault, in both, or local-only because the server no longer has it.
- **Delete from the server with confidence** — archive first, then delete, in one operation. The local copy stays.
- **Portable by construction** — back the folder up, move it to another machine, mirror it to an external drive. Export the lot as MBOX for Thunderbird or Apple Mail. No database, no lock-in.

### Threads, or chat

![A conversation rendered as chat bubbles](.github/images/03-chat.webp)

Conversations stack chronologically with quotes folded — or switch the whole client to chat view: sent and received mail merged into one continuous thread of bubbles, per-sender avatars, progressive body loading. Same mailbox, two ways to read it.

### Bulk operations

![Bulk selection with date-range presets](.github/images/04-bulk.webp)

Pick a year — or a custom range — and archive, delete, or archive-and-delete thousands of messages in one pass, with a live progress bar, a cancel button, and crash-safe recovery if the machine gives up halfway.

### Security

![Suspicious link warning showing link text against its real destination](.github/images/05-security.webp)

- **Link safety** — a warning when a link's text is not where the link goes, with both URLs shown side by side before anything opens.
- **Sender checks** — SPF, DKIM and DMARC badges, display-name impersonation warnings, and From/Reply-To mismatch alerts.
- **Credentials in the OS keychain** — macOS Keychain, Linux Secret Service. Never in a config file.
- **Sandboxed on macOS**, no cloud service, no tracking, no telemetry.

### Multi-account

![Unified inbox across three accounts](.github/images/06-accounts.webp)

Unlimited accounts, each with its own display name and colour, all mergeable into one unified inbox. Switching is instant — state is cached per account — and each account remembers the folder you left it in. Sender insights show your exchange history with a contact.

### Built for the long run

| | |
|---|---|
| Binary | ~8 MB (Rust + Tauri, not Electron) |
| Memory | ~80 MB idle |
| Startup | under a second |
| Sync | CONDSTORE delta sync — zero IMAP calls when nothing changed |
| Bandwidth | COMPRESS=DEFLATE, 70–80% less on the wire |
| Lists | virtual scrolling, comfortable past 17,000 messages |

A background helper keeps mail syncing with the window closed, and macOS builds update themselves through a signed Sparkle appcast.

### Premium

The client is free forever — reading, composing, search, threading, and unlimited manual archiving. Premium adds the parts that need a scheduler or a server: automatic backups with health verification, cross-account migration, a guided server change with DNS health checks, cleanup rules driven by a local Naive Bayes classifier, and Time Capsule snapshots of a mailbox as it was on any past date. Pricing is on [mailvaultapp.com/pricing](https://mailvaultapp.com/pricing.html).

## Requirements

- macOS 11 or later (Apple Silicon and Intel), or Linux (`.deb`, AppImage, Snap, Flatpak)
- An IMAP account, or Gmail / Microsoft 365 via OAuth2

## Building

```sh
npm install
npm run tauri dev
```

Release build:

```sh
npm run tauri build
```

The Rust core lives in [`src-core/`](src-core/), the Tauri shell in [`src-tauri/`](src-tauri/), the background sync helper in [`src-daemon/`](src-daemon/), and the React front end in [`src/`](src/). Tests:

```sh
npx vitest run
npm run test:e2e
```

The E2E suite drives the real app against a scripted mock IMAP server ([`src-mock-imap/`](src-mock-imap/)) — no credentials, no network, no chance of touching a real mailbox. Packaging, signing and notarisation are documented in [BUILDING.md](BUILDING.md).

## Screenshots

Every screenshot here and on the website comes from one scripted demo mailbox, captured from the real app on a HiDPI Mac:

```sh
scripts/screenshots/prepare-build.sh
npm run build && cargo build -p mailvault --features webdriver
npx wdio run wdio.screenshots.conf.js
```

---

<p align="center">Made by <a href="https://graphicmeat.com">Graphic Meat</a></p>
