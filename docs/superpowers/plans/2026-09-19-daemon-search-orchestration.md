# Daemon Search Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every locally stored mailbox search return indexed results immediately, keep every result scoped to the current account/mailbox, and run resilient multi-mailbox local/server work in the daemon with Premium-aware bounded concurrency.

**Architecture:** The React/Zustand layer converts the current view into an explicit, immutable search request and renders daemon progress events; it does not fan out mailbox work. A new daemon coordinator owns named cancellation, concurrent local/index and IMAP lanes, one-retry transient handling through the existing IMAP pool, and partial-result events. The existing SQLite FTS index supplies stored `row_json` directly; only uncovered local folders use bounded folder reads.

**Tech Stack:** Rust, Tokio, `futures` already in the workspace, rusqlite/FTS5, daemon JSON-RPC/EventBus, Tauri v2 transport, React, Zustand, Vitest/Testing Library, WebdriverIO, static website i18n generator.

**Spec:** `docs/superpowers/specs/2026-09-19-daemon-search-orchestration-design.md`

**Execution:** A Luna implementation agent executes the tasks and preserves the RED/GREEN evidence; a fresh Sol verification agent reviews the final diff and runs the final Mac mini gates.

## Global Constraints

- The daemon owns target execution, retries, concurrency, cancellation, and local fallback; the frontend owns only view-to-target normalization and rendering.
- The saved `searchMailboxConcurrency` is an integer in `1...5`, default `3`; the effective value at every start boundary is `premium ? (valid saved value or 3) : 1`.
- Logout or Premium loss preserves the saved value but makes the effective value `1`; purchase/login restores the saved value (or `3` if absent), and either transition cancels/restarts an active search.
- The same effective limit independently bounds server mailboxes and unindexed local fallback folders. One SQLite query is never split into batches.
- Clearing, starting another search, changing account, or changing mailbox during `current` scope synchronously advances the frontend generation and best-effort cancels the named daemon run.
- Indexed rows must come from stored `row_json` plus stored filename-derived flags; a matched `.eml` must not be MIME-parsed to assemble an indexed result.
- The existing IMAP pool read path supplies the single retry for dead connections. Permanent `NO`/`BAD` folder failures are recorded and skipped.
- Microsoft Graph remote search remains unsupported in this phase; locally stored Graph mail remains searchable.
- Do not add a query-result cache, remote-only full-message index, runtime dependency, schema table, Tauri-owned search worker, or frontend mailbox fan-out.
- Reuse `DaemonState.events`, the named backup-run cancellation pattern, `ImapPool::run_read`, `futures::stream::buffer_unordered`, `mailvault_core::search_index`, and `vault_files` batch reads.
- Every test command runs through `/Users/Rokas/.claude/bin/testq`; native WebdriverIO runs on the Mac mini with a clone-unique `E2E_TAURI_WD_PORT` and `testq --port`.
- Update `architecture.md` and `CHANGELOG.md` under `Unreleased`; edit English website sources and regenerate localized pages rather than hand-editing generated `website/{de,es,fr,it,ja,ko,pt-br,zh}/` HTML.

## Review Focus

- An empty target set (all accounts hidden, or server-only search with only Graph accounts) must still emit one terminal event and clear the spinner.
- Invalid daemon concurrency (`0`, a value above `5`, or a missing field) must clamp to `1...5` and never create a zero-capacity scheduling hang.
- Reusing an active `searchId` must return `INVALID_PARAMS`; completion of an older run must never remove a newer run's cancellation token.
- A vault/index close or unavailable drive between registration and local work must produce a local failure/terminal frame without panicking, hanging, or publishing rows after cancellation.
- Two folders whose names sanitize to the same vault directory, and vault-only directories no longer present in LIST, must retain an honest local location without being opened as an unrelated server folder.

---

## Interface Map

The tasks below use one wire contract. Keep these names and camelCase serialization exact.

```rust
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailSearchStart {
    pub search_id: String,
    #[serde(default)] pub query: String,
    #[serde(default)] pub sender: Option<String>,
    #[serde(default)] pub date_from: Option<i64>,
    #[serde(default)] pub date_to: Option<i64>,
    #[serde(default)] pub has_attachments: bool,
    pub location: SearchLocation,                 // All | Local | Server
    #[serde(default = "default_concurrency")] pub concurrency: usize,
    #[serde(default)] pub targets: Vec<MailSearchTarget>,
}

fn default_concurrency() -> usize { 1 } // the daemon's safe default is always the free limit

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailSearchTarget {
    pub account_id: String,
    pub account: Option<mailvault_core::imap::ImapConfig>,
    // None means every on-disk vault directory for this account; Some means exactly these server paths.
    pub local_mailboxes: Option<Vec<String>>,
    // LIST paths let the frontend map a sanitized vaultDir back when the mapping is unambiguous.
    #[serde(default)] pub known_mailboxes: Vec<String>,
    #[serde(default)] pub server_mailboxes: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailSearchProgress {
    pub search_id: String,
    pub sequence: u64,
    pub lane: Option<SearchLane>,                 // Local | Server; None only for whole-run terminal
    pub rows: Vec<serde_json::Value>,
    pub completed: usize,
    pub total: usize,
    pub local_mode: Option<LocalMode>,            // Index | Scan
    pub fallback_reason: Option<FallbackReason>,  // Off | Building | Unavailable
    pub coverage: Option<SearchCoverage>,
    pub failures: Vec<SearchFailure>,
    pub terminal: Option<SearchTerminal>,         // Complete | Cancelled | Error
    pub error_key: Option<String>,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SearchLocation { All, Local, Server }
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SearchLane { Local, Server }
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LocalMode { Index, Scan }
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FallbackReason { Off, Building, Unavailable }
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SearchTerminal { Complete, Cancelled, Error }

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchCoverage {
    pub indexed: u64,
    pub total: u64,
    pub complete: bool,
    pub matched: u64,
    pub shown: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFailure {
    pub account_id: String,
    pub mailbox: String,
    pub lane: SearchLane,
    pub code: String, // one of "connection", "mailbox", "credentials", "vault"
}
```

Every emitted row carries `_accountId`, `_mailbox`, `vaultDir` when local, `isLocal`, and `source`. For a vault-only or ambiguous sanitized directory, `_mailbox` is the actual `vaultDir` and `_localOnlyFolder: true`; it is never guessed into a server path. `searchStore.finalize` continues to deduplicate by exact account/mailbox/UID and normalized Message-ID.

### Task 1: Persist and derive Premium search concurrency

**Files:**
- Modify: `src/stores/settingsStore.js:90-120` (`_mergePersistedSettings` normalizers)
- Modify: `src/stores/settingsStore.js:313-318` (search defaults)
- Modify: `src/stores/settingsStore.js:1038-1058` (`resetSettings` defaults)
- Modify: `src/stores/settingsStore.js:1138-1160` (`hasPremiumAccess` helpers)
- Modify: `src/stores/__tests__/settingsStore.test.js:17-38` and append focused entitlement cases

**Interfaces:**
- Consumes: existing `hasPremiumAccess(billingProfile)` and Zustand persisted merge.
- Produces: `normalizeSearchMailboxConcurrency(value): number`, `effectiveSearchMailboxConcurrency(state?): number`, state field `searchMailboxConcurrency`, and gated action `setSearchMailboxConcurrency(value)`.

- [ ] **Step 1: Write failing normalization and entitlement-transition tests**

```js
import {
  _mergePersistedSettings, effectiveSearchMailboxConcurrency,
  normalizeSearchMailboxConcurrency, useSettingsStore,
} from '../settingsStore';

it('normalizes the saved preference to 1..5 with default 3', () => {
  expect([undefined, 'x', 0, 2, 9].map(normalizeSearchMailboxConcurrency)).toEqual([3, 3, 1, 2, 5]);
  const merged = _mergePersistedSettings({ searchMailboxConcurrency: 9 }, { searchMailboxConcurrency: 3 });
  expect(merged.searchMailboxConcurrency).toBe(5);
});

it('preserves the saved preference through logout and restores it on login', () => {
  useSettingsStore.setState({ searchMailboxConcurrency: 5, billingProfile: { hasSubscription: true, status: 'active' } });
  expect(effectiveSearchMailboxConcurrency()).toBe(5);
  useSettingsStore.getState().clearBillingProfile();
  expect(useSettingsStore.getState().searchMailboxConcurrency).toBe(5);
  expect(effectiveSearchMailboxConcurrency()).toBe(1);
  useSettingsStore.getState().setBillingProfile({ hasSubscription: true, status: 'active' });
  expect(effectiveSearchMailboxConcurrency()).toBe(5);
});

it('does not let a free caller overwrite the saved premium preference', () => {
  useSettingsStore.setState({ searchMailboxConcurrency: 4, billingProfile: null });
  useSettingsStore.getState().setSearchMailboxConcurrency(2);
  expect(useSettingsStore.getState().searchMailboxConcurrency).toBe(4);
});
```

- [ ] **Step 2: Run the focused test and preserve the RED output**

Run: `/Users/Rokas/.claude/bin/testq npm test -- src/stores/__tests__/settingsStore.test.js --run`

Expected: FAIL because the two helper exports and persisted field do not exist.

- [ ] **Step 3: Add the minimal saved/effective setting implementation**

```js
export const normalizeSearchMailboxConcurrency = value => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(5, Math.max(1, Math.trunc(parsed))) : 3;
};

export function effectiveSearchMailboxConcurrency(state = useSettingsStore.getState()) {
  return hasPremiumAccess(state?.billingProfile)
    ? normalizeSearchMailboxConcurrency(state?.searchMailboxConcurrency)
    : 1;
}

// In the store defaults:
searchMailboxConcurrency: 3,
setSearchMailboxConcurrency: value => {
  if (!hasPremiumAccess(get().billingProfile)) return;
  set({ searchMailboxConcurrency: normalizeSearchMailboxConcurrency(value) });
},
```

Add `searchMailboxConcurrency: normalizeSearchMailboxConcurrency(...)` to `_mergePersistedSettings`, add `3` to `resetSettings`, and leave `clearBillingProfile` unchanged so logout does not erase the saved field.

- [ ] **Step 4: Run focused settings tests GREEN**

Run: `/Users/Rokas/.claude/bin/testq npm test -- src/stores/__tests__/settingsStore.test.js --run`

Expected: PASS, including default `3`, clamp, free effective `1`, logout preservation, login restoration, and gated writer.

- [ ] **Step 5: Commit the independently reviewable settings model**

```bash
git add src/stores/settingsStore.js src/stores/__tests__/settingsStore.test.js
git commit -m "feat(search): derive premium mailbox concurrency"
```

### Task 2: Return indexed rows without reparsing matched mail

**Files:**
- Modify: `src-core/src/search_index/query.rs:27-59,100-181` (`SearchHit`, `SearchPage`, `search`)
- Modify: `src-core/src/search_index/db.rs:177-216` (scoped coverage helper)
- Modify: `src-daemon/src/search_index.rs:200-305` (`assemble_rows`, `search_reply`)
- Modify: `src-daemon/src/search_index.rs:949-1094` (row assembly/search reply tests)
- Modify: `src-core/src/search_index/query.rs:184-end` (query/coverage tests)

**Interfaces:**
- Consumes: existing `messages.row_json`, `messages.filename`, `mailbox_scan.file_count`, `SearchRequest.mailboxes`, `parse_flags_from_filename`.
- Produces: `SearchHit { vault_dir, uid, filename, message_id, row_json }`, `ScopeCoverage { indexed, total, complete, uncovered_vault_dirs }`, `db::scope_coverage(conn, account_id, mailboxes)`, and index reply fields `mode: "index"`, `coverage`, `uncoveredVaultDirs`.

- [ ] **Step 1: Add a RED test proving indexed assembly survives a missing `.eml`**

```rust
#[test]
fn assemble_rows_uses_row_json_without_reading_the_eml() {
    let page = core::query::SearchPage {
        hits: vec![core::query::SearchHit {
            vault_dir: "INBOX".into(), uid: 7, filename: "7:2,AS.eml".into(),
            message_id: Some("<seven@example>".into()),
            row_json: r#"{"uid":7,"messageId":"<seven@example>","subject":"Indexed only"}"#.into(),
        }],
        total: 1,
        needles: vec!["indexed".into()],
    };
    let rows = assemble_rows(&page);
    assert_eq!(rows[0]["subject"], "Indexed only");
    assert_eq!(rows[0]["flags"], serde_json::json!(["archived", "seen", "\\Seen"]));
    assert_eq!(rows[0]["vaultDir"], "INBOX");
}
```

Also change the existing UID-reissue assembly test: verification now occurs when the result is opened through the existing Message-ID guard, not by reading every hit during search.

- [ ] **Step 2: Add RED scoped coverage tests**

```rust
#[test]
fn scoped_coverage_names_only_incomplete_requested_folders() {
    let conn = fixture_db();
    seed_scan(&conn, "a", "INBOX", 2);
    seed_scan(&conn, "a", "Archive", 3);
    seed_indexed_rows(&conn, "a", "INBOX", 2);
    seed_indexed_rows(&conn, "a", "Archive", 1);
    seed_scan(&conn, "b", "INBOX", 50);
    let c = db::scope_coverage(&conn, "a", Some(&["INBOX".into(), "Archive".into()])).unwrap();
    assert_eq!((c.indexed, c.total, c.complete), (3, 5, false));
    assert_eq!(c.uncovered_vault_dirs, vec!["Archive"]);
}
```

Add cases for `mailboxes=None` (all folders for one account), an explicitly requested mailbox with no `mailbox_scan` row (reported uncovered), body-pending rows, a vault-only `mailbox_scan` row, and two server names that sanitize to the same directory (one directory in coverage, never two invented paths).

- [ ] **Step 3: Run the Rust RED tests**

Run: `/Users/Rokas/.claude/bin/testq cargo test -p mailvault-core search_index::query -- --nocapture`

Run: `/Users/Rokas/.claude/bin/testq cargo test -p mailvault-daemon search_index::tests::assemble_rows -- --nocapture`

Expected: FAIL because `row_json`, `scope_coverage`, and the no-I/O `assemble_rows` signature do not exist.

- [ ] **Step 4: Select and deserialize `row_json` in the index query**

Change the SELECT to:

```rust
"SELECT m.vault_dir, m.uid, m.filename, m.message_id, m.row_json \
 FROM messages m WHERE {where_sql} ORDER BY m.date_utc DESC, m.id DESC LIMIT {limit}"
```

and build `SearchHit { vault_dir, uid, filename, message_id, row_json }`. Keep the existing default `500` and maximum `2000`; this task does not add result caching or paging state.

- [ ] **Step 5: Add scoped coverage from existing tables**

Implement `scope_coverage` using `mailbox_scan LEFT JOIN messages`, limited by account and the same sanitized mailbox set as `search`. Seed explicitly requested sanitized names as an in-memory/SQL `VALUES` scope so a mailbox absent from `mailbox_scan` is still returned as uncovered. A directory is uncovered when it has no scan row, `count(messages) < file_count`, or any row has `body_state = BODY_PENDING`; `indexed` counts non-pending rows, and `total` is `max(file_count, row_count)` summed over the selected scope. No schema migration is needed.

```rust
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeCoverage {
    pub indexed: u64,
    pub total: u64,
    pub complete: bool,
    pub uncovered_vault_dirs: Vec<String>,
}
```

- [ ] **Step 6: Replace per-hit file reads with `row_json` assembly**

```rust
pub fn assemble_rows(page: &core::query::SearchPage) -> Vec<Value> {
    page.hits.iter().filter_map(|hit| {
        let mut row: Value = serde_json::from_str(&hit.row_json).ok()?;
        let flags = parse_flags_from_filename(&hit.filename);
        let obj = row.as_object_mut()?;
        obj.insert("uid".into(), hit.uid.into());
        obj.insert("vaultDir".into(), hit.vault_dir.clone().into());
        obj.insert("flags".into(), serde_json::json!(flags));
        obj.insert("isArchived".into(), flags.iter().any(|f| f == "archived").into());
        Some(row)
    }).collect()
}
```

`search_reply` returns `available:false` with `reason:"off"|"building"|"unavailable"`; when available it returns `mode:"index"`, rows, match count, scoped coverage, and `uncoveredVaultDirs`. Do not recreate `snippet` or `matchedIn` by parsing MIME; the list already renders `subject/from/date` from `row_json`.

- [ ] **Step 7: Run focused and package Rust tests GREEN**

Run: `/Users/Rokas/.claude/bin/testq cargo test -p mailvault-core search_index -- --nocapture`

Run: `/Users/Rokas/.claude/bin/testq cargo test -p mailvault-daemon search_index -- --nocapture`

Expected: PASS and the missing-file test proves result assembly does no matched-file parse.

- [ ] **Step 8: Commit the fast index boundary**

```bash
git add src-core/src/search_index/query.rs src-core/src/search_index/db.rs src-daemon/src/search_index.rs
git commit -m "perf(search): assemble indexed rows from sqlite"
```

### Task 3: Add named daemon runs, local index-first search, and bounded fallback

**Files:**
- Create: `src-daemon/src/handlers/mail_search.rs`
- Modify: `src-daemon/src/handlers/mod.rs:1-end` (export handler)
- Modify: `src-daemon/src/server.rs:35-170,314-324,464-520` (`DaemonState`, route, test constructor)
- Modify: `src-daemon/src/main.rs:388-425` (production state initialization)
- Modify: `src-core/src/search_index/reconcile.rs:106-125` only if a public account-filtered vault directory helper avoids duplicating traversal

**Interfaces:**
- Consumes: Task 2 `search_reply`/coverage contract, `mailvault_core::vault_files::{list,read_light_batch}`, `search_index::reconcile::list_vault_dirs`, `DaemonState.events`.
- Produces: daemon routes `mail_search_start`, `mail_search_cancel`; `DaemonState.search_runs: Mutex<HashMap<String, Arc<SearchRun>>>`; event name `mail-search-progress`; pure `matches_local_row(row, request)`; `run_local_lane(...)`.

- [ ] **Step 1: Write RED route/registry tests in the new handler module**

```rust
#[tokio::test]
async fn duplicate_id_is_rejected_and_cancel_is_named() {
    let state = test_state_with_slow_local_folder();
    assert!(call(&state, "mail_search_start", request("same", 3)).await.result.is_some());
    let duplicate = call(&state, "mail_search_start", request("same", 3)).await;
    assert_eq!(duplicate.error.unwrap().code, ipc::INVALID_PARAMS);
    call(&state, "mail_search_cancel", serde_json::json!({"searchId":"same"})).await;
    wait_until(|| state.search_runs.lock().unwrap().is_empty()).await;
}

#[tokio::test]
async fn empty_targets_emit_terminal_complete() {
    let state = DaemonState::for_test(temp_mail(), temp_app(), true);
    let mut rx = state.events.subscribe();
    call(&state, "mail_search_start", request_with_targets("empty", 3, vec![])).await;
    let event = next_named(&mut rx, "mail-search-progress").await;
    assert_eq!(event["searchId"], "empty");
    assert_eq!(event["terminal"], "complete");
}
```

Add a pointer-identity regression: remove old `SearchRun A`, register `SearchRun B` with the same ID after A is gone, then drop A's guard and assert B remains. Add invalid concurrency cases `0`, `6`, and omitted, asserting effective capacities `1`, `5`, and `1` at the daemon boundary.

- [ ] **Step 2: Write RED local-lane tests**

Create real temporary Maildir fixtures and index rows, then assert:

```rust
#[tokio::test]
async fn local_lane_publishes_index_before_scanning_only_uncovered_folders() {
    let (state, parse_counts) = indexed_and_uncovered_fixture();
    let events = run_and_collect(&state, local_request("r1", 2)).await;
    assert_eq!(events[0]["lane"], "local");
    assert_eq!(events[0]["localMode"], "index");
    assert_eq!(events[0]["rows"][0]["subject"], "already indexed");
    assert_eq!(parse_counts["INBOX"], 0);
    assert_eq!(parse_counts["Archive"], 1);
}
```

Also cover: index off/building/unavailable reasons; free limit `1` never overlaps fallback folders; limit `3` reaches three overlaps but not four; cancellation while folder one is gated schedules no later folder and emits no later rows; vault close/unavailable after registration yields a failure and terminal event; a vault-only directory emits `_localOnlyFolder:true` rather than a guessed server mailbox.

- [ ] **Step 3: Run new daemon tests RED**

Run: `/Users/Rokas/.claude/bin/testq cargo test -p mailvault-daemon handlers::mail_search -- --nocapture`

Expected: compile/test failure because the module, state registry, and routes do not exist.

- [ ] **Step 4: Implement `SearchRun` and pointer-safe guard**

```rust
pub struct SearchRun {
    cancelled: AtomicBool,
    sequence: AtomicU64,
    publish: Mutex<()>,
}

impl SearchRun {
    fn is_cancelled(&self) -> bool { self.cancelled.load(Ordering::SeqCst) }
}
```

Register before spawning. Reject an empty or duplicate active ID. `SearchRunGuard::drop` removes only when `Arc::ptr_eq(current, &self.run)`. `mail_search_cancel` sets the matching token and returns `{ success:true, found:boolean }`. The worker owns the guard until both lanes join and emits nothing after observing cancellation.

- [ ] **Step 5: Implement event publication and terminal accounting**

Use one `emit_progress` helper that takes `run.publish`, checks cancellation, increments the sequence, and calls the synchronous `state.events.emit` before releasing the mutex. This makes event delivery order match sequence order even when two lanes finish together. Per-lane frames accumulate only failures newly observed in that frame; the terminal frame carries the complete failure list and `errorKey:"search.allSourcesFailed"` only when every requested source failed.

- [ ] **Step 6: Implement local index-first behavior**

For each target, call the existing index search once inside `tokio::task::spawn_blocking`; never hold the SQLite mutex or parse files on an async RPC worker. Publish indexed rows immediately. Aggregate per-account coverage by summing `indexed`/`total` and requiring every selected account to be complete. For `localMailboxes:null`, list the account's current on-disk vault directories once and add any directory absent from index coverage to the uncovered set; this catches a new folder created after the last sweep. If coverage is complete, do not parse `.eml` files. If incomplete, convert only the union of `uncoveredVaultDirs` and those new on-disk directories into fallback work; if unavailable, enumerate all requested vault directories for that account and set the exact `fallbackReason`.

Create a `tokio::sync::watch<bool>` named `initial_local_published`. Initialize it to `true` for server-only searches. For local/all searches, set it to `true` only after every target's initial index reply (available or unavailable) has been emitted. The server lane may connect and run concurrently, but must await this watch before its first result/failure publication. This preserves concurrent I/O while making “indexed local results first” deterministic.

For unambiguous mapping, compare `vault_dir_name(path)` across `known_mailboxes`: one match uses that path; zero or multiple matches uses the vault directory plus `_localOnlyFolder:true`.

- [ ] **Step 7: Implement folder-at-a-time fallback with the same filters**

Use `futures::stream::iter(folder_jobs).map(...).buffer_unordered(request.concurrency.clamp(1, 5))`. Each job wraps `vault_files::list`, `read_light_batch`, and Rust filtering in `tokio::task::spawn_blocking`. Check cancellation before spawning and before publishing. Stamp all returned JSON rows in the daemon.

```rust
fn matches_local_row(row: &LightEmail, req: &MailSearchStart) -> bool {
    let query = req.query.trim().to_lowercase();
    let haystack = [&row.subject, &row.from.address, row.from.name.as_deref().unwrap_or(""),
        row.text.as_deref().unwrap_or(""), row.html.as_deref().unwrap_or("")].join(" ").to_lowercase();
    (query.is_empty() || haystack.contains(&query))
        && req.sender.as_deref().is_none_or(|s| {
            let s = s.to_lowercase();
            row.from.address.to_lowercase().contains(&s)
                || row.from.name.as_deref().unwrap_or("").to_lowercase().contains(&s)
        })
        && (!req.has_attachments || row.has_attachments)
        && date_inclusive(row.date.as_deref(), req.date_from, req.date_to)
}

fn date_inclusive(value: Option<&str>, from: Option<i64>, to: Option<i64>) -> bool {
    let Some(raw) = value else { return from.is_none() && to.is_none() };
    let stamp = chrono::DateTime::parse_from_rfc3339(raw)
        .or_else(|_| chrono::DateTime::parse_from_rfc2822(raw))
        .map(|d| d.timestamp());
    match stamp {
        Ok(ts) => from.is_none_or(|lo| ts >= lo) && to.is_none_or(|hi| ts <= hi),
        Err(_) => from.is_none() && to.is_none(),
    }
}
```

- [ ] **Step 8: Wire state construction and route dispatch**

Add `search_runs` to both `src-daemon/src/main.rs` and `DaemonState::for_test`, export `handlers::mail_search`, and dispatch it immediately after `handlers::search_index` so both flat methods receive normal daemon error handling.

- [ ] **Step 9: Run local coordinator tests GREEN**

Run: `/Users/Rokas/.claude/bin/testq cargo test -p mailvault-daemon handlers::mail_search -- --nocapture`

Run: `/Users/Rokas/.claude/bin/testq cargo test -p mailvault-daemon server -- --nocapture`

Expected: PASS; no empty-target hang, duplicate orphan, post-cancel publication, or fallback scan of a covered folder.

- [ ] **Step 10: Commit named local search orchestration**

```bash
git add src-daemon/src/handlers/mail_search.rs src-daemon/src/handlers/mod.rs src-daemon/src/server.rs src-daemon/src/main.rs src-core/src/search_index/reconcile.rs
git commit -m "feat(search): orchestrate cancellable local search in daemon"
```

### Task 4: Add the concurrent resilient IMAP lane and truthful pool ceiling

**Files:**
- Modify: `src-core/src/imap/pool.rs:32,60-70,199-255,430-455`
- Modify: `src-core/src/imap/pool.rs` existing retry/pool tests
- Modify: `src-daemon/src/handlers/mail_search.rs` server lane and tests
- Modify: `src-daemon/src/handlers/imap.rs:114-122,379-403` only to expose/reuse the filter conversion without duplicating behavior

**Interfaces:**
- Consumes: Task 3 `MailSearchStart`, `SearchRun`, publisher; existing `ImapPool::run_read`; `mailvault_core::imap::search_emails`.
- Produces: pool maximum `5`; `run_server_lane(...)`; one mailbox job per explicit `server_mailboxes` path; stable failure codes `connection`, `mailbox`, `credentials`; first-publication wait on Task 3's `initial_local_published` watch.

- [ ] **Step 1: Raise the pool-cap test to five and add retry classification RED tests**

```rust
#[tokio::test]
async fn background_pool_allows_five_and_queues_the_sixth() {
    let peak = exercise_concurrent_background_reads(6).await;
    assert_eq!(peak, 5);
}

#[tokio::test]
async fn permanent_no_is_not_retried() {
    let calls = AtomicUsize::new(0);
    let result = retry_once_on_dead_socket(|_| async {
        calls.fetch_add(1, Ordering::SeqCst);
        Err::<(), _>("NO no such mailbox".into())
    }).await;
    assert!(result.is_err());
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}
```

Keep the existing dead-socket test asserting exactly two attempts.

- [ ] **Step 2: Add RED server-lane partial-success and concurrency tests**

Use the existing mock IMAP server helpers in `handlers/imap.rs` tests. Gate searches and record active/peak counts. Assert limit `1` produces peak `1`, limit `3` produces peak `3`, and limit `5` is not silently capped at `3`. Configure one dead connection (success on retry), one permanent missing folder, and one successful folder; assert successful rows remain and only the permanent folder appears under `failures`.

- [ ] **Step 3: Run IMAP/core and daemon RED tests**

Run: `/Users/Rokas/.claude/bin/testq cargo test -p mailvault-core imap::pool -- --nocapture`

Run: `/Users/Rokas/.claude/bin/testq cargo test -p mailvault-daemon handlers::mail_search::tests::server -- --nocapture`

Expected: pool-cap assertion reports `3`, and the server lane test fails because the lane is absent.

- [ ] **Step 4: Raise only the existing pool ceiling**

Change `const MAX_POOL_SIZE: usize = 3;` to `5`. Do not add another semaphore or retry loop. Preserve `run_read -> run_retrying -> retry_once_on_dead_socket`, which already discards a dead session and retries once.

- [ ] **Step 5: Implement bounded server mailbox jobs**

Flatten explicit `(account, mailbox)` jobs only for targets with `account:Some` and non-empty server mailbox lists. Run them with a separate `buffer_unordered(concurrency.clamp(1,5))`; this stream starts alongside the local stream. Before emitting the first server frame, await Task 3's `initial_local_published` watch so an indexed local frame always wins publication order. Each job calls:

```rust
state.imap_pool.run_read(&account, false, |mut session| {
    let mailbox = mailbox.clone();
    let query = request.query.clone();
    let filters = filters.clone();
    async move {
        let found = mailvault_core::imap::search_emails(
            &mut session, &mailbox, nonempty(&query), filters.from.as_deref(),
            None, filters.since.as_deref(), filters.before.as_deref(),
        ).await.map_err(|e| format!("Failed to search emails: {e}"))?;
        Ok((found, session, Some(mailbox)))
    }
}).await
```

Stamp each row with the job's account/mailbox. Record permanent folder errors and continue. Do not retry outside `run_read` and do not create Graph jobs.

- [ ] **Step 6: Run the focused GREEN tests and IMAP integration suite**

Run: `/Users/Rokas/.claude/bin/testq cargo test -p mailvault-core imap::pool -- --nocapture`

Run: `/Users/Rokas/.claude/bin/testq cargo test -p mailvault-daemon handlers::mail_search -- --nocapture`

Run: `/Users/Rokas/.claude/bin/testq npm run test:imap`

Expected: PASS; a dead socket gets exactly one retry, permanent `NO` does not, and peak work matches clamped limits.

- [ ] **Step 7: Commit server search orchestration**

```bash
git add src-core/src/imap/pool.rs src-daemon/src/handlers/mail_search.rs src-daemon/src/handlers/imap.rs
git commit -m "feat(search): fan out resilient imap searches"
```

### Task 5: Build explicit cross-account targets and expose daemon RPC/events

**Files:**
- Create: `src/services/mailSearch.js`
- Create: `src/services/searchTargets.js`
- Create: `src/services/__tests__/mailSearch.test.js`
- Create: `src/services/__tests__/searchTargets.test.js`
- Modify: `src/services/transport.js:121-205` (`DAEMON_OWNED`)
- Modify: `src/services/__tests__/transportDaemonOwned.test.js:18-60`
- Modify: `src-tauri/src/main.rs:2225-2265,3485-3528` (`reply_timeout` and tests)
- Modify: `src/stores/searchStore.js:12-59` (remove old single-account target helpers after callers migrate)

**Interfaces:**
- Consumes: daemon wire contract, `useMailStore`, `useSettingsStore.hiddenAccounts`, `_resolveMailboxPath`, cached mailbox trees, `ensureFreshToken`, `hasValidCredentials`, Task 1 effective concurrency.
- Produces: `serverSearchTargets(mailboxes): string[]`; `resolveServerScope(account, tree, mail, folder): string[]`; `resolveLocalScope(tree, mail, folder): string[]|null`; `mailboxTreeFor(accountId, mail): Promise<object[]>`; `buildSearchTargets(mailState, settingsState, searchFilters): Promise<MailSearchTarget[]>`; `startMailSearch(request,onProgress): Promise<{unlisten:Function}>`; `cancelMailSearch(searchId): Promise<void>`.

- [ ] **Step 1: Write RED target matrix tests**

```js
it('maps unified current to the selected canonical folder across visible accounts', async () => {
  const targets = await buildSearchTargets(unifiedState({ unifiedFolder: 'Sent', hidden: { b: true } }), settings(), filters('current'));
  expect(targets.map(t => [t.accountId, t.localMailboxes, t.serverMailboxes])).toEqual([
    ['a', ['Sent Items'], ['Sent Items']],
    ['c', ['Sent'], ['Sent']],
  ]);
});

it('maps unified all to every selectable folder but keeps all on-disk local dirs eligible', async () => {
  const [target] = await buildSearchTargets(unifiedState(), settings(), filters('all'));
  expect(target.localMailboxes).toBeNull();
  expect(target.serverMailboxes).toEqual(['INBOX', 'Archive']);
});

it('keeps Graph local and emits no remote server work', async () => {
  const [target] = await buildSearchTargets(graphState(), settings(), filters('all'));
  expect(target.account).toBeNull();
  expect(target.serverMailboxes).toEqual([]);
  expect(target.localMailboxes).toBeNull();
});
```

Add named-folder/subtree cases (active account only), `\Noselect`/duplicate filtering, hidden-account exclusion, and an all-hidden result of `[]`.

- [ ] **Step 2: Write RED event-listener ordering test**

Mock `@tauri-apps/api/event.listen` and transport `send`. Assert `startMailSearch` installs the listener before sending `mail_search_start`, forwards only `mail-search-progress`, unlistens on start failure, and `cancelMailSearch` sends `{ searchId }` without throwing when the daemon is already gone.

- [ ] **Step 3: Run service tests RED**

Run: `/Users/Rokas/.claude/bin/testq npm test -- src/services/__tests__/searchTargets.test.js src/services/__tests__/mailSearch.test.js src/services/__tests__/transportDaemonOwned.test.js --run`

Expected: FAIL because the new modules and owned methods do not exist.

- [ ] **Step 4: Implement target normalization without search execution**

`buildSearchTargets` takes snapshots, never reads Zustand after its first line, and resolves fresh OAuth tokens with `Promise.all` only for IMAP-capable server targets. `mailboxTreeFor` returns `mail.mailboxes` for the active account and otherwise `getAccountCacheMailboxes(accountId) ?? []`. `serverSearchTargets` preserves the existing INBOX-first, no-`\Noselect`, deduplicated behavior. `resolveServerScope` maps unified `current` through `_resolveMailboxPath`, returns every selectable path for `all`, and returns the selected path/branch for single-account named/subtree scope. `resolveLocalScope` returns `null` for `all`, the same explicit array for named/subtree scope, and the resolved one-folder array for `current`. For unified `current`, use `_resolveMailboxPath` against each account's cached mailbox tree and the selected `unifiedFolder`; for unified `all`, use every visible account. For single-account `current`/specific/subtree, target only the active account. Preserve `knownMailboxes` for local location recovery.

```js
export async function buildSearchTargets(mail, settings, filters) {
  const visible = mail.accounts.filter(a => !settings.hiddenAccounts?.[a.id]);
  const selected = mail.unifiedInbox ? visible : visible.filter(a => a.id === mail.activeAccountId);
  return Promise.all(selected.map(async account => {
    const tree = await mailboxTreeFor(account.id, mail);
    const serverMailboxes = resolveServerScope(account, tree, mail, filters.folder);
    const canSearchServer = account.oauth2Transport !== 'graph' && hasValidCredentials(account);
    return {
      accountId: account.id,
      account: canSearchServer ? await ensureFreshToken(account) : null,
      localMailboxes: resolveLocalScope(tree, mail, filters.folder),
      knownMailboxes: serverSearchTargets(tree),
      serverMailboxes: canSearchServer ? serverMailboxes : [],
    };
  }));
}
```

- [ ] **Step 5: Implement the thin event/RPC adapter**

Register `listen('mail-search-progress', ...)` before `send('mail_search_start', request)`. Return the unlisten function to the store. `cancelMailSearch` catches/logs daemon shutdown because cancellation is best effort; start failures still reject.

- [ ] **Step 6: Add daemon-owned names and timeout budgets**

Add `mail_search_start` and `mail_search_cancel` to `DAEMON_OWNED` and to the 30-second `reply_timeout` arm. Extend both existing enumeration tests so a missing routing/budget entry fails deterministically.

- [ ] **Step 7: Run JS service tests and Tauri timeout tests GREEN**

Run: `/Users/Rokas/.claude/bin/testq npm test -- src/services/__tests__/searchTargets.test.js src/services/__tests__/mailSearch.test.js src/services/__tests__/transportDaemonOwned.test.js --run`

Run: `/Users/Rokas/.claude/bin/testq cargo test -p mailvault reply_timeout -- --nocapture`

Expected: PASS with event listener established before start and all target matrix cases exact.

- [ ] **Step 8: Commit the frontend/daemon boundary**

```bash
git add src/services/mailSearch.js src/services/searchTargets.js src/services/__tests__/mailSearch.test.js src/services/__tests__/searchTargets.test.js src/services/transport.js src/services/__tests__/transportDaemonOwned.test.js src-tauri/src/main.rs src/stores/searchStore.js
git commit -m "feat(search): send explicit targets to daemon"
```

### Task 6: Make searchStore generation-safe and restart on context/entitlement changes

**Files:**
- Modify: `src/stores/searchStore.js:62-312` (`finalize`, run state, `performSearch`, `clearSearch`)
- Modify: `src/stores/__tests__/searchStore.test.js:1-end`
- Modify: `src/components/SearchBar.jsx:37-68,571-590` (restart lifecycle and progress/fallback rendering)
- Modify: `src/components/__tests__/searchSubfolders.test.jsx:1-end`
- Create: `src/components/__tests__/SearchBarLifecycle.test.jsx`

**Interfaces:**
- Consumes: Tasks 1 and 5 helpers/adapters and `MailSearchProgress` frames.
- Produces: store fields `activeSearchId`, `searchGeneration`, `lastSequence`, `searchFallback`; actions `handleSearchProgress(frame)`, `restartSearch()`, generation-safe `performSearch()` and `clearSearch()`.

- [ ] **Step 1: Replace legacy mocks with the daemon adapter and write stale-clear RED test**

```js
it('clear invalidates synchronously and late events cannot republish rows', async () => {
  startMailSearch.mockImplementation(async (_request, onProgress) => {
    progress = onProgress;
    return { unlisten: vi.fn() };
  });
  useSearchStore.setState({ searchQuery: 'old' });
  await useSearchStore.getState().performSearch();
  const oldId = useSearchStore.getState().activeSearchId;
  useSearchStore.getState().clearSearch();
  progress({ searchId: oldId, sequence: 1, lane: 'server', rows: [row('stale')] });
  expect(cancelMailSearch).toHaveBeenCalledWith(oldId);
  expect(useSearchStore.getState().searchResults).toEqual([]);
  expect(useSearchStore.getState().searchActive).toBe(false);
});
```

- [ ] **Step 2: Write obsolete/out-of-order/terminal RED tests**

Assert frames for an old ID, the same sequence, or a lower sequence are ignored; local sequence `1` followed by server sequence `2` merges; a terminal frame stops searching and writes history once; an all-source-error terminal clears the spinner but preserves any already-published rows and exposes `errorKey`.

- [ ] **Step 3: Write context and entitlement restart RED tests**

Render `SearchBar`, begin a `current` search, then mutate the account store from unified `UNIFIED/INBOX` to account `b/Archive`. Assert cancellation of the old ID, a second start whose targets contain only account `b`/`Archive`, and no old row. Change the saved concurrency `3 -> 5` while Premium and assert restart with `5`; clear billing and assert saved remains `5`, restart sends `1`; restore billing and assert restart sends `5`. For explicit `folder:'all'`, a same-account mailbox-only change must not restart.

- [ ] **Step 4: Run store/component tests RED**

Run: `/Users/Rokas/.claude/bin/testq npm test -- src/stores/__tests__/searchStore.test.js src/components/__tests__/SearchBarLifecycle.test.jsx src/components/__tests__/searchSubfolders.test.jsx --run`

Expected: FAIL because clear does not advance the old run and the component has no context/entitlement lifecycle.

- [ ] **Step 5: Replace frontend fan-out with one generation-safe start**

At module scope retain only `let generation = 0`, `let activeUnlisten = null`, and `let activeId = null`. `performSearch` snapshots query/filters/mail/settings, increments generation, detaches/cancels the previous run, resets results, builds explicit targets, rechecks its generation after every await, then starts the daemon listener/RPC. Generate IDs with `crypto.randomUUID()` when available and a timestamp/counter fallback for tests.

```js
handleSearchProgress: frame => set(state => {
  if (frame.searchId !== state.activeSearchId || frame.sequence <= state.lastSequence) return state;
  const merged = finalize([...state.searchResults, ...(frame.rows || [])], state.searchSnapshot);
  return {
    searchResults: merged,
    lastSequence: frame.sequence,
    searchProgress: frame.terminal ? null : { done: frame.completed, total: frame.total },
    searchIndexCoverage: frame.coverage ?? state.searchIndexCoverage,
    searchFallback: frame.localMode === 'scan' ? frame.fallbackReason : state.searchFallback,
    searchError: frame.errorKey || state.searchError,
    isSearching: !frame.terminal,
  };
}),
```

`clearSearch` first increments `generation`, nulls the active ID/listener, and calls `cancelMailSearch(oldId)` without awaiting; only then reset visible state. `performSearch` writes history only when the terminal frame belongs to the active ID.

- [ ] **Step 6: Add `SearchBar` restart effects from stable scalar selectors**

Select `activeAccountId`, `activeMailbox`, `unifiedInbox`, `unifiedFolder`, and `effectiveSearchMailboxConcurrency(state)`. Store the previous scalar tuple in a ref and skip first render. If an active search exists, restart on account/unified-mode changes; restart on mailbox/unified-folder changes only for `folder:'current'`; restart whenever effective concurrency changes. Effects call `restartSearch`, which preserves query/filters and delegates to `performSearch`.

- [ ] **Step 7: Render truthful fallback progress**

In the existing result indicator, render a compact notice when `searchFallback` is set: `off`, `building`, and `unavailable` select distinct localized copy. The index action calls the existing `useMailStore.getState().requestSettingsTab('storage')`; the upgrade action calls `requestSettingsTab('billing')`. Show the compact upgrade button only when `effectiveSearchMailboxConcurrency(...) === 1` and `hasPremiumAccess(...)` is false; the copy states that Premium speeds multi-folder search, never that indexing requires Premium. Add component assertions for both exact requested tab IDs.

- [ ] **Step 8: Run focused lifecycle tests GREEN**

Run: `/Users/Rokas/.claude/bin/testq npm test -- src/stores/__tests__/searchStore.test.js src/components/__tests__/SearchBarLifecycle.test.jsx src/components/__tests__/searchSubfolders.test.jsx --run`

Expected: PASS for clear, new query, out-of-order frames, All Inboxes-to-mailbox switch, effective limit transitions, and no needless explicit-all restart.

- [ ] **Step 9: Commit the lifecycle/root-cause fix**

```bash
git add src/stores/searchStore.js src/stores/__tests__/searchStore.test.js src/components/SearchBar.jsx src/components/__tests__/SearchBarLifecycle.test.jsx src/components/__tests__/searchSubfolders.test.jsx
git commit -m "fix(search): cancel stale runs on context changes"
```

### Task 7: Add the settings control, localized fallback copy, and Premium catalog entry

**Files:**
- Modify: `src/components/settings/SearchIndexSettings.jsx:1-167`
- Modify: `src/components/settings/StorageSettings.jsx:31,381` (pass `onUpgrade`)
- Modify: `src/components/settings/__tests__/SearchIndexSettings.test.jsx:1-end`
- Modify: `src/data/premiumFeatures.js:1-30`
- Modify: `src/i18n/locales/en.json`, `de.json`, `es.json`, `fr.json`, `it.json`, `ja.json`, `ko.json`, `pt-BR.json`, `zh-Hans.json`
- Modify: `src/i18n/__tests__/catalogs.test.js`
- Modify: `src/components/settings/__tests__/premiumFeatureList.test.jsx`
- Modify: `src/components/onboarding/__tests__/premiumGallery.test.jsx`

**Interfaces:**
- Consumes: Task 1 saved/effective helpers, existing `Button`, `onUpgrade`, settings anchor `settings-search-index`.
- Produces: `SearchIndexSettings({ onUpgrade })` with `data-testid="search-mailbox-concurrency"`; Premium feature ID `fast-multi-folder-search` with `tab:'storage'`.

- [ ] **Step 1: Write RED settings UI tests**

```jsx
it('shows fixed one plus upgrade for a free user', () => {
  useSettingsStore.setState({ billingProfile: null, searchMailboxConcurrency: 4 });
  const onUpgrade = vi.fn();
  render(<SearchIndexSettings onUpgrade={onUpgrade} />);
  expect(screen.getByTestId('search-mailbox-concurrency')).toHaveValue('1');
  expect(screen.getByTestId('search-mailbox-concurrency')).toBeDisabled();
  fireEvent.click(screen.getByTestId('search-concurrency-upgrade'));
  expect(onUpgrade).toHaveBeenCalledOnce();
});

it('lets premium save 1..5', () => {
  useSettingsStore.setState({ billingProfile: { hasSubscription: true, status: 'active' }, searchMailboxConcurrency: 3 });
  render(<SearchIndexSettings onUpgrade={vi.fn()} />);
  fireEvent.change(screen.getByTestId('search-mailbox-concurrency'), { target: { value: '5' } });
  expect(useSettingsStore.getState().searchMailboxConcurrency).toBe(5);
});
```

- [ ] **Step 2: Add RED catalog and locale parity assertions**

Assert `PREMIUM_FEATURES` contains exactly one `fast-multi-folder-search`, its title/blurb keys exist in every app locale, and every newly referenced `search.fallback.*`/`settings.searchIndex.concurrency*` key exists in every locale.

- [ ] **Step 3: Run settings/catalog tests RED**

Run: `/Users/Rokas/.claude/bin/testq npm test -- src/components/settings/__tests__/SearchIndexSettings.test.jsx src/components/settings/__tests__/premiumFeatureList.test.jsx src/components/onboarding/__tests__/premiumGallery.test.jsx src/i18n/__tests__/catalogs.test.js --run`

Expected: FAIL because the control, feature, and localized keys do not exist.

- [ ] **Step 4: Add the concurrency control to the existing card**

Pass `onUpgrade` from `StorageSettings`. Add a five-option select. Premium binds the saved field; free binds effective `1`, is disabled, and shows a small upgrade button. Keep index toggles available to free users.

```jsx
<select data-testid="search-mailbox-concurrency" value={effective} disabled={!isPremium}
  onChange={e => setSearchMailboxConcurrency(Number(e.target.value))}>
  {[1,2,3,4,5].map(n => <option key={n} value={n}>{n}</option>)}
</select>
```

- [ ] **Step 5: Add exact English keys and localized equivalents**

Add these English source values, then add meaning-equivalent translations under the same keys in all eight non-English app catalogs:

```json
{
  "search.fallback.off": "Search is reading your saved folders because the index is off. Build the index for faster results.",
  "search.fallback.building": "Indexed results are still being built. Search is reading the folders not indexed yet.",
  "search.fallback.unavailable": "The search index is unavailable, so Search is reading saved folders directly.",
  "search.fallback.openSettings": "Search index settings",
  "search.fallback.upgrade": "Upgrade for faster multi-folder search",
  "search.allSourcesFailed": "Search could not read any selected folder. Try again.",
  "settings.searchIndex.concurrency": "Mailboxes searched at once",
  "settings.searchIndex.concurrencyHint": "Premium can search 1 to 5 server mailboxes and fallback folders at once. Indexed search stays instant.",
  "settings.searchIndex.concurrencyFree": "Free searches one server mailbox and one fallback folder at a time.",
  "premium.fastMultiFolderSearch.title": "Faster multi-folder search",
  "premium.fastMultiFolderSearch.blurb": "Search up to five server mailboxes and unindexed local folders at once, with a concurrency level you control."
}
```

Do not translate “indexing” as a Premium-only capability. Preserve interpolation tokens exactly where a locale value has them.

Use these exact non-English values (the catalogs are flat JSON, so merge these entries at the existing search/settings/premium key groups):

```json
// de.json
{"search.fallback.off":"Die Suche liest Ihre gespeicherten Ordner, weil der Index deaktiviert ist. Erstellen Sie den Index für schnellere Ergebnisse.","search.fallback.building":"Die indexierten Ergebnisse werden noch erstellt. Die Suche liest die noch nicht indexierten Ordner.","search.fallback.unavailable":"Der Suchindex ist nicht verfügbar, daher liest die Suche gespeicherte Ordner direkt.","search.fallback.openSettings":"Suchindex-Einstellungen","search.fallback.upgrade":"Upgrade für eine schnellere Suche in mehreren Ordnern","search.allSourcesFailed":"Die Suche konnte keinen ausgewählten Ordner lesen. Versuchen Sie es erneut.","settings.searchIndex.concurrency":"Gleichzeitig durchsuchte Postfächer","settings.searchIndex.concurrencyHint":"Premium kann 1 bis 5 Server-Postfächer und Ersatzordner gleichzeitig durchsuchen. Die indexierte Suche bleibt sofort verfügbar.","settings.searchIndex.concurrencyFree":"Kostenlos wird jeweils ein Server-Postfach und ein Ersatzordner durchsucht.","premium.fastMultiFolderSearch.title":"Schnellere Suche in mehreren Ordnern","premium.fastMultiFolderSearch.blurb":"Durchsuchen Sie bis zu fünf Server-Postfächer und nicht indexierte lokale Ordner gleichzeitig, mit einer von Ihnen festgelegten Parallelität."}
// es.json
{"search.fallback.off":"La búsqueda está leyendo tus carpetas guardadas porque el índice está desactivado. Crea el índice para obtener resultados más rápidos.","search.fallback.building":"Los resultados indexados todavía se están creando. La búsqueda está leyendo las carpetas aún no indexadas.","search.fallback.unavailable":"El índice de búsqueda no está disponible, así que la búsqueda está leyendo directamente las carpetas guardadas.","search.fallback.openSettings":"Ajustes del índice de búsqueda","search.fallback.upgrade":"Mejora el plan para buscar más rápido en varias carpetas","search.allSourcesFailed":"La búsqueda no pudo leer ninguna carpeta seleccionada. Inténtalo de nuevo.","settings.searchIndex.concurrency":"Buzones buscados a la vez","settings.searchIndex.concurrencyHint":"Premium puede buscar de 1 a 5 buzones del servidor y carpetas alternativas a la vez. La búsqueda indexada sigue siendo instantánea.","settings.searchIndex.concurrencyFree":"El plan gratuito busca un buzón del servidor y una carpeta alternativa a la vez.","premium.fastMultiFolderSearch.title":"Búsqueda más rápida en varias carpetas","premium.fastMultiFolderSearch.blurb":"Busca hasta cinco buzones del servidor y carpetas locales sin indexar a la vez, con el nivel de concurrencia que elijas."}
// fr.json
{"search.fallback.off":"La recherche lit vos dossiers enregistrés car l’index est désactivé. Créez l’index pour obtenir des résultats plus rapides.","search.fallback.building":"Les résultats indexés sont encore en cours de création. La recherche lit les dossiers qui ne sont pas encore indexés.","search.fallback.unavailable":"L’index de recherche est indisponible ; la recherche lit donc directement les dossiers enregistrés.","search.fallback.openSettings":"Réglages de l’index de recherche","search.fallback.upgrade":"Passez à Premium pour une recherche multidossier plus rapide","search.allSourcesFailed":"La recherche n’a pu lire aucun dossier sélectionné. Réessayez.","settings.searchIndex.concurrency":"Boîtes recherchées simultanément","settings.searchIndex.concurrencyHint":"Premium peut rechercher simultanément dans 1 à 5 boîtes serveur et dossiers de secours. La recherche indexée reste instantanée.","settings.searchIndex.concurrencyFree":"La version gratuite recherche une boîte serveur et un dossier de secours à la fois.","premium.fastMultiFolderSearch.title":"Recherche multidossier plus rapide","premium.fastMultiFolderSearch.blurb":"Recherchez jusqu’à cinq boîtes serveur et dossiers locaux non indexés à la fois, avec le niveau de concurrence de votre choix."}
// it.json
{"search.fallback.off":"La ricerca sta leggendo le cartelle salvate perché l’indice è disattivato. Crea l’indice per risultati più rapidi.","search.fallback.building":"I risultati indicizzati sono ancora in fase di creazione. La ricerca sta leggendo le cartelle non ancora indicizzate.","search.fallback.unavailable":"L’indice di ricerca non è disponibile, quindi la ricerca legge direttamente le cartelle salvate.","search.fallback.openSettings":"Impostazioni dell’indice di ricerca","search.fallback.upgrade":"Passa a Premium per una ricerca più rapida in più cartelle","search.allSourcesFailed":"La ricerca non ha potuto leggere nessuna cartella selezionata. Riprova.","settings.searchIndex.concurrency":"Caselle cercate contemporaneamente","settings.searchIndex.concurrencyHint":"Premium può cercare contemporaneamente da 1 a 5 caselle server e cartelle di ripiego. La ricerca indicizzata resta istantanea.","settings.searchIndex.concurrencyFree":"La versione gratuita cerca una casella server e una cartella di ripiego alla volta.","premium.fastMultiFolderSearch.title":"Ricerca più rapida in più cartelle","premium.fastMultiFolderSearch.blurb":"Cerca fino a cinque caselle server e cartelle locali non indicizzate alla volta, con il livello di concorrenza che scegli."}
// ja.json
{"search.fallback.off":"インデックスがオフのため、保存済みフォルダーを直接読み取って検索しています。より速く検索するにはインデックスを作成してください。","search.fallback.building":"インデックス結果を作成中です。まだインデックスされていないフォルダーを読み取って検索しています。","search.fallback.unavailable":"検索インデックスを利用できないため、保存済みフォルダーを直接読み取っています。","search.fallback.openSettings":"検索インデックス設定","search.fallback.upgrade":"複数フォルダーをより速く検索するにはアップグレード","search.allSourcesFailed":"選択したフォルダーを読み取れませんでした。もう一度お試しください。","settings.searchIndex.concurrency":"同時に検索するメールボックス数","settings.searchIndex.concurrencyHint":"Premiumでは、サーバーメールボックスと代替読み取りフォルダーを1〜5件同時に検索できます。インデックス検索は常に瞬時です。","settings.searchIndex.concurrencyFree":"無料版では、サーバーメールボックス1件と代替読み取りフォルダー1件を同時に検索します。","premium.fastMultiFolderSearch.title":"複数フォルダーをより高速に検索","premium.fastMultiFolderSearch.blurb":"サーバー上のメールボックスと未インデックスのローカルフォルダーを最大5件まで、指定した並列数で同時に検索します。"}
// ko.json
{"search.fallback.off":"인덱스가 꺼져 있어 저장된 폴더를 직접 읽어 검색하고 있습니다. 더 빠른 결과를 위해 인덱스를 만드세요.","search.fallback.building":"인덱스 결과를 아직 만드는 중입니다. 인덱싱되지 않은 폴더를 직접 읽어 검색하고 있습니다.","search.fallback.unavailable":"검색 인덱스를 사용할 수 없어 저장된 폴더를 직접 읽고 있습니다.","search.fallback.openSettings":"검색 인덱스 설정","search.fallback.upgrade":"더 빠른 다중 폴더 검색으로 업그레이드","search.allSourcesFailed":"선택한 폴더를 읽지 못했습니다. 다시 시도하세요.","settings.searchIndex.concurrency":"동시에 검색할 편지함 수","settings.searchIndex.concurrencyHint":"Premium에서는 서버 편지함과 대체 검색 폴더를 1개에서 5개까지 동시에 검색할 수 있습니다. 인덱스 검색은 계속 즉시 실행됩니다.","settings.searchIndex.concurrencyFree":"무료 버전은 서버 편지함 하나와 대체 검색 폴더 하나를 동시에 검색합니다.","premium.fastMultiFolderSearch.title":"더 빠른 다중 폴더 검색","premium.fastMultiFolderSearch.blurb":"사용자가 정한 동시 실행 수로 서버 편지함과 인덱싱되지 않은 로컬 폴더를 최대 5개까지 한 번에 검색합니다."}
// pt-BR.json
{"search.fallback.off":"A pesquisa está lendo suas pastas salvas porque o índice está desativado. Crie o índice para obter resultados mais rápidos.","search.fallback.building":"Os resultados indexados ainda estão sendo criados. A pesquisa está lendo as pastas que ainda não foram indexadas.","search.fallback.unavailable":"O índice de pesquisa está indisponível, então a pesquisa está lendo diretamente as pastas salvas.","search.fallback.openSettings":"Configurações do índice de pesquisa","search.fallback.upgrade":"Faça upgrade para pesquisar várias pastas mais rapidamente","search.allSourcesFailed":"A pesquisa não conseguiu ler nenhuma pasta selecionada. Tente novamente.","settings.searchIndex.concurrency":"Caixas pesquisadas ao mesmo tempo","settings.searchIndex.concurrencyHint":"O Premium pode pesquisar de 1 a 5 caixas do servidor e pastas alternativas ao mesmo tempo. A pesquisa indexada continua instantânea.","settings.searchIndex.concurrencyFree":"O plano gratuito pesquisa uma caixa do servidor e uma pasta alternativa por vez.","premium.fastMultiFolderSearch.title":"Pesquisa mais rápida em várias pastas","premium.fastMultiFolderSearch.blurb":"Pesquise até cinco caixas do servidor e pastas locais não indexadas ao mesmo tempo, com o nível de simultaneidade que você escolher."}
// zh-Hans.json
{"search.fallback.off":"搜索索引已关闭，因此正在直接读取已保存的文件夹。创建索引可更快获得结果。","search.fallback.building":"索引结果仍在构建中。搜索正在读取尚未编入索引的文件夹。","search.fallback.unavailable":"搜索索引不可用，因此正在直接读取已保存的文件夹。","search.fallback.openSettings":"搜索索引设置","search.fallback.upgrade":"升级以更快搜索多个文件夹","search.allSourcesFailed":"无法读取任何所选文件夹。请重试。","settings.searchIndex.concurrency":"同时搜索的邮箱数","settings.searchIndex.concurrencyHint":"Premium 可同时搜索 1 至 5 个服务器邮箱和回退文件夹。索引搜索仍会即时完成。","settings.searchIndex.concurrencyFree":"免费版每次搜索一个服务器邮箱和一个回退文件夹。","premium.fastMultiFolderSearch.title":"更快的多文件夹搜索","premium.fastMultiFolderSearch.blurb":"可按您选择的并发级别，同时搜索最多五个服务器邮箱和未编入索引的本地文件夹。"}
```

- [ ] **Step 6: Add the catalog feature**

Import `Gauge` from `lucide-react` and append:

```js
{ id: 'fast-multi-folder-search', icon: Gauge,
  titleKey: 'premium.fastMultiFolderSearch.title',
  blurbKey: 'premium.fastMultiFolderSearch.blurb', shot: null, tab: 'storage' },
```

- [ ] **Step 7: Run focused and full locale tests GREEN**

Run: `/Users/Rokas/.claude/bin/testq npm test -- src/components/settings/__tests__/SearchIndexSettings.test.jsx src/components/settings/__tests__/premiumFeatureList.test.jsx src/components/onboarding/__tests__/premiumGallery.test.jsx src/i18n/__tests__/catalogs.test.js --run`

Expected: PASS; free cannot mutate, Premium can choose all five values, and every locale has all keys.

- [ ] **Step 8: Commit settings and app messaging**

```bash
git add src/components/settings/SearchIndexSettings.jsx src/components/settings/StorageSettings.jsx src/components/settings/__tests__/SearchIndexSettings.test.jsx src/data/premiumFeatures.js src/i18n/locales src/i18n
git commit -m "feat(search): expose premium concurrency setting"
```

### Task 8: Update website feature messaging and regenerate localized pages

**Files:**
- Modify: `website/features.html:194-225,826-870`
- Modify (generated by existing script): `website/pricing.html`
- Modify: `website/i18n/corpus.json`, `website/i18n/strings.json`, and `website/i18n/locales/{de,es,fr,it,ja,ko,pt-br,zh}/blocks-*.json` selected by extractor keys
- Modify (generated): `website/{de,es,fr,it,ja,ko,pt-br,zh}/features.html`, `pricing.html`, locale navigation/sitemap/search-index outputs touched by `npm run i18n`
- Modify: `website/__tests__/premium-catalog.test.js`

**Interfaces:**
- Consumes: Task 7 `PREMIUM_FEATURES` and app English locale.
- Produces: pricing catalog with 13 entries; feature page copy that distinguishes free instant indexed search from Premium multi-folder concurrency.

- [ ] **Step 1: Strengthen catalog RED assertions**

```js
it('publishes fast multi-folder search with app copy', () => {
  const d = new JSDOM(readFileSync('website/pricing.html','utf8')).window.document;
  const detail = d.getElementById('premium-fast-multi-folder-search');
  expect(detail).not.toBeNull();
  expect(detail.textContent).toContain('Search up to five server mailboxes');
  expect(d.querySelectorAll('.mv-premium-detail')).toHaveLength(13);
});
```

- [ ] **Step 2: Run catalog test RED**

Run: `/Users/Rokas/.claude/bin/testq npx vitest run website/__tests__/premium-catalog.test.js`

Expected: FAIL because pricing has 12 catalog entries.

- [ ] **Step 3: Regenerate pricing from the canonical app catalog**

Run: `/Users/Rokas/.claude/bin/testq python3 scripts/generate-premium-web.py`

Expected: output `Generated 13 Premium features from the app catalog`; never hand-copy the 13th entry into pricing.

- [ ] **Step 4: Update the English features page**

Under Email Management, change the capability count to `17`, retain the existing advanced-filter line, and add:

```html
<li class="flex items-start gap-3">
  <!-- reuse the adjacent check SVG exactly -->
  <span class="text-slate-700 dark:text-slate-300"><strong>Instant indexed search for locally stored mail</strong> — results come from the private index in your vault, even offline</span>
</li>
```

Under Premium Features, change the count to `12` and add:

```html
<li class="flex items-start gap-3">
  <!-- reuse the adjacent amber check SVG exactly -->
  <span class="text-slate-700 dark:text-slate-300"><strong>Faster multi-folder search</strong> <span class="align-middle inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400">Premium</span> — search up to five server mailboxes and unindexed local folders at once, with a concurrency level you control</span>
</li>
```

The HTML comments in the sketch mean to copy the exact existing SVG element from the immediately neighboring list item; do not ship the comments instead of icons.

- [ ] **Step 5: Extract, translate the new corpus entries, and verify no English fallback**

Run the extractor first:

Run: `/Users/Rokas/.claude/bin/testq bash -lc 'cd website && node i18n/i18n.mjs extract && node i18n/i18n.mjs status'`

For the two new feature-page strings and the generated pricing title/blurb, fill the exact hash keys emitted into each locale's `blocks-*.json`. Use these translations:

| Locale | Instant local-index copy | Premium concurrency copy |
| --- | --- | --- |
| de | **Sofortige indexierte Suche in lokal gespeicherten E-Mails** — Ergebnisse kommen aus dem privaten Index in Ihrem Tresor, auch offline | **Schnellere Suche in mehreren Ordnern** — Durchsuchen Sie bis zu fünf Server-Postfächer und nicht indexierte lokale Ordner gleichzeitig, mit einer von Ihnen festgelegten Parallelität |
| es | **Búsqueda indexada instantánea en el correo guardado localmente** — los resultados provienen del índice privado de tu bóveda, incluso sin conexión | **Búsqueda más rápida en varias carpetas** — busca hasta cinco buzones del servidor y carpetas locales sin indexar a la vez, con el nivel de concurrencia que elijas |
| fr | **Recherche indexée instantanée dans les e-mails stockés localement** — les résultats proviennent de l'index privé de votre coffre, même hors connexion | **Recherche multidossier plus rapide** — recherchez jusqu'à cinq boîtes serveur et dossiers locaux non indexés à la fois, avec le niveau de concurrence de votre choix |
| it | **Ricerca indicizzata istantanea nella posta salvata localmente** — i risultati provengono dall'indice privato del vault, anche offline | **Ricerca più rapida in più cartelle** — cerca fino a cinque caselle server e cartelle locali non indicizzate alla volta, con il livello di concorrenza che scegli |
| ja | **ローカル保存メールを瞬時にインデックス検索** — オフラインでも、保管庫内のプライベートなインデックスから結果を表示します | **複数フォルダーをより高速に検索** — サーバー上のメールボックスと未インデックスのローカルフォルダーを最大5件まで、指定した並列数で同時に検索します |
| ko | **로컬 저장 메일 즉시 인덱스 검색** — 오프라인에서도 보관함의 비공개 인덱스에서 결과를 가져옵니다 | **더 빠른 다중 폴더 검색** — 사용자가 정한 동시 실행 수로 서버 편지함과 인덱싱되지 않은 로컬 폴더를 최대 5개까지 한 번에 검색합니다 |
| pt-BR | **Pesquisa indexada instantânea nos e-mails salvos localmente** — os resultados vêm do índice privado do seu cofre, mesmo offline | **Pesquisa mais rápida em várias pastas** — pesquise até cinco caixas do servidor e pastas locais não indexadas ao mesmo tempo, com o nível de simultaneidade que você escolher |
| zh-Hans | **即时搜索本地存储邮件的索引** — 即使离线，结果也来自您保管库中的私有索引 | **更快的多文件夹搜索** — 可按您选择的并发级别，同时搜索最多五个服务器邮箱和未编入索引的本地文件夹 |

Translate the generated pricing title/blurb with the same terminology; keep the numeric `5` and HTML markup unchanged.

- [ ] **Step 6: Build and verify localized website output**

Run: `/Users/Rokas/.claude/bin/testq bash -lc 'cd website && npm run i18n && node i18n/i18n.mjs status'`

Expected: build/verify exit `0`, status reports no untranslated new keys, and localized `features.html`/`pricing.html` contain the new translated feature.

- [ ] **Step 7: Run catalog and website tests GREEN**

Run: `/Users/Rokas/.claude/bin/testq npx vitest run website/__tests__/premium-catalog.test.js`

Run: `/Users/Rokas/.claude/bin/testq npx vitest run website/__tests__`

Expected: PASS with 13 generated pricing entries and no locale verification failure.

- [ ] **Step 8: Commit canonical and generated website outputs together**

```bash
git add website scripts/generate-premium-web.py src/data/premiumFeatures.js src/i18n/locales/en.json
git commit -m "docs(search): publish fast multi-folder search"
```

### Task 9: Add native regression/performance coverage, architecture docs, and final verification

**Files:**
- Create: `tests/e2e/connected-search-context.test.js`
- Modify: `tests/e2e/connected-search-index.test.js`
- Modify: `tests/e2e/connected-search-all-folders.test.js`
- Modify: `tests/e2e/mockImap.js:868-884` (`slowCommand`, `slowFetch` helpers)
- Modify: `src-daemon/src/search_index.rs` ignored `search_index_bench_50k_real_parser`
- Modify: `architecture.md` search/index and daemon event-flow sections
- Modify: `CHANGELOG.md` under `## [Unreleased]`

**Interfaces:**
- Consumes: complete feature from Tasks 1-8.
- Produces: native proof of cancellation/context isolation, local-first events, retry/partial results, and warm 50k indexed performance below 200 ms with zero result-assembly MIME parses.

- [ ] **Step 1: Add the native stale-context RED case**

Seed two accounts with distinct matching subjects. Delay the All Inboxes server SEARCH through the mock server, start a `current` search, switch to one account/mailbox before release, release the old response, and assert only the new account/mailbox remains.

```js
it('cannot republish All Inboxes rows after switching mailbox', async () => {
  await openUnifiedInbox();
  await delayNextSearch('account-a', 'INBOX');
  await submitMailSearch('scope-race');
  await openMailbox('account-b', 'Archive');
  await releaseDelayedSearch();
  await browser.waitUntil(async () => (await visibleSearchSubjects()).includes('B Archive match'));
  assert.deepEqual(await visibleSearchAccounts(), ['account-b']);
  assert.ok(!(await visibleSearchSubjects()).includes('A stale match'));
});
```

- [ ] **Step 2: Add native local-first/failure tests**

Gate the server lane and assert an indexed local row appears before release. Add a transient disconnect fixture and assert the folder succeeds after one retry. Add a permanent missing folder alongside a successful folder and assert the successful result remains and the run finishes. Add a server-only Graph/all-hidden case and assert the spinner terminates with no rows.

- [ ] **Step 3: Run focused E2E RED on the Mac mini**

Use a task-owned clone `/Users/unicorn/Repos/mv-search-20260919-4cd9`, confirm TCP port `4467` is unused, set `E2E_TAURI_WD_PORT=4467`, sync the exact working tree without secrets or app data, install from lockfiles, and build the webdriver app. Then run:

```bash
/Users/Rokas/.claude/bin/testq --port 4467 --lane macmini-search-e2e ssh macmini \
  'cd /Users/unicorn/Repos/mv-search-20260919-4cd9 && E2E_TAURI_WD_PORT=4467 npx wdio run wdio.conf.js --spec ./tests/e2e/connected-search-context.test.js --spec ./tests/e2e/connected-search-index.test.js --spec ./tests/e2e/connected-search-all-folders.test.js --logLevel warn'
```

Expected before the final integration build: the new context assertion fails against old behavior; driver launch/port collision is not valid RED evidence.

- [ ] **Step 4: Tighten the existing 50k benchmark assertion**

Instrument the parser closure with an atomic counter reset after indexing. Warm the query once, time the next indexed search/assembly, assert `elapsed < 200ms`, and assert parser count remains `0` during result assembly. Keep it `#[ignore]` for ordinary test runs.

- [ ] **Step 5: Run the release benchmark on the Mac mini**

```bash
/Users/Rokas/.claude/bin/testq --lane macmini-search-bench ssh macmini \
  'cd /Users/unicorn/Repos/mv-search-20260919-4cd9 && cargo test -p mailvault-daemon --release search_index_bench_50k_real_parser -- --ignored --nocapture'
```

Expected: PASS, warm indexed results below 200 ms, result-assembly parser count `0`. If timing fails, profile the index query/JSON assembly and fix that measured path; do not add the excluded 100-query cache.

- [ ] **Step 6: Update architecture and changelog with the landed boundary**

Document the two RPCs, event shape, local/server lane ownership, search-run registry, `row_json` fast path, fallback reason/coverage, 1...5 entitlement clamp, Graph remote limitation, and why there is no query cache or remote-only full index. Add a concise Unreleased entry describing scoped cancellation, instant indexed local rows, resilient concurrent folders, and the Premium control.

- [ ] **Step 7: Run the complete local non-E2E gate**

Run each command separately and preserve exit codes/output:

```bash
/Users/Rokas/.claude/bin/testq npm test -- --run
/Users/Rokas/.claude/bin/testq cargo test -p mailvault-core -- --nocapture
/Users/Rokas/.claude/bin/testq cargo test -p mailvault-daemon -- --nocapture
/Users/Rokas/.claude/bin/testq cargo test -p mailvault reply_timeout -- --nocapture
/Users/Rokas/.claude/bin/testq npm run test:integration
/Users/Rokas/.claude/bin/testq npm run test:imap
/Users/Rokas/.claude/bin/testq npx vitest run website/__tests__
```

Expected: every command exits `0`; no test is muted or weakened to get green.

- [ ] **Step 8: Rebuild exact final revision and run focused plus regression E2E on Mac mini**

After resyncing and checksum-verifying the final source, rebuild, then run:

```bash
/Users/Rokas/.claude/bin/testq --port 4467 --lane macmini-search-e2e ssh macmini \
  'cd /Users/unicorn/Repos/mv-search-20260919-4cd9 && E2E_TAURI_WD_PORT=4467 npx wdio run wdio.conf.js --spec ./tests/e2e/connected-search-context.test.js --spec ./tests/e2e/connected-search-index.test.js --spec ./tests/e2e/connected-search-all-folders.test.js --logLevel warn'
/Users/Rokas/.claude/bin/testq --port 4467 --lane macmini-search-e2e ssh macmini \
  'cd /Users/unicorn/Repos/mv-search-20260919-4cd9 && E2E_TAURI_WD_PORT=4467 npx wdio run wdio.conf.js --suite ui-headless --logLevel warn'
/Users/Rokas/.claude/bin/testq --port 4467 --lane macmini-search-e2e ssh macmini \
  'cd /Users/unicorn/Repos/mv-search-20260919-4cd9 && E2E_TAURI_WD_PORT=4467 npx wdio run wdio.conf.js --suite connected-ci --logLevel warn'
```

Expected: all three waves exit `0`; delayed old results never appear, indexed local rows appear before gated server rows, and retry/partial-folder behavior remains visible and terminal.

- [ ] **Step 9: Have the Sol verifier review the final diff and evidence**

The verifier checks: all Global Constraints; every Review Focus regression; effective entitlement transitions; daemon clamp independent of UI; no `Promise.all`/loop mailbox execution in the store; no matched-hit `.eml` parse; no new dependency/schema/cache; exact website/app catalog parity; and Mac mini source checksum parity. Any finding returns to the Luna implementer with a new failing regression before a fix.

- [ ] **Step 10: Commit tests and documentation only after final GREEN**

```bash
git add tests/e2e/connected-search-context.test.js tests/e2e/connected-search-index.test.js tests/e2e/connected-search-all-folders.test.js tests/e2e/mockImap.js src-daemon/src/search_index.rs architecture.md CHANGELOG.md docs/superpowers/specs/2026-09-19-daemon-search-orchestration-design.md docs/superpowers/plans/2026-09-19-daemon-search-orchestration.md
git commit -m "test(search): verify daemon orchestration end to end"
```

## Definition of Done

- Clearing or navigating invalidates the active ID synchronously; delayed All Inboxes events cannot contaminate the selected mailbox.
- All Inboxes `current` searches the selected unified folder across visible accounts; `all` searches all selectable folders and all on-disk vault directories across visible accounts.
- Indexed local results are emitted from SQLite `row_json` before a gated server response, with no matched-result MIME parsing.
- Incomplete/unavailable indexes scan only uncovered/all required local folders respectively, with localized reason and index-settings action.
- Free uses effective `1` for each lane and cannot change it. Premium saves `1...5`, defaults to `3`, preserves the saved value through logout, restores it on login/purchase, and restarts an active search on each effective transition.
- Server folders run concurrently through the existing five-session pool, dead connections retry once, permanent folder failures do not erase successes, and Graph remote search remains excluded.
- No last-100 query cache, remote-only body download/index, new runtime dependency, or new index table was added.
- App and website Premium catalogs/locales pass parity; `architecture.md` and `CHANGELOG.md` describe the shipped behavior.
- The Mac mini 50k warm benchmark is below 200 ms with zero result-assembly MIME parses; focused and regression native suites pass from the exact final source.
