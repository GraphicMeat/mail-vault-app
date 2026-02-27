# MailVault - Project Notes

## Architecture
- **Desktop app**: Tauri v2 (Rust) + React (Vite) + Zustand state management
- **IMAP/SMTP**: Native Rust via `async-imap` + `lettre` crates — all email operations run in-process via Tauri `invoke()` commands (no sidecar)
- **Storage**: Maildir format — emails stored as individual `.eml` files on disk (not in a database)
- **EML support**: App reads/writes standard `.eml` files for email storage and import/export
- **Website**: Static HTML + Express API on Hostinger (`website/`)
- **Sandbox**: macOS App Sandbox is enabled — the app runs in a container (`~/Library/Containers/com.mailvault.app/`)
- **Background pipelines**: `EmailPipelineManager` singleton coordinates per-account `AccountPipeline` instances; active account runs content caching at concurrency=3, then cascades to background accounts (headers + content) at concurrency=1; `usePipelineCoordinator` hook bridges React lifecycle to the manager

## Background Caching Pipeline
- **Coordinator**: `src/services/EmailPipelineManager.js` — singleton `pipelineManager` manages all per-account pipelines
- **Per-account worker**: `src/services/AccountPipeline.js` — class with configurable concurrency, two phases: header loading (paginated) then content caching (concurrent `.eml` downloads)
- **React bridge**: `src/hooks/usePipelineCoordinator.js` — watches store state, starts/stops pipelines on account switch, handles offline/online
- **Cascade order**: Active account content (concurrency=3) + background headers (parallel, chunks of 3) → after active finishes, background content (concurrency=1, sequential)
- **Retry**: Failed UIDs queued for exponential backoff retry (3s → 120s cap), same as header loading
- **Credential helper**: `hasValidCredentials(account)` exported from `AccountPipeline.js` — shared by store and pipeline code
- **Old hook deleted**: `useBackgroundCaching.js` is gone — all background caching now goes through the pipeline manager

## OAuth2 Token Refresh
- **Module**: `src/services/authUtils.js` — shared `ensureFreshToken(account)` utility
- **Proactive refresh**: Tokens refreshed 5 minutes before expiry; deduplicated via module-level `_refreshPromise`
- **Call sites**: `loadEmails`, `markEmailReadStatus`, `performSearch`, `setActiveAccount`, ComposeModal SMTP send — all call `ensureFreshToken()` before IMAP/SMTP operations
- **Credential check**: `hasValidCredentials(account)` accepts both password and OAuth2 tokens; shared by store, pipeline, and search code

## Sidebar & Layout
- **Collapsible sidebar**: `sidebarCollapsed` boolean in settingsStore (persisted); collapsed = 56px icon-only strip, expanded = 256px (w-64)
- **Toggle**: `PanelLeftClose` / `PanelLeftOpen` Lucide icons in sidebar header/footer
- **App.jsx**: `sidebarWidth` in resize handler is dynamic based on `sidebarCollapsed`
- **Account avatars**: Colored circles with initial letter(s) instead of generic User icon; deterministic color from email hash via `getAccountColor()`, user override via `accountColors` map in settingsStore
- **Avatar helpers**: `getAccountInitial(account, displayName)` and `getAccountColor(accountColors, account)` exported from `settingsStore.js`; `AVATAR_COLORS` palette of 10 distinct colors
- **Per-account mailbox memory**: `lastMailboxPerAccount` in settingsStore; `setActiveAccount` restores last folder, `setActiveMailbox` persists selection
- **Non-selectable folders**: `noselect` field on `MailboxInfo` struct; sidebar expands children on click instead of SELECT

## Email Threading
- **Algorithm**: Simplified JWZ — `buildThreads()` in `src/utils/emailParser.js`
- **RFC headers**: `In-Reply-To` (from IMAP ENVELOPE) + `References` (fetched via `BODY.PEEK[HEADER.FIELDS (References)]`) used to build parent-child chains
- **Thread root**: First Message-ID in `References` array = thread root; falls back to `In-Reply-To` chain walking, then normalized subject
- **Subject fallback**: Single-email "threads" without RFC headers merged into existing threads with same normalized subject (two-pass to avoid iteration-order dependency)
- **Cycle detection**: `findRoot()` tracks visited Message-IDs to prevent infinite recursion on malformed headers
- **`normalizeSubject()`**: Strips all levels of `Re:`, `Fwd:`, `FW:`, `Re[N]:` prefixes via loop (not just 2 passes)
- **Rust IMAP**: `EmailHeader` struct has `in_reply_to: Option<String>` and `references: Option<Vec<String>>`; all 4 IMAP fetch specs include `BODY.PEEK[HEADER.FIELDS (References)]`; `parse_references_header()` extracts `<message-id>` tokens
- **Regular list view**: `EmailList.jsx` groups emails into threads via `buildThreads()` — multi-email threads show as collapsed `ThreadRow` / `CompactThreadRow` with participant names, message count badge, latest date; single-email threads render as normal `EmailRow`
- **Chat view**: `ChatTopicsList` and `ChatBubbleView` use `buildThreads()` instead of subject-only `groupByTopic()`; navigation keyed by `threadId` (root Message-ID) not subject
- **Store**: `getThreads()` getter in mailStore calls `buildThreads(getChatEmails())` on merged INBOX + Sent emails; `selectedThread` state + `selectThread(thread)` method for thread conversation view
- **Thread conversation view**: `EmailViewer.jsx` renders `ThreadView` when `selectedThread` is set — all emails stacked chronologically, latest expanded by default, auto-scrolls to newest; each email has its own Reply/Reply All/Forward buttons and attachment section; uses `useChatBodyLoader` for progressive concurrent body loading (same as chat view)

## Account State Cache (Instant Switching)
- **Module-level LRU**: `_accountCache` Map in mailStore.js (max 5 entries), same pattern as `_mailboxCache`
- **Save**: Full email state saved on `setActiveAccount` (before switching) and at end of `loadEmails`/`loadMoreEmails`
- **Restore**: `setActiveAccount` checks cache first → if hit, restores all state instantly (no loading flash), fires background `loadEmails()` + `loadSentHeaders()` for silent sync
- **Invalidate**: On `removeAccount`, `clearEmailCache`, `refreshAllAccounts`
- **Fields cached**: emails, sortedEmails, localEmails, emailsByIndex, totalEmails, savedEmailIds, archivedEmailIds, loadedRanges, currentPage, hasMoreEmails, sentEmails, mailboxes, serverUidSet, connectionStatus, activeMailbox, lastSyncTimestamp

## Email Body Pre-fetch
- **Method**: `_prefetchAdjacentEmails(currentUid)` in mailStore — pre-fetches next 3 email bodies after selecting an email
- **Strategy**: Check emailCache → Maildir (db.getLocalEmailLight) → IMAP (api.fetchEmailLight); break on network error
- **Call site**: Fire-and-forget from `selectEmail` finally block

## Hide/Unhide Accounts
- **Store**: `hiddenAccounts` map in settingsStore with `setAccountHidden(accountId, hidden)` and `isAccountHidden(accountId)` methods
- **Sidebar**: Filters hidden accounts from the account list via `orderedAccounts.filter(a => !hiddenAccounts[a.id])`
- **Pipeline**: `isHidden()` guard in `EmailPipelineManager.js` prevents starting pipelines for hidden accounts; `restartBackgroundPipelines()` public method resumes background sync on unhide
- **Store integration**: `refreshAllAccounts` and `init` skip hidden accounts; hiding the active account switches to next visible; unhiding restarts pipeline immediately
- **Settings UI**: Toggle in Settings > Accounts with EyeOff indicator and dimmed avatar for hidden accounts

## Clear Cache
- **Settings UI**: "Clear Cache" button in Settings > General > Local Email Caching
- **Behavior**: Removes all cached `.eml` files and `headers.json` per mailbox; preserves archived emails (with `A` flag); restarts the sync pipeline after clearing

## Chat Body Loader
- **Hook**: `src/hooks/useChatBodyLoader.js` — progressively loads email bodies for header-only emails
- **Pattern**: Pre-populates from in-memory emailCache, then fetches missing bodies from Maildir → IMAP at concurrency=3
- **Per-bubble updates**: Each MessageBubble registers a per-uid listener; only that bubble re-renders when its body loads
- **Shared**: Used by both `ChatBubbleView` (chat view) and `ThreadView` (email list thread conversation view)

## Email List Styles
- **Settings**: `emailListStyle` in settingsStore — `'default'` or `'compact'`
- **Compact view**: `CompactEmailRow` component — 2-line layout (sender+date on line 1, subject on line 2), `ROW_HEIGHT_COMPACT = 52` vs `ROW_HEIGHT_DEFAULT = 56`
- **Cloud icon**: Uses `style={{ color: 'rgba(59, 130, 246, 0.5)' }}` instead of CSS opacity to avoid Retina double-compositing

## Native IMAP/SMTP (Rust)
- **IMAP crate**: `async-imap` 0.11 with `async-native-tls` for TLS and `compress` feature for DEFLATE — uses `async_std::net::TcpStream` (async-imap requires futures IO traits, not tokio IO)
- **SMTP crate**: `lettre` 0.11 with `tokio1-rustls-tls` — supports password + XOAUTH2 (Microsoft & Google OAuth2); from address uses `Mailbox::new()` for proper RFC 5322 formatting
- **Connection pool**: `src-tauri/src/imap/pool.rs` — two-pool design (`background` for pagination/caching, `priority` for user-initiated fetches); uses `tokio::sync::Mutex<HashMap<String, ImapSession>>`; caches server capabilities and tracks last-selected mailbox per connection
- **Session type**: `ImapSession = Session<Box<dyn ImapTransport>>` — type-erased stream allows both plain TLS and COMPRESS=DEFLATE sessions in the same pool
- **COMPRESS=DEFLATE**: Negotiated during `create_imap_session()` after auth when server advertises `COMPRESS=DEFLATE` capability; uses async-imap's built-in `session.compress()` method; falls back to plain TLS if negotiation fails
- **CONDSTORE delta sync**: `check_mailbox_status()` uses `SELECT CONDSTORE` when server supports it; `fetch_changed_flags()` uses `CHANGEDSINCE` modifier; `loadEmails()` in mailStore has 4-tier decision tree: (1) modseq+uidNext unchanged → zero IMAP calls, (2) modseq changed but uidNext same → flag-only sync, (3) uidNext changed → UID search delta-sync, (4) no CONDSTORE → existing behavior
- **ESEARCH**: `search_all_uids()` uses `UID SEARCH RETURN (ALL) ALL` when server supports ESEARCH for compact UID range responses; falls back to regular `UID SEARCH ALL`
- **UID range compression**: `compress_uid_ranges()` helper turns `[1,2,3,5,6,10]` into `"1:3,5:6,10"` for smaller IMAP commands; used in `fetch_headers_by_uids()` and `search_emails()`
- **Chunked UID FETCH**: `fetch_headers_by_uids()` chunks UIDs into batches of 200 to avoid IMAP command-length limits
- **Lean fetch spec**: Header loading uses `HEADER_FETCH_SPEC` (no BODYSTRUCTURE/RFC822.SIZE) for faster fetches; `HEADER_FETCH_SPEC_FULL` retained for search results
- **NOOP health check**: Pooled sessions verified with NOOP before reuse; stale sessions logged out and replaced
- **IPv4-only**: All IMAP/SMTP connections force IPv4 to avoid IPv6 hangs (especially with Outlook)
- **Commands**: `src-tauri/src/commands.rs` — 20 Tauri `#[tauri::command]` wrappers for IMAP/SMTP/OAuth2/Graph operations
- **Frontend API**: `src/services/api.js` — all functions use `tauriInvoke()` in Tauri mode, HTTP fallback in dev mode; includes `fetchChangedFlags()` for CONDSTORE
- **Tauri auto-naming**: Rust command parameters use `snake_case`; Tauri automatically maps from JS `camelCase` (e.g. `start_index` ↔ `startIndex`)
- **UID EXPUNGE**: Permanent deletion uses RFC 4315 `UID EXPUNGE` to only remove the targeted message
- **Bulk archive**: `src-tauri/src/archive.rs` — 3 concurrent email fetches via Tokio semaphore + IMAP priority pool

## Microsoft Graph API Transport
- **Module**: `src-tauri/src/graph.rs` — REST client for Microsoft Graph API v1.0
- **Purpose**: Alternative email transport for personal Microsoft accounts (outlook.com, hotmail.com, live.com, msn.com) where IMAP is broken due to a Microsoft server-side regression since Dec 2024
- **Auto-detection**: `is_personal_microsoft(email)` checks domain against known personal Microsoft domains; `oauth2Transport: 'graph'` stored on account
- **OAuth2 scopes**: Graph accounts request `Mail.ReadWrite` + `offline_access` instead of IMAP scopes; scope branching happens in `generate_auth_url()` via `use_graph` flag
- **Data structures**: `GraphMessage`, `GraphMailFolder`, etc. — serde deserialization from Graph JSON; `GraphMessage::to_email_header()` converts to standard `EmailHeader` struct
- **Client methods**: `list_folders()`, `list_messages()`, `get_message()`, `set_read_status()`, `get_mime_content()` — all via `reqwest` with Bearer token auth
- **Tauri commands**: `graph_list_folders`, `graph_list_messages`, `graph_get_message`, `graph_get_mime`, `graph_set_read`, `graph_cache_mime`
- **Store integration**: `mailStore.js` branches on `isGraphAccount()` in `loadEmails`, `selectEmail`, `markEmailReadStatus`, `loadSentHeaders`, `_prefetchAdjacentEmails`
- **Pipeline integration**: `AccountPipeline.js` branches header loading and content caching for Graph accounts; `graph_cache_mime` Rust command does fetch+store+parse in single IPC call
- **Graph ID mapping**: Module-level `_graphIdMap` in mailStore maps sequential UIDs to Graph message IDs for body fetches
- **Folder name mapping**: Graph uses "Inbox"/"Sent Items"/"Deleted Items" → normalized to IMAP-style "INBOX"/"Sent"/"Trash"

## Email Test Accounts (Hostinger)
- IMAP: `imap.hostinger.com` / SMTP: `smtp.hostinger.com`
- Account 1: `luke@forceunwrap.com`
- Account 2: `i-am-your-father@forceunwrap.com`
- Passwords stored in `scripts/signing-config.sh` (gitignored)

## Signing & Distribution
- Apple Developer Team ID: `YXDJG24NWG`
- Apple ID: `info@templateshero.com`
- Certificate: "Developer ID Application: MB Modernios Aplikacijos (YXDJG24NWG)"
- Tauri updater keys: `~/.tauri/mailvault.key` (password-protected)
- Signing config: `scripts/signing-config.sh` (gitignored, has all secrets)
- Local build script: `scripts/build-developer-id.sh` (builds, signs, notarizes, creates DMG + updater artifacts)

## CI/CD
- GitHub Actions: `.github/workflows/release.yml` (manual dispatch, universal macOS build)
- Creates draft GitHub release with DMG + updater `latest.json`
- Required GitHub secrets: APPLE_CERTIFICATE, APPLE_CERTIFICATE_PASSWORD, KEYCHAIN_PASSWORD, APPLE_SIGNING_IDENTITY, APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID, TAURI_SIGNING_PRIVATE_KEY, TAURI_SIGNING_PRIVATE_KEY_PASSWORD
- Optional GitHub secrets: MAILVAULT_MS_CLIENT_ID, MAILVAULT_MS_CLIENT_SECRET (overrides default Thunderbird public client ID for OAuth2)

## Website Hosting
- Hosted on Hostinger with Express (Node.js)
- Static files served from `website/` directory
- API server: `website/api/server.js`
- Database: MySQL on Hostinger (env vars: DB_HOST, DB_USER, DB_PASS, DB_NAME)
- DB_HOST must be `127.0.0.1` (not `localhost` — IPv6 `::1` causes access denied)
- Env vars are set in Hostinger deploy settings, written to `website/api/.env` at build time by `scripts/write-env.cjs`
- Features: "I Want This" voting, feature voting, newsletter subscription, contact form

## OAuth2 (Multi-Provider)
- **Providers**: Microsoft (Azure AD / Entra ID) and Google (Gmail) — both use PKCE authorization code flow
- **Implementation**: `src-tauri/src/oauth2.rs` — pure Rust, provider-agnostic `ProviderConfig` struct with per-provider constants
- **Flow**: Generate auth URL (with provider) → browser-based login → shared local TCP callback server receives code → exchange for tokens using provider-specific token endpoint
- **Callback server**: `http://localhost:19876/callback` — TCP server in Rust (`tokio::net::TcpListener`), shared across all providers, auto-started on first OAuth flow, auto-restarts on failure
- **Microsoft scopes**: `offline_access`, `https://outlook.office.com/IMAP.AccessAsUser.All`, `https://outlook.office.com/SMTP.Send`
- **Google scopes**: `https://mail.google.com/` (covers both IMAP and SMTP); uses `access_type=offline` + `prompt=consent` for refresh token
- **Microsoft client ID**: Defaults to MailVault's own Azure AD app (`d4e1c192-2c87-4aeb-b2d6-edbb91c577cd`) — public client, no secret needed; per-account custom client ID and tenant ID for corporate overrides
- **Google client ID**: Defaults to Thunderbird's public ID (`406964657835-aq8lmia8j95dhl1a2bvharmfk3t1hgqj.apps.googleusercontent.com`) — PKCE public client, no secret needed
- **Custom override**: `MAILVAULT_MS_CLIENT_ID` / `MAILVAULT_MS_CLIENT_SECRET` env vars for Microsoft (CI/build-time); per-account `oauth2CustomClientId` / `oauth2TenantId` fields for corporate users (runtime UI); `MAILVAULT_GOOGLE_CLIENT_ID` / `MAILVAULT_GOOGLE_CLIENT_SECRET` for Google
- **Token storage**: OAuth2 tokens stored in macOS Keychain as part of the account JSON object; `oauth2Provider` field identifies which provider ("microsoft" or "google")
- **Token refresh**: Access tokens expire in ~1 hour; refresh happens via `oauth2_refresh` Tauri command with `provider` parameter
- **XOAUTH2 SASL**: `user=<email>\x01auth=Bearer <token>\x01\x01` — same mechanism for both Google and Microsoft; implemented as custom `Authenticator` trait for async-imap, and via `Mechanism::Xoauth2` for lettre SMTP
- **IPv4 forced**: All IMAP/SMTP connections force IPv4 to avoid IPv6 hangs with Outlook
- **Timeout**: Each pending OAuth flow auto-expires after 300 seconds; `oneshot` channels connect callback server to `exchange_code`
- **Adding new providers**: Add a new match arm in `get_provider_config()` in `oauth2.rs`, add `supportsOAuth2: true, oauth2Provider: '<name>'` to `PROVIDER_CONFIGS` in `AccountModal.jsx`

### OAuth2 Implementation Notes (Reference: Pimalaya projects)
- **Himalaya** (https://github.com/pimalaya/himalaya/) — Rust email client with built-in OAuth2
- **Ortie** (https://github.com/pimalaya/ortie) — Standalone OAuth2 token manager CLI from same team
- Both use Thunderbird's public client ID `9e5f94bc-e8a4-4e73-b8be-63364c29d753` for Microsoft
- Both use `https://outlook.office.com/` scopes (NOT `outlook.office365.com`)
- No special audience handling needed — v2.0 Microsoft endpoint derives audience from scopes
- Personal Outlook.com accounts affected by Microsoft IMAP OAuth regression since Dec 2024:
  "User is authenticated but not connected" — server-side bug, not a client issue
  (https://learn.microsoft.com/en-us/answers/questions/5673167/)
- M365 Business/Enterprise accounts should work fine with OAuth2
- Fallback: App Password for personal Outlook.com accounts until Microsoft fixes the regression

## Bulk Archive (Rust Thread)
- **Module**: `src-tauri/src/archive.rs` — async archive runner on Tokio thread pool
- **Command**: `archive_emails` — takes UIDs, fetches via IMAP priority pool, writes .eml with `archived+seen` flags
- **Concurrency**: 3 concurrent fetches via `tokio::sync::Semaphore` + IMAP pool (each task gets its own session; old sessions logged out on pool return)
- **Progress**: Emits `archive-progress` Tauri events consumed by `BulkSaveProgress.jsx`
- **Cancellation**: `cancel_archive` command sets `AtomicBool` checked by workers; new `Arc` per run isolates runs
- **Frontend**: `saveEmailsLocally` in mailStore uses Tauri invoke when available, falls back to serial JS fetch in dev mode
- **Helpers**: `maildir_cur_path`, `build_maildir_filename`, `find_file_by_uid` in main.rs are `pub fn` for archive module access

## Storage Details
- **Maildir path**: `~/Library/Application Support/com.mailvault.app/maildir/<email>/INBOX/cur/`
- **EML naming**: `<uid>.eml` for auto-cached, `<uid>_<flags>.eml` for flagged (A=Archived, S=Seen, R=Replied, F=Flagged)
- **Headers cache**: `headers.json` per mailbox — cached email list for fast loading (quick-load)
- **Attachments**: Embedded in .eml as MIME parts, not stored separately; Rust parses MIME on demand
- **Quick-load flow**: App reads `headers.json` → shows cached list instantly → then does full IMAP init in background
- **Website sync**: Root `index.html` must be kept identical to `website/index.html`

## Key Commands
- `npm run dev` — Start dev (frontend only; IMAP/SMTP run natively via Tauri invoke)
- `npm run tauri dev` — Start dev with Tauri (full native IMAP/SMTP)
- `npm run tauri build` — Build desktop app (needs `source scripts/signing-config.sh` first for updater signing)
- `bash scripts/build-developer-id.sh` — Full production build with signing, notarization, DMG, updater artifacts
- `bash scripts/bump-version.sh <patch|minor|major>` — Bump version in package.json, Cargo.toml, tauri.conf.json
- `node scripts/generate-changelog.cjs` — Regenerate `website/changelog.html` from `CHANGELOG.md`

## Important Notes
- Bundle identifier `com.mailvault.app` ends with `.app` (Tauri warning, non-blocking)
- App uses `app.html` not `index.html` — window config has `"url": "app.html"`
- Window close hides to tray (not quit) — dock icon reopen handled via `RunEvent::Reopen`
- Updater checks GitHub releases: `https://github.com/GraphicMeat/mail-vault-app/releases/latest/download/latest.json`
- Do NOT add Co-Authored-By to git commits
- Root package.json has `"type": "module"` — scripts using `require()` need `.cjs` extension
- NEVER reveal hosting provider details (name, URLs, hostnames) in any output, commits, or code comments
- Root `index.html` is the file actually served by the hosting — keep it in sync with `website/index.html`
- Keep this CLAUDE.md updated when making any big or breaking changes (new features, architectural shifts, storage format changes, new dependencies, etc.)
- After any significant app changes (new features, UI overhauls, major fixes), ask the user if they want to update the repo README and the website (`website/index.html`, `website/faq.html`) to reflect the changes
- Automatically update `CHANGELOG.md` for any bigger changes (new features, bug fixes, improvements) — do not ask, just do it
- New CHANGELOG entries always go under the `## [Unreleased]` section at the top — never create a new version heading manually
- When adding new CHANGELOG entries under `[Unreleased]`, consolidate with existing unreleased entries where possible — combine related fixes into fewer lines, avoid repeating the same area (e.g. merge multiple OAuth2 fixes into one bullet), keep it concise for the eventual release
- Do NOT run `node scripts/generate-changelog.cjs` after updating CHANGELOG.md — the bump-version script handles it automatically
- To bump versions, use `bash scripts/bump-version.sh <patch|minor|major>` — updates package.json, Cargo.toml, tauri.conf.json, moves `[Unreleased]` to the new version tag in CHANGELOG.md, and regenerates `website/changelog.html`
- CHANGELOG.md is for app changes only — do NOT include website-only changes (website/faq.html, website/index.html, etc.)
- Any website feature or page change must be SEO-friendly: use proper semantic HTML, structured data (JSON-LD schema), meta tags (title, description, og, twitter), and keyword-rich content; update the `SoftwareApplication` schema featureList when adding new app features to the website
- After every version bump, update the "What's New?" section in `website/index.html` (and sync root `index.html`) — replace the summary text and version reference with a brief summary of the new release's highlights from the changelog


## Workflow Orchestration
### 1. PLan Node Default
- Enter plan mode for ANY non-trivial task (3+ steps or architectural decisions)
- If something goes sideways, STOP and re-plan immediately - don't keep pushing
- Use plan mode for verification steps, not just building
- Write detailed specs upfront to reduce ambiguity
### 2. Subagent Strategy
- Use subagents liberally to keep main context window clean
- Offload research, exploration, and parallel analysis to subagents
- For complex problems, throw more compute at it via subagents
- One tack per subagent for focused execution
### 3. Self-Improvement Loop
- After ANY correction from the user: update 'tasks/lessons.md" with the pattern
- Write rules for yourself that prevent the same mistake
- Ruthlessly iterate on these lessons until mistake rate drops
- Review lessons at session start for relevant project
### 4. Verification Before Done
- Never mark a task complete without proving it works
- Diff behavior between main and your changes when relevant
- Ask yourself: "Would a staff engineer approve this?"
- Run tests, check logs, demonstrate correctness
### 5. Demand Elegance (Balanced)
- For non-trivial changes: pause and ask "is there a more elegant way?"
- If a fix feels hacky: "Knowing everything I know now, implement the elegant solution"
- Skip this for simple, obvious fixes - don't over-engineer
- Challenge your own work before presenting it
### 6. Autonomous Bug Fizing
- When given a bug report: just fix it. Don't ask for hand-holding
- Point at logs, errors, failing tests - then resolve them
- Zero context switching required from the user
- Go fix failing CI tests without being told how
## Task Management
1. **Plan First**: Write plan to tasks/todo.md" with checkable items
2. **Verify Plan**: Check in before starting implementation
3. **Track Progress**: Mark items complete as you go
4. **Explain Changes**: High-level summary at each step
5. **Document Results**: Add review section to "tasks/todo.md
6. **Capture Lessons**: Update "tasks/lessons.md"after corrections
## Core Principles
- **Simplicity First**: Make every change as simple as possible. Impact minimal code.
- **No Laziness**: Find root causes. No temporary fixes. Senior developer standards.
- **Minimat Impact**: Changes should only touch what's necessary. Avoid introducing bugs.
