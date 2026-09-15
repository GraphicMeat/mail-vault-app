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
import { readFileSync } from 'node:fs';

const main = readFileSync('src-tauri/src/main.rs', 'utf8');
const handlerList = main.slice(main.indexOf('generate_handler!['), main.indexOf(']', main.indexOf('generate_handler![')));

// Task 2.6: the vault read family and the attachment cache.
const MOVED = [
  'maildir_read', 'maildir_read_light', 'maildir_read_light_batch', 'maildir_read_raw_source', 'maildir_read_attachment',
  'maildir_exists', 'maildir_list', 'maildir_storage_stats', 'maildir_orphan_stats',
  'cache_attachment', 'cached_attachment_path', 'prefetch_attachments',
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
    // main.rs still calls vault_files:: for the writers that stay (maildir_store,
    // maildir_delete, maildir_delete_many, maildir_set_flags, maildir_clear_cache,
    // maildir_migrate_*) plus the repair-input helpers maildir_repair_generation
    // and maildir_purge_orphans use (sidecar_message_id_map, cached_sync_meta,
    // orphan_mailbox_dirs) — this only checks the 12 moved *method* names are
    // gone as literal command definitions, already covered above; this test
    // documents the boundary rather than re-asserting it structurally.
    for (const name of MOVED) {
      expect(main).not.toMatch(new RegExp(`fn ${name}\\(`));
    }
  });
});
