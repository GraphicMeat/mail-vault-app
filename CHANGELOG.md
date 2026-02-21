# Changelog

## [Unreleased]

## [1.7.0] - 2026-02-21

### Added
- **Email threading (Gmail-style)** — emails are now grouped into threads using RFC 2822 `In-Reply-To` and `References` headers, with normalized subject as fallback; the regular email list shows collapsed thread rows with participant names, message count badges, and latest date; the chat view uses the same threading algorithm for its topic grouping; Rust IMAP layer now fetches `In-Reply-To` from ENVELOPE and `References` via `BODY.PEEK[HEADER.FIELDS (References)]`
- **Thread conversation view** — clicking a thread in the email list now shows all emails in the thread as a stacked conversation in the viewer; emails are sorted chronologically with the latest expanded by default; each email has its own reply/reply-all/forward buttons and attachment section; email bodies load progressively using the same concurrent loader as the chat view
- **Chat view: sent message merge** — chat conversations now display both received (INBOX) and sent messages together; Sent folder headers are synced via the background pipeline and merged with INBOX emails, with deduplication by Message-ID to avoid duplicates; body loading handles per-mailbox IMAP fetches transparently
- **Clear cache button** — Settings > General > Local Email Caching now has a "Clear Cache" button that removes all cached .eml files and headers, preserves archived emails, and restarts the sync pipeline
- **Hide/unhide accounts** — accounts can be hidden from Settings > Accounts; hidden accounts disappear from the sidebar and stop all syncing (background pipelines, scheduled refresh); unhiding immediately resumes sync; if the active account is hidden, the app switches to the next visible account

### Removed
- **App Password fallback for OAuth2 providers** — Gmail and Microsoft accounts no longer show the "Use App Password instead" toggle; OAuth2 is the only authentication method for these providers as app passwords are less secure

### Fixed
- **Thread row actions** — threaded email rows in the list view now show archive and more-menu buttons on hover (matching single-email rows); archive button archives all emails in the thread; more menu offers "Delete thread from server" with confirmation
- **Chat view "Content cannot be displayed"** — chat bubbles showed "Content cannot be displayed" for all messages because the chat view only received header-only emails (no body content); added progressive body loading via `useChatBodyLoader` hook that fetches email bodies concurrently (3 at a time) from cache → Maildir → IMAP, with per-bubble loading spinners and targeted re-renders

## [1.6.0] - 2026-02-20

### Added
- **Gmail OAuth2 sign-in** — Gmail accounts now support "Sign in with Google" via OAuth2 PKCE flow, alongside the existing Microsoft OAuth2; uses Thunderbird's public Google client ID with `https://mail.google.com/` scope for IMAP and SMTP access
- **Multi-provider OAuth2 architecture** — OAuth2 backend refactored from Microsoft-only to a provider-agnostic design; adding new OAuth2 providers requires only a new `ProviderConfig` entry in Rust
- **Automatic OAuth2 token refresh** — access tokens are now refreshed proactively 5 minutes before expiry; refresh is deduplicated across concurrent calls, persisted to Keychain, and patched into the live store so all pipelines and UI operations get fresh tokens transparently
- **Collapsible sidebar** — click the panel icon in the sidebar header to collapse it to a narrow icon-only strip (~56px); expands back with one click; state persisted across sessions
- **Compact email list view** — alternative 2-line layout (sender + date on line 1, subject on line 2) selectable from Settings > General
- **Account avatar initials & colors** — account avatars now show the first letter of the display name (or email) on a deterministic color circle instead of a generic person icon; each account gets a unique color, customizable per-account from Settings > Accounts
- **From account selector** — compose modal shows a "From" dropdown when multiple accounts exist, defaulting to the currently active account
- **Per-account mailbox memory** — switching accounts restores the last selected folder for that account instead of always resetting to INBOX
- **Non-selectable folder handling** — IMAP `\Noselect` folders (e.g. Gmail's `[Google Mail]`) now expand children on click instead of triggering a SELECT error

### Fixed
- **Inline images treated as attachments** — embedded images with Content-ID (referenced via `cid:` in HTML) incorrectly showed the paperclip icon in the email list and appeared in the attachment section; BODYSTRUCTURE walker now checks Content-ID to distinguish embedded images from real attachments, and `.eml` parsing applies the same filter (tracking pixels also excluded)
- **Gmail XOAUTH2 auth hanging** — `async-imap`'s `authenticate()` deadlocked because the IMAP server greeting was not consumed before starting the SASL handshake; added explicit `read_response()` to drain the greeting first
- **XOAUTH2 authenticator infinite loop** — when the server rejected XOAUTH2 with a `+` error challenge, the authenticator resent the full token on every challenge; now sends empty response on subsequent challenges to let the server close cleanly
- **Gmail OAuth2 "client_secret is missing"** — Google requires `client_secret` even for PKCE public clients (unlike Microsoft); added Thunderbird's public Google client secret as default
- **OAuth2 sign-in endless spinner** — entering wrong credentials during OAuth2 sign-in left the UI in a permanent loading state; added Cancel button to abort the OAuth2 flow
- **Test connection timeout** — `imap_test_connection` had no timeout; wrapped in 20-second `tokio::time::timeout`
- **OAuth2 token refresh race condition** — concurrent callers could bypass the deduplication guard; moved guard registration before any async operation
- **Missing token refresh at IMAP entry points** — `markEmailReadStatus`, `performSearch`, and `setActiveAccount` didn't call `ensureFreshToken`, causing expired-token failures for OAuth2 accounts
- **Server-side search broken for OAuth2** — `performSearch` only checked `account.password`; now uses `hasValidCredentials()` which accepts both password and OAuth2 tokens
- **Mailbox folders unsorted** — folders appeared in arbitrary server order; now sorted alphabetically with INBOX pinned first
- **"Invalid from address" on send** — special characters in display name broke `format!()` address parsing; now uses `lettre::Mailbox::new()` for proper RFC 5322 formatting
- **Namespace error on account switch** — old mailbox path (e.g. `[Google Mail]/Spam`) carried across accounts; fixed with per-account mailbox memory
- **Cloud icon doubling on Retina** — CSS `opacity-50` on Lucide SVG caused double-compositing; replaced with `rgba()` inline color
- **Badge count log spam** — `set_badge_count` logged on every call; added deduplication and downgraded to debug level

## [1.5.0] - 2026-02-19

### Performance
- **Delta-sync on folder/account switch** — switching mailbox or account now checks IMAP UIDVALIDITY + UIDNEXT before fetching; if nothing changed, the cached email list is kept as-is with zero IMAP fetches; when emails were added or deleted, only the diff is fetched via `UID SEARCH ALL` + `UID FETCH` for new UIDs, instead of re-downloading the entire first page
- **Lazy email parsing** — opening an email now only parses text/HTML body and attachment metadata; attachment binaries and raw source are no longer loaded upfront, reducing parse time from ~60ms to ~8ms for a 5 MB email
- **On-demand attachment loading** — attachment content is fetched from the .eml file only when the user clicks download, eliminating wasted memory for unviewed attachments
- **On-demand raw source** — "View Source" now loads the full email source lazily instead of including it with every email open
- **Optimized email list rendering** — `EmailRow` wrapped in `React.memo` with stable selectors, eliminating thousands of unnecessary re-renders per store mutation at scale (10k+ emails)
- **Light IMAP fetch** — new `imap_get_email_light` command returns only body text and attachment metadata from the server, auto-persisting the full .eml to Maildir for later on-demand access
- **Light Maildir reads** — `getLocalEmails()` and email selection now use `maildir_read_light` which skips base64-encoding attachment binaries and raw source
- **Light background caching** — content caching pipeline now uses `fetchEmailLight` (Rust auto-persists .eml) instead of fetching full email + JS-side save, reducing memory and bandwidth per cached email

### Fixed
- **Garbled sender/subject in email list** — non-ASCII names and subjects (e.g. `=?windows-1257?Q?Ona_...?=`) appeared as raw RFC 2047 encoded text in the email list; IMAP envelope values are now decoded through `mailparse` before display
- **Attachment indicators missing from email list** — IMAP header fetches never detected attachments because `BODYSTRUCTURE` wasn't requested; now included in the FETCH command so `hasAttachments` is set correctly at the header level without needing to open the email
- **Attachment section not showing in email viewer** — `hasAttachments` updates only wrote to the `emails` array but not to `emailsByIndex` (the Map used by the virtual-scroll list); now both are updated in sync when selecting an email or background-caching completes
- **IMAP namespace error** — servers requiring mailbox prefix (e.g., `INBOX.Sent` instead of `Sent`) would fail with "nonexistent namespace" when the app fell back to hardcoded mailbox paths; now caches server-returned mailbox paths and falls back to INBOX-only when no cache exists
- **Black screen crash** — app going to a black screen after extended use due to WKWebView memory exhaustion; stripped heavy fields (rawSource, attachment content) from in-memory cache, reduced default cache limit from 5GB to 512MB, and eliminated wasteful Map copies on every cache read/write
- Iframe event listeners (click, contextmenu) leaked on every email selection — now properly cleaned up when switching emails
- Rust panic hook installed — panics are now logged to stderr/system log before process abort, aiding crash diagnosis
- Update checker blocked a Tokio worker thread with `std::thread::sleep` — replaced with async `tokio::time::sleep`
- Email archive from cache could fail when rawSource was not available — now falls through to a fresh IMAP fetch
- Bulk archive ("Archive Selected") now correctly sets the `archived` flag — previously only set `seen`, so bulk-archived emails didn't appear in Local view
- Failproof email loading — emails that fail to load are now retried with unlimited exponential backoff (3s → 9s → 18s → 36s… capped at 120s) instead of being silently skipped
- OAuth2 accounts (Microsoft 365) silently failed to load email content — background caching and header loading both checked only for password, now correctly accept OAuth2 access tokens
- All network activity pauses automatically when app goes offline and resumes on reconnect (both header loading and content caching pipelines)
- Per-message error handling on the server — one malformed email no longer kills the entire page fetch; failed messages are skipped with a warning and the rest load normally
- IMAP connection retry now covers more transient error types (BYE, closed, SERVERBUG, EPIPE, EAI_AGAIN) in addition to timeouts and resets
- Priority IMAP connections (used for single email fetch) now properly cleaned up on error/close, preventing stale connection buildup
- Guard against stale state updates when user switches mailbox while background loading is in progress
- Mailbox mutation detection — if another client adds or deletes emails mid-pagination, sequence numbers shift and MailVault now detects the total change and restarts pagination instead of loading duplicates or gaps
- Stale UID cleanup on refresh — cached emails deleted on another client are removed from the local list when the server no longer returns them in the overlap window
- Server returns skipped UIDs to client for retry instead of silently dropping them; client re-requests the affected page/range after 5 seconds
- Server graceful shutdown now cleans up both priority and background IMAP connection pools (previously leaked priority connections)
- Drag-and-drop account reordering in sidebar and settings had no visible effect — components weren't subscribed to the `accountOrder` state, so reorders were persisted but never reflected in the UI

### Added
- **Native Rust IMAP/SMTP** — replaced Node.js sidecar server with native `async-imap` and `lettre` crates; all email operations now run directly in the Tauri process via `invoke()` commands (no more HTTP to localhost:3001)
- **IMAP connection pooling** — two-pool design (background + priority) with NOOP health checks and automatic reconnection on stale sessions
- **Native OAuth2 PKCE flow** — Microsoft OAuth2 moved from Node.js to Rust with PKCE code challenge, local TCP callback server on port 19876, and automatic token refresh
- **UID EXPUNGE support** — permanent email deletion now uses RFC 4315 UID EXPUNGE to only remove the targeted message, not all deleted messages in the mailbox
- Background loading pipeline architecture — dedicated `AccountPipeline` class manages per-account header loading and content caching with configurable concurrency
- Multi-account background sync — after the active account finishes loading, all other accounts' INBOX headers are fetched and cached automatically
- Parallel content caching — active account downloads 3 email bodies concurrently (up from 1); background accounts use 1 concurrent worker
- Cross-account cascade — after active account content is fully cached, background accounts also get their email bodies cached sequentially
- Shared credential helper (`authUtils.js`) — single source of truth for password/OAuth2 credential validation
- Bulk archive runs on Rust async thread pool — 3 concurrent email fetches via IMAP pool, with progress events and cancellation support; no longer blocks the JS event loop
- Cancel button on bulk archive progress toast — stops in-flight archive operation

### Changed
- Disabled browser's native "Open Frame in New Window" right-click option on email content iframe
- Replaced monolithic `useBackgroundCaching` hook with clean pipeline architecture: `AccountPipeline` (per-account worker), `EmailPipelineManager` (singleton coordinator), `usePipelineCoordinator` (React bridge)
- Removed Node.js sidecar server — no more bundled binary, sidecar spawning, health check polling, or HTTP-based API calls; reduces app size and startup time

## [1.4.11] - 2026-02-19

### Fixed
- Sidecar server port conflict after app update — old sidecar process stayed alive on port 3001, blocking new instance; new sidecar now sends a shutdown request (`POST /api/shutdown`) to the old instance before retrying, enabling graceful handoff without shell commands (blocked in sandbox)

## [1.4.10] - 2026-02-19

### Fixed
- API calls now routed through Tauri HTTP plugin instead of WKWebView's native fetch — App Sandbox blocks WebView from making HTTP requests to `localhost` sidecar; the plugin routes requests through Rust's networking stack, bypassing the restriction
- Fixed duplicate `http:default` capability identifier that could cause permission conflicts

### Added
- Comprehensive diagnostic logging throughout the connection flow: API module startup, HTTP plugin loading, health check polling, request lifecycle, and IMAP test-connection steps — enables pinpointing exactly where failures occur in sandbox environments

## [1.4.9] - 2026-02-19

### Fixed
- "SecurityError: the operation is insecure" crash caused by Web Worker — WKWebView blocks `blob:` URL workers under the `tauri://` origin; replaced Web Worker with main-thread queue processor (no functionality lost, all I/O was already on the main thread)
- Infinite spinner when adding an account — sidecar server crashed silently on `EADDRINUSE` (port 3001 occupied by previous instance) and the frontend waited forever; sidecar now retries port binding up to 5 times before exiting cleanly so the crash is detected and reported
- Frontend API requests now have a 30-second timeout (AbortController) to prevent infinite hangs
- Health check polling now throws and resets on failure, allowing retry on subsequent API calls instead of caching the failed state forever
- IMAP test-connection timeout reduced from 30s to 15s for faster settings detection feedback

## [1.4.8] - 2026-02-19

### Fixed
- "SecurityError: The operation is insecure" crash — completely replaced localStorage with Tauri filesystem-backed storage; WKWebView in App Sandbox blocks all web storage APIs, now settings persist via JSON file on disk instead
- Black screen on first launch — Framer Motion animations starting at opacity 0 could stay invisible if animation engine failed in WKWebView
- Added React error boundary with visible fallback UI and stack trace for rendering crashes
- Splash screen now only dismisses after React successfully renders (not before)
- Added 10-second timeout fallback if app fails to load — shows reload button instead of blank screen

### Added
- Blog section on website with post about the v1.4.x signing saga

### Changed
- Updated README icon descriptions to match current UI

## [1.4.5] - 2026-02-18

### Fixed
- Sidecar crashing in sandboxed release builds — sidecar now signed with dedicated entitlements (no sandbox, JIT allowed) while main app keeps App Sandbox; signing order corrected (sidecar first, no `--deep`)

## [1.4.4] - 2026-02-18

### Fixed
- Sidecar server crashing on launch in release builds — App Sandbox blocked Bun's JIT compiler; sidecar now signed with dedicated entitlements (no sandbox, JIT allowed)
- Removed `--deep` codesigning flag that was overwriting sidecar entitlements
- Replaced shell-based process cleanup (lsof, kill) with Tauri CommandChild handle

## [1.4.3] - 2026-02-18

### Fixed
- Sidecar server not starting in sandboxed builds — removed shell commands (lsof, kill) blocked by App Sandbox, replaced with Tauri CommandChild handle for clean process management

## [1.4.2] - 2026-02-18

### Fixed
- Sidecar server unable to start in sandboxed release builds — added missing `network.server` entitlement so the backend can listen on localhost

## [1.4.1] - 2026-02-18

### Fixed
- "Server unreachable (/test-connection): Load failed" when auto-detecting server settings — raw fetch bypassed the API base URL in Tauri builds

## [1.4.0] - 2026-02-18

### Fixed
- Server unreachable error in release builds — sidecar now explicitly binds to 127.0.0.1 to prevent IPv4/IPv6 mismatch

## [1.3.0] - 2026-02-18

### Added
- Settings menu item in macOS app menu (Cmd+,) for quick access to Settings
- Escape key closes Settings page
- Copy button in logs section — copies logs to clipboard with "Copied!" feedback
- Inline confirmation modal for account removal — replaces browser confirm() dialog

## [1.2.0] - 2026-02-18

### Added
- Microsoft 365 OAuth2 (XOAUTH2) support — sign in with Microsoft for Outlook/Hotmail/Live/M365 accounts
- "Sign in with Microsoft" button in account setup for Outlook provider (uses PKCE authorization code flow)
- OAuth2 token auto-refresh — access tokens refresh automatically when expired
- OAuth2 account status in Settings — shows "Connected" / "Token expired" badges, with Reconnect button
- OAuth2 callback server on `localhost:19876` — temporary server for receiving Microsoft auth redirects
- `server/oauth2Config.js` — Microsoft OAuth2 endpoints and credential configuration
- `updateOAuth2Tokens()` helper in `db.js` for updating tokens after refresh
- OAuth2 API functions in `api.js` — `getOAuth2AuthUrl`, `exchangeOAuth2Code`, `refreshOAuth2Token`
- App Password fallback — users can still choose password auth for Outlook accounts

### Fixed
- Settings page blank screen — missing `AnimatePresence` import from framer-motion
- Notifications now show app icon — replaced AppleScript `osascript` with `tauri-plugin-notification`
- Email content now renders with original formatting preserved — removed aggressive dark mode CSS overrides that broke email layouts, centering, and styled elements; emails now display on a light background (like Apple Mail) regardless of app theme
- IPv6 connection hangs with Outlook — forced IPv4 on all IMAP/SMTP connections
- Multiple sidecar server processes — added orphan cleanup on startup and kill on quit

### Changed
- IMAP/SMTP auth now supports `accessToken` (XOAUTH2) in addition to password auth
- Outlook provider renamed to "Outlook / Microsoft 365" with OAuth2 as recommended auth method
- Account setup for Outlook defaults to OAuth2, with "Use App Password instead" fallback link
- Settings Authentication section shows auth type badge (Password vs Microsoft OAuth2)
- OAuth2 now uses Mozilla Thunderbird's public client ID by default (no Azure app registration needed)
- Specific error message for Microsoft Outlook IMAP regression with link to FAQ
- "Sign in with Microsoft" button requires email before clicking and uses purple accent styling

## [1.1.0] - 2026-02-16

### Changed
- Emails now stored as standard .eml files (RFC 5322) in Maildir format
- Opening an email automatically caches it locally (download once, read forever)
- "Save locally" now archives emails with a Maildir flag
- Local view shows only explicitly archived emails
- Email file operations moved to Rust for better performance
- Extracted keychain parsing utilities to `src/services/keychainUtils.js` for testability
- Backup format changed from JSON blob to ZIP archive of .eml files for better performance and portability
- ZIP structure uses email addresses (not UUIDs) so backups are portable across installations
- Export/import now uses Rust for file operations (faster, handles large mailboxes)
- Export dialog lets you choose between "All Emails" or "Archived Only"
- Import automatically creates new accounts for unrecognized email addresses (user re-enters password in Settings)

### Added
- Maildir filename flags (Seen, Flagged, Replied, Archived)
- Raw email source always available for cached emails
- Automatic migration of existing saved emails to .eml format
- Unit tests for legacy keychain migration (`parseKeychainValue`, `getAccountsFromKeychain`, cleanup logic)
- GitHub Actions CI workflow — runs tests on push/PR to main
- "Open in New Window" — pop-out button in toolbar + custom right-click menu in email iframes, uses `WebviewWindowBuilder` to open a native Tauri window
- Email popup windows close normally (only main window hides to tray)
- `export_backup` and `import_backup` Tauri commands (Rust) for ZIP-based backup
- `src/services/backupUtils.js` with testable pure utility functions
- Unit tests for backup utilities (buildBackupEmailPath, matchAccountsByEmail, parseBackupManifest)
- Extracted `computeDisplayEmails` utility (`src/services/emailListUtils.js`) for testability
- Unit tests for display email computation — covers all view modes, local-only flag logic, edge cases (18 tests)
- Unit tests for state transitions — archive→delete→local-only flow, cache restoration, quick-load state (13 tests)
- Integration test for local-only flag detection — real IMAP flow: send → archive → delete from server → verify flag (4 tests)
- CI workflow now writes `.env.test` from GitHub secrets for integration tests
- `initBasic()` in db.js — lightweight init that skips keychain, used by quick-load

### Removed
- Session Cache settings from Settings page — redundant now that Maildir auto-caches every opened email to disk; in-memory cache still works silently with default limit

### Fixed
- Dark mode email text readability — force light text via inline `!important` on all elements (EmailViewer + ChatBubbleView)
- Logs no longer clear before confirmation — replaced `confirm()` with Tauri dialog `ask()` for proper async blocking
- Dynamic version display from package.json
- Export/import backup compatibility with new storage format
- Backup export now works in Tauri WebView (replaced broken blob download with native save dialog + Rust ZIP writer)
- Backup import now correctly restores all emails (previously silently skipped every email due to missing accountId/mailbox fields)
- "Open in New Window" now works on macOS — popup loads HTML from a temp file instead of eval on about:blank (WKWebView ignores eval before page ready)
- Email list no longer shows empty placeholder cells when scrolling — virtual scroll row count now matches loaded emails instead of server-reported total
- Email list no longer shows overlapping rows after switching accounts — email state fully cleared on account switch + virtual scroll container keyed by account ID
- Email list no longer shows overlapping rows after switching view modes — scroll position resets on view mode change + virtual scroll container keyed by view mode
- Delete confirmation no longer hides the email content view — replaced native `confirm()` dialogs with inline React modals in EmailViewer and EmailRow
- "Local only (deleted from server)" indicator now clearly visible — changed from tiny corner dot to amber-colored HardDrive icon; fixed local view mode to check server UIDs
- After deleting from server, email immediately shows as local-only — `emails` array updated synchronously before background refresh; cached headers on disk also updated to prevent `loadEmails` from restoring the deleted email
- Local-only flag now only appears for explicitly archived emails, not auto-cached ones
- Local view mode now correctly filters to show only archived emails (not all cached emails)
- No more black screen on app launch — quick-load uses `initBasic()` which skips keychain; shows cached emails + branded loading while keychain password prompt is active
