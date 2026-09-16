/**
 * Plan 2026-09-15 daemon-shell-phase2, Global constraints "Deleted Tauri
 * commands" (b)+(d): every Phase 2 command that moves to the daemon must be
 * absent from `generate_handler!` and present in this file's list. Tasks
 * 2.6-2.9b each extend the list as their methods move; nothing here yet
 * removes a name once added — a name that came back to the app would be a
 * regression this guard exists to catch. CI never runs `cargo test -p
 * mailvault`, so this reads the source directly, same pattern as
 * `tests/unit/searchIndexInDaemon.test.js` (Phase 1).
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

const main = readFileSync('src-tauri/src/main.rs', 'utf8');
const handlerList = main.slice(main.indexOf('generate_handler!['), main.indexOf(']', main.indexOf('generate_handler![')));

// Task 2.6: the vault read family and the attachment cache.
const MOVED = [
  'maildir_read', 'maildir_read_light', 'maildir_read_light_batch', 'maildir_read_raw_source', 'maildir_read_attachment',
  'maildir_exists', 'maildir_list', 'maildir_storage_stats', 'maildir_orphan_stats',
  'cache_attachment', 'cached_attachment_path', 'prefetch_attachments',
  // Task 2.7: header caches, mailbox cache, Outlook uid ledger, op journal,
  // pending operation (18 names — inventory-cache.md §1 rows 3-20).
  'save_email_cache', 'load_email_cache', 'load_email_cache_partial', 'load_email_cache_meta',
  'load_email_cache_by_uids', 'list_cached_uids', 'clear_email_cache',
  'save_mailbox_cache', 'load_mailbox_cache', 'delete_mailbox_cache',
  'graph_allocate_uids', 'load_graph_id_map',
  'op_journal_queue', 'op_journal_clear', 'op_journal_read',
  'read_pending_operation', 'save_pending_operation', 'clear_pending_operation',
  // Task 2.8: the six simple vault writers (inventory-maildir.md §1 rows 1,
  // 12, 14, 16-18).
  'maildir_store', 'maildir_delete', 'maildir_set_flags', 'maildir_clear_cache',
  'maildir_migrate_json_to_eml', 'maildir_migrate_email_dirs',
  // Task 2.9b: the custody cutover — the four custody commands and the three
  // vault writers that read or rewrite custody rows (inventory-maildir §1 rows
  // 13, 19, 21; inventory-custody-plumbing §1).
  'local_index_read', 'local_index_append', 'local_index_remove', 'custody_status',
  'maildir_delete_many', 'maildir_repair_generation', 'maildir_purge_orphans',
];

// The three mirror-broker forwarders (spec deviation 1) and the two settings
// json commands (R2.3) stay registered — they must never be flagged absent.
const STAY_REGISTERED = [
  'vault_apply_flags', 'vault_rename_mailbox', 'vault_adopt_mailbox_dirs',
  'read_settings_json', 'write_settings_json',
];

describe('vault reads and the attachment cache live in the daemon (Task 2.6)', () => {
  it('reads a real handler list', () => {
    expect(handlerList).toContain('daemon_rpc');
  });

  it.each(MOVED)('the app does not register %s', (name) => {
    expect(handlerList).not.toMatch(new RegExp(`\\b${name}\\b`));
  });

  it.each(STAY_REGISTERED)('%s stays a Tauri command (forwarder or shell allowlist)', (name) => {
    expect(handlerList).toMatch(new RegExp(`\\b${name}\\b`));
  });

  it('no app source calls mailvault_core::vault_files:: for a moved read/attachment-cache method', () => {
    // main.rs still calls vault_files:: for the app-side writers that stay until
    // Phases 3-5 (maildir_store_raw, the mbox importer, verify_archived_emails)
    // and for the repair-input helpers the custody-backed trio uses
    // (sidecar_message_id_map, cached_sync_meta, orphan_mailbox_dirs) — this
    // only checks the moved *method* names are
    // gone as literal command definitions, already covered above; this test
    // documents the boundary rather than re-asserting it structurally.
    for (const name of MOVED) {
      expect(main).not.toMatch(new RegExp(`fn ${name}\\(`));
    }
  });
});

/**
 * Task 2.9b: `custody.db` opens EXCLUSIVE, so exactly one process may hold it.
 * The daemon opens it at startup; a single line of app code that opens or
 * borrows a connection makes that open fail BUSY — for the daemon or for the
 * app, whichever loses the race — and the failure is a banner, not a crash.
 * So the guard is the absence of the app-side openers and borrowers, not a
 * test of behaviour.
 *
 * Deliberately NOT forbidden: `custody::db::DB_DIR` / `DB_FILE`. `insights.rs`
 * stamps those two paths' mtimes before reading (a file watch works from any
 * process) and `vault.rs` names them when it sets a copy aside during a vault
 * move. Neither opens the store.
 */
describe('custody.db has exactly one opener, and it is the daemon (Task 2.9b)', () => {
  const dir = 'src-tauri/src';
  const sources = readdirSync(dir).filter((f) => f.endsWith('.rs')).map((f) => [f, readFileSync(`${dir}/${f}`, 'utf8')]);

  it('reads the real app sources', () => {
    expect(sources.length).toBeGreaterThan(10);
  });

  it.each(['src-tauri/src/custody.rs', 'src-tauri/src/custody_tests.rs'])('%s is deleted', (f) => {
    expect(existsSync(f)).toBe(false);
  });

  // The app's own custody module and its managed state are gone outright:
  // no file, test or not, may name them.
  it.each([
    ['crate::custody', /crate::custody\b/],
    ['CustodyState', /\bCustodyState\b/],
  ])('no app source mentions %s', (_name, pattern) => {
    const offenders = sources.filter(([, body]) => pattern.test(body)).map(([f]) => f);
    expect(offenders).toEqual([]);
  });

  // Borrowing a connection from core is what would actually take the
  // EXCLUSIVE lock, so it is forbidden in everything the shipped binary runs.
  // `*_tests.rs` is exempt: `insights_tests.rs` opens a store of its own in a
  // tempdir to feed the bridge closure, which is `#[cfg(test)]` and can never
  // race the daemon's open.
  it.each([
    ['custody::db::open', /custody::db::open\b/],
    ['custody::entries::', /custody::entries::/],
    ['custody::lock(', /custody::lock\(/],
  ])('no shipped app source calls %s', (_name, pattern) => {
    const offenders = sources.filter(([f, body]) => !f.endsWith('_tests.rs') && pattern.test(body)).map(([f]) => f);
    expect(offenders).toEqual([]);
  });

  it('the three mirror-broker forwarders reach the daemon, not a local writer', () => {
    const forwarders = readFileSync(`${dir}/vault_flags.rs`, 'utf8');
    expect(forwarders).toMatch(/daemon_call_blocking/);
    expect(forwarders).not.toMatch(/apply_everywhere|rename_dirs|adopt_dirs/);
  });
});
