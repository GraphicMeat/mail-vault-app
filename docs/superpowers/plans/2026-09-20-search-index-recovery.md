# Search Index Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep indexed search self-healing and keep Rebuild/Delete usable when index status is unavailable.

**Architecture:** Treat `available: false` as a recoverable runtime state, not proof of corruption. The daemon retries opening a configured closed index, while explicit Rebuild deletes the derived SQLite index from the canonical vault root and opens a fresh one. The settings UI never gates recovery actions on index availability.

**Tech Stack:** React 18, Zustand, Vitest/Testing Library, Rust, rusqlite, Cargo tests.

**Spec:** User-approved bounded design in this task conversation; no separate spec file.

## Global Constraints

- Preserve `.eml` vault files; only the derived `search_index/index.db*` files may be deleted.
- Preserve newer-schema indexes during automatic recovery; only explicit Rebuild may replace them.
- Preserve vault-unreachable and vault-switch safety gates.
- Add no dependencies or unrelated abstractions.
- Write all regression tests before production changes. Per explicit user instruction, do not run them until all planned code is implemented.
- After implementation, run verification once and fix code failures in one pass.

## Review Focus

- A configured index whose first open failed must retry without frontend activity.
- Automatic retry must never delete a newer-schema or temporarily unavailable index.
- Explicit Rebuild must work when no database connection/root slot is installed.
- Rebuild/Delete must remain usable while status reports unavailable.
- Configure transport failure must retry even if reconnect notification is missed.

---

### Task 1: Pin recovery behavior in tests

**Files:**
- Modify: `src/components/settings/__tests__/SearchIndexSettings.test.jsx`
- Modify: `src/hooks/__tests__/useSearchIndexConfig.test.js`
- Modify: `src-daemon/src/search_index.rs`

**Interfaces:**
- Consumes: existing `SearchIndexSettings`, `useSearchIndexConfig`, and daemon worker state.
- Produces: regression coverage for unavailable controls, configure retry, closed-index reopen, and explicit unavailable rebuild.

- [x] Add a component test that sets `statusReply = { available: false, state: 'unavailable' }`, asserts Rebuild/Delete are enabled, invokes Rebuild, opens Delete confirmation, and confirms both service functions are reachable.
- [x] Replace the hook's “retry on unrelated store change” expectation with fake-timer coverage proving a failed `configure()` retries without any store or reconnect event.
- [x] Add a Rust test that closes a configured index, drives the recovery pass, and asserts the existing index reopens without file deletion.
- [x] Add a Rust test that plants an unavailable/newer-schema index with no installed root, explicitly rebuilds it, and asserts a fresh current-schema index opens.
- [x] Do not run tests yet; record expected failures: UI actions disabled, no scheduled configure retry, closed passes do not reopen, and rebuild returns early when `root` is `None`.

### Task 2: Implement minimal self-healing

**Files:**
- Modify: `src/components/settings/SearchIndexSettings.jsx`
- Modify: `src/hooks/useSearchIndexConfig.js`
- Modify: `src-daemon/src/search_index.rs`

**Interfaces:**
- Consumes: tests from Task 1.
- Produces: recovery behavior without new public APIs.

- [x] Remove `info.available` from Rebuild/Delete disabled conditions; keep Delete disabled only while deletion runs.
- [x] Add one retry timer inside `useSearchIndexConfig`; a failed push clears dedupe state and retries while mounted. Successful configure, reconnect, config change, and unmount clear obsolete timers.
- [x] Make a configured closed daemon index attempt `open_into()` during a recovery/full pass. Keep automatic opening non-destructive: `db::open` preserves non-corruption failures and newer schemas.
- [x] Make `rebuild_index` use `vault_root` after verifying `mail_dir_ok` and switch generation, rather than requiring the installed `root` slot. Explicit Rebuild can therefore replace an index that could not open.
- [x] Keep existing destroy semantics and safety checks unchanged.

### Task 3: Verify, fix once, and integrate

**Files:**
- Modify only production files needed to fix test failures.

**Interfaces:**
- Consumes: completed implementation.
- Produces: tested commits merged into `main` and pushed to `origin/main`.

- [x] Run focused JS tests: `npm test -- src/components/settings/__tests__/SearchIndexSettings.test.jsx src/hooks/__tests__/useSearchIndexConfig.test.js --run`.
- [x] Run focused Rust tests: `cargo test -p mailvault-daemon search_index -- --nocapture`.
- [x] Run full JS suite: `npm test`.
- [x] Run full Rust suite: `cargo test -p mailvault-core -p mailvault-daemon`.
- [x] Fix implementation failures in one code pass, then rerun failed gates. (No implementation failures occurred.)
- [x] Review the final diff for vault safety, automatic non-destruction, and scope.
- [ ] Commit plan, tests, and implementation on `codex/fix-search-index-recovery`.
- [ ] Merge into local `main`, verify the merged result, then push `main` to `origin`.
