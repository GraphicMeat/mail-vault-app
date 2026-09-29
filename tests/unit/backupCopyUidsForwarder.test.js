/**
 * `backup_copy_uids` (Archive, Back up & Delete): copy vault files onto the
 * backup drive and verify them there. Like `backup_purge_uids`, the app can not
 * do this itself and the daemon can not resolve the drive's security-scoped
 * bookmark, so the call is a bookmark FORWARDER: the app command resolves the
 * backup slot, holds it for the call and forwards to the daemon with the
 * resolved `mirrorRoot`; every read, write and comparison runs in the daemon.
 *
 * CI never runs `cargo test -p mailvault`, so this reads the sources directly,
 * the same pattern as `vaultInDaemon.test.js`. Each assertion pins one hop of
 * the route, because a missing hop fails at runtime as "command not found" or
 * as a copy that silently has no drive to write to.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as transport from '../../src/services/transport.js';

const read = (p) => readFileSync(p, 'utf8');
const main = read('src-tauri/src/main.rs');
const handlerList = main.slice(main.indexOf('generate_handler!['), main.indexOf(']', main.indexOf('generate_handler![')));
const shell = read('src-tauri/src/backup.rs');
const daemon = read('src-daemon/src/handlers/backup.rs');
const api = read('src/services/api.js');

/** The body of `pub async fn <name>` in the shell file, up to the next top-level item. */
const shellFn = (name) => {
  const at = shell.indexOf(`pub async fn ${name}(`);
  expect(at, `${name} is declared in src-tauri/src/backup.rs`).toBeGreaterThan(-1);
  const next = shell.indexOf('\n#[tauri::command]', at);
  return shell.slice(at, next === -1 ? undefined : next);
};

describe('backup_copy_uids reaches the daemon through the shell forwarder', () => {
  it('is a registered Tauri command, next to its purge and scan siblings', () => {
    expect(handlerList).toMatch(/\bbackup::backup_copy_uids\b/);
    expect(handlerList).toMatch(/\bbackup::backup_purge_uids\b/);
  });

  it('is NOT daemon-owned: the renderer must go through the shell that holds the bookmark', () => {
    expect(transport.DAEMON_OWNED.has('backup_copy_uids')).toBe(false);
    // The purge forwarder it is modelled on is the same shape.
    expect(transport.DAEMON_OWNED.has('backup_purge_uids')).toBe(false);
  });

  it('forwards the four params with the backup slot resolved, on the blocking pool', () => {
    const body = shellFn('backup_copy_uids');
    expect(body).toMatch(/spawn_blocking/);
    expect(body).toMatch(/forward\(\s*&app_handle,\s*"backup_copy_uids"/);
    for (const key of ['accountId', 'email', 'mailbox', 'uids']) expect(body).toContain(`"${key}"`);
    // No queue and no status for a copy: an unreachable drive is an error the caller answers by keeping the mail.
    expect(body).not.toMatch(/externalStatus|external_location_status/);
    // The command does no file work itself.
    expect(body).not.toMatch(/std::fs|copy_uids_to_mirror|write_atomic/);
  });

  it('the daemon routes backup_copy_uids to a handler that copies on the blocking pool', () => {
    expect(daemon).toMatch(/"backup_copy_uids"\s*=>\s*match backup_copy_uids\(/);
    const at = daemon.indexOf('pub(crate) async fn backup_copy_uids(');
    expect(at).toBeGreaterThan(-1);
    const body = daemon.slice(at, daemon.indexOf('\n}\n', at));
    expect(body).toMatch(/common::blocking\(/);
    expect(body).toMatch(/backup::copy_uids_to_mirror\(/);
    // The read-side vault gate, before any disk access.
    expect(body.indexOf('common::vault_root(state)')).toBeGreaterThan(-1);
    expect(body.indexOf('common::vault_root(state)')).toBeLessThan(body.indexOf('common::blocking('));
  });

  it('the app-side wrapper invokes the command with the ids the daemon reads', () => {
    expect(api).toMatch(/export async function backupCopyUids\(accountId, email, mailbox, uids\)/);
    expect(api).toMatch(/tauriInvoke\('backup_copy_uids',\s*\{\s*accountId,\s*email,\s*mailbox,\s*uids\s*\}\)/);
  });
});
