# Startup and Daemon Reliability Fixes

**Date:** 2026-04-07
**Status:** Approved design, pending implementation plan

## Scope

Three focused behavioral fixes. No architecture changes, no storage format changes, no daemon mode semantic changes.

---

## Fix 1: dev.sh Replace-Existing

### Problem

`dev.sh` checks `daemon.pid` for a stale daemon but does not check `daemon.lock` (the real singleton mechanism). If a production MailVault app or its daemon holds the lock and socket, the script's daemon launch either hangs or reports "no socket after 3s" without explaining why.

### Change

Before daemon launch, inspect `daemon.lock` with `lsof` to identify the lock holder. Route based on what holds the lock:

1. **Lock held by `mailvault-daemon` or `mailvault`**: terminate the holder with `kill`, wait for lock release in a short loop (up to 3s, polling 0.2s), then remove stale `daemon.sock` / `daemon.pid`.
2. **Lock held by an unexpected process**: fail with a clear message naming the holder PID and command, instead of hanging.
3. **Lock not held**: proceed normally.

Before `npm run tauri:dev`, check for a running MailVault app process by matching the exact binary path or process name: `MailVault.app` (macOS bundle), `mail-vault-app` (Tauri dev binary), or `mailvault` (release binary). Use `pgrep -f` with specific patterns. Only kill if the matched process is a MailVault instance — no broad name matching that could hit unrelated binaries.

The existing pid-based cleanup (lines 92-100) stays as the fast path. The lock-based check is the robust fallback inserted after it.

### Files

- Modify: `scripts/dev.sh`

---

## Fix 2: Empty Mailbox After Migration

### Problem

In `init()` (`src/services/workflows/activateAccount.js`, line 993), when `currentActiveId === firstVisible.id`, the function assumes the account is already hydrated. It only acts if `currentEmails.length > 0 && currentLoading` (stuck loading flag). After migration, quick-load may set `activeAccountId` without populating `emails`. If `emails.length === 0` and `loading === false`, init does nothing — the user sees "No emails in this folder" despite cache/server data existing.

### Change

Replace the `currentActiveId === firstVisible.id` branch with:

```js
if (currentActiveId === firstVisible.id) {
  const { emails: currentEmails, loading: currentLoading, sortedEmails: currentSorted } = get();
  if (currentEmails.length === 0) {
    // Quick-load set account active but didn't hydrate — force activation
    const lastMailbox = useSettingsStore.getState().getLastMailbox(firstVisible.id);
    await get().activateAccount(firstVisible.id, lastMailbox || 'INBOX');
  } else if (currentLoading) {
    // Loading stuck with emails present — clear the flag
    set({ loading: false });
    if (currentSorted.length === 0) get().updateSortedEmails();
  }
  // else: account active, emails present, not loading — normal state, do nothing
}
```

Key points:
- Uses `lastMailbox` from settings (not hardcoded `'INBOX'`) to preserve the user's last folder selection.
- The normal case (emails present, not loading) is unchanged.
- The else branch (`currentActiveId !== firstVisible.id`) is unchanged — it already calls `activateAccount`.

### Files

- Modify: `src/services/workflows/activateAccount.js`

---

## Fix 3: Quit Paths Honor Daemon Shutdown

### Problem

Three `std::process::exit(0)` calls bypass the Tauri event loop. `RunEvent::Exit` never fires, so `shutdown_daemon_child()` never runs. The on-demand daemon survives app exit.

### Change

Replace `std::process::exit(0)` at two locations with `app_handle.exit(0)` / `app.exit(0)`:

| Location | Line | Current | Replacement |
|----------|------|---------|-------------|
| App menu "Quit" handler | ~4483 | `std::process::exit(0)` | `app_handle_for_menu.exit(0)` |
| Tray menu "Quit" handler | ~4539 | `std::process::exit(0)` | `app.exit(0)` |
| Single-instance early exit | ~4184 | `std::process::exit(0)` | **Keep as-is** (pre-setup, no daemon) |

`app.exit(0)` triggers the normal Tauri shutdown sequence: `RunEvent::ExitRequested` → `RunEvent::Exit` → `shutdown_daemon_child()`. Both closures already have access to the app handle.

No changes to `shutdown_daemon_child()` itself — it already correctly handles the on-demand case (kills spawned child) and the always-on case (does nothing).

### Files

- Modify: `src-tauri/src/main.rs`

---

## Test Plan

### Dev script
- Start MailVault or its daemon manually, then run `./scripts/dev.sh`
- Verify old instance is terminated and new daemon socket appears
- Verify the script fails clearly if lock is held by an unrelated process

### Startup recovery
- Simulate quick-load setting `activeAccountId` with empty `emails[]`
- Verify `init()` forces `activateAccount()` using the persisted last mailbox
- Regression: normal startup with cached emails still renders instantly without re-activation

### Quit behavior
- Launch app in on-demand mode, trigger daemon spawn, then quit via:
  - Cmd+Q (macOS) / Ctrl+Q (Linux)
  - App menu Quit
  - Tray menu Quit
- Verify daemon process exits in each case
- Verify always-on mode is unaffected (daemon stays running)

## Assumptions

- The daemon should only be auto-replaced in development tooling, not in production runtime.
- The app should only kill daemon processes it spawned itself during normal on-demand operation.
- `app.exit(0)` in Tauri v2 triggers the full `RunEvent` lifecycle including `RunEvent::Exit`.
