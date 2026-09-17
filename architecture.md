# MailVault Architecture

This document describes the stable architecture of the codebase and the design rules that should guide future changes. It is intentionally higher level than implementation notes in code.

## Goals

- Keep email data local and portable.
- The Tauri app is a thin shell; all heavy logic and actions run in the daemon, off the UI process, on their own threads.
- Keep the React layer focused on presentation, state coordination, and user workflow.
- Preserve feature parity across providers and views wherever practical.
- Prefer changes that improve resilience without obscuring control flow.

## System Overview

MailVault is a desktop application built from three runtime pieces: a React frontend, a thin Tauri v2 shell, and a Rust daemon sidecar that does the work.

- `src/`: React UI, Zustand stores, hooks, and browser-side service adapters.
- `src-tauri/src/`: the shell. Windows, native dialogs, OS integration, external-location authorization, spawning the daemon, and forwarding requests to it.
- `src-daemon/`: the daemon. Sync, fetch, send, delete, backup, archive, indexing, import/export, vault and cache writes.
- `src-core/`: shared Rust logic used by the daemon (and, during migration, the shell). Testable logic lives here.
- `website/`: marketing site and website API, kept separate from the desktop runtime.

The app is not a web app wrapped in Tauri, and the Tauri process is not the backend. Work happens in the daemon; the shell exists so the UI has a native window and a channel to the daemon.

Migration note: many Tauri commands still do real work from before this split. They are legacy, not precedent. New work goes to the daemon; an existing command that does real work moves to the daemon when it is touched.

## Architectural Boundaries

### Frontend

The frontend owns:

- Rendering and interaction flows.
- View-specific state and derived UI state.
- Coordination of async work through stores, hooks, and service adapters.
- User feedback, optimistic UI, and progress indicators.

The frontend should not:

- Reimplement transport or storage logic that belongs to the daemon.
- Encode provider-specific protocol behavior unless it is purely presentational.
- Scatter business rules across many components when they can live in a store or service.

### Tauri shell

The shell owns:

- Windows, menus, tray, notifications, and native dialogs.
- OS integration that must run in the app process.
- External file access authorization: security-scoped bookmarks on macOS, path validation on Linux (including Snap confinement detection). Long-lived access to user-chosen folders must be managed natively; the frontend renders state but does not own authorization. Filesystem features must degrade explicitly rather than silently dropping writes when access is lost.
- Daemon lifecycle (spawn, reconnect, shutdown) and forwarding requests and events between the frontend and the daemon.
- The settings JSON file (read before the daemon can be assumed to exist; a failed read followed by a save must not wipe it) and three narrow forwarders (`vault_apply_flags`, `vault_rename_mailbox`, `vault_adopt_mailbox_dirs`) that resolve the backup mirror's security-scoped bookmark, forward the call to the daemon with the resolved path, and release the bookmark once the daemon replies or the reply budget expires. The daemon cannot resolve a bookmark itself, so this one step of an otherwise daemon-owned operation stays in the shell; every rename, mirror copy and custody update the call triggers still runs in the daemon.

The shell must not do heavy work: no transport, no vault walks, no indexing, no bulk file I/O. A Tauri command is a forwarder to a daemon RPC, not an implementation. Apart from the settings file and the three bookmark forwarders above, the shell does not open or write a vault file, cache, journal or ledger directly, with a recorded exception, corrected at Task 3.9 (Phase 3) and narrowed again at Phase 4 (Task 4.9): `backup.rs` (the mirror sync and Graph/IMAP importers) and `commands.rs` (`graph_cache_mime`) still write a vault path directly, not behind the daemon's vault gate, so a vault move can race either of them. `main.rs` stays on this list too, but for a different reason now: its two Phase-4-era raw vault writers, the mbox importer (`import_mbox`) and the backup ZIP importer (`import_backup`), both moved into the daemon (Tasks 4.6 and 4.4) and are gone from `main.rs` as of this branch. What remains is `maildir_store_raw`, `commands.rs`'s `imap_get_email_light` auto-cache caller, which still calls `vault_files::store` directly from the app process; moving that caller into the daemon is Phase 5's job, not this phase's.

`archive.rs` belongs in that list too, but only through the path `backup.rs` still drives. Phase 3 moved the daemon's *own* `archive_emails` / `bulk_delete_emails` / `verify_archived_emails` routes into the daemon (Tasks 3.4-3.5), gated by `common::with_vault_write` in-process with no RPC bridge left at all, and the vault-writing body itself moved out of `src-tauri/src/archive.rs` into `mailvault_core::archive` (Task 3.2). But `backup.rs:797` still calls that same shared core runner in-process, through the app's `archive.rs` shim, which supplies a no-op gate (the daemon's `vault_gate` `RwLock` cannot cross the process boundary) - so the backup-driven archive path is exactly as ungated as before, even though the daemon's own archive route is not. `src-tauri/src/archive.rs` itself now contains no literal vault write at all (it only builds the core runner's context), which is why `tests/unit/vaultInDaemon.test.js`'s writer guard, which reads `src-tauri/src` file text, no longer names `archive.rs` - the guard and this paragraph are answering different questions (what does this directory's text write vs. what can the app still reach) and can disagree on purpose.

`restore.rs` comes off this list entirely: it reads local `.eml` files and re-uploads them over IMAP, and never writes the vault. Its earlier inclusion here was a misclassification, an ungated reader flagged as a writer, corrected at Task 3.9 (the same failure mode project memory already cites twice).

`tests/unit/vaultInDaemon.test.js`'s `ALLOWED_WRITERS` (still `backup.rs`, `commands.rs`, `main.rs`) keeps the real list of *message* writers closed. Since Task 3.9 its pattern also sees a raw `fs::write` / `fs::copy` into a vault path, not only a `vault_files::` call - the Graph backup writer (`backup.rs`) was never routed through `vault_files::`, so the old pattern was structurally blind to it; the mbox importer had the same shape before Task 4.6 moved it to the daemon. As of Phase 4 (Task 4.9, verified with a negative control: plant a raw write on `main.rs`, watch the assertion go red, revert, watch it go green), `main.rs` no longer trips the raw-write pattern at all - its one surviving writer, `maildir_store_raw`, goes through `vault_files::store` and is caught by the `vault_files::` pattern instead, so `backup.rs` alone now proves the raw-write pattern still catches something real. `src-tauri/src/vault.rs` sits outside this list on purpose, not by the guard's accident: `copy_tree`'s `std::fs::copy` (around line 332) and `set_aside_custody`'s `std::fs::rename` (around line 401) move the whole vault tree during a relocation, not an individual message, so `rename` never matches the guard's `fs::(write|copy)` pattern and `copy`'s call site carries none of the guard's `cur_dir`/`cur_path` markers - a structurally different operation, deliberately not folded into this message-writer list. Backup's own migration is deferred, blocked on a security-scoped bookmark probe Rokas has not yet run (see Known Gaps below); until it moves, this paragraph keeps its caveat for `backup.rs`, `commands.rs`, `main.rs`'s `maildir_store_raw`, and the app-invoked half of `archive.rs`.

### Daemon

The daemon owns:

- IMAP, SMTP, Microsoft Graph, OAuth2, and DNS mail-health operations, including sync, IDLE, and — as of Phase 5 — every interactive one-shot call the UI makes too (fetch, send, folder management, connection tests, autodiscovery). There is no longer a separate app-side IMAP/SMTP/Graph/OAuth2 client; `sync_engine.rs`'s calls and the RPC-routed interactive calls both go through the same `mailvault_core` functions and, for IMAP, the same pooled connections.
- Keychain credential reads for sync/IDLE (`resolve_account_credentials`, Phase 5 Task 5.1), alongside the app's own keychain read/write for the 3 commands tied directly to a UI action (`store_credentials`, `get_credentials`, `store_password` — add-account, settings; these stay app-local by deliberate scoping call, not oversight).
- The OAuth2 loopback callback listener (`127.0.0.1:19876`), relocated from the app process in Phase 5 Task 5.7; whether a sandboxed, separately-signed daemon child can actually bind that port under a signed build is unverified — see Known Gaps.
- All Maildir and `.eml` persistence: vault files, header and mailbox caches, the operation journal and pending operations, the Outlook uid ledger, custody, and the search index. Each opens and writes in exactly one process, the daemon, under a shared per-root gate that refuses while the vault is unreachable or being moved.
- MIME parsing and attachment access.
- Archive, restore, import/export, account migration, cleanup, and classification. Backup itself (the mirror sync and Graph/IMAP importers) has not moved yet and stays ungated in the app process; see Known Gaps.

Every long-running job runs on its own thread or worker, never on the RPC handling path, so one slow account, drive, or index pass cannot stall other requests. Jobs are resumable where practical (level-triggered reconciles, batched commits) and report progress as events; the frontend renders that progress and never computes it.

Daemon RPCs should expose cohesive operations. Prefer a small number of meaningful operations over many thin wrappers around internal functions.

### Website

The website is a separate surface area.

- Desktop app changes should not automatically force website changes.
- Website SEO, navigation, and generated changelog behavior belong to website-specific docs and scripts, not core application architecture.

## Core Data Model

The app is organized around a few durable concepts:

- Account: credentials, provider metadata, transport choice, and account-specific settings.
- Mailbox: server folder plus local cache metadata.
- Email header: list-level representation for loading, sorting, filtering, and threading.
- Email body: full parsed message content, loaded on demand or cached ahead of time.
- Local archive: Maildir-backed `.eml` files used for portability and offline access.

Maildir is the source of truth for locally saved email content. Cached JSON and in-memory state are performance layers, not the canonical archive format.

### Storage tiers

Two distinct locations, not one:

- **Vault (working copy)** — the mail the app reads and writes. Defaults to the app data dir; the user can relocate it to any folder. `src-tauri/src/vault.rs` owns resolution, folder verification and the copy-verify-delete offload; every mail-data path goes through `vault::root()`. Only mail data moves (`Maildir`, `maildir`, `email_cache`, `attachment_cache`, `mailboxes`, `search_index`, `custody`) — accounts, settings, logs, models and daemon bookkeeping stay in the app data dir so the app can boot and report an unreachable vault. When the vault cannot be resolved, mail-data commands fail rather than falling back to the app data dir, which would fork the archive.
- **External backup (cold storage)** — a second, independent copy written during backups and never read for day-to-day use. Managed by `src-tauri/src/external_location.rs`; both locations persist through the same security-scoped bookmark slot mechanism (`SLOT_VAULT`, `SLOT_EXTERNAL_BACKUP`).

The daemon resolves the vault independently from `<app_data_dir>/vault-meta.json` and keeps its own `app_dir` for logs, lock, models and classification state. A vault adopt/move/reset holds `DAEMON_SUSPENDED` (nothing may spawn a daemon onto a root mid-move), closes the daemon's search index and custody store together (`vault_close`), performs the move, then either stops the daemon so the channel respawns it on the new root, or, if the root did not change, reopens both in place (`vault_reopen`) instead. Every vault-rooted RPC route refuses while this gate is held, rather than falling back to reading or writing under the app data dir.

Custody opens once at daemon startup, before the socket is bound, so its startup status event always predates the daemon's first possible subscriber and is dropped by design: not a race, an invariant. The frontend instead re-queries custody status on every `daemon-reconnected` event (fired on the first connection too, and again after any respawn), which is therefore the one channel that actually carries this state, not a patch over a race window.

### Transfer accounting

`mailvault_core::transfer_stats` counts wire bytes per account: a `CountingStream` wraps the TCP/TLS stream inside `connect_transport`, below COMPRESS=DEFLATE, so compression savings are reflected. Counters are process-global, keyed by account email (the only identity `ImapConfig` carries), and flushed every 30s — plus on shutdown — into `<app_data_dir>/transfer_stats/{account_id}.{app|daemon}.json`. Each process writes only its own file, so the app and the daemon never contend; readers sum both. The daemon's optional soft daily cap reads its per-account limits from the app's persisted settings blob (`frontend-settings.json`) and skips `sync_account` once the day's allowance is spent.

## Data Flow

The common flow is:

1. React initiates an action through a store or service adapter.
2. The adapter calls a Tauri command, which forwards to a daemon RPC.
3. The daemon performs transport or filesystem work on a worker thread.
4. Results and progress events flow back through the shell and are normalized into frontend state.
5. Components render derived state rather than owning duplicated business logic.

This means:

- Components should stay thin.
- Stores should own cross-screen state transitions.
- Services should encapsulate integration details.
- The daemon should own protocol and persistence details; the shell only forwards.

Daemon-owned commands (listed as `DAEMON_OWNED` in `src/services/transport.js`) go straight to `daemon_rpc` under their own names instead of the request/response flow above. They never fall back to `invoke`; an unreachable daemon rejects with `errors.daemonUnavailable`. Every vault file read or write, header and mailbox cache access, journal and pending-operation update, Outlook uid allocation, and custody read or write is one of these: the daemon performs the disk work under the per-root gate described above, and the shell never opens the underlying file.

Three vault operations are the deliberate exception: `vault_apply_flags`, `vault_rename_mailbox` and `vault_adopt_mailbox_dirs` stay ordinary Tauri commands (not `DAEMON_OWNED`) because only the shell can resolve the backup mirror's security-scoped bookmark. Each resolves the bookmark, forwards the call to the daemon with the resolved path added as a parameter, and releases the bookmark once the daemon replies or the reply budget expires, on every path including a daemon error. Because they bypass the `DAEMON_OWNED` mapping, a daemon-side failure reaches these three callers as a raw error code rather than a translated message.

As of Phase 3 (Tasks 3.4-3.7), the daemon owns archive, bulk delete, verify and Mail Insights end to end: their own RPC routes, their own cancel-token registry, no bridge call to the app for any of it. Insights moved whole, including its snapshot map, 300s expiry and 30s sweeper; its custody reads are in-process now, and the `custody_entries_for_account` bridge route it used to call is deleted with it.

Backup has not moved, and still reaches custody and the mirror-bookmark rename the way it always has, through the same bridge: `backup.rs` calls `local_index_append` over RPC after a save (the same call the app's `archive.rs` shim makes on backup's behalf, since backup still drives that shim's code path), and calls `vault_apply_flags` directly by RPC for the mirror-bookmark rename, bypassing the frontend's three forwarders (its own bookmark resolution spans the whole run, not one call, an incompatible lifetime the forwarders don't have). So `local_index_append`'s bridge survives even though its insights caller is gone: it is not a second custody API, it is backup's own bridge now, and it is not deleted until backup itself moves into the daemon (see Known Gaps).

As of Phase 5 (Tasks 5.1-5.9), the daemon owns the network layer end to end: interactive IMAP (20 commands, 6 of which duplicate a call `sync_engine.rs` already made — rerouted to a thin daemon RPC over the same `mailvault_core::imap` function rather than deleted, since real one-shot callers outside the sync loop still need them), SMTP (4, after the client itself relocated into `src-core` in Task 5.3), Microsoft Graph (12; the 13th, `graph_get_mime`, had 0 callers and was deleted outright), OAuth2 (3, plus the loopback listener itself), and DNS mail-health (2). None of these have an app-side Tauri-command twin left; `src-tauri/src/smtp.rs` and `src-tauri/src/dns.rs` (both once kept as thin re-export shims for an in-process app caller that no longer exists) are deleted outright. `sync.now`/`sync.watch`'s payload no longer carries credentials at all (see Known Gaps); every other migrated command still accepts credentials as an RPC param exactly as before, unchanged shape. `store_credentials`/`get_credentials`/`store_password` are the one deliberate exception to "network work moves to the daemon" — OS keychain calls triggered synchronously by a UI action, not background work, kept app-local by scoping call rather than migrated for the sake of uniformity.

A second, long-lived channel (`src-tauri/src/daemon_channel.rs` ↔ `src-daemon/src/channel.rs`) carries two things outside the request/response flow: daemon bus events (e.g. `search-index-progress`), re-emitted by the shell as Tauri events for the frontend to render; and app → daemon fire-and-forget notifications (`search_index.nudge {accountId, mailbox}` from every vault writer, `search_index.sweep_soon`), dropped while disconnected and recovered by a `sweep_soon` sent on every (re)connect. The daemon starts unconfigured on each spawn, so the frontend re-pushes its effective index config on `daemon-reconnected`.

## Known Gaps

Deliberately deferred or unresolved boundary issues, not a bug tracker; keep this list short and re-read it before touching the areas it names.

- **Backup stays in the app.** `backup.rs` (mirror sync, Graph/IMAP importers) is unmoved and ungated, blocked on an unresolved question: `resolve_external_location`'s `start_access` (`external_location.rs:404`) rebuilds a plain `fileURLWithPath:` from the resolved bookmark's path string rather than starting scope on the security-scoped URL itself - the same defect `open_in_finder_inner` was fixed for, but that fix (`c393c14c`) never touched the call site `backup.rs:85` actually uses. Whether this silently no-ops in production is unverified and needs a signed-build test; if the bookmark scope was never load-bearing to begin with, the entire broker-vs-daemon-restart architecture choice for moving backup into the daemon is moot. Its bookmark lifetime also already diverges from the three `vault_flags.rs` forwarders (spans the whole run, not one call); moving it has to resolve that too, not just relocate the code.
- **Two `ImapPool`s per account, changed shape but not closed by Phase 5.** Before Phase 5, the daemon's archive/bulk routes used the daemon's own pool while the app's separately-managed pool served interactive IMAP, up to 10 concurrent connections per account combined (two 5-permit semaphores). Task 5.4b deleted that app-managed pool entirely — every interactive IMAP command is now a daemon RPC sharing the daemon's own `Arc<ImapPool>` (the same instance `SyncEngine` uses, confirmed by `imap_disconnect` now clearing sync's pooled sessions too, a small but real behavior change from before). What Phase 5 did *not* close: `backup.rs`/`archive.rs` (the still-unmoved backup path, see the gap below) construct their own separate `ImapPool` — one shared process-global instance via `backup.rs`'s `OnceLock` (`pool()`/`pool_if_started()`), not three independent ones, but still a second pool from the daemon's. So the gap is real but narrower: not "app interactive commands vs. daemon", but "backup/archive's own pool vs. everything else", and it closes only when backup itself moves into the daemon.
- **Daemon RPC handling is serial per connection.** `archive_emails` / `bulk_delete_emails` await their run inline inside the server's per-connection request loop; `cancel_archive` only reaches a different in-flight run because `rpc_attempt_inner` opens a fresh socket per call. If RPCs are ever multiplexed over one connection, a cancel could deadlock behind the run it is meant to cancel.
- **Insights snapshot state does not survive a daemon restart.** Snapshots used to live in the app process; now they die with the daemon, so a `snapshotExpired` error mid-load has no automatic retry. Recoverable today by reopening the panel; rare.
- **Insights daemon replies are not byte-identical to the pre-migration shape.** Structured failures round-trip as `Ok({ok:false, error:{...}})` because `daemon_rpc` cannot carry a structured `Err` (Task 3.7 decision); `ok:true` also now leaks into success payloads that never had that key before, and whether that is permanent has not been decided. The JS-side unwrap of a failure reply is covered by the daemon's wire-shape tests, not by a dedicated JS unit test.
- **The archived-ids map has more bypass writers than Task 3.8 closed.** `messageListSlice.js`'s `_archivedIdsByGroup` is fed by 5 named writers, plus 3 more (`activateAccount.js`, `AccountPipeline.js`, `messageMutations.js`) fixed in a follow-up round after review found they could stale-narrow the map. Still open: `messageMutations.js:158-160` and `:425-431`, `loadEmails.js:170-187` (main path) and `:809-817` (Graph path), and a related optimistic-update desync in `localDrafts.js` all still write `archivedEmailIds` directly on a successful read without feeding the map - the same latent-stale-map shape, not yet fixed. Two comments are stale in the meantime: `messageListSlice.js:88-94` and `archivedIdsPerGroup.test.js:216-220` still say `activateAccount.js` writes "outside the map", which the follow-up round already fixed.
- **A live-bridge-object mismatch recurs at the transport boundary.** `withGlobalTauri: true` injects two separate `invoke` objects (`window.__TAURI__.core.invoke` vs. the ESM import from `@tauri-apps/api/core`); code that resolves the ESM one at module load time can silently miss a test fixture (or a future feature) that only patches the global. Fixed once in `src/services/transport.js` (`c85770c1`) and once in `src/services/daemonClient.js` (`61c75c11`) by preferring the live global. Any new module that calls `invoke` directly should check which one it is reading.
- **`backup_migrate_legacy_path` stays a Tauri command, not a daemon gap.** Phase 4 (Task 4.9) excluded it deliberately, not by oversight: unlike every other Phase 4 command, its `legacy_path` argument is read from a persisted settings value (`useSettingsStore.getState().backupCustomPath`), not a fresh picker result, and the function it calls (`external_location::migrate_legacy_path`) mints and validates a security-scoped bookmark slot (`SLOT_EXTERNAL_BACKUP`) - squarely the shell's permanent, sandbox-mandated bookmark responsibility, the same bucket `backup_resolve_external_location` already sits in. Recorded here so a future phase does not rediscover it as a gap.
- **A daemon restart mid-OAuth2-flow loses the pending exchange (Phase 5, Task 5.7).** `OAuth2Manager` moved from the app's `.manage(...)` into `DaemonState` (one instance for the daemon's whole lifetime, same shape as `imap_pool`), so its in-memory `pending`/`senders` maps — populated by `oauth2_auth_url`, redeemed later by `oauth2_exchange` once the user finishes in the system browser — now live in the daemon, not the long-lived app process. Before this move the app never restarted mid-flow; now, a daemon crash, forced respawn, or vault-move-triggered restart between "Sign in" and the provider's redirect drops the pending state, and the browser's eventual callback either hits an empty map (if the port rebinds) or a "No pending OAuth flow for this state" error. Same category as the migration-restart gap below: not fixed (would need persisting pending flows to disk keyed by state token, or the JS side detecting the failure and cleanly restarting `oauth2_auth_url`), a direct and foreseeable consequence of this relocation rather than a pre-existing issue.
- **OAuth2 loopback binding under a sandboxed daemon is unverified.** `com.apple.security.network.server` was added to `src-daemon/entitlements.plist` (Task 5.1) so the daemon can bind `127.0.0.1:19876` for the OAuth2 callback (Task 5.7 moved `OAuth2Manager` construction there). Whether a separately-signed, `app-sandbox`-entitled child process can actually bind a *listening* socket under a real signed, notarized build is unknown — the earlier P0.1 sandbox-inheritance probe covered file access and SCM_RIGHTS fd-passing, never a listening bind. `scripts/probe-oauth2-loopback.py` (Task 5.7) is a standalone, zero-GUI script that verifies this against an already-launched signed build: it speaks the daemon's JSON-RPC-over-Unix-socket protocol directly, calls the real `oauth2_auth_url` RPC (no network call, just requests the bind), polls a TCP connect to `127.0.0.1:19876`, and cross-checks the accepting PID against the daemon's own pid file. Same category as the still-open backup-bookmark-scope probe — Rokas needs to run it himself; if it comes back FAIL, the documented fallback is reverting Task 5.7's RPC-routing changes and keeping `OAuth2Manager` in the app (every other Phase 5 task is unaffected either way).
- **Migration does not survive a daemon restart mid-run.** `start_migration`/`resume_migration` register their cancel/pause/notify tokens in `DaemonState.run_tokens`, an in-memory map, and the run itself is a bare `tokio::spawn`ed task; a daemon restart drops the process and everything the run held, with only the last-saved `migration_state.json` checkpoint (written once per completed folder, plus once on pause) surviving. Nothing in the daemon's startup sequence scans for or relaunches an interrupted migration - the app must notice and issue a fresh `resume_migration` RPC itself. Recovery is folder-granularity, not message-granularity: a folder that was mid-flight when the daemon died restarts from its own beginning (safe, since Message-ID dedup against the destination skips messages that already landed, but not free - already-copied messages are re-fetched from the source and only then recognized as duplicates). Unchanged from the app's own pre-Phase-4 behavior; Task 4.7 neither improved nor worsened it, this is simply the first time it is stated explicitly in project docs.
- **Migration pause does not always persist a checkpoint, and resume can drop a completed folder.** `pause_migration`'s flag is checked in two places: at the top of each folder's loop, where it correctly builds and saves a `MigrationState{status: "paused", ...}`, and inside the per-message copy loop (`interruptible_sleep`), which blocks correctly but never calls `save_migration_state`. A pause requested mid-folder therefore halts the run (safe) but leaves `migration_state.json` not reflecting `"paused"` until the next folder boundary, if one is ever reached. Separately, `resume_migration` rebuilds its run from `loaded.folder_mappings.into_iter().filter(|f| f.status != "completed")`, so a folder that finished between the pause request and the loop's next top-of-loop check is silently absent from the resumed run's own tracked state (harmless in practice only because destination-side Message-ID dedup means nothing is re-copied, but the resumed run's own progress count undercounts what actually happened). The original paused task is also never torn down when a fresh run starts, again harmless only due to the same dedup. Found during Task 4.10's e2e work while writing a pause/resume assertion against the real behavior; not fixed in Phase 4, since it predates this phase's own scope (pause/resume logic itself was not touched, only relocated).
- **`ImportResult.newAccounts` is a permanent, not transitional, deviation from the byte-identical-payload rule.** Every other Phase 4 command's JSON payload matches its pre-migration Tauri shape exactly. `import_backup`'s `newAccounts` field changed from `string[]` (bare emails) to an array of `{id, email, imapServer, smtpServer, createdAt}` objects, because the daemon route reads `accounts.json` but deliberately never writes it (that file already has an independent writer, `src/services/db/accounts.js`, and a second, uncoordinated daemon writer would turn a same-process race into a cross-process one). The app merges these descriptors into `accounts.json` itself, through `ensureAccountsInFile`. This is a permanent shape, not a migration artifact meant to be reconciled back to a bare string array later.
- **`sync.now`/`sync.watch`'s payload no longer carries credentials — permanent, not transitional (Phase 5, Task 5.2).** `toSyncAccount` (`src/services/syncService.js`) used to put `password` and `oauth2AccessToken` on `imapConfig`; it now sends eleven fields instead of thirteen, dropping both. The daemon resolves them itself, per request, via `credentials::resolve_account_credentials(account_id)` (`src-daemon/src/credentials.rs`, added Task 5.1) — the one call site in the daemon that reads the shared `com.mailvault.app`/`credentials` keychain entry the app writes (or the `MAILVAULT_TEST_CREDENTIALS` debug-only file bypass), parses that account's stored JSON, and fills `imap_config.password`/`access_token` before the request reaches `sync_engine`/`idle_watch`. `sync.watch`'s account is captured wholesale by its IDLE task for the life of the watcher, including every reconnect (`idle_watch.rs` `run`) — it does not re-resolve credentials per connection, so `handle_sync_watch` must populate the real password/token before calling `state.idle.watch()`, the same way `handle_sync_now` does before `sync_engine.run_ticket`. Every other daemon command is unaffected: `store_credentials`/`get_credentials`/`store_password` (interactive keychain read/write tied to a UI action — add-account, settings) stay in the app shell, per the Phase 5 scoping call, and keep accepting/returning credentials exactly as before.

## State Management Guidelines

Use Zustand stores for durable app state shared across screens and workflows.

- Put long-lived state, cache coordination, and async orchestration in stores.
- Put component-local concerns in React component state.
- Put reusable side-effect orchestration in hooks.
- Put integration wrappers in `src/services/`.

Avoid:

- Duplicating the same source of truth across multiple stores.
- Hiding critical state transitions in deeply nested components.
- Mixing transport calls directly into presentational components.

Settings window lifetime is owned by `useSettingsWindow`: closed, open, or minimized. Generic open actions resume the same session; an explicit page/account/section link creates a new navigation request. Minimized Settings keeps its component tree and scroll containers mounted inside an inert dialog, while releasing focus trapping and pausing page-level keyboard listeners. Closing ends that session. This is transient UI state, not persisted account or preference data.

### Mailbox Explorer

`EmailList` switches between the existing list and `ExplorerView`. `utils/explorer` derives date, sender and conversation groups from the current loaded headers; groups never create mailboxes or move stored messages. Sender grouping uses normalized addresses and date grouping uses the local calendar. Group selection retains each message's account, mailbox and UID through the existing selection workflow.

Explorer owns its navigation, local header search, row virtualization and next/previous navigation. Settings persist its mode, date detail and bounded navigation paths per account, mailbox, storage view and grouping. Partial mailbox windows are identified in the UI and use the existing explicit load-more action. Email rows, state indicators, actions and the reader are shared with List.

Conversation groups use RFC relationships with subject fallback disabled and thread IDs qualified by account. Counts and selections stay inside the browsed date/mailbox scope; the full conversation action can include loaded messages outside that scope, including Sent. Explorer supplies its own thread map to refresh an open conversation even in Date/Sender mode. The legacy List thread refresh is inactive while Explorer owns the pane.

## Performance and Caching

### Mail Insights

Insights is a separate sidebar workspace. `insightsStore` owns shared filters, scan and query generations, drill-down, and a session-scoped worker. `insightsSession` reads native snapshot pages and transfers header copies to `insightsWorker` in batches of at most 1,000, yielding a task between batches. Staged builds publish atomically after all transfers complete; superseding or cancelled scans cannot replace the last complete model. The pure `utils/insights` model owns logical-message identity, direction events, calendar bucketing, sender ranking, and exact matching-message keys. Only validated display preferences persist. Headers and native snapshot handles are released when the workspace closes.

`src-daemon/src/insights.rs` (moved from `src-tauri/src/insights.rs` at Task 3.6) inventories the available header cache and Maildir metadata through the configured vault root. It exposes bounded pages with file/generation validation and explicit coverage; it never treats the current visible mailbox window as the full inventory. Provider receive dates and original sent dates retain provenance, and legacy fallback or missing dates remain disclosed. The enumerated file set is frozen for that scan; later arrivals appear on refresh. Changes to captured files, source metadata, UID generations, directory identity or vault/account context invalidate the whole snapshot rather than mixing generations. Directory timestamp changes from independent mail arrivals do not invalidate captured headers.

`openInsightsMessage` verifies a physical account/mailbox/UID locator and known identity evidence before using the existing reader. The ordinary reader is unmounted during an Insights visit; its previous selection is restored from current headers only when still valid. Choosing an ordinary account or folder discards that restoration. Insights chart browsing reads headers only; opening a matching message uses normal reader loading and mark-as-read behavior. Source, export, and reply actions keep the selected message's account and mailbox context.

### General caching rules

Caching exists to reduce latency, not to create alternate truth sources.

- Prefer fast restore plus background sync over blocking the UI.
- Keep cache invalidation rules explicit.
- Make background work cancelable or ignorable when user context changes.
- Optimize hot paths with measurement and clear ownership, not incidental memoization.

When adding caching, document:

- What is cached.
- What invalidates it.
- Whether stale data is acceptable temporarily.
- How recovery works if cache and server diverge.

## Reliability Rules

Mail flows are networked and failure-prone. Design for partial failure.

- Retry transient transport and keychain failures when appropriate.
- Preserve local data on failure; never trade correctness for convenience.
- Prefer degraded operation over hard failure where the user can still make progress.
- Avoid destructive writes that can silently drop existing local state.
- Treat account switching, offline mode, and provider-specific limitations as first-class scenarios.

## Provider Strategy

Provider-specific behavior should be isolated behind transport or configuration boundaries.

- General UI should work across providers.
- Special-case Microsoft Graph, OAuth provider quirks, and server capability differences in transport and service layers.
- Do not leak provider-specific branching into many unrelated components.

If a provider needs custom behavior, add it in the narrowest layer that can fully own it.

## Threading and View Consistency

Threading, sender metadata, and message indicators affect many views. When changing them:

- Keep list, thread, chat, and detail views semantically aligned.
- Prefer shared parsing and derivation utilities over view-specific reimplementation.
- Document intentional differences explicitly rather than letting them drift.

## File and Module Placement

Use these defaults:

- `src/components/`: rendering and interaction.
- `src/hooks/`: reusable UI-side orchestration.
- `src/stores/`: app state and workflow coordination.
- `src/services/`: external integration and domain helpers.
- `src/utils/`: pure helpers with minimal side effects.
- `src-tauri/src/`: shell code only: windows, platform integration, authorization, daemon forwarding.
- `src-daemon/`: daemon RPC handlers, workers, and job scheduling.
- `src-core/`: shared transport, storage, and domain logic. Put testable Rust here.
- `src-mock-imap/`: test-only crate. A scriptable IMAP server used by the Rust suites. Not shipped (`publish = false`, never a runtime dependency).

Before adding a new module, prefer extending an existing boundary if it keeps ownership clearer. Create a new top-level service or store only when it introduces a distinct responsibility.

## Change Guidelines

When making architectural changes:

- Prefer one clear owner for each business rule.
- Keep data contracts explicit between frontend and Rust.
- Avoid "temporary" parallel code paths unless there is a defined removal plan.
- Update docs when the architecture or core boundaries change, not for every small implementation tweak.

Good reasons to update this file:

- New subsystem or transport layer.
- State ownership changes across stores/services.
- Storage format or cache model changes.
- New cross-cutting reliability or provider rules.

Bad reasons to update this file:

- Renaming helpers.
- Tuning constants.
- Minor UI layout details.
- Adding one more command to an existing subsystem.

## Verification Expectations

Non-trivial changes should be verified at the layer they affect.

- Frontend state and pure logic: unit tests.
- Rust transport or storage behavior: Rust tests where practical, in `src-core/` (CI does not run `cargo test` on the `src-tauri` crate).
- IMAP client behavior, including server misbehavior: the mock server in `src-mock-imap`. Server quirks that caused a shipped bug (spliced keepalives, unparseable ESEARCH, truncated UID lists, stalled APPEND) belong here as a fault scenario, not as a live test — they cannot be reproduced on demand against a real provider.
- Cross-layer user flows: integration or end-to-end coverage when the risk justifies it.
- Live provider tests (`tests/integration/`) are a conformance canary against a real mailbox. They run on a schedule, not per push, and must not be the only coverage for any client behavior.

Architectural work is complete only when the new boundary is understandable and testable.
