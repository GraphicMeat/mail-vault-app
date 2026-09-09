# Mail Insights Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Follow test-driven development and review each bounded deliverable. This task authorizes writing the plan; do not infer that implementation or a test run has already happened.

**Goal:** Add the approved sidebar Insights workspace with a sender bubble map, sender/date timeline, and sent/received activity calendar, verified with TDD and native Mac mini E2E tests.

**Architecture:** A read-only native snapshot inventories locally available headers across accounts and the active vault. A pure normalization/aggregation model, evaluated in a worker, is the single source for all three charts and their drill-down results. A dedicated Insights store owns transient view/query state; the existing mail store and reader continue to own real message actions.

**Tech Stack:** React 18, Zustand, Tauri v2/Rust, existing date-fns/identity helpers, SVG and native controls, TanStack virtualization, Vitest/Testing Library, WebdriverIO with the compiled Tauri WebView and mock IMAP/SMTP servers. No new dependency is planned.

**Spec:** [Mail Insights design](../specs/2026-09-09-mail-insights-design.md). Read it in full before execution. The conversation-owned mockup is a visual reference, not source to copy into the app.

**Execution:** The user subsequently authorized implementation, TDD, Mac mini E2E, commit, and local merge to main. Actual commands and results are recorded in [the verification report](../../insights-verification-2026-09-09.md). Use `bash scripts/testing/insights/check.sh <mode> [args...]` for every test wave; this wrapper holds the shared queue before freezing and syncing source. The command examples below describe the original plan.

**Implementation refinement from native acceptance:** snapshots freeze enumerated paths and tolerate subsequent independent file arrivals. Captured file contents, metadata/index/generation files, directory identity and vault/account context remain guarded. The original full-directory timestamp check repeatedly failed while ordinary background downloads appended Maildir files. Native tests must prove both append tolerance and continued rejection of changed/deleted captured data; retry limits remain bounded.

## Global constraints

- All tests run on the Mac mini through the controller's `/Users/Rokas/.claude/bin/testq`.
- All native runs use the shared `macmini-e2e` lane.
- Based on mail available on this device. A finished scan is not proof of complete server history.
- Read-only charts; retain existing reader actions and custody provenance. No new database, telemetry, remote analysis, or background mail download.
- Preserve existing legacy `date` semantics; add explicit receive/send date fields where missing.
- Bubble area is proportional to count; radial distance increases monotonically with elapsed time.
- Sender identity is normalized address, never display name or a guessed alias.
- No new dependencies; both themes/palettes, localization, keyboard access, and reduced motion ship together.
- No tests, production feature code, deployment, version bump, or commits are performed by the planning task itself.

## Current code and execution boundary

Inspected on 9 September 2026:

- `src/App.jsx` owns sidebar/main workspace composition; it currently mounts the mail list and existing reader or Chat view.
- `src/components/Sidebar.jsx` implements list/stacked/switcher/collapsed sidebar structures. Insights must be reachable in each.
- `src/stores/mailStore.js:getAccountCacheEmails()` returns only the active account's available window. `src/utils/contactsIndex.js` caps folders and can synthesize capped contact records. Neither is an analytics source.
- Tauri sidecar cache readers, Maildir path helpers, local-index commands, and header parsing currently live in `src-tauri/src/main.rs`. `src/services/transport.js` deliberately keeps this storage family on Tauri because daemon formats differ.
- `src-core/src/imap/mod.rs:EmailHeader` already exposes `internalDate`, `listId`, `listUnsubscribe`, and `precedence`. `src-core/src/graph.rs` and `src/services/graphConfig.js` currently use receive time as legacy `date`; send time needs explicit preservation.
- `src/utils/emailParser.js` exports `identitySet`, `isFromUser`, and `getCorrespondent`; `src/utils/sentFolder.js` resolves Sent paths; `src/stores/slices/unifiedHelpers.js` owns physical location and selection contracts.
- `src/services/db/emails.js` preserves local origin/server-absence facts. `local_sent` and `local_draft` are not equivalent.
- `wdio.conf.js` runs a debug `webdriver` build, creates temporary app data, seeds mock accounts, and serializes instances. Its `onPrepare` stops named test processes, so every native run must hold the shared lane.
- `docs/backup-status-placement-verification-2026-09-09.md` and `docs/settings-minimize-verification-2026-09-08.md` document the working Mac mini commands and driver limitations.

The working tree contains concurrent Explorer work in App, EmailList, settings, English translations, and new Explorer files/tests. Preserve it. At execution, inspect fresh status and create an isolated `codex/mail-insights` worktree using the worktree skill. Base it on an agreed integrated revision if Explorer has landed; otherwise implement Insights independently and reconcile those shared integration points without staging or reverting someone else's changes. Never use `git add -A` for this feature.

## File and responsibility map

| File | Responsibility |
| --- | --- |
| `src-tauri/src/insights.rs` | Snapshot registry, native inventory, bounded header pages, coverage, cancellation |
| `src-tauri/src/insights_tests.rs` | Native filesystem, corruption, pagination, and provenance tests |
| `src-tauri/src/main.rs` | Module/state/command registration and narrow visibility changes for existing storage helpers |
| `src-core/src/imap/mod.rs`, `src-core/src/graph.rs`, `src/services/graphConfig.js` | Preserve explicit receive/send dates through provider normalization |
| `src/services/insightsApi.js` | Typed-by-JSDoc Tauri snapshot boundary; no UI/store imports |
| `src/utils/insights/model.js` | Canonical message records, direction/identity/date rules, counts, drill-down keys |
| `src/utils/insights/calendar.js` | Local date boundaries, week/day buckets, heatmap coordinates |
| `src/utils/insights/mapLayout.js` | Deterministic count/recency geometry and angular collision handling |
| `src/workers/insightsWorker.js` | Build/query model off the UI thread; request IDs and stale-result rejection |
| `src/services/insightsSession.js` | Snapshot pagination, cancellation, worker lifecycle, query orchestration |
| `src/stores/insightsStore.js` | Current tab/query, selected sender/day, progress, errors, snapshot lifecycle |
| `src/components/insights/InsightsPage.jsx` | Shared toolbar, tabs, coverage, empty/error states |
| `src/components/insights/SenderMap.jsx`, `SenderList.jsx` | Bubble canvas and equivalent searchable/sortable list |
| `src/components/insights/SenderTimeline.jsx` | Virtualized sender lanes and date zoom |
| `src/components/insights/ActivityCalendar.jsx` | Daily calendar with keyboard navigation |
| `src/components/insights/InsightsMessages.jsx` | Bounded matching-message list and existing-reader entry |
| `src/services/workflows/selectEmail.js`, `src/stores/slices/selectionSlice.js` | Backward-compatible explicit-location reader entry for rows outside the active list |
| `src/styles/insights.css` | Scoped layout and theme-aware chart tokens |
| `src/App.jsx`, `src/components/Sidebar.jsx`, `src/hooks/useKeyboardShortcuts.js` | Workspace routing, sidebar reachability, shortcut ownership |
| `src/stores/settingsStore.js`, `src/i18n/locales/{en,de,es,fr,it,pt-BR,ja,ko,zh-Hans}.json` | Validated preferences and complete translated catalogs |
| `tests/fixtures/insights.js` | Explicit, deterministic header fixtures and independent expected totals |
| `tests/e2e/insightsFixture.js`, `wdio.insights.conf.js` | Dedicated native fixture without changing the existing shared mailbox scenarios |
| `tests/e2e/connected-insights.test.js` | Real controls, real native storage/provider paths, reader drill-down |
| `tests/e2e/ui-insights.test.js` | Empty state, reachability, focus, themes, responsive layout |
| `docs/insights-verification-2026-09-09.md` | Actual execution evidence; create during implementation, not before tests run |

## Shared interfaces

Declare these JSDoc contracts in `src/services/insightsApi.js` and `src/utils/insights/model.js`; keep field names identical across tasks. Date strings below are ISO timestamps or null unless explicitly local-date keys.

```js
// Physical copy. Keep these fields when opening an existing message.
// source is 'server-cache' | 'vault'; origin preserves local_sent/local_draft.
// uidValidity may be null; never silently turn unknown into a known generation.
const copyExample = {
  accountId: '11111111-1111-4111-8111-111111111111',
  mailbox: 'INBOX', uid: 17, uidValidity: 4,
  source: 'server-cache', origin: null,
  messageId: '<letter-17@example.test>',
  from: { address: 'ana@example.test', name: 'Ana' },
  to: [{ address: 'me@example.test', name: '' }], cc: [], bcc: [],
  subject: 'Project dates',
  messageDate: '2026-09-08T20:00:00Z',
  receivedAt: '2026-09-08T21:30:00Z', sentAt: null,
  dateEvidence: { received: 'imap-internaldate', sent: 'unknown' },
  flags: [], specialUse: '\\Inbox',
  listId: null, listUnsubscribe: null, precedence: null,
  serverDeleted: false, serverAbsent: false,
};

// InsightsQuery
const queryExample = {
  accountIds: [copyExample.accountId],
  startDate: '2026-08-10', endDate: '2026-09-09', // inclusive local dates
  timeZone: 'Europe/Vilnius', direction: 'received',
  senderAddress: null, hideAutomated: false,
  timelineBucket: 'week', senderSort: 'recent',
};

// Coverage is independent from query counts.
// status: 'reading' | 'ready' | 'partial' | 'stale' | 'error'.
// knownServerMessages is null when unproven; errors are structured codes.
// folder fields: accountId, mailbox, cachedHeaders, knownServerMessages,
// missingHeaders, status, lastSyncedAt.
// warning counts: unknownDates, fallbackDates, uncertainIdentity, unreadableFiles.

// API, camelCase wire payloads:
// beginInsightsSnapshot(accountIds, { signal })
//   -> { snapshotId, inventoryCount, coverage }
// readInsightsPage(snapshotId, cursor, { signal })
//   -> { rows: HeaderCopy[], nextCursor: string|null, coverage }
// releaseInsightsSnapshot(snapshotId) -> Promise<void>
// Native command names: insights_begin_snapshot, insights_read_page,
// insights_release_snapshot. Page size is native-enforced at 1000 rows.

// Pure model:
// buildInsightsModel(copies, { accounts, ownAddressesByAccount }) -> model
// queryInsights(model, query) -> {
//   totals: { sent, received, both },
//   senders: [{ address, name, count, sent, received, lastAt, automationEvidence }],
//   days: [{ date, sent, received, value }],
//   lanes: [{ address, buckets: [{ startDate, endDate, sent, received, keys }] }],
//   unknownDateCount, fallbackDateCount, uncertainIdentityCount
// }
// matchingInsightsMessages(model, query, { senderAddress, startDate, endDate })
//   -> [{ key, copies: HeaderCopy[], subject, from, eventAt }]
// Dates in days/buckets are local YYYY-MM-DD strings.

// Worker messages:
// { type: 'build-start', requestId, accounts, ownAddressesByAccount }
//   -> build-started payload: { buildId: requestId }
// { type: 'build-append', requestId, buildId, copies } // <=1000 copies
//   -> build-appended; session yields a macrotask between chunks
// { type: 'build-commit', requestId, buildId } // atomic model publication
// A new start supersedes incomplete staging; the previous committed model remains available.
// { type: 'query', requestId, query }
// { type: 'messages', requestId, query, selection }
// Replies also include { type: 'built'|'result'|'messages'|'error', requestId, payload }.
// Session consumes request IDs; it ignores replies from an older generation.

// Session:
// createInsightsSession({ api, workerFactory }) -> { load, query, messages, dispose }
// load({ accountIds, accounts, ownAddressesByAccount, onProgress }) -> Promise<void>
// query(query) -> Promise<InsightsResult>
// messages(query, selection) -> Promise<MessageMatch[]>
// dispose() cancels the load, terminates the worker, and releases its snapshot.
```

## Task 0: Prepare the isolated Mac mini runner and evidence ledger

**Files:** Create execution-only helpers under `scripts/testing/insights/`: `sync.sh`, `remote.sh`, and `source-manifest.mjs`. Create the verification document only when execution starts.

**Interfaces:** Later Run commands assume these helpers exist. `sync.sh` takes no arguments and copies a frozen source snapshot to the task-owned runner. `remote.sh <unit|rust|build|e2e|regression> [args...]` runs inside that runner. `source-manifest.mjs` emits relative source paths and SHA-256 values, excluding generated files and secrets.

- [ ] Inspect the current worktree, Explorer integration points, queue helper, SSH alias, and runner prerequisites without running tests on the controller.

```sh
git status --short
/Users/Rokas/.claude/bin/testq --status
ssh macmini 'uname -m; sw_vers; command -v tauri-wd; test -x /opt/homebrew/opt/node@24/bin/node'
```

- [ ] Create `/Users/unicorn/Repos/mv-insights-20260909-01a08694` only for this feature. Initialize it from the implementation worktree's tracked source plus this feature's untracked files. Do not reuse or overwrite the Explorer or backup-placement runners. Sync with an explicit source manifest; exclude `.git`, `.claude`, `.codex`, `.agents`, signing config, `.env*`, `node_modules`, `target`, generated `dist`, website API data, and screenshots. Remove stale source files only when named in the previous task-owned manifest. Verify remote checksums before every test wave. Freeze the manifest for the entire build/test wave and do not resync while a runner is active.
- [ ] Install dependencies using the matching lockfiles. Resolve Sparkle through the repository's existing download/build workflow if missing. Do not borrow binaries from another source revision. Keep dependencies/build caches in the private runner; never copy real app data.
- [ ] Implement the remote dispatcher with these exact modes. The controller invokes it under `testq`; it is not an alternative queue bypass.

```sh
#!/bin/bash
set -euo pipefail
export PATH=/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/Users/unicorn/.cargo/bin:$PATH
cd /Users/unicorn/Repos/mv-insights-20260909-01a08694
mode=$1
shift
case "$mode" in
  unit) npm test -- "$@" ;;
  rust) SPARKLE_FRAMEWORK_PATH="$PWD/src-tauri" DYLD_FRAMEWORK_PATH="$PWD/src-tauri" cargo test --locked "$@" ;;
  build)
    VITE_E2E=1 npm run build
    DAEMON_PROFILE=debug npm run build:daemon
    SPARKLE_FRAMEWORK_PATH="$PWD/src-tauri" cargo build -p mailvault --features webdriver --locked
    ;;
  e2e)
    DYLD_FRAMEWORK_PATH="$PWD/src-tauri" npx wdio run wdio.insights.conf.js "$@"
    ;;
  regression)
    DYLD_FRAMEWORK_PATH="$PWD/src-tauri" npx wdio run wdio.conf.js "$@"
    ;;
  *) exit 64 ;;
esac
```

- [ ] Run the relevant baseline tests on the mini, record existing failures before editing implementation, and verify a baseline native launch. These are existing tests, not new RED evidence.

```sh
bash scripts/testing/insights/sync.sh
/Users/Rokas/.claude/bin/testq --lane macmini-insights-unit ssh macmini \
  'bash /Users/unicorn/Repos/mv-insights-20260909-01a08694/scripts/testing/insights/remote.sh unit src/utils/__tests__/sendAsIdentity.test.js src/utils/__tests__/sentFolder.test.js src/components/__tests__/SidebarNavigation.test.jsx'
/Users/Rokas/.claude/bin/testq --lane macmini-e2e ssh macmini \
  'bash /Users/unicorn/Repos/mv-insights-20260909-01a08694/scripts/testing/insights/remote.sh build'
```

- [ ] Start the ledger with baseline revision, source manifest hash, OS/tool versions, command, exit code, and log path. Commit only the runner helpers when ready; do not claim test counts until observed.

All later commands assume a fresh `sync.sh` and checksum match first. RED and GREEN each get separate logs. The Rust mode supplies the native framework paths and keeps the existing dependency link setup from the build. Unit tests importing browser-dependent stores use the repository's `// @vitest-environment jsdom` annotation.

The repository ignores `docs/`; during implementation, include the approved spec and this plan explicitly with `git add -f docs/superpowers/specs/2026-09-09-mail-insights-design.md docs/superpowers/plans/2026-09-09-mail-insights.md`. Do not change global ignore rules or force-add unrelated documents. Carry both files in the implementation branch before execution handoff.

## Task 1: Preserve dates and read a complete local header snapshot

**Files:** Create `src-tauri/src/insights.rs`, `src-tauri/src/insights_tests.rs`, `src/services/insightsApi.js`, and `src/services/__tests__/insightsApi.test.js`. Modify `src-tauri/src/main.rs`, `src-core/src/imap/mod.rs`, `src-core/src/graph.rs`, and `src/services/graphConfig.js`; extend their existing provider tests and create `src/services/__tests__/graphInsightsDates.test.js`.

**Interfaces:** Produce the three snapshot commands and HeaderCopy/Coverage schema above. The native `InsightsSnapshots` state owns opaque IDs, manifests, cursors, and five-minute inactivity expiry. A page cannot outlive its snapshot or cross account scope. Native source errors are structured, never silently converted into an empty successful snapshot.

- [ ] Add failing provider tests asserting separate send/receive timestamps without changing legacy `date`. Additive IMAP metadata is optional and backward compatible; update every Rust struct literal affected by additive fields. For Graph, request `sentDateTime` in list/detail selects and preserve both timestamps in Rust and JS mappings. Preserve available original RFC Date separately.

```js
it('keeps Graph receive time and send time distinct', () => {
  const row = graphMessageToEmail({
    id: 'graph-17', receivedDateTime: '2026-09-09T00:30:00Z',
    sentDateTime: '2026-09-08T23:30:00Z',
    from: { emailAddress: { address: 'ana@example.test' } },
  }, 17);
  expect(row.date).toBe('2026-09-09T00:30:00Z');
  expect(row.receivedAt).toBe('2026-09-09T00:30:00Z');
  expect(row.sentAt).toBe('2026-09-08T23:30:00Z');
});
```

- [ ] Write Rust temporary-directory tests before the reader: 1,201 sidecars drain as 1,000 + 201; the inventory includes unselected accounts and nested/vault-only folders; cache + vault copies retain separate locators; UID reuse retains conflicting IDs; absent/corrupt metadata never means zero; a missing vault fails explicitly; cancellation releases manifests; file mutation/deletion during paging marks the result stale; a legacy monolithic cache still reads. A header fallback test uses a large body and asserts the parser stops after the header terminator.

```rust
#[test]
fn insights_pages_cover_headers_beyond_the_mailbox_window() {
    let dir = tempfile::tempdir().unwrap();
    let cache = dir.path().join("email_cache").join("fixture");
    std::fs::create_dir_all(&cache).unwrap();
    for uid in 1..=1201_u32 {
        std::fs::write(cache.join(format!("{uid}.json")),
            serde_json::json!({"uid":uid,"messageId":format!("<m{uid}@test>"),
                "from":{"address":"ana@example.test"},"subject":"fixture"}).to_string()).unwrap();
    }
    // read_header_files is the native pure page reader introduced by this task:
    // (&Path, &[u32]) -> Result<Vec<serde_json::Value>, String>.
    let first = read_header_files(&cache, &(1..=1000).collect::<Vec<_>>()).unwrap();
    let last = read_header_files(&cache, &(1001..=1201).collect::<Vec<_>>()).unwrap();
    assert_eq!(first.len(), 1000);
    assert_eq!(last.len(), 201);
    assert_eq!(last.last().unwrap()["uid"], 1201);
}
```

- [ ] Sync and run RED. If an import/compile failure only proves the module is absent, add a minimal importable interface and rerun until behavioral assertions fail. Record those failures before implementation.

```sh
/Users/Rokas/.claude/bin/testq --lane macmini-insights-rust ssh macmini \
  'bash /Users/unicorn/Repos/mv-insights-20260909-01a08694/scripts/testing/insights/remote.sh rust -p mailvault insights'
/Users/Rokas/.claude/bin/testq --lane macmini-insights-unit ssh macmini \
  'bash /Users/unicorn/Repos/mv-insights-20260909-01a08694/scripts/testing/insights/remote.sh unit src/services/__tests__/graphInsightsDates.test.js src/services/__tests__/insightsApi.test.js'
```

- [ ] Implement the manifest reader in `spawn_blocking`. Inventory cached mailbox metadata, sidecars, local indexes, and Tauri Maildir files under the resolved active vault. Preserve real mailbox paths; do not reverse a lossy sanitized directory name into a guessed server path. Unresolvable local folders remain readable via their verified local locator and carry an explicit location limitation for server actions. Skip symlink escapes and reject unconfigured account IDs before resolving files.
- [ ] Pages read at most 1,000 header records; do not include HTML, body text, attachments, credentials, or filesystem paths in replies. For `.eml` fallback use a buffered header-only reader ending at the first blank line, bounded to 1 MiB; report over-limit headers. Reuse existing address/header parsing semantics and origin flags. Avoid calling the body-loading `getAllLocalEmails()` path.
- [ ] Keep inventory filenames/expected metadata in the snapshot. Detect read-file identity changes and directory/index generation changes; return `stale` and require a new snapshot rather than mixing generations. Release snapshots explicitly on cancel/unmount and expire abandoned ones. Retry starts a new snapshot, never appends a second scan into old rows.
- [ ] Implement `insightsApi.js` through the Tauri transport fallback already used for caches. Register commands and state; do not add this family to daemon routing. Add a transport contract test that daemon availability does not change the response schema.
- [ ] Run GREEN for focused native/JS tests and provider regressions. Refactor only while green. Commit the native/date/API deliverable with a focused file list.

## Task 2: Canonical counts, calendar boundaries, and independent fixtures

**Files:** Create `tests/fixtures/insights.js`, `src/utils/insights/model.js`, `src/utils/insights/calendar.js`, `src/utils/insights/__tests__/model.test.js`, and `calendar.test.js`.

**Interfaces:** Produce `buildInsightsModel`, `queryInsights`, and `matchingInsightsMessages` above. Calendar exports `localDateKey(instant, timeZone)`, `calendarDays(startDate, endDate)`, and `calendarCell(date, startDate)` returning `{ week, weekday }`, Monday = 0. Use calendar arithmetic, not elapsed milliseconds divided by 86,400,000.

- [ ] Create explicit fixtures: Ana has two received logical messages (one duplicated in vault), Ben has one; one sent email addresses Ana + Ben + a duplicate Ana CC; one draft is excluded; a second account reuses UID 1 for a different message. Dates straddle midnight in Vilnius. Export a `copy(overrides)` factory based on the full HeaderCopy example and the literal `COUNT_FIXTURE` array. Avoid random data and expectations calculated by the production aggregator.

```js
export const A = '11111111-1111-4111-8111-111111111111';
export const B = '22222222-2222-4222-8222-222222222222';
export function copy(overrides = {}) {
  return {
    accountId: A, mailbox: 'INBOX', uid: 1, uidValidity: 4,
    source: 'server-cache', origin: null, messageId: '<ana-1@test>',
    from: { address: 'ana@example.test', name: 'Ana' },
    to: [{ address: 'me@example.test', name: '' }], cc: [], bcc: [],
    subject: 'Project dates', messageDate: '2026-09-08T20:00:00Z',
    receivedAt: '2026-09-08T21:30:00Z', sentAt: null,
    dateEvidence: { received: 'imap-internaldate', sent: 'unknown' },
    flags: [], specialUse: '\\Inbox', listId: null,
    listUnsubscribe: null, precedence: null,
    serverDeleted: false, serverAbsent: false,
    ...overrides,
  };
}
export const COUNT_FIXTURE = [
  copy(),
  copy({ source: 'vault', origin: 'local' }),
  copy({ uid: 2, messageId: '<ana-2@test>', subject: 'Second project date' }),
  copy({ uid: 3, messageId: '<ben-1@test>', from: { address: 'ben@example.test', name: 'Ben' } }),
  copy({ uid: 1, mailbox: 'Sent', specialUse: '\\Sent', messageId: '<sent-1@test>',
    from: { address: 'me@example.test', name: 'Me' },
    to: [{ address: 'ana@example.test' }, { address: 'ben@example.test' }],
    cc: [{ address: 'ana@example.test' }],
    receivedAt: null, sentAt: '2026-09-08T21:40:00Z',
    dateEvidence: { received: 'unknown', sent: 'rfc-date' } }),
  copy({ uid: 1, mailbox: 'Drafts', specialUse: '\\Drafts',
    messageId: '<draft-1@test>', origin: 'local_draft', flags: ['draft'] }),
  copy({ accountId: B, uid: 1, messageId: '<account-b-1@test>',
    from: { address: 'other@example.test', name: 'Other' } }),
];
```

```js
it('deduplicates storage copies without multiplying outgoing activity', () => {
  const model = buildInsightsModel(COUNT_FIXTURE, {
    accounts: [{ id: A, email: 'me@example.test' }],
    ownAddressesByAccount: { [A]: ['me@example.test'] },
  });
  const result = queryInsights(model, {
    accountIds: [A], startDate: '2026-09-01', endDate: '2026-09-09',
    timeZone: 'Europe/Vilnius', direction: 'both', senderAddress: null,
    hideAutomated: false, timelineBucket: 'day', senderSort: 'recent',
  });
  expect(result.totals).toEqual({ received: 3, sent: 1, both: 4 });
  expect(result.senders.find(s => s.address === 'ana@example.test').count).toBe(3);
  expect(result.senders.find(s => s.address === 'ben@example.test').count).toBe(2);
  expect(result.days.reduce((n, d) => n + d.value, 0)).toBe(4);
});

it('assigns local dates across midnight and keeps leap day', () => {
  expect(localDateKey('2026-09-08T21:30:00Z', 'Europe/Vilnius')).toBe('2026-09-09');
  expect(calendarDays('2024-02-28', '2024-03-01')).toEqual([
    '2024-02-28', '2024-02-29', '2024-03-01',
  ]);
});
```

- [ ] Add failing cases for copied Message-IDs with conflicting sender/date/subject; missing Message-ID; UIDVALIDITY reuse; same name/different address; explicit aliases; sent special-use/override/local_sent; unsent outbox/draft rejection; self-mail; unknown recipients; missing/invalid/future timestamps; receive-versus-send date; fallback evidence; leap years/DST/year boundaries; all-account duplicates; empty scope; custom range validation; automated evidence and unknown classification. Assert exact drill-down keys match counts.
- [ ] Run RED with `remote.sh unit src/utils/insights/__tests__/model.test.js src/utils/insights/__tests__/calendar.test.js` through the unit lane.
- [ ] Implement normalization once. Build a logical-record map with retained copies, per-direction events, correspondent sets, and source/date evidence. Apply scope before dedup direction totals, and never treat missing metadata as proof of equality. Use existing `identitySet` semantics; do not change global contact behavior.

```js
// Count contribution, after physical copies have been canonicalized:
const receivedKeys = new Set(receivedEvents.map(event => event.key));
const sentKeys = new Set(sentEvents.map(event => event.key));
const totals = {
  received: receivedKeys.size,
  sent: sentKeys.size,
  both: receivedKeys.size + sentKeys.size,
};
// Per-correspondent sets are separate; totals are never the sum of those sets.
```

- [ ] Materialize only the date range's daily cells; keep Unknown date records out of heatmap and radial geometry but reachable in a labeled list. Bucket timeline keys using the same date helper and query predicate as Activity. Return all counts even when the chart only renders the top 30 nodes.
- [ ] Run GREEN and existing identity/date tests, then refactor. Commit model + fixture tests as one independently reviewable unit.

## Task 3: Cancellable session, worker, preferences, and workspace navigation

**Files:** Create `src/workers/insightsWorker.js`, `src/workers/__tests__/insightsWorker.test.js`, `src/services/insightsSession.js`, `src/services/__tests__/insightsSession.test.js`, `src/stores/insightsStore.js`, `src/stores/__tests__/insightsStore.test.js`, `src/stores/__tests__/insightsSettings.test.js`, `src/components/insights/InsightsPage.jsx`, `src/components/insights/__tests__/InsightsPage.test.jsx`, and `src/styles/insights.css`. Modify App, Sidebar, shortcut hooks, settings, and all nine translation catalogs listed above.

**Interfaces:** Store state: `{ isOpen, tab, query, status, progress, coverage, result, selectedDay, messages, error }`. Actions: `openInsights()`, `closeInsights()`, `setTab(tab)`, `setQuery(patch)`, `selectSender(address|null)`, `selectDay(date|null)`, `refresh()`, `loadMessages(selection)`, `resetSession()`. The session API is defined above; components never import Tauri directly. Settings persist a validated `insightsPreferences` object only.

- [ ] Write session tests that drive real orchestration with a tiny in-memory API boundary: two pages produce one complete model; cancelled/old-account results never overwrite a newer request; unmount releases snapshot and terminates worker; stale/error pages preserve previous results labeled stale; no successful empty state appears after a read failure. Worker tests invoke the real model and compare it with direct pure results.
- [ ] Write store/preference tests: all tabs share filters; absent persisted fields migrate to defaults; invalid dates/directions/account IDs normalize; only preferences persist; close/open retains session selections without altering mail store state; removed accounts invalidate scope; successful refresh replaces, rather than adds to, old counts.
- [ ] Write component/navigation failures before mounting Insights: sidebar entry in all layouts, collapsed label, switcher reachability, return restores inbox/Explorer/search state, mail shortcuts do not fire behind charts, Escape first closes the message detail then exits Insights, Settings/Compose remain reachable. Snapshot existing mail state and compare after a visit.

```jsx
it('preserves the inbox while opening and closing Insights', () => {
  const before = useMailStore.getState();
  const expected = {
    activeAccountId: before.activeAccountId,
    activeMailbox: before.activeMailbox,
    selectedEmailId: before.selectedEmailId,
    searchQuery: before.searchQuery,
  };
  useInsightsStore.getState().openInsights();
  useInsightsStore.getState().closeInsights();
  expect(useMailStore.getState()).toMatchObject(expected);
});
```

- [ ] Run RED with the new session/store/preferences/page tests and SidebarNavigation through the unit lane.
- [ ] Implement a worker loaded only when Insights opens. Send one accumulated slim header model per complete snapshot; query in the worker, and use request IDs to ignore stale replies. Limit account inventory concurrency to two and page sequentially per snapshot. Expose progress while scanning; stop scheduling new work on cancellation. Never persist the header dataset to localStorage.
- [ ] Mount Insights lazily in App's main workspace; preserve underlying mail panes without allowing hidden focus/shortcuts or duplicated active readers. Use an inert hidden mail subtree during Insights or equivalent stable parent ownership. Connect sidebar props uniformly across layouts. Treat Insights as a distinct workspace, not a value of the existing server/local `viewMode` or List/Explorer `emailListView`.
- [ ] Implement real account/date/direction controls and localization keys under `insights.*`. Translate each key in all nine catalogs, preserve `{{placeholders}}`, and provide each locale's required plural forms. Do not use `IDENTICAL_OK.json` to bypass translating prose. Coverage copy must distinguish reading, partial, unknown, stale, offline-with-data, vault-unavailable, and no-mail states. For partial data show affected folder counts, not an invented percentage. A retry is a new read-only snapshot.
- [ ] Run GREEN and the full affected sidebar/settings/shortcut test families. Review preservation of the concurrent Explorer work before committing.

## Task 4: Sender map and accessible sender list

**Files:** Create `src/utils/insights/mapLayout.js`, `src/utils/insights/__tests__/mapLayout.test.js`, `src/components/insights/SenderMap.jsx`, `SenderList.jsx`, and `__tests__/SenderMap.test.jsx`. Modify InsightsPage and scoped styles.

**Interfaces:** `layoutSenderMap(senders, { width, height, endAt, limit = 30 })` returns `{ nodes: [{ address, x, y, radius, radialDistance }], center, bounds, omittedCount }`. Components accept `{ senders, endAt, selectedAddress, onSelect }`. Selection delegates to the shared store.

- [ ] Write geometry failures for area ratios, monotonic recency independent of count, stable layout under reordered input, deterministic ties, no radial drift during collision resolution, top-30 limit, zero/missing timestamps, and no endless iterations in dense cases. Use a fixture where the frequent sender is old and the infrequent sender is recent.

```js
it('encodes four times the volume as twice the radius', () => {
  const endAt = Date.parse('2026-09-09T12:00:00Z');
  const layout = layoutSenderMap([
    { address: 'old@test', count: 40, lastAt: '2026-06-01T12:00:00Z' },
    { address: 'new@test', count: 10, lastAt: '2026-09-09T11:00:00Z' },
  ], { width: 900, height: 600, endAt });
  const old = layout.nodes.find(n => n.address === 'old@test');
  const recent = layout.nodes.find(n => n.address === 'new@test');
  expect(old.radius / recent.radius).toBeCloseTo(2);
  expect(old.radialDistance).toBeGreaterThan(recent.radialDistance);
});
```

- [ ] Write component tests for sender selection, label/count/date accessible names, list equivalence, search outside the top 30, automated filter changes, and Unknown date access. Do not test SVG path strings or arbitrary CSS class names.
- [ ] Run RED with mapLayout and SenderMap tests through the unit lane.
- [ ] Implement radius from square-root count and radial distance from monotonic log age. Hash addresses for initial angles; perform at most 24 deterministic angular adjustment passes. Resolve remaining density using a larger world/canvas and explicit pan/zoom or fewer drawn nodes with the full list available; do not move a node to a false recency radius.

```js
const radiusFor = (count, scale) => scale * Math.sqrt(count);
const distanceFor = (ageDays, minDistance, maxDistance, oldestDays) =>
  minDistance + (maxDistance - minDistance)
    * Math.log1p(Math.max(0, ageDays)) / Math.log1p(Math.max(1, oldestDays));
```

- [ ] Render real button nodes over SVG rings/links, with larger invisible hit areas where needed. Put full labels in the sender list when the map is crowded. Keep pointer targets/labels inside the measured viewport and use the list alternative for small panels. No perpetual animation; reduced motion changes state immediately.
- [ ] Run GREEN plus deterministic 500-sender/30-node cases. Commit map and list after reviewing the geometry against the approved semantics.

## Task 5: Sender timeline and shared message drill-down

**Files:** Create `src/components/insights/SenderTimeline.jsx`, `InsightsMessages.jsx`, `__tests__/SenderTimeline.test.jsx`, `__tests__/InsightsMessages.test.jsx`, and `src/services/workflows/openInsightsMessage.js` with `src/services/workflows/__tests__/openInsightsMessage.test.js`. Modify `src/services/workflows/selectEmail.js` and `src/stores/slices/selectionSlice.js`. Extend calendar/model tests as needed.

**Interfaces:** Timeline consumes `{ lanes, query, onQueryChange, onSelectBucket }`; a bucket selection is `{ senderAddress, startDate, endDate }`. `openInsightsMessage(match)` opens a verified copy through the existing `selectEmail` flow and never resolves UID from the active folder. Extend the current signature compatibly to `selectEmail(uid, source = 'server', mailboxOverride = null, locationOverride = null)`, where a non-null override is `{ accountId, mailbox, uid, header }`. Validate that account, UID, mailbox, and header stamps agree, then use the explicit location before any active-list lookup. The selection-slice wrapper forwards the optional fourth parameter. Every existing three-argument caller retains its behavior. InsightsMessages consumes actual model matches and shows the existing reader in one owned detail region.

- [ ] Write timeline failures: row order by latest/count, shared scale, received circles versus sent diamonds, week/day/message zoom, equal interval boundaries with calendar, sender selection survives tab changes, and virtualized large lane sets.
- [ ] Write opening failures for same UID in another account/folder, local-only messages, stale UID/Message-ID mismatches, repeated opens, and return focus. Opening a bucket must not trigger a whole mailbox search with a differently defined predicate. Use exact matching keys from Task 2.

```js
it('returns exactly the calendar day messages for timeline drill-down', () => {
  const model = buildInsightsModel(COUNT_FIXTURE, IDENTITY_FIXTURE);
  const query = { ...QUERY_FIXTURE, direction: 'received' };
  const result = queryInsights(model, query);
  const date = '2026-09-09';
  const matches = matchingInsightsMessages(model, query, {
    senderAddress: null, startDate: date, endDate: date,
  });
  expect(matches).toHaveLength(result.days.find(d => d.date === date).received);
});
```

`IDENTITY_FIXTURE` and `QUERY_FIXTURE` are literal exports added to `tests/fixtures/insights.js` in this task, using the own-address/query values in Task 2. They contain no expected values derived by production code.

```js
export const IDENTITY_FIXTURE = {
  accounts: [{ id: A, email: 'me@example.test' }],
  ownAddressesByAccount: { [A]: ['me@example.test'] },
};
export const QUERY_FIXTURE = {
  accountIds: [A], startDate: '2026-09-01', endDate: '2026-09-09',
  timeZone: 'Europe/Vilnius', direction: 'received', senderAddress: null,
  hideAutomated: false, timelineBucket: 'day', senderSort: 'recent',
};
```

- [ ] Run RED with timeline/message/opening tests through the unit lane.
- [ ] Implement viewport-sized SVG with virtualized sender lanes and bounded bins. Use shared calendar bucketing; show exact bucket bounds in accessible labels. A short range can display individual message marks; dense days remain selectable count clusters. Keep sorting and zoom controls out of the account chrome.
- [ ] Render a virtualized match list using existing row/custody helpers. Before calling the existing reader, stamp real `_accountId`, `_mailbox`, UID, Message-ID, and origin from the selected copy. Thread the explicit header through cached-body and vault Message-ID verification too; a stale cached body cannot bypass the new location check. Prefer a verified accessible vault copy offline; otherwise retain the verified server locator. Let the reader handle its established mark-as-read and errors. Do not overwrite the normal inbox `sortedEmails` just to open an Insights result. Save the previous reader selection on entry and restore it on exit only if still valid, using current flags/provenance rather than an obsolete object snapshot. Ensure only the Insights detail reader subscribes to the new selection while the ordinary reader is hidden.
- [ ] Run GREEN plus `selectEmailCompositeKey`, `selectEmailVaultMismatch`, and `selectEmailReadAccount` regression tests. Commit timeline and reader bridge together.

## Task 6: Activity calendar, day selection, and responsive polish

**Files:** Create `src/components/insights/ActivityCalendar.jsx` and `__tests__/ActivityCalendar.test.jsx`; extend calendar tests, InsightsPage, styles, and translations.

**Interfaces:** Calendar consumes `{ days, direction, selectedDate, onSelectDate }`. Days are the model's complete local-date series; the calendar never recomputes totals from contacts. `onSelectDate` calls the same message-query selection used by Timeline.

- [ ] Write failing calendar cases: 365/366-day ranges; Monday row origin; one unique date per cell; month/year labels; no padding dates counted; intensity thresholds shared across the displayed range; Received/Sent/Both changes; no multiplication for multi-recipient outgoing mail; correct self-mail totals; empty versus unavailable data; persisted day selection; quarter blocks at narrow width.

```jsx
it('selects a date with its actual sent and received counts', () => {
  const onSelectDate = vi.fn();
  render(<ActivityCalendar
    days={[{ date: '2026-09-09', received: 3, sent: 1, value: 4 }]}
    direction="both" selectedDate={null} onSelectDate={onSelectDate}
  />);
  fireEvent.click(screen.getByRole('button', {
    name: /9 September 2026.*3 received.*1 sent/i,
  }));
  expect(onSelectDate).toHaveBeenCalledWith('2026-09-09');
});
```

- [ ] Write keyboard behavior tests for Left/Right, Up/Down, Home/End, Enter/Space, bounds, and focus after closing day details. These tests prove app handlers; do not describe them as physical native keyboard tests.
- [ ] Run RED through the unit lane.
- [ ] Implement native date buttons with date/count labels, app-level keyboard handlers, a theme-aware five-level ramp, unavailable-coverage treatment, and a clear selected-day outline. On Both use total activity and retain separate sent/received totals. The calendar's zero-day color is distinct from out-of-range cells.
- [ ] Render contiguous quarter-sized chunks when needed; each date appears once. Check shared toolbars, long translated labels, all tabs, and reader detail at 720px app width and 320px available content width. Add scoped chart tokens for light/dark and Graphite without changing existing custody colors.
- [ ] Run GREEN, then all Insights component/model tests. Commit calendar and its direct integration.

## Task 7: Native E2E fixtures and real end-to-end scenarios on the Mac mini

**Files:** Create `tests/e2e/insightsFixture.js`, `wdio.insights.conf.js`, `tests/e2e/connected-insights.test.js`, `tests/e2e/ui-insights.test.js`, and `tests/unit/insightsFixture.test.js`. Extend shared harness configuration only as necessary to inject a scenario without changing its default accounts/counts.

**Interfaces:** `buildInsightsScenario()` returns mock-server Scenario data plus a literal expected-results object for a fixed custom range. Dedicated config composes the existing WDIO lifecycle/isolation/cleanup and changes only scenario inputs/spec selection. Tests use the default mock-server native transport; they do not write a fabricated Insights result directly into a store.

- [ ] Before integration behavior is completed in Tasks 3–6, add its corresponding native case and record a failing run against the current build. Add cases incrementally; Task 7 collects and completes them. A missing/unreachable control is valid initial E2E RED; a driver launch failure is not.
- [ ] Build a fixed September 2026 scenario with separate sender identities, known send/receive dates, a 700-header mailbox, a nested folder, same UID across accounts, Sent with multiple recipients, an automated sender, a draft, and a server/vault duplicate. Seed vault state via the established native archive path or test-owned real files, not by supplying precomputed chart data. Create a vault-only message by verifying archive then removing its mock-server copy. Avoid mutating the default Luke/Vader fixtures used by other specs.
- [ ] Test the fixture itself against literal expected counts and raw RFC headers before relying on it. Use custom dates in the UI, so the test never depends on the machine's current year/day. Keep DST and leap-day mathematical cases in unit tests and verify one timezone-boundary case through native header extraction.
- [ ] Implement UI interaction helpers that verify visible bounds, inert/hidden state, focusability, and center hit-testing before a DOM click. The existing Tauri driver has limitations with element-reference display checks and untrusted key events. Use the real visible control's handler; never call an Insights store action as a substitute for testing navigation.

```js
async function clickReachable(selector) {
  const clicked = await browser.execute(sel => {
    const node = document.querySelector(sel);
    if (!node || node.disabled || node.closest('[hidden], [inert]')) return false;
    node.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    const rect = node.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    if (hit !== node && !node.contains(hit)) return false;
    node.focus(); node.click(); return true;
  }, selector);
  assert.equal(clicked, true, `Reachable control: ${selector}`);
}

it('opens Insights from the real sidebar and shows receive activity', async () => {
  await waitForApp(); await waitForEmails();
  await clickReachable('[data-testid="open-insights"]');
  await browser.waitUntil(() => browser.execute(() =>
    document.querySelector('[data-testid="insights-page"]')?.dataset.status === 'ready'
  ), { timeout: 30000, interval: 150, timeoutMsg: 'Insights local inventory did not settle' });
  await clickReachable('[data-testid="insights-tab-activity"]');
  assert.ok(await browser.execute(() =>
    document.querySelector('[data-testid="insights-activity"]') !== null));
});
```

The ready assertion above is for the dedicated complete fixture. Partial/error cases assert their own visible status and coverage; never wait for ready unconditionally across all tests.

- [ ] Complete the native acceptance matrix:

| Scenario | Required observation |
| --- | --- |
| Entry/exit in all sidebar layouts | Real entry works, return restores mailbox/search/Explorer/reader state |
| Sender map semantics | Old frequent contact has larger area; new infrequent contact has smaller radial distance; selection opens exact sender detail |
| Top-30/search | Omitted count visible; a sender beyond the top 30 can be found and opened |
| Timeline | Exact received-date buckets, sent shapes, sort/zoom, sender filter carries across tabs |
| Activity | Literal sent/received totals, correct custom-year/date cells, day opens matching messages |
| Data beyond current page | 700-header inventory or visible incomplete coverage, never a false complete 200-message year |
| All accounts/nested folders | Unselected account and nested folder included; duplicate UIDs remain distinct |
| Server/vault dedup | Archived copy does not increase logical count; vault-only message remains visible offline |
| Reader drill-down | Correct account/folder/Message-ID/body and existing custody; no unrelated mail is opened |
| Refresh/new mail | New mock mail and deletion update counts once; account switch during loading cannot leak stale results |
| Failure/cancel/offline | Partial warning, retry, vault-disconnected error, no-data distinction, usable last result |
| Preferences/reload | Preferences restored after real WebView reload; mail data is not stored in preferences |
| UI states | Light/dark, Indigo/Graphite, empty state, non-English long labels, 720px window, collapsed sidebar |
| Large data | 50,000-header synthetic native inventory remains responsive; top 30 bubbles, virtualized lanes/messages, bounded page sizes |
| Interaction safety | Opening charts does not read/mark/send/archive/delete messages; opening a message follows existing read behavior |

- [ ] Run RED/GREEN native waves from the exact synced and rebuilt revision under the shared queue. Never enable CI mode to bypass the screen-lock check.

```sh
/Users/Rokas/.claude/bin/testq --lane macmini-e2e ssh macmini \
  'bash /Users/unicorn/Repos/mv-insights-20260909-01a08694/scripts/testing/insights/remote.sh build'
/Users/Rokas/.claude/bin/testq --lane macmini-e2e ssh macmini \
  'bash /Users/unicorn/Repos/mv-insights-20260909-01a08694/scripts/testing/insights/remote.sh e2e --spec ./tests/e2e/connected-insights.test.js --spec ./tests/e2e/ui-insights.test.js --logLevel warn'
```

- [ ] Measure the large fixture: no main-thread task over 100ms attributable to aggregation; filter/selection response within 200ms after the worker model is ready; at most 30 rendered map nodes; bounded native pages; no mailbox body/attachment fetch caused by entering charts. Save timings and counts, including machine/build context. If a target fails, profile and fix the measured path with a regression test; do not relax assertions without explaining the evidence.
- [ ] Capture and inspect map, timeline, calendar, sender/day detail, partial coverage, and narrow/light/dark screenshots from the real native app. Distinguish semantic focus/handler coverage from physical Enter/Tab activation when the driver cannot provide trusted events. Record a manual native keyboard pass if available; otherwise list that limitation explicitly.
- [ ] Commit fixtures/specs and any demonstrated fixes. A rerun passes only after the failing behavior has an explained cause; preserve first-failure logs.

## Task 8: Final verification, source parity, and reviewable delivery

**Files:** Update `README.md`, `CHANGELOG.md` under Unreleased, `architecture.md`, and the actual `docs/insights-verification-2026-09-09.md`. Update the design spec only if implementation reveals a necessary, explicitly documented refinement.

- [ ] Run all Insights tests after the last implementation change, then the full frontend suite on the mini. Run the native reader tests and changed core/provider suites. No frontend test suite runs on the controller.

```sh
/Users/Rokas/.claude/bin/testq --lane macmini-insights-unit ssh macmini \
  'bash /Users/unicorn/Repos/mv-insights-20260909-01a08694/scripts/testing/insights/remote.sh unit --reporter=dot'
/Users/Rokas/.claude/bin/testq --lane macmini-insights-rust ssh macmini \
  'bash /Users/unicorn/Repos/mv-insights-20260909-01a08694/scripts/testing/insights/remote.sh rust -p mailvault-core -p mailvault-daemon'
/Users/Rokas/.claude/bin/testq --lane macmini-insights-rust ssh macmini \
  'bash /Users/unicorn/Repos/mv-insights-20260909-01a08694/scripts/testing/insights/remote.sh rust -p mailvault insights'
```

- [ ] Rebuild the exact final revision and run the dedicated Insights config. Then run both existing CI-safe native suites through the shared lane. `local-manual` includes visual/archive/migration flows with separate prerequisites; do not call an unrun manual suite passed or sweep it in with the unrestricted `specs` glob.

```sh
/Users/Rokas/.claude/bin/testq --lane macmini-e2e ssh macmini \
  'bash /Users/unicorn/Repos/mv-insights-20260909-01a08694/scripts/testing/insights/remote.sh regression --suite ui-headless --logLevel warn'
/Users/Rokas/.claude/bin/testq --lane macmini-e2e ssh macmini \
  'bash /Users/unicorn/Repos/mv-insights-20260909-01a08694/scripts/testing/insights/remote.sh regression --suite connected-ci --logLevel warn'
```

- [ ] The focused regression review must include sidebar/navigation, List/Explorer switching if integrated, layouts, search across folders, unified inbox, read-state, UID-reissue/vault mismatch, partial loading, Settings, and Compose. Existing suite failures must be classified with evidence; do not mute or delete assertions to obtain green.
- [ ] Run translation/catalog checks already included in the frontend suite. Run the Impeccable mechanical detector once over changed UI files after visual work is finished, and address findings that apply to this design. Inspect native screenshots after the last relevant visual change.
- [ ] Regenerate the source manifest locally and on the runner. Compare every tested source/build-input checksum. Exclude generated Tauri schemas, binaries, and screenshot artifacts explicitly; any unexplained mismatch invalidates the claimed source revision.
- [ ] Record per-task RED/GREEN logs, final commands/exit codes/counts, retry history, screenshots, timing evidence, source hash, and any unrun/driver-limited checks. The report must say whether coverage is local inventory only and how unknown/fallback dates are presented.
- [ ] Review the final patch against the spec. Confirm no unrelated Explorer edits were staged, no version bump/release occurred, and all three views open real matching mail with the existing reader. Commit only this feature's reviewed files.

## Definition of done

Execution completed; see the verification report for actual test-first waves, final results, and disclosed driver limits.

- [x] Insights is reachable in every sidebar mode; mailbox/Explorer state returns intact.
- [x] All three views use the same complete available-header model, identity rules, direction definitions, and local-date boundaries.
- [x] Bubble area/recency geometry, timeline zoom, daily calendar, shared filters, and real message drill-down meet the spec.
- [x] Partial, unknown, stale, offline, and disconnected-vault states are truthful and actionable.
- [x] Test-first evidence exists for every behavioral deliverable; focused and full required Mac mini test waves have actual results.
- [x] Native screenshots are inspected, large-mailbox behavior is measured, and source parity matches the tested revision.
- [x] Documentation and final report accurately distinguish completed, failed, limited, and unrun validation.
