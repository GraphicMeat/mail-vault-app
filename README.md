<p align="center">
  <img src="src-tauri/icons/icon.png" width="128" alt="MailVault icon">
</p>

<h1 align="center">MailVault</h1>

<p align="center">
  <b>Read your mail. Keep your mail.</b><br>
  A local-first email client that files every message on your own disk as a plain <code>.eml</code> — and keeps it after the server lets go.
</p>

<p align="center">
  macOS · Windows · Linux · IMAP, Gmail, Microsoft 365, Outlook.com · Rust + Tauri · Free core, no account<br>
  <a href="https://mailvaultapp.com">mailvaultapp.com</a> · <a href="https://github.com/GraphicMeat/mail-vault-app/releases/latest">Download</a>
</p>

---

![Inbox with the reading pane open](website/screenshots/email-list-view-1440.webp)

MailVault is a full email client with a vault behind it. You read, search, thread and reply the way you would in any client — and every message you keep is written to your own disk as a standard `.eml` file in a Maildir tree, readable by anything. When the provider deletes it, expires it, or asks you to pay for storage, your copy does not care.

No account to create. No sync service in the middle. No telemetry.

## Platforms

| | |
|---|---|
| **macOS** | macOS 11 or later, Apple Silicon and Intel. Signed, notarised `.dmg` that updates itself through Sparkle. |
| **Windows** | Windows 10 or 11, 64-bit Intel or AMD. Signed installer (`-setup.exe`). |
| **Linux** | x86_64 and aarch64: `.deb` for Ubuntu 22.04+ / Debian 12+, or the Snap Store. Wayland and X11. |

Every build is on the [latest release](https://github.com/GraphicMeat/mail-vault-app/releases/latest). Accounts: any IMAP server, plus Gmail and Microsoft 365 through OAuth2 and Outlook.com through Microsoft Graph.

## Features

### Mail, properly

- **One-click sign-in** — Google and Microsoft 365 OAuth2, plus Microsoft Graph for Outlook.com. Everything else is plain IMAP, with server auto-detection from SRV records, Mozilla autoconfig and MX fallback.
- **Threaded conversations** — JWZ threading, quote folding, signature folding, oldest- or newest-first.
- **Compose that behaves** — templates, contacts picker, attachments, undo send from 15 seconds to 5 minutes, and an outbox that stages locally so a failed send is recoverable rather than lost.
- **Search with filters** — sender, date range, attachments, folder, with history and suggestions.

### Explorer and Insights

<p>
  <img src="website/screenshots/explorer-date-light-1440.webp" width="49%" alt="Explorer browsing a mailbox by year and month">
  <img src="website/screenshots/insights-map-1440.webp" width="49%" alt="Insights sender map, frequent contacts drawn larger">
</p>

- **Explorer** — switch from List to browse by Date, Sender, or Date → Conversation. Open year, month and optional day groups, follow breadcrumbs, search the current group, or select its messages together. Your view and place are remembered.
- **Insights** — a sender map, sender timeline, and daily activity calendar built from local headers. Frequent contacts have larger bubbles; recent contacts sit closer to you. Filter by account, date, direction, or likely automated mail, then open matching messages.

### The vault

![Per-message state icons: on the server, in the vault, or local-only](website/screenshots/state-icons-light-1440.webp)

- **Maildir + `.eml`** — one standard RFC 5322 file per message: headers, body, inline images, attachments. Readable by Thunderbird, Apple Mail, `grep`, or anything else you own.
- **Per-message state, on the row** — whether a message is on the server, in the vault, in both, or local-only because the server no longer has it.
- **Delete from the server with confidence** — archive first, then delete, in one operation. The local copy stays.
- **Portable by construction** — the mail is plain files: back the folder up, move it to another machine, mirror it to an external drive, or export the lot as MBOX for Thunderbird or Apple Mail. No lock-in.

### Threads, or chat

![A conversation rendered as chat bubbles](website/screenshots/chat-view-thread-1440.webp)

Conversations stack chronologically with quotes folded — or switch the whole client to chat view: sent and received mail merged into one continuous thread of bubbles, per-sender avatars, progressive body loading. Same mailbox, two ways to read it.

### Organise it your way

<p>
  <img src="website/screenshots/settings-auto-tags-light-1440.webp" width="49%" alt="Auto Tags rules written in plain English">
  <img src="website/screenshots/custom-fields-1440.webp" width="49%" alt="A custom Priority field on an invoice email">
</p>

- **Auto Tags** — rules, written in plain English, that tag matching mail as it arrives. They run on your computer unless you point them at a remote provider, and never move or delete anything on the server.
- **Saved views and custom fields** — filters that behave like inboxes, and your own fields, such as a priority, on any message.
- **AI writing help** — draft, shorten, change tone, or summarise a thread with a model that runs on your computer, or one you choose.
- **Layouts and themes** — three- or two-column, resizable panes, light and dark, customisable keyboard shortcuts.

### Bulk operations

![Bulk selection with date-range presets](website/screenshots/selection-dialog-1440.webp)

Pick a year — or a custom range — and archive, delete, or archive-and-delete thousands of messages in one pass, with a live progress bar, a cancel button, and crash-safe recovery if the machine gives up halfway.

### Security

![Suspicious link warning showing link text against its real destination](website/screenshots/link-safety-modal-light-1440.webp)

- **Link safety** — a warning when a link's text is not where the link goes, with both URLs shown side by side before anything opens.
- **Sender checks** — SPF, DKIM and DMARC badges, display-name impersonation warnings, and From/Reply-To mismatch alerts.
- **Tracker blocking** *(Premium)* — the hidden pixels that report when you opened a message are found on every mail, named on the row, and stripped out of the HTML before it renders. Detection is free; removal comes with a subscription.
- **Credentials in the OS store** — macOS Keychain, Windows Credential Manager, Linux Secret Service. Never in a config file.
- **Sandboxed on macOS**, no cloud service, no tracking, no telemetry.

### Multi-account

![Unified inbox across three accounts](website/screenshots/unified-inbox-1440.webp)

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

A background helper keeps mail syncing with the window closed, and the app updates itself with an in-app changelog.

### Premium

<p>
  <img src="website/screenshots/premium-scheduled-send-light-1440.webp" width="49%" alt="Scheduled Send picking a date, time and time zone">
  <img src="website/screenshots/premium-time-capsule-1440.webp" width="49%" alt="Time Capsule showing a mailbox as it was on an earlier date">
</p>

The client is free forever: reading, composing, search, threading, Explorer, Insights, Auto Tags, and unlimited manual archiving. Premium adds the parts that need a scheduler or a server: automatic backups with health verification, cross-account migration, a guided server change with DNS health checks, cleanup rules driven by a local Naive Bayes classifier, attachment search, and Time Capsule snapshots of a mailbox as it was on any past date. Focus sessions, a timer that covers the window and holds notifications for the minutes you choose, are Premium too. So is Scheduled Send: an email goes out at the exact date and time you pick, in any time zone, with the recipient's zone suggested from their last email; delaying a send by up to five minutes stays free. So is Portable MailVault: a copy on a USB stick or external drive that runs on any computer with your mail and accounts on the drive, locked with a password (Windows, Linux AppImage and the macOS website build; not the App Store version). Pricing is on [mailvaultapp.com/pricing](https://mailvaultapp.com/pricing.html).

## Building

```sh
npm install
npm run tauri dev
```

Release build:

```sh
npm run tauri build
```

### Browser demo

The website includes a browser-only demo of the real React client. Build it
into the static site and serve `website/` with any static server:

```sh
npm ci --ignore-scripts
npm run build:demo
npm run capture:demo-preview
npm run update:demo-preview
node website/i18n/i18n.mjs build
python3 -m http.server 4174 --directory website
```

Then open [http://127.0.0.1:4174/demo/](http://127.0.0.1:4174/demo/). It covers
the inbox, threaded chat, Explorer, Insights, compose, search, archive/delete,
attachments, snapshots, account-scoped folders, and all Settings pages using
300 fictional seeded messages, with 100 messages in each of the three sample
accounts and a 75-message primary Inbox spread across months and years, including
long conversations and HTML newsletters. Reset restores the initial mailbox and
settings.

The demo runs entirely in the visitor's browser. It does not contact an IMAP
server, send mail, collect credentials, open native dialogs, run Rust, or
perform billing and OAuth actions. Mailbox changes, drafts, and settings are
stored in a dedicated IndexedDB workspace with a fixed seven-day expiry and a
5 MB limit. Expired workspaces reset when the demo opens or resumes. If browser
storage is unavailable, the demo continues in memory and explains the limitation.
Exports download sample files in the browser, while import buttons use a
canned sample and arbitrary file import and native filesystem access are
unavailable. The generated bundle is written to
`website/demo/` and rebuilt by the website deployment workflow.

The homepage hero button and preview image open the demo separately; the homepage
loads only a responsive preview image, with no demo JavaScript or iframe.
Localized pages pass an explicit app language, such as `/demo/?lang=de` or
`/demo/?lang=pt-BR`. The demo header, tour, and explanations support the app's
nine languages. Fictional sample email bodies remain in English.

The website release builds the demo from the shared React app, captures fresh
light/dark WebP previews, then regenerates the localized pages. Run the capture
locally after `build:demo` with `npm run capture:demo-preview` and
`npm run update:demo-preview` (requires Chrome and `cwebp`; WebdriverIO provisions
an isolated driver), then `node website/i18n/i18n.mjs build`. Content-hashed demo assets
receive a seven-day HTTP cache policy; HTML revalidates on navigation. Old
assets are retained through an additional grace period for open demo tabs.
New native commands still need a demo adapter and a regression test when added
to the shared app.

The Rust core lives in [`src-core/`](src-core/), the Tauri shell in [`src-tauri/`](src-tauri/), the background sync helper in [`src-daemon/`](src-daemon/), and the React front end in [`src/`](src/). Tests:

```sh
npx vitest run
npm run test:e2e
```

The E2E suite drives the real app against a scripted mock IMAP and SMTP server ([`src-mock-imap/`](src-mock-imap/)): no credentials, no network, no chance of touching a real mailbox, and a send that can either succeed or be refused on demand. Packaging, signing and notarisation are documented in [BUILDING.md](BUILDING.md).

## Screenshots

Documentation screenshots come from a scripted demo mailbox captured from the
real app on a HiDPI Mac, in light and dark. This README shows the website set
in `website/screenshots/` directly, so a reshoot updates both. The homepage demo preview is captured from the browser
build during website releases, as described above:

```sh
scripts/screenshots/prepare-build.sh
npm run build && cargo build -p mailvault --features webdriver
npx wdio run wdio.screenshots.conf.js
```

---

<p align="center">Made by <a href="https://graphicmeat.com">Graphic Meat</a></p>
