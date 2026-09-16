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

The shell must not do heavy work: no transport, no vault walks, no indexing, no bulk file I/O. A Tauri command is a forwarder to a daemon RPC, not an implementation. It does not open or write any vault file, cache, journal, ledger or the custody store directly: the settings file and the three bookmark forwarders above are the only carved-out exceptions, recorded here precisely because they are exceptions.

### Daemon

The daemon owns:

- IMAP, SMTP, and Microsoft Graph operations, including sync and IDLE.
- OAuth2 token refresh used by transport.
- All Maildir and `.eml` persistence: vault files, header and mailbox caches, the operation journal and pending operations, the Outlook uid ledger, custody, and the search index. Each opens and writes in exactly one process, the daemon, under a shared per-root gate that refuses while the vault is unreachable or being moved.
- MIME parsing and attachment access.
- Backup, archive, restore, import/export, cleanup, and classification.

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

Archive, Mail Insights and backup have not moved into the daemon yet, but the data they touch (custody rows, vault read-state renames) now lives only there. Until they move, each reaches it through a daemon RPC call from inside its own background work: archive appends custody entries after a save, Insights reads one account's custody rows per RPC call, and backup's read-state catch-up calls the same flag-rename RPC the frontend's forwarders use. This is a temporary bridge, not a second custody API: when archive, insights and backup themselves move into the daemon, these calls become direct in-process calls and the bridge functions are deleted.

A second, long-lived channel (`src-tauri/src/daemon_channel.rs` ↔ `src-daemon/src/channel.rs`) carries two things outside the request/response flow: daemon bus events (e.g. `search-index-progress`), re-emitted by the shell as Tauri events for the frontend to render; and app → daemon fire-and-forget notifications (`search_index.nudge {accountId, mailbox}` from every vault writer, `search_index.sweep_soon`), dropped while disconnected and recovered by a `sweep_soon` sent on every (re)connect. The daemon starts unconfigured on each spawn, so the frontend re-pushes its effective index config on `daemon-reconnected`.

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

`src-tauri/src/insights.rs` inventories the available header cache and Maildir metadata through the configured vault root. It exposes bounded pages with file/generation validation and explicit coverage; it never treats the current visible mailbox window as the full inventory. Provider receive dates and original sent dates retain provenance, and legacy fallback or missing dates remain disclosed. The enumerated file set is frozen for that scan; later arrivals appear on refresh. Changes to captured files, source metadata, UID generations, directory identity or vault/account context invalidate the whole snapshot rather than mixing generations. Directory timestamp changes from independent mail arrivals do not invalidate captured headers.

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
