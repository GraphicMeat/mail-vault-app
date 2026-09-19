# Daemon Search Orchestration Design

## Goal

Make locally stored mail searchable with near-immediate first results regardless of vault size, keep results scoped to the currently selected mailbox/account context, and make multi-mailbox search faster and resilient without moving orchestration into the UI.

## Product behavior

- Clearing search cancels the active run and immediately makes every later result from that run ineligible for display.
- Changing mailbox or account while a `current`-scope search is active cancels and restarts the same query in the new context. The list contains only results from that new context.
- In All Inboxes, `current` means the selected unified folder across all visible accounts; `all` means every selectable folder across all visible accounts.
- Indexed local results appear first. Server results continue to arrive and merge into the same list without removing valid local results.
- When the local index cannot fully answer, search falls back to reading locally stored folders and shows a localized explanation with a shortcut to Search Index settings. Free users also see a compact Premium upgrade action for faster multi-folder search; the copy must not imply that indexing itself requires Premium.
- One failed folder does not discard results from other folders. Transient server connection failures receive one retry; permanent IMAP failures are recorded and skipped.

## Concurrency and entitlement

The saved setting is `searchMailboxConcurrency`, normalized to the inclusive range `1...5` and defaulting to `3`.

The effective value is calculated at every daemon boundary as:

```text
premium ? (valid saved value or 3) : 1
```

- Free users always run one server mailbox and one unindexed-local fallback mailbox at a time. They cannot change the control.
- Premium users may choose `1...5`; the default is `3`.
- Purchase or Premium login immediately changes the effective value to the saved preference, or `3` when none exists.
- Logout or loss of Premium immediately changes the effective value to `1` without erasing the saved Premium preference.
- Logging back in restores the saved preference, or `3` when none exists.
- A running search uses the entitlement/config snapshot supplied at its start. An entitlement transition cancels and restarts an active search so the new effective limit applies immediately.
- The daemon clamps the supplied value independently. Frontend gating is presentation, not authorization.
- The same effective setting limits the server lane and the folder-reading local fallback lane separately. Indexed SQLite search remains one query and is never split into artificial batches.

## Architecture

### Daemon-owned coordinator

Add a daemon search coordinator exposed through cancellable RPCs:

- `mail_search_start`: accepts a unique `searchId`, normalized account and mailbox targets, query filters, location, and the entitlement-derived concurrency value. It acknowledges the run after registering cancellation state.
- `mail_search_cancel`: cancels the named run and prevents new mailbox work from being scheduled.
- `mail-search-progress`: daemon events carry `searchId`, a monotonic sequence, lane (`local` or `server`), rows, completed/total counts, local mode, folder failures, and terminal state.

The coordinator launches local and server lanes concurrently. Each lane uses bounded scheduling, checks cancellation before scheduling and before publishing, and reports partial progress. The frontend only merges/deduplicates frames for its active `searchId`.

The daemon owns target execution, retry classification, concurrency, and cancellation. The frontend may compute view intent such as `current`, `all`, or a subtree, but sends explicit normalized targets so the daemon never depends on UI state.

### Fast indexed local results

The existing FTS database is authoritative for local search. Search should return stored `row_json` metadata and current filename-derived flags without MIME-parsing every matched `.eml`. Opening a selected result continues through the existing location and Message-ID verification path.

The index response reports an explicit local mode and coverage:

- `index`: the index answered, with indexed/total/matched/shown counts.
- `scan`: the daemon is falling back to folder reads, with reason `off`, `building`, or `unavailable`.

If coverage is incomplete, indexed rows are published first and the fallback only scans the uncovered scope. Results are deduplicated by account, mailbox/UID, and normalized Message-ID using existing semantics.

### Server search

Server mailbox searches use the existing IMAP pool read path that replaces dead connections and retries once. The pool ceiling rises from three to five so a Premium preference of four or five is truthful. Permanent `NO`/`BAD` folder failures do not retry and do not fail the run.

The existing Microsoft Graph limitation is preserved and documented: this phase does not add remote Graph search.

### Frontend lifecycle

`searchStore` owns one active `searchId` and frontend generation:

- A new search, Clear, account change, mailbox change, or entitlement transition advances the generation synchronously.
- Clear sends best-effort daemon cancellation and resets visible state immediately.
- Current-scope navigation restarts the query for the new context.
- Any event with an obsolete ID or non-increasing sequence is ignored.
- Search history is written only for the active run.

This dual guard makes stale updates harmless even if cancellation races with an event already in transit.

## Settings and messaging

- Add the concurrency control to the existing Search Index settings card.
- The free state displays `1`, is disabled, and includes a compact upgrade affordance.
- The Premium state displays and persists `1...5`, default `3`.
- Add localized fallback/index-building copy and actions to all application locale catalogs.
- Add fast multi-folder search to the in-app Premium feature catalog and generated website pricing catalog.
- Update the website features/search performance copy and regenerate localized website pages using the repository scripts rather than editing generated translations by hand.

## Deliberate exclusions

### Query-result cache

Do not add a last-100-results cache. It duplicates the persistent FTS index, adds invalidation for query/scope/account/moves/deletes, and does not help new queries. Reconsider only if the optimized index misses the performance target on the Mac mini.

### Remote-only background indexing

Do not download and index every remote-only message in this phase. That requires product decisions for storage limits, body download policy, synchronization, provider throttling, deletion, and Graph/IMAP parity. Already-local messages remain background-indexed. A later phase may index existing server header sidecars for subject/sender search without mirroring bodies.

## Failure handling

- Cancellation is success and emits no later result rows.
- An unavailable index activates the local fallback and reports why.
- A failed local folder or server mailbox is included in progress metadata while remaining targets continue.
- If every selected source fails, the terminal event contains a localized error key and no stale rows replace prior UI state.
- Daemon restart/unavailability uses the existing daemon error path; the UI may offer retry but must not silently fall back to frontend-owned fan-out.

## Verification

### Regression and unit coverage

- Clear during a deferred All Inboxes search cannot republish stale rows.
- Switching from All Inboxes to a mailbox cancels/restarts a current-scope search and only shows that mailbox's results.
- Obsolete and out-of-order daemon events are ignored.
- Local indexed and server lanes publish independently, with indexed local results first under a gated server test.
- Free concurrency is exactly one per lane; Premium defaults to three, persists `1...5`, clamps invalid values, restores the saved value after login, and becomes one after logout.
- A transient dead IMAP connection retries once; a permanent folder failure preserves successful-folder results.
- Cancellation stops new scheduling and later publication.
- Indexed row assembly does not parse matched `.eml` files.
- Premium app/website catalog parity remains enforced.

### Mac mini gates

- Run frontend, Rust daemon/core, integration, website, and targeted connected-search suites through `~/.claude/bin/testq`.
- Use the existing 50,000-message index benchmark in release mode.
- Target warm first indexed rows under 200 ms with no per-hit MIME parse.
- Run the connected end-to-end regression with a unique `E2E_TAURI_WD_PORT` and verify mailbox switching while the original search is delayed.

## Expected files

The implementation is expected to touch the daemon search handler/state, shared search-index query assembly, IMAP pool limit/read path, frontend transport/event adapter and search store, Search Index settings, entitlement persistence, localized strings, Premium catalogs, website feature copy, tests, and `architecture.md`. No new runtime dependency is required.
