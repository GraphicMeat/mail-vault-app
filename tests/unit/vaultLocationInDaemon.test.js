/**
 * Plan 2026-09-17 daemon-shell-phase6 ("vault location and cleanup"): the
 * real work behind `vault_get_status`/`vault_adopt`/`vault_move_to`/
 * `vault_move_to_default` moves to the daemon (`mailvault_core::vault_ops`,
 * `src-daemon/src/handlers/vault.rs`); the five Tauri commands stay
 * registered as thin bookmark/choreography forwarders (spec deviation 1
 * shape, same as `vaultInDaemon.test.js`'s `STAY_REGISTERED` list) — this is
 * a different phase's claim about a different set of commands, kept in its
 * own file rather than editing that one. `vault_reset` and
 * `vault_inspect_folder` are decided exceptions with no real work to move
 * (documented in the phase 6 plan doc and in `vault.rs`'s module doc
 * comment), not stragglers. CI never runs `cargo test -p mailvault`, so this
 * reads the source directly, same pattern as `vaultInDaemon.test.js`.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

const main = readFileSync('src-tauri/src/main.rs', 'utf8');
const handlerList = main.slice(main.indexOf('generate_handler!['), main.indexOf(']', main.indexOf('generate_handler![')));
const vaultRs = readFileSync('src-tauri/src/vault.rs', 'utf8');
const commandsRs = readFileSync('src-tauri/src/commands.rs', 'utf8');

// The five vault-location commands never leave `generate_handler!` — only
// their bodies changed (bookmark + choreography, not the file work).
const VAULT_LOCATION_COMMANDS = ['vault_get_status', 'vault_adopt', 'vault_move_to', 'vault_move_to_default', 'vault_reset'];

// Already-decided exceptions, unaffected by this phase — pinned here (not
// re-litigated) so a later phase does not "clean them up" by habit.
const STAY_REGISTERED = ['vault_inspect_folder', 'vault_apply_flags', 'vault_rename_mailbox', 'vault_adopt_mailbox_dirs', 'save_attachment_to'];

// Confirmed absent before this phase started (already removed in earlier
// phases): get_password, delete_password, export_mbox, graph_get_mime. Only
// these three were still live.
const DEAD_COMMANDS = ['get_log_path', 'request_notification_permission', 'backup_resolve_external_location'];

describe('vault-location commands stay registered as daemon forwarders (Phase 6)', () => {
  it('reads a real handler list', () => {
    expect(handlerList).toContain('daemon_rpc');
  });

  it.each(VAULT_LOCATION_COMMANDS)('%s stays a Tauri command', (name) => {
    expect(handlerList).toMatch(new RegExp(`\\b${name}\\b`));
  });

  it.each(STAY_REGISTERED)('%s stays registered (a decided exception, not a straggler)', (name) => {
    expect(handlerList).toMatch(new RegExp(`\\b${name}\\b`));
  });

  it.each(DEAD_COMMANDS)('the app does not register the dead command %s', (name) => {
    expect(handlerList).not.toMatch(new RegExp(`\\b${name}\\b`));
  });

  it('get_log_path and request_notification_permission are not defined in main.rs', () => {
    expect(main).not.toMatch(/fn get_log_path\(/);
    expect(main).not.toMatch(/fn request_notification_permission\(/);
  });

  it('backup_resolve_external_location is not defined in commands.rs', () => {
    expect(commandsRs).not.toMatch(/fn backup_resolve_external_location\(/);
  });

  it('MoveFollowUp/after_failed_move are gone — the two-phase daemon protocol replaces the root-before/root-after guess', () => {
    expect(main).not.toMatch(/\benum MoveFollowUp\b/);
    expect(main).not.toMatch(/\bfn after_failed_move\b/);
  });

  it('vault.rs no longer defines the copy/verify/move algorithms (moved to mailvault_core::vault_ops)', () => {
    for (const fn of ['fn copy_tree', 'fn verify_tree', 'fn copy_and_verify', 'fn remove_sources', 'fn set_aside_custody', 'fn verify_custody', 'fn adopt', 'fn move_to', 'fn move_to_default']) {
      expect(vaultRs).not.toContain(fn);
    }
  });

  it('vault.rs keeps the app-only bookmark broker and local status cache', () => {
    for (const fn of ['pub fn resolve', 'pub fn status', 'pub fn reset', 'pub fn inspect_folder', 'pub struct VaultState']) {
      expect(vaultRs).toContain(fn);
    }
  });

  // Phase 3 remainder, Task 5: `root()` handed the mail-data directory to
  // app-side readers and writers. The backup runners were the last of those,
  // so it was deleted — every vault path now resolves inside the daemon
  // (`handlers::common::vault_root`). The `Resolved` cache stays for
  // `status()`, which is why the assertion above still holds.
  it('vault.rs no longer hands out the mail-data root to app-side callers', () => {
    expect(vaultRs).not.toContain('pub fn root');
  });
});

describe('the vault-location file work lives in mailvault_core::vault_ops and the daemon (Phase 6)', () => {
  const vaultOpsPath = 'src-core/src/vault_ops.rs';
  const vaultLayoutPath = 'src-core/src/vault_layout.rs';
  const daemonHandlerPath = 'src-daemon/src/handlers/vault.rs';
  const libRs = readFileSync('src-core/src/lib.rs', 'utf8');

  it('src-core/src/vault_ops.rs exists and is registered in lib.rs', () => {
    expect(existsSync(vaultOpsPath)).toBe(true);
    expect(libRs).toMatch(/pub mod vault_ops;/);
  });

  it.each(['copy_tree', 'verify_tree', 'copy_and_verify', 'remove_sources', 'classify_folder', 'count_messages', 'count_files'])('vault_ops exports %s', (name) => {
    const body = readFileSync(vaultOpsPath, 'utf8');
    // Tolerate a generic parameter list between the name and `(`, e.g.
    // `pub fn copy_and_verify<F: Fn(MoveProgress)>(`.
    expect(body).toMatch(new RegExp(`pub fn ${name}(<[^>]*>)?\\(`));
  });

  it('vault_layout.rs gained write_marker/new_vault_id/now_millis (the daemon now writes markers, not just reads them)', () => {
    const body = readFileSync(vaultLayoutPath, 'utf8');
    expect(body).toMatch(/pub fn write_marker\(/);
    expect(body).toMatch(/pub fn new_vault_id\(/);
    expect(body).toMatch(/pub fn now_millis\(/);
  });

  it('src-daemon/src/handlers/vault.rs exists and routes the five method names', () => {
    expect(existsSync(daemonHandlerPath)).toBe(true);
    const body = readFileSync(daemonHandlerPath, 'utf8');
    for (const method of ['vault_get_status', 'vault_adopt', 'vault_move_to', 'vault_move_to_default', 'vault_move_finalize']) {
      expect(body).toContain(`"${method}"`);
    }
  });

  it('handlers::vault is registered in the daemon dispatch chain', () => {
    const serverRs = readFileSync('src-daemon/src/server.rs', 'utf8');
    expect(serverRs).toMatch(/crate::handlers::vault::route\(/);
  });

  it('a move is guarded by a moveId — vault_move_finalize can never commit a mismatched or absent pending move', () => {
    const body = readFileSync(daemonHandlerPath, 'utf8');
    expect(body).toMatch(/move_id/);
    expect(body).toMatch(/pending_move/);
  });
});
