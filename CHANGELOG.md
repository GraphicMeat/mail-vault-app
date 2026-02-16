# Changelog

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
