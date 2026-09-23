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

#### Atomic UI design and reuse

Build UI from the smallest useful shared units, then compose them into workflows:

- **Atoms** in `src/components/ui/` own one control or visual rule: buttons, searchable selects, segmented choices, labels, and accessible input states. Use one atom for the same interaction across Settings and the rest of the app.
- **Molecules** combine atoms into one understandable choice. `SettingsField` joins a visible label and explanation to a control; `SettingsSection` groups related fields with the shared settings card rhythm. Their layout and responsive behavior belong to the molecule, not each feature page.
- **Organisms** own a complete task with state and feedback, such as an Auto Tag rule editor, a saved View editor, or a message preview. They consume the shared controls and keep feature-specific rules in their store or service.
- **Templates and pages** arrange organisms in the Settings window, message list, or compose window. A page chooses the reading order and where a preview appears; it should not copy the atoms' CSS or recreate their keyboard behavior.

Reuse is an ownership rule, not a requirement to make every control generic. When two surfaces need the same behavior, extend the existing shared component and update both callers. When their behavior differs, keep two clear components. New settings flows should use the established 920px reading width, settings sections, field labels, and preview placement. Preview data stays local to its editor and never repaints the active mail list. A detached window is another host for the same page component, not a second implementation of that page; the main window remains the owner of persisted settings and receives explicit changes from the detached host.

Notifications are decided in exactly one place: `notify()` in `src/stores/focusStore.js`, which `notifyChokepoint.test.js` enforces — a caller reaching past it into `services/api.sendNotification` is a banner that fires through a Focus session's hold. The policy itself is a pure function (`src/utils/notificationPolicy.js`) applied there, in order: a Focus session, the global switch, the important-sender allowlist, quiet hours, view mutes, then account and folder mutes. Every decision is recorded with the rule that made it, delivered or suppressed, so a notification that never arrived can be accounted for. Deciding whether to raise a banner is shell work and stays in the app, with one exception: when the daemon's keychain gate closes and no app has the event channel open, the daemon posts its own "unlock your keychain" banner (see the keychain gate under Daemon), because there is no app to decide anything.

The frontend owns:

- Rendering and interaction flows.
- View-specific state and derived UI state.
- Coordination of async work through stores, hooks, and service adapters.
- User feedback, optimistic UI, and progress indicators.

Open compose windows keep a separate UI-session snapshot through `safeStorage`, alongside persisted preferences. App restores these snapshots as minimized draft bubbles after storage hydration. The snapshots retain editor fields, attachments, sending identity and reply context; the existing local-draft service still writes the message itself into the vault through the daemon. Sending or discarding a compose window removes its session entry.

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
- **Keeping the daemon alive across app quit and login** (`src-tauri/src/autostart.rs`, pure parts in `mailvault_core::autostart`). One setting, `daemonAlwaysOn`, drives two things: `RunEvent::Exit` skips the daemon SIGTERM so the running daemon is adopted by init, and a per-platform login item brings it back at login. `stop_daemon()` (vault moves, restarts) is unaffected; only the app-quit path is gated.
  - macOS registers through `SMAppService`. **Currently unproven and not working on a signed build**: `register()` fails with "Operation not permitted". The cause is not the app being sandboxed — Microsoft Teams is sandboxed and registers bundled agents fine — but the agent's *program*. A sandboxed app may not ask launchd to run a binary that is not itself sandboxed, because that escapes the app's sandbox, and `src-daemon/entitlements.plist` deliberately carries no `app-sandbox` key. Teams signs its agents `app-sandbox` + `application-groups` and puts them in `Contents/Library/LaunchAgents/`.
  - Fixing that is coupled to *where the app and daemon meet*. A sandboxed helper gets its **own** container (`~/Library/Containers/com.microsoft.teams2.agent` exists beside `com.microsoft.teams2`), so a sandboxed daemon would lose both `~/.mailvault` and `~/Library/Application Support/com.mailvault.app`, which today it only sees by inheriting the app's sandbox when the app spawns it. One binary cannot do both: without `inherit` it gets its own container, with `inherit` launchd cannot start it. The meeting point has to become the `group.com.mailvault` container (`core::group_container_dir`; a socket there is 76 bytes, under the 104-byte `SUN_LEN` cap) — a migration, so it is deliberately not done yet.
  - `src-agent-probe/` is a throwaway crate that answers both questions on a signed build before anything is migrated: a ~20-line sandboxed agent registered from the Help menu ("Probe: Background Agent Registration"), which writes one line into the group container. Registration clearing EPERM proves the diagnosis; the line appearing proves a launchd-started agent can reach the group container. **Delete the crate, its plist, its signing block in `scripts/build-developer-id.sh` and the menu item once the daemon itself runs as the agent.**
  - Two further facts cost a signed build each: **the agent label must sit under the app's bundle id** (`com.mailvault.app.daemon`, not `com.mailvault.daemon`) or macOS answers `NotFound`; and the App Store sidecar is signed `com.apple.security.inherit`, which aborts unless its sandboxed parent spawned it. `NotFound` is reported as "unsupported" only when the plist is genuinely absent — when it is present the switch stays live so `register()`'s NSError surfaces, which is the only reason the EPERM was ever seen.
  - Until this lands, the shipped behaviour is the half that works everywhere: the daemon outlives app quit. Nothing brings it back at login on macOS.
  - Linux writes an XDG autostart `.desktop`. Its `Exec=` names the *app* binary with `--daemon-only` (a launcher mode handled before any window exists), because the sidecar's own path depends on the packaging and an AppImage's mount root does not survive a reboot — `$APPIMAGE` is used there. Snap is refused with a reason rather than attempted: `~/.config/autostart` is outside the `home` interface.
  - Windows uses the `HKCU` Run key. Unreachable today — the daemon's IPC is a Unix socket, so no Windows build runs it — and present so the switch is wired when that changes.
- The settings JSON file (read before the daemon can be assumed to exist; a failed read followed by a save must not wipe it) and the narrow **bookmark forwarders**: `vault_apply_flags`, `vault_rename_mailbox`, `vault_adopt_mailbox_dirs` (`vault_flags.rs`) plus `backup_run_account`, `backup_status`, `backup_purge_uids`, `backup_scan_uids` (`backup.rs`, `commands.rs`). Each resolves the backup mirror's security-scoped bookmark, forwards the call to the daemon with the resolved path as `mirrorRoot`, and releases it again. The daemon cannot resolve a bookmark itself, so this one step of an otherwise daemon-owned operation stays in the shell; every rename, mirror copy, fetch and custody update the call triggers runs in the daemon.
  - Release timing splits the two groups. The six bounded calls finish before they reply, so they release on every path — success, daemon error, budget expiry. `backup_run_account` is fire-and-forget: the daemon ACKs the start with a `runId` and the run keeps going for minutes, still needing the path live. The shell parks the resolved path in `backup::HeldBackupPaths` (keyed by account id) and `daemon_channel.rs` releases it when that run's terminal `backup-progress` frame (`active: false`) comes back up the channel. A second start for the same account releases the displaced path rather than leaking it.

The shell must not do heavy work: no transport, no vault walks, no indexing, no bulk file I/O. A Tauri command is a forwarder to a daemon RPC, not an implementation. **Apart from the settings file and the bookmark forwarders above, the shell no longer opens or writes a vault file, cache, journal or ledger at all** — the recorded exception that stood through Phases 3-5 is closed, in both of the two senses it was ever tracked in:

- No vault write lives in `src-tauri/src`'s own text. `commands.rs`'s `graph_cache_mime` went to the daemon at Task 5.6, `main.rs`'s `maildir_store_raw` at Task 5.4a, the mbox and backup-ZIP importers at Tasks 4.6/4.4, and the Phase 3 remainder took the last one: `backup.rs`'s Graph fetch loop and its bidirectional mirror pre-sync, both now in `mailvault_core::backup` in the daemon (the fetch loop's writes under the daemon's gate, the pre-sync outside it; see Daemon below).
- No app-side path *reaches* a core vault writer either. `src-tauri/src/archive.rs` — the shim that built the core archive runner's context with a deliberately no-op write gate, because the daemon's `vault_gate` `RwLock` cannot cross the process boundary — existed only for the app-side backup runner to call. With that runner in the daemon the shim had no callers and is deleted; the daemon's own backup route builds the same context from its own state under the real gate. `vault::root`, the app's mail-data path accessor, went with it for want of a caller, as did `main.rs`'s `maildir_cur_path`/`graph_ledger_path` and its `nudge_index` index signal. The app process now holds no `ImapPool`, no vault path builder, and no way to write a message.

`restore.rs` comes off this list entirely: it reads local `.eml` files and re-uploads them over IMAP, and never writes the vault. Its earlier inclusion here was a misclassification, an ungated reader flagged as a writer, corrected at Task 3.9 (the same failure mode project memory already cites twice).

`tests/unit/vaultInDaemon.test.js`'s `ALLOWED_WRITERS` is now **empty**, and keeps the real list of *message* writers closed at zero. Since Task 3.9 its pattern also sees a raw `fs::write` / `fs::copy` into a vault path, not only a `vault_files::` call - the Graph backup writer (`backup.rs`) was never routed through `vault_files::`, so the old pattern was structurally blind to it; the mbox importer had the same shape before Task 4.6 moved it to the daemon. As of Phase 4 (Task 4.9, verified with a negative control: plant a raw write on `main.rs`, watch the assertion go red, revert, watch it go green), `main.rs` no longer trips the raw-write pattern at all - its one surviving writer, `maildir_store_raw`, goes through `vault_files::store` and is caught by the `vault_files::` pattern instead, and since the Phase 3 remainder's Task 5 `backup.rs` does not either. With no offender left, neither pattern can be proven non-vacuous against a current file, so the guard instead asserts both patterns still match a planted example string — an empty offender list then means "nothing writes" rather than "the regexes rotted". `src-tauri/src/vault.rs` used to sit outside this list on purpose (`copy_tree`'s `std::fs::copy` and `set_aside_custody`'s `std::fs::rename` moved the whole vault tree during a relocation, a structurally different operation from a single message write); as of Phase 6 those functions are gone from `vault.rs` entirely, moved verbatim to `mailvault_core::vault_ops` and called from the daemon (`handlers::vault.rs`), so the exception no longer has a subject - `vault.rs` is now the bookmark broker and local status cache only, with no vault write of its own in either shape. Backup's own migration has now landed too (Phase 3 remainder), which is what empties the list; the bookmark-scope question that deferred it is still unanswered but no longer blocking, because the shell still resolves the bookmark exactly as it always did and only hands the resolved path across (see Known Gaps below).

### Daemon

The daemon owns:

- IMAP, SMTP, Microsoft Graph, OAuth2, and DNS mail-health operations, including sync, IDLE, and — as of Phase 5 — every interactive one-shot call the UI makes too (fetch, send, folder management, connection tests, autodiscovery). There is no longer a separate app-side IMAP/SMTP/Graph/OAuth2 client; `sync_engine.rs`'s calls and the RPC-routed interactive calls both go through the same `mailvault_core` functions and, for IMAP, the same pooled connections.
- Keychain credential reads for sync/IDLE (`resolve_account_credentials`, Phase 5 Task 5.1), alongside the app's own keychain read/write for the 3 commands tied directly to a UI action (`store_credentials`, `get_credentials`, `store_password` — add-account, settings; these stay app-local by deliberate scoping call, not oversight).
- **The keychain gate** (`credentials.rs`, classifier in `mailvault_core::keychain`). A daemon keychain read that fails for a reason unlocking would fix (locked, a refused or cancelled prompt, or no answer within the read's clock) blocks that item; the next read of the same item that answers, even with "nothing stored", clears it, and the gate is blocked while any item is. Each item has at most one blocking read out at a time, which later callers join rather than start again, so a read parked on an unanswered prompt cannot multiply into a thread per retry. The daemon does not wait to be asked: a watcher task reads the blob once at start, and while the gate is blocked reads every blocked item again every 5 seconds, sleeping while it is clear; the clear wakes the scheduled-send worker. macOS's password prompt shows once per blocked episode: only a read that finds the gate clear, or `keychain.retry`, may raise it, and every other read while blocked runs with `SecKeychainSetUserInteractionAllowed` off and fails fast. That switch is process-wide, so one lock spans switch, read and restore, and a single-flight read never lets a quiet probe answer an interactive retry. Each blocked/clear flip is one `keychain-status` event, and `keychain.status` answers the current state for an app that connects later. On macOS the app shows a corner card for as long as the gate is blocked, with no dismiss; it stands in for the sidebar's connection notice and the keychain toast while it shows, and every third click past it starts its Unlock. Its Unlock is one `keychain.retry`, which first unlocks the default keychain with macOS's own dialog when `SecKeychainGetStatus` says it is locked (after a cancelled prompt macOS does not prompt that process again for item reads, so this is the only way back to a prompt), then reads (or joins the read already out for) both daemon items under a 120s clock and wakes the scheduled-send worker when they answer. The app itself never prompts: `get_credentials` reads with interaction off, so a locked keychain answers "unavailable" and the card covers it. Every blocked-to-clear flip, whatever caused it, runs the app's `retryKeychainAccess` once so its own "Password missing" state recovers and `sync.watch` registers again. While blocked, scheduled sends stay queued without spending a try, like offline, and the worker looks again at most every 5 minutes on its own. When a blocking transition reaches no receiver, the daemon posts a banner itself through UNUserNotificationCenter (at most once per 30 minutes); that relies on `NSBundle.mainBundle` resolving to `MailVault.app` from `Contents/MacOS` and is unproven until a signed build shows it.
- The OAuth2 loopback callback listener (`127.0.0.1:19876`), relocated from the app process in Phase 5 Task 5.7; whether a sandboxed, separately-signed daemon child can actually bind that port under a signed build is unverified — see Known Gaps.
- All Maildir and `.eml` persistence: vault files, header and mailbox caches, the operation journal and pending operations, the Outlook uid ledger, custody, and the search index. Each opens and writes in exactly one process, the daemon, under a shared per-root gate that refuses while the vault is unreachable or being moved. Two vault writers run outside that gate on purpose: backup's mirror pre-sync (below) and `graph_cache_mime` (its module doc in `handlers/graph.rs` says why).
- MIME parsing and attachment access.
- Archive, restore, import/export, account migration, cleanup, and classification — and, as of the Phase 3 remainder, backup: the IMAP and Graph account runs, the bidirectional mirror pre-sync, the pending-purge queue, the status comparison and the read-state catch-up all live in `mailvault_core::backup`, driven by `src-daemon/src/handlers/backup.rs` with the same write gate a manual archive run takes. The gate is taken per write, not around the run: each vault write takes the vault registry's mailbox lock and then the gate, and a mirror write takes a gate call of its own outside that lock. The mirror pre-sync takes neither, so a copy off a slow external drive cannot block the folder's reads; when it copied anything into the vault it invalidates that folder in the registry once, and the folder's next read lists it again. A run is fire-and-forget (`backup_run_account` returns a `runId`; progress and the outcome arrive as `backup-progress` events) with cancellation held per account in `DaemonState.backup_runs`. The shell contributes only the resolved mirror path — see the bookmark forwarders above.
- **Scheduled send.** `scheduled_send_worker.rs` owns the outbox: the complete MIME is frozen into the vault's `Scheduled` mailbox at schedule time and the row in `app.db` points at it, `.eml` first so a row can never name a file that was never written. The worker runs a catch-up pass at start (the daemon dies with the app unless always-on is enabled, so "already due" is the normal case, never an error), then sleeps to the next `fire_at`. Sending replays the frozen bytes through `mailvault_core::smtp::send_raw`; `send_built` cannot, because lettre re-derives envelope and body from its own `Message`. Offline is neither transient nor terminal: the row stays queued and the attempt is released. A row is claimed in-process for the duration of a send so `scheduled.send_now`, which skips the due-time gate, cannot dial out alongside the worker, and a send re-reads its row under that claim, so a cancel, edit or reschedule that landed after the due batch was read beats the stale copy. Editing a scheduled email reads the frozen `.eml` back out of the vault (the server never had it) and leaves the row queued until the edit replaces it: `scheduled.update` rebuilds the `.eml` in place under the same claim and refuses a row that is claimed or no longer `queued`/`failed` (`E_SCHEDULED_NOT_EDITABLE`), and `scheduled.cancel` refuses a claimed, `sending` or `sent` row the same way, so a message that went out is never relabelled cancelled; an edit sent immediately cancels the row only once the send has gone out. Compose preselects the recipient's zone from `scheduled.suggest_tz`, which answers facts, not a zone: the UTC offset of the newest cached Date header from that address (custody.db) and the zone last scheduled to them (app.db). The app picks the zone, because `Intl` holds the DST rules.
- **The AI provider layer.** `llm.rs` answers one question — `generate(provider, prompt, system, max_tokens)` — for three providers: the GGUF engine in `inference.rs`, a user-configured OpenAI-compatible endpoint, and Apple's on-device model through `mailvault-fm-helper`, a weak-linked Swift sidecar spoken to in one JSON object per line. Only the endpoint arm constructs an HTTP client; the two on-device paths cannot reach the network by construction, and a test asserts it. Quick replies, compose actions and auto-tag verdicts all go through this one layer.
- **Auto tags.** `auto_tag_worker.rs` is a level-triggered sweep, not a queue: on every wake it re-derives what still needs a verdict from durable state (header cache, `enabled_at`, `auto_tag_decisions`), so it is self-healing across restarts. A rule's deterministic constraints are the prefilter and run before any model is asked; `enabled_at` bounds the sweep to mail arriving after the rule was switched on, which is what keeps an enable from becoming an implicit unbounded backfill. Only a verdict the model actually returned is recorded — a failure to ask (no model downloaded, an endpoint that timed out, a remote provider the rule may not use) leaves the message undecided, or that mail would never be judged once the model exists. `inbox_action: hide` is a local fact only: the daemon moves nothing, and the app does the hiding.
- Vault-location file work (Phase 6): folder classification, the copy/verify/marker pipeline behind `vault_get_status`/`vault_adopt`/`vault_move_to`/`vault_move_to_default` (`mailvault_core::vault_ops`, `src-daemon/src/handlers/vault.rs`). The four Tauri commands (plus `vault_reset`, which has no file work to move — clearing a bookmark is its entire body) stay registered as thin forwarders: the app still owns the security-scoped bookmark (spec §3.4) and the `vault_close`/`vault_reopen`/`stop_daemon` restart choreography around each call, unchanged in shape from before Phase 6. A move is two RPCs, not one — `vault_move_to`/`vault_move_to_default` copy and verify but never delete, because the app cannot know whether to delete the source until it has saved the new bookmark and confirmed it actually resolves; `vault_move_finalize` (internal, never called from JS) commits (deletes source) or aborts, guarded by a `moveId` so a stale or mismatched finalize can never commit a move it wasn't answering.

Every long-running job runs on its own thread or worker, never inline on the RPC handling path, so one slow account, drive, or index pass cannot stall other requests. Which thread owns what is set out under Process and Thread Model below; the socket itself has a thread and a runtime of its own. Jobs are resumable where practical (level-triggered reconciles, batched commits) and report progress as events; the frontend renders that progress and never computes it.

Daemon RPCs should expose cohesive operations. Prefer a small number of meaningful operations over many thin wrappers around internal functions.

Account transfer (Settings > Accounts, "Move to another computer") is split along the same line. The daemon owns the file format and the crypto: `transfer.export` encrypts a bundle the app hands it, `transfer.decrypt` opens one, and `transfer.apply_config` merges the bundle's app.db config (tags, fields, views, auto-tag rules) under an account id map. A `.mvtransfer` file is `MVXFER`, a version byte, the argon2id parameters (export: m=64 MiB, t=3, p=1), a 16-byte salt and a 24-byte nonce, then XChaCha20-Poly1305 ciphertext with the whole header as AAD (`mailvault_core::transfer::crypto`). The daemon never receives a user-chosen path: the app picks the file through the native dialog, writes it with `save_attachment_to`, and reads it with `read_file_base64`, a thin Tauri command that only opens `.mvtransfer` files. The app remains the only writer of account credentials: `saveAccounts` (`services/db/accounts.js`) stores every imported account in one keychain write and one accounts.json write, and frontend settings travel through an allowlist (`services/transfer/settingsTransfer.js`) that leaves machine-bound state behind. The only secret the daemon writes is the AI provider key, into the keychain entry it already owns. Export and import both run in the main window only (`components/transfer/ExportModal`, `ImportModal`, raised through `settings-window-action` from a detached Settings window): the detached window cannot write settings to disk, the main window's keychain cache would drop imported secrets on its next write, and export reads accounts through `getAccounts`, whose legacy repairs can write the keychain from the calling window's cache. The main window reloads when an import lands. A detached compose window that already loaded the keychain is not reloaded by that import, so its next send can still write the credentials blob from its stale in-memory copy, overwriting the imported accounts; this is the same pre-existing hazard as adding an account while compose is detached.

### Website

The website is a separate surface area.

- Desktop app changes should not automatically force website changes.
- Website SEO, navigation, and generated changelog behavior belong to website-specific docs and scripts, not core application architecture.

## Process and Thread Model

One box, one thread. Every separate action runs on a thread of its own, and nothing that can be slow shares a thread with the socket.

**App process (Tauri shell).** The webview owns the UI thread and never does file work. Each `daemon_rpc` call opens its own Unix socket connection on the app's runtime, so one slow reply cannot queue behind another; the long-lived event channel (`daemon_channel`) is a separate connection with its own pump. Spawning, build-checking and token reads for the daemon go through `spawn_blocking`, never the UI thread.

**Daemon process.** Four owners, each with its own thread:

- **`ipc-server` thread, its own tokio runtime** (`server::spawn_on_own_thread`) — the socket: bind, accept, per-connection framing, RPC dispatch, and the long jobs handlers spawn (restore, migration, backup, `mail_search`, reclassify). Nothing else is on this runtime, so no background work anywhere else in the daemon can delay an accept or a reply.
- **Startup runtime** (`daemon_main`) — the periodic and long-lived workers: the sync engine, the IDLE watchers, the classification queue worker, the contacts flush, transfer stats and the Insights snapshot sweeper. It binds nothing and answers nothing. Its own disk work leaves it too: every sync cache step (the metadata read and cached count, the header writes, the flag patch, the prune and the contacts observation) goes through `sync_engine::cache_io`, one blocking hop per step, and the cached-header walk behind classification and the local scan behind a restore do the same.
- **`search-index` OS thread** — the index worker, sole owner of the search index's SQLite connection: level-triggered reconciles, rebuilds, destroys and compaction, coalescing signals rather than blocking a caller.
- **`custody-import` OS thread** — the one-time legacy JSON import, taking the custody lock one mailbox at a time.

**Blocking pools.** Each runtime has its own, reached through `spawn_blocking` (`handlers::common::blocking`). Everything that touches disk goes there and nowhere else: directory listings, file reads and writes, SQLite queries, MIME parsing, ZIP and mbox passes, attachment extraction (with PDF text extraction in a separate process again, for crash isolation).

Rules this model exists to keep:

- Nothing is awaited between process start and the socket being bound. A migration or import that must run at startup runs on its own thread afterwards, and a store it has not reached yet reads as empty, never as wrong.
- No directory listing, file read or write, or SQLite call on a tokio worker thread. A vault walk is tens of thousands of files; parking a worker on it stalls unrelated work on the same runtime.
- A job spanning many files or mailboxes takes its lock per file or per mailbox batch, never once around the whole job, so a concurrent read waits for one unit rather than the whole run.
- Long jobs answer their RPC immediately and report progress as events; the RPC path itself stays request/response.

## Core Data Model

The app is organized around a few durable concepts:

- Account: credentials, provider metadata, transport choice, and account-specific settings.
- Mailbox: server folder plus local cache metadata.
- Email header: list-level representation for loading, sorting, filtering, and threading.
- Email body: full parsed message content, loaded on demand or cached ahead of time.
- Local archive: Maildir-backed `.eml` files used for portability and offline access.

Maildir is the source of truth for locally saved email content. The SQLite stores and in-memory state are performance layers, not the canonical archive format.

### Where state lives

Two SQLite stores hold everything that used to be loose JSON files:

- **`<vault>/custody/custody.db`** — records about the mail: custody entries (`vault_entries`), the header cache (`header_cache`, `header_cache_meta`), the per-account folder list (`mailbox_cache`) and the sender address book (`contacts`). Never derived, never deleted, never rebuilt: a store this build cannot read is reported and left exactly as it is. Opened EXCLUSIVE by the daemon, so nothing else in either process may open it — everything reads it through `custody::with_conn`.
- **`<app_data_dir>/app.db`** — what the app keeps about itself: the vault and external-backup locations with their security-scoped bookmarks (`external_locations`), wire-byte counters (`transfer_stats`), classification results/model/queue, the scheduled outbox (`scheduled_sends`, schema v3), the auto-tag rules with their backfill batches and recorded verdicts (`auto_tag_rules`, `auto_tag_backfills`, `auto_tag_decisions`, schema v4), and the journals of confirmed-but-unfinished work (`pending_ops`, `pending_backup_purge`, and the single in-flight bulk operation in `meta`). Deliberately **not** EXCLUSIVE and with a non-zero `busy_timeout`, because two processes hold it: the app creates the bookmark that grants the daemon access to the vault, so it cannot wait for the daemon to exist.

A third SQLite file is derived, not kept: **`<app_data_dir>/vault_registry.db`**, the vault registry (`mailvault_core::vault_registry`, daemon only). Per `(account, vault_dir)` and uid it records the file name, size, mtime and parsed light row of every vault message, and it answers `vault_uid_sets`, `vault_light_rows` and the uid-to-file resolution behind every single-message route (body, light row, raw source, attachments, exists, delete, flag change). It holds nothing the vault cannot rebuild, so it is droppable: an open error, a schema mismatch or a different vault root deletes and recreates it, a failed recreate runs it in memory for the session, and it is never in custody. A mailbox is verified (listed from disk) at most once per daemon session; after that every vault writer updates its rows or invalidates the mailbox before replying. `src-core/tests/vault_registry_guard.rs` enforces the writer half: a function that creates a vault file must upsert, one that only renames or removes must make some registry call, and each exception is listed with its reason.

### The metadata layer (tags, and the fields and views to come)

Tags, custom field values and saved-view definitions are user-authored, so they
live in `app.db` (schema v2: `tags`, `tag_assignments`, `fields`,
`field_values`, `views`) and never in `<vault>/search_index/index.db`. That
index is rebuildable by design — the daemon worker may delete and rebuild it —
so anything a person typed would be lost with it. Nothing in this layer touches
an `.eml`, a server flag or an IMAP keyword: a tag is local, and works the same
on a provider with no label support.

Assignments are keyed by `app_db::identity::msg_key`: the `Message-ID` where
the message has one, and `u:<vault_dir>:<uid>` only where it does not. The old
`[accountId, mailbox, uid]` key (`localMailLabelKey`, and `emailKey` for the
render cache) does not survive a move — an IMAP uid is per-mailbox — nor a
Graph resync, where vault files are named by listing position. Two copies of
one message in two folders share a key, which is what "a tag is independent of
the folder" means.

The app computes no keys. It sends what its rows carry (account, mailbox, uid,
`Message-ID` when present) and the daemon derives the key, so the rule has one
home. The frontend's `tagStore.byRow` is a render cache for the rows on screen,
refetched per page, and deliberately keyed by something unstable.

`tags.migrate_legacy` re-keys the old settings-file labels. The app reads its
own `frontend-settings.json` and hands the rows over — the daemon never opens
that file — and the daemon refuses the whole migration while its index cannot
place an assignment for an account, because the app clears its legacy store on
a success reply.

### Custom fields

A field is a definition (`fields`) plus a value per message (`field_values`),
both in `app.db`, both keyed by `identity::msg_key`. `scope` is an account id,
or `*` for every account; values are always per account, because the same
message in two accounts is two messages to the person reading it. Sharing a
field is a scope change on the same row, never a copy, so the values already
given stay attached; copying a schema to another account makes new fields and
leaves the answers behind.

Two rules worth keeping: editing a field is an `UPDATE`, never
`INSERT OR REPLACE` — this store enforces foreign keys, so a REPLACE would
delete the row and cascade every value away — and clearing a value deletes the
row rather than storing a null, so "no answer" and "answered nothing" cannot
read the same to a filter. `fields.set` refuses a payload with no `value` key
at all: forgetting an answer has to be asked for. `fields.save` keeps the
position a field already had, so an ordinary edit can never renumber a schema
behind the person's back; moving one is `fields.reorder`, which renumbers a
whole scope group in one transaction and refuses to trade places across the
line between the shared fields and an account's own.

Views narrow on fields the same way they narrow on tags: `app.db` answers which
identities match, the index answers which rows those are, and the two sets
intersect. `field:` in the search box does the same over a search's frames.

A view that groups by a field (`def.group` of `field:<id>`) is the one place
the render cache is filled ahead of the rows: `openView` loads the values for
everything it is about to show before `showRows`, because values arriving one
rendered row at a time would group every row as "no value" and then reshuffle
the list under the reader.

### Saved views

A view is a stored `ViewDef` (`app_db::views`) plus an evaluation, never a
stored set of messages. `views.evaluate` builds one `SearchRequest` per account
from the definition, runs it through the same `search_index::query::search` the
search bar uses, and returns rows stamped by `mail_search::stamp_local_row` —
the same shape the search's index lane produces, so the list renders them with
no second path. The app never evaluates a view itself: a set difference against
a partly loaded list is a guess, not a view.

Two rules the definitions follow, both learned from bugs of the same shape:

- **A starter stores no name.** "Needs reply" written into `views.name` would
  pin English into the database for every locale, and a later language change
  could not undo it. Starters carry a `builtin` id and the app translates it;
  only a name someone typed is stored.
- **Folders are excluded by special-use, never by name.** A mailbox's name is a
  per-mailbox word (a German account's bin is `Papierkorb`), so `exclude_special`
  names IMAP attributes (`\Trash`, `\Junk`, `\Archive`) and the app resolves
  them to server paths per account when it runs the view.

The index gained a `flags` column for this (schema v3): the Maildir letters live
in the file name and `index_doc_from_light` strips them from `row_json`, so
Starred and unread were not answerable before. The migration reads them back out
of the file names the index already holds — no re-read of the vault — and a
rename (which is what starring a message *is*) updates the column.

Metadata is forgotten when its message is. A reconcile pass reports the
identities of the rows it removed and the daemon prunes `tag_assignments` and
`field_values` for them — but only after checking no other folder of that
account still holds the same identity, because a move is a removal plus an
insertion and the halves can land in either order. That check runs while the
index lock is held, before `app.db` is opened, so no path holds both in the
other order.

A tag-filtered view resolves its identities from `app.db` first and passes them
to the index as a whitelist through a temp table; every `app.db` read happens
before the index lock is taken, so no path holds both.

The one-time move of the pre-SQL JSON files runs on the first open of each store and retires each file to `<name>.pre-db-<stamp>` (never deletes it). `app.db`'s import runs entirely inside one `BEGIN IMMEDIATE` with a `legacy_import` marker set in the same transaction, because the app and the daemon can both reach it at the same launch and `transfer_stats` rows accumulate rather than replace.

Two files deliberately stay outside both stores: `accounts.json` (the frontend owns it, and a second writer would turn a same-process race into a cross-process one) and `email_cache/<account>_<mailbox>/graph_id_map.json` (the Outlook uid ledger, which needs a cross-process file lock and must travel with the vault). Those sidecar directories therefore still exist; they just hold nothing but the ledger.

### Storage tiers

Two distinct locations, not one:

- **Vault (working copy)** — the mail the app reads and writes. Defaults to the app data dir; the user can relocate it to any folder. `src-tauri/src/vault.rs` owns resolution, folder verification and the copy-verify-delete offload; every mail-data path goes through `vault::root()`. Only mail data moves (`Maildir`, `maildir`, `email_cache`, `attachment_cache`, `mailboxes`, `search_index`, `custody`, `contacts_index`) — accounts, settings, logs, `app.db` and the vault registry stay in the app data dir so the app can boot and report an unreachable vault. When the vault cannot be resolved, mail-data commands fail rather than falling back to the app data dir, which would fork the archive.
- **External backup (cold storage)** — a second, independent copy written during backups and never read for day-to-day use. Managed by `src-tauri/src/external_location.rs`; both locations persist through the same security-scoped bookmark slot mechanism (`SLOT_VAULT`, `SLOT_EXTERNAL_BACKUP`).

The daemon resolves the vault independently from `app.db`'s `vault` location row (it was `<app_data_dir>/vault-meta.json`) and keeps its own `app_dir` for logs, lock, models and classification state. A vault adopt/move/reset holds `DAEMON_SUSPENDED` (nothing may spawn a daemon onto a root mid-move), closes the daemon's search index and custody store together (`vault_close`), performs the move, then either stops the daemon so the channel respawns it on the new root, or, if the root did not change, reopens both in place (`vault_reopen`) instead. Every vault-rooted RPC route refuses while this gate is held, rather than falling back to reading or writing under the app data dir.

Custody opens once at daemon startup, before the socket is bound, so its startup status event always predates the daemon's first possible subscriber and is dropped by design: not a race, an invariant. The open itself is only the file and its schema; the one-time import of legacy JSON records (`custody::run_legacy_import`) runs on its own thread AFTER the socket is bound, taking the custody lock one mailbox at a time, and marks each imported mailbox in `meta` so later starts skip it without reading a file. Blocking the socket on that import is what made a large vault start with no mail and a "Helper Not Running" card for minutes (2026-09-20); a mailbox not imported yet reads as "no cached headers", never as wrong ones, because the import only inserts rows the store does not have. The frontend instead re-queries custody status on every `daemon-reconnected` event (fired on the first connection too, and again after any respawn), which is therefore the one channel that actually carries this state, not a patch over a race window.

### Transfer accounting

`mailvault_core::transfer_stats` counts wire bytes per account: a `CountingStream` wraps the TCP/TLS stream inside `connect_transport`, below COMPRESS=DEFLATE, so compression savings are reflected. Counters are process-global, keyed by account email (the only identity `ImapConfig` carries), and flushed every 30s — plus on shutdown — into `app.db`'s `transfer_stats` table, keyed `(account_id, day, source)` with `source` naming the writing process. Each process only ever touches its own rows, so the app and the daemon never clobber each other; readers sum both sources. The daemon's optional soft daily cap reads its per-account limits from the app's persisted settings blob (`frontend-settings.json`) and skips `sync_account` once the day's allowance is spent.

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

Daemon-owned commands (listed as `DAEMON_OWNED` in `src/services/transport.js`) go straight to `daemon_rpc` under their own names instead of the request/response flow above. They never fall back to `invoke`; an unreachable daemon rejects with `errors.daemonUnavailable`. Every vault file read or write, header and mailbox cache access, journal and pending-operation update, Outlook uid allocation, and custody read or write is one of these: the daemon performs the disk work, its writes under the per-root gate described above (the two exceptions named under Daemon aside), and the shell never opens the underlying file.

Three vault operations are the deliberate exception: `vault_apply_flags`, `vault_rename_mailbox` and `vault_adopt_mailbox_dirs` stay ordinary Tauri commands (not `DAEMON_OWNED`) because only the shell can resolve the backup mirror's security-scoped bookmark. Each resolves the bookmark, forwards the call to the daemon with the resolved path added as a parameter, and releases the bookmark once the daemon replies or the reply budget expires, on every path including a daemon error. Because they bypass the `DAEMON_OWNED` mapping, a daemon-side failure reaches these three callers as a raw error code rather than a translated message.

As of Phase 3 (Tasks 3.4-3.7), the daemon owns archive, bulk delete, verify and Mail Insights end to end: their own RPC routes, their own cancel-token registry, no bridge call to the app for any of it. Insights moved whole, including its snapshot map, 300s expiry and 30s sweeper; its custody reads are in-process now, and the `custody_entries_for_account` bridge route it used to call is deleted with it.

Backup's own two RPC bridges are gone with it (Phase 3 remainder). It used to call `local_index_append` over RPC after each save and `vault_apply_flags` over RPC for the mirror-bookmark rename — the daemon calling itself, because the runner lived in the app. In the daemon both are in-process: custody appends through the same shared function `local_index_append` routes to, and the flag catch-up straight into `handlers::vault_flags::apply_flags` under the same `WRITER` the frontend's own forwarder takes. `local_index_append` stays a route because the frontend still calls it (`api.js`, `DAEMON_OWNED`), not as a bridge.

As of Phase 5 (Tasks 5.1-5.9), the daemon owns the network layer end to end: interactive IMAP (20 commands, 6 of which duplicate a call `sync_engine.rs` already made — rerouted to a thin daemon RPC over the same `mailvault_core::imap` function rather than deleted, since real one-shot callers outside the sync loop still need them), SMTP (4, after the client itself relocated into `src-core` in Task 5.3), Microsoft Graph (12; the 13th, `graph_get_mime`, had 0 callers and was deleted outright), OAuth2 (3, plus the loopback listener itself), and DNS mail-health (2). None of these have an app-side Tauri-command twin left; `src-tauri/src/smtp.rs` and `src-tauri/src/dns.rs` (both once kept as thin re-export shims for an in-process app caller that no longer exists) are deleted outright. `sync.now`/`sync.watch`'s payload no longer carries credentials at all (see Known Gaps); every other migrated command still accepts credentials as an RPC param exactly as before, unchanged shape. `store_credentials`/`get_credentials`/`store_password` are the one deliberate exception to "network work moves to the daemon" — OS keychain calls triggered synchronously by a UI action, not background work, kept app-local by scoping call rather than migrated for the sake of uniformity.

A second, long-lived channel (`src-tauri/src/daemon_channel.rs` ↔ `src-daemon/src/channel.rs`) carries two things outside the request/response flow: daemon bus events (e.g. `search-index-progress`), re-emitted by the shell as Tauri events for the frontend to render; and app → daemon fire-and-forget notifications (`search_index.nudge {accountId, mailbox}` from every vault writer, `search_index.sweep_soon`), dropped while disconnected and recovered by a `sweep_soon` sent on every (re)connect. The daemon starts unconfigured on each spawn, so the frontend re-pushes its effective index config on `daemon-reconnected`.

Interactive mail search is a daemon-owned job too. `mail_search_start` receives a unique `searchId`, the filter snapshot, explicit normalized account/mailbox targets, location, and effective mailbox concurrency; it registers the run before acknowledging. `mail_search_cancel` marks only that run cancelled and shares a publication lock with `mail-search-progress`, so after cancellation is acknowledged it cannot publish another result frame. Progress frames carry a monotonic sequence, local/server lane, rows, completed/total counts, local mode, fallback reason, index coverage, folder failures, and terminal state. The frontend `searchStore` only merges increasing-sequence frames for its active ID; a `current`-scope account/mailbox change or entitlement change cancels and restarts the search. Tauri remains a forwarder, and the UI does not fan out work across mailboxes.

The daemon runs the local and server lanes concurrently. Local search queries the existing SQLite FTS index and assembles result metadata from stored `row_json` plus current filename-derived flags, without MIME-parsing each matching `.eml`. It reports index coverage and publishes indexed rows first; when the index is off, building, unavailable, or incomplete for the requested folders, it scans only the uncovered local folders and reports why. Server search schedules mailbox work with bounded concurrency, retains successful-folder results when another folder fails, and retries a transient IMAP connection failure once. The daemon clamps concurrency to 1–5 independently of UI state; the frontend sends the saved Premium value (default 3) for Premium accounts and 1 otherwise. Losing Premium does not erase the saved preference, and an entitlement transition restarts an active search so the new limit applies immediately. Microsoft Graph remote search remains unsupported, so a Graph-only server search terminates without a remote lane rather than leaving the spinner active.

The persistent search index remains one daemon-owned SQLite connection in exclusive WAL mode. Startup and runtime SQL failures go through the existing index worker: valid newer or structurally damaged search-index databases are rebuilt from Maildir, while lock, permission, disk, and vault-access failures keep the index files and retry with a capped delay. The worker reports `starting`, `recovering`, `indexing`, `idle`, `error`, or `off`; a real recovery failure carries `searchIndex.recoveryFailed` and its detail. Rebuild, disable, Delete, and vault switches fence in-flight open and attachment-extraction work by operation generation, and attachment files/extractors run without the database mutex. Search-index recovery only removes the four derived index files; it does not touch Maildir, custody, or account data.

Local indexed queries use the same mailbox concurrency as fallback/server work. The daemon deduplicates selected vault directories, queries them in bounded SQL scopes, and merges each scope's top 500 hits by descending indexed date and row id so the account's displayed 500 are the same as one unbatched query. Indexed progress frames carry a cumulative per-account snapshot; the store replaces that account's prior indexed rows while preserving other accounts and later fallback/server results.

Search deliberately adds neither a last-100 query cache nor a remote-only full index. The cache would duplicate the persistent FTS index while adding invalidation for scope, account, move, and delete changes, and it would not accelerate new queries. Downloading and indexing all remote-only messages would add storage, body-download, synchronization, provider-throttling, and IMAP/Graph parity decisions; this phase indexes mail already stored locally instead.

## Known Gaps

Deliberately deferred or unresolved boundary issues, not a bug tracker; keep this list short and re-read it before touching the areas it names.

- **The backup mirror's bookmark scope is still unverified — it just no longer blocks anything.** `resolve_external_location`'s `start_access` (`external_location.rs`) rebuilds a plain `fileURLWithPath:` from the resolved bookmark's path string rather than starting scope on the security-scoped URL itself — the same defect `open_in_finder_inner` was fixed for, but that fix (`c393c14c`) never touched the call site backup uses. Whether it silently no-ops in production needs a signed-build test Rokas has to run himself. Backup's migration no longer waits on the answer: the shell resolves and releases exactly as it always did and hands the daemon the resolved path, so a scope that was never load-bearing and one that is both behave as before. What the answer would change is whether the hold-across-a-run bookkeeping (`HeldBackupPaths`) is doing real work or is ceremony.
- **One `ImapPool` per process, gap closed.** Before Phase 5 the daemon's archive/bulk routes used the daemon's pool while the app's separately-managed pool served interactive IMAP, up to 10 concurrent connections per account combined. Task 5.4b deleted the app-managed pool; the Phase 3 remainder deleted the process-global `OnceLock` pool that `backup.rs`/`archive.rs` shared, when those runners moved. The app process now constructs no pool at all, and `tests/unit/networkInDaemon.test.js` asserts no `ImapPool::new()` remains in `src-tauri`.
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

### Reads come from the database

The daemon's databases are what every read consults: list headers, which messages the vault holds and with which flags, and the parsed light row of each stored message. The disk is not re-read to answer those questions.

For the vault that database is the vault registry (see Where state lives). Its blind spot is by design: a change made to the vault from outside the daemon mid-session (another Mac writing a shared SMB vault, a file copied in by hand) is not seen until the mailbox is listed again. A file removed or renamed from outside fails its next open, which relists the mailbox once; a file added from outside fails no open, because a verified miss is authoritative, so it stays invisible until the mailbox is invalidated (a structural vault change, `vault_reopen`) or the next daemon session. Jobs that walk a whole mailbox on their own schedule (the no-index search scan, backup and archive runs, generation repair) still list it from disk.

- **Read the disk once, or on recovery.** A mailbox's vault directory is listed and verified at most once per daemon session, and again only after a failed read (a stored filename that no longer opens invalidates the mailbox, triggers one rescan, then one retry). Never list or stat a whole directory to answer a question about one message.
- **Parse once.** A message is MIME-parsed the first time its light row is asked for and the result is stored; later readers take the stored row. A write or a verify records the file and never parses, and a rewritten file drops its stored row so the next read parses it again; a flag rename keeps it. Only opening a message's body or an attachment reads its `.eml`, and one open resolves the file and parses it once, however many parts it needs.
- **Writers update the database before replying.** A vault write that returns has already updated or invalidated the rows it touched, so the next read sees it. A coalesced background nudge (the search index's) is not a substitute.
- **Unknown is not empty.** A mailbox not yet verified, or a read that failed, returns `null` ("unknown, keep what you know"), never an empty set; callers persist only real answers.
- **Batch, do not loop.** One RPC per user action, not one per message, image or folder; chunk large id sets instead of issuing one query per id or one unbounded `IN (...)`.

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
