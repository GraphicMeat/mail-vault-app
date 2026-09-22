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
  'maildir_read_attachments',
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
  // Task 3.5: archive, bulk delete, verify and their cancel routes: cancel
  // tokens are daemon state now (per-operation-kind, fixing inventory N4),
  // so ArchiveCancelToken's managed state is gone along with the commands.
  'archive_emails', 'cancel_archive', 'bulk_delete_emails', 'verify_archived_emails',
  // Task 3.7: insights moved whole. The snapshot map, its 300s expiry and
  // its 30s sweeper are daemon state now, so `InsightsSnapshots` and its
  // `start_cleanup` call are gone from the app along with the commands.
  'insights_begin_snapshot', 'insights_read_page', 'insights_release_snapshot',
  // Task 4.2: a pure reqwest fetch, no vault/app_dir/state, moved with no
  // gate, first of the Phase 4 commands.
  'fetch_remote_asset',
  // Task 4.4: backup ZIP export/import. `BackupManifest`/`BackupAccount`/
  // `ExportResult`/`ImportResult`/`AccountsJsonEntry` and
  // `read_accounts_json`/`write_accounts_json` moved out with them; nothing
  // else in the app referenced those.
  'export_backup', 'import_backup',
  // Task 4.6: mbox export/import (archived-flag fix included, decision 3).
  // `sanitize_mailbox_name`, the escape/unescape/from-line/split helpers and
  // `MboxExportResult`/`MboxImportResult` moved out with them; the dead
  // single-mailbox export variant was deleted, not moved.
  'export_mbox_all', 'import_mbox',
  // Task 4.8: migration and restore, the last of Phase 4's three cutovers.
  // `MigrationCancelToken`/`MigrationPauseToken`/`MigrationNotify`/
  // `RestoreCancelToken` and their four `.manage(...)` calls are gone from
  // the app along with the commands; `src-tauri/src/migration.rs` and
  // `restore.rs` (kept as byte-identical copies through Task 4.7's
  // no-cutover phase) are deleted outright, not just emptied.
  'start_migration', 'cancel_migration', 'pause_migration', 'resume_migration',
  'get_migration_state', 'clear_migration_state_cmd', 'count_migration_folders',
  'get_folder_mappings', 'start_restore', 'cancel_restore', 'count_local_folder',
];

// The three mirror-broker forwarders (spec deviation 1) and the two settings
// json commands (R2.3) stay registered — they must never be flagged absent.
// Task 3.9 (plan decision 1) adds `save_attachment_to`: it base64-decodes
// caller-supplied bytes to a caller-supplied destination and never touches
// the vault or the attachment cache, so it belongs on the shell allowlist
// permanently, not as a straggler; pinned here so a later phase does not
// move it out of habit.
const STAY_REGISTERED = [
  'vault_apply_flags', 'vault_rename_mailbox', 'vault_adopt_mailbox_dirs',
  'read_settings_json', 'write_settings_json', 'save_attachment_to',
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
    // main.rs still calls vault_files:: for the app-side writer that stays
    // until Phase 5 (maildir_store_raw); verify_archived_emails
    // moved to the daemon in Task 3.5, so it is no longer a straggler here,
    // and for the repair-input helpers the custody-backed trio uses
    // (sidecar_message_id_map, cached_sync_meta, orphan_mailbox_dirs) — this
    // only checks the moved *method* names are
    // gone as literal command definitions, already covered above; this test
    // documents the boundary rather than re-asserting it structurally.
    for (const name of MOVED) {
      expect(main).not.toMatch(new RegExp(`fn ${name}\\(`));
    }
  });

  // Task 3.7: the snapshot map itself, not just the commands. It carried the
  // 300s expiry and the 30s sweeper, and a second copy of it in the app
  // would split the snapshot store across two processes again.
  it('the app manages no insights snapshot state', () => {
    expect(main).not.toMatch(/InsightsSnapshots/);
    expect(existsSync('src-tauri/src/insights.rs')).toBe(false);
  });

  // Task 4.8: migration.rs/restore.rs left src-tauri for good. Task 4.7 kept
  // byte-identical copies alive through its own no-cutover phase (main.rs
  // still needed the old token types until this task); this cutover deletes
  // both files outright, not just their command registrations.
  it('migration.rs and restore.rs are deleted from the app crate', () => {
    expect(existsSync('src-tauri/src/migration.rs')).toBe(false);
    expect(existsSync('src-tauri/src/restore.rs')).toBe(false);
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
 * Deliberately NOT forbidden: `custody::db::DB_DIR` / `DB_FILE`. `vault.rs`
 * names them when it sets a copy aside during a vault move, which does not
 * open the store. (Insights used to name them too, to stamp their mtimes
 * before reading; Task 3.7 moved it into the daemon, where it reads the
 * custody write counter instead.)
 */
describe('custody.db has exactly one opener, and it is the daemon (Task 2.9b)', () => {
  const dir = 'src-tauri/src';
  const sources = readdirSync(dir).filter((f) => f.endsWith('.rs')).map((f) => [f, readFileSync(`${dir}/${f}`, 'utf8')]);

  // task-2.11 carry-in M4: a file earns the test exemption below by actually
  // being loaded as a `#[cfg(test)]` module (e.g.
  // `#[cfg(test)] #[path = "insights_tests.rs"] mod tests;` in
  // `insights.rs`), not by ending in `_tests.rs`. A future non-test file
  // named `*_tests.rs`, or a `_tests.rs` file no longer reached through such
  // a declaration, must not be silently exempt.
  const declFor = (filename) => new RegExp(`#\\[cfg\\(test\\)\\]\\s*#\\[path\\s*=\\s*"${filename}"\\]\\s*mod\\s+\\w+;`);
  const isCfgTestModuleFile = (filename) => sources.some(([, body]) => declFor(filename).test(body));

  it('reads the real app sources', () => {
    expect(sources.length).toBeGreaterThan(10);
  });

  // Task 3.7 deleted `insights.rs` and `insights_tests.rs`, the app's only
  // pair using this declaration, so nothing in `src-tauri/src` is exempt any
  // more. The mechanism stays: it is what stops a future `*_tests.rs` from
  // being exempt by its name alone.
  it('exemption needs a real #[cfg(test)] module declaration, and no app source claims one now', () => {
    expect(sources.filter(([f]) => isCfgTestModuleFile(f)).map(([f]) => f)).toEqual([]);
    // Not vacuous: the matcher still recognises the declaration shape, it
    // just has nothing left in the app to match against.
    expect(declFor('planted_tests.rs').test('#[cfg(test)]\n#[path = "planted_tests.rs"]\nmod tests;')).toBe(true);
    // A bare path declaration without the cfg(test) attribute is not one.
    expect(declFor('planted_tests.rs').test('#[path = "planted_tests.rs"]\nmod tests;')).toBe(false);
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
  // A file is exempt only when `isCfgTestModuleFile` proves it is loaded
  // through a `#[cfg(test)]` module declaration (M4). Since Task 3.7 no app
  // file claims that exemption, so this now covers every source in the
  // directory.
  it.each([
    ['custody::db::open', /custody::db::open\b/],
    ['custody::entries::', /custody::entries::/],
    ['custody::lock(', /custody::lock\(/],
  ])('no shipped app source calls %s', (_name, pattern) => {
    const offenders = sources.filter(([f, body]) => !isCfgTestModuleFile(f) && pattern.test(body)).map(([f]) => f);
    expect(offenders).toEqual([]);
  });

  it('the three mirror-broker forwarders reach the daemon, not a local writer', () => {
    const forwarders = readFileSync(`${dir}/vault_flags.rs`, 'utf8');
    expect(forwarders).toMatch(/daemon_call_blocking/);
    expect(forwarders).not.toMatch(/apply_everywhere|rename_dirs|adopt_dirs/);
  });
});

/**
 * Task 2.11 (corrected by Task 3.9, narrowed by Task 5.9, closed by the
 * Phase 3 remainder's Task 5): the app-side vault writer list is now
 * **empty**. Every file in `src-tauri/src` only reads through
 * `vault_files::`, forwards to the daemon, or does not touch the vault at
 * all. A file calling a `vault_files::` write function, or writing a vault
 * path with a raw `fs::write`/`fs::copy`, would be exactly the "new feature
 * added to src-tauri instead of the daemon" mistake CLAUDE.md's shell rule
 * forbids; this guard catches it structurally instead of relying on review.
 *
 * `backup.rs` was the last name on the list. The Phase 3 remainder moved the
 * IMAP and Graph backup runners, the mirror pre-sync (`fs::copy` in both
 * directions) and the purge queue into `mailvault_core::backup`, run by
 * `src-daemon/src/handlers/backup.rs` under the daemon's real write gate;
 * `src-tauri/src/backup.rs` is now only the security-scoped bookmark broker
 * (resolve, hold across a fire-and-forget run, release) plus four
 * forwarders. `src-tauri/src/archive.rs` — the shim that built the core
 * runner's context with the app's no-op gate — was deleted outright in the
 * same task, since `backup.rs` was its only caller; the app now holds no
 * `ImapPool` and no way to reach a core vault writer at all.
 *
 * Three names came off this list, for different reasons:
 * - `restore.rs` (Task 3.9) never wrote the vault at all: it read local
 *   `.eml` files and re-uploaded them over IMAP. It was an ungated *reader*
 *   mistakenly on a writer allowlist (project memory: this exact failure
 *   mode is cited twice). Verified by reading `run_restore`; its only vault
 *   touch was `std::fs::read`. The file itself left the app crate entirely
 *   in Task 4.8 (moved to the daemon in Task 4.7); its own writer-allowlist
 *   test is gone with it, not converted, since the claim it made has no
 *   subject any more (see the "migration.rs and restore.rs are deleted"
 *   test above).
 * - `archive.rs` (Task 3.9, deleted in the Phase 3 remainder's Task 5) no
 *   longer exists. Task 3.2 had already moved the archive/bulk runner's
 *   body, including the real `fsx::write_atomic` call, into
 *   `mailvault_core::archive`, leaving only the shim that built that
 *   runner's context (root, pool, sinks, a no-op gate) for `backup.rs`.
 *   With the backup runners in the daemon, that shim had no callers and the
 *   file is gone — which also takes the *conceptual* ungated-writer entry
 *   `architecture.md` kept for it: nothing app-side drives a core vault
 *   writer any more.
 * - `commands.rs` and `main.rs` (Task 5.9) are the same shape as
 *   `archive.rs` above, closed out rather than left vacuous. `commands.rs`'s
 *   only writer, `graph_cache_mime`'s raw `std::fs::write` into the maildir
 *   `cur` path, moved to the daemon at Task 5.6 (ported unchanged, still
 *   the documented ungated exception, just no longer in this directory's
 *   text). `main.rs`'s only writer, `maildir_store_raw` (called only by
 *   `commands.rs`'s `imap_get_email_light`), moved to the daemon at Task
 *   5.4a. Both files had been sitting in `ALLOWED_WRITERS` doing no actual
 *   writing since those tasks landed — this guard's own "every vault write
 *   lives in an allowed writer file" check can't tell a vacuously-allowed
 *   file from a real one, so leaving them in silently hid the fact that
 *   Phase 5 had already closed them out. Removed from the list; the
 *   non-vacuity test below pins that they really don't write any more,
 *   the same proof `archive.rs` already had.
 */
describe('app-side vault writers are a closed, named list (Task 2.11)', () => {
  const dir = 'src-tauri/src';
  const files = readdirSync(dir).filter((f) => f.endsWith('.rs') && !f.endsWith('_tests.rs'));
  // Empty on purpose: the app has no vault writer left. A new name here
  // needs the shell-rule argument in the doc comment above, not a quick add.
  const ALLOWED_WRITERS = [];
  // The write-capable half of vault_files::, everything that creates,
  // renames or deletes a vault file or the attachment cache. The read family
  // (read/read_light/list/exists/...) is deliberately not in this list: every
  // remaining app writer also reads, and that is not the thing being fenced.
  const WRITE_FNS = [
    'store', 'delete', 'delete_maildir_files', 'set_flags',
    'clear_cache', 'migrate_json_to_eml', 'migrate_email_dirs', 'cache_attachment',
  ];
  const writePattern = new RegExp(`vault_files::(${WRITE_FNS.join('|')})\\(`);

  // Task 3.9: the old `writePattern` alone is blind to a raw `fs::write` /
  // `fs::copy` straight into a vault path, exactly how the Graph backup
  // writer (`backup.rs`'s Graph fetch loop) writes today, and how the mbox
  // importer (`main.rs`'s former `import_mbox`, moved to the daemon in Task
  // 4.6) used to; neither ever called `vault_files::`. The destination is
  // usually built a line or two above the call (`let dest =
  // cur_dir.join(&filename); fs::write(&dest, ..)`), not inside the call's
  // own argument list, so this looks for a vault-path marker in a window
  // around each raw write/copy call rather than in the call itself.
  const RAW_WRITE_CALL = /\bfs::(write|copy)\(/g;
  const VAULT_PATH_MARKER = /\bcur_dir\b|\bcur_path\b|maildir_cur_path/;
  // Test fixtures (`#[cfg(test)] mod tests { .. }`) write scratch `.eml`
  // files under a tempdir, not the real vault; `restore.rs` and `backup.rs`
  // both do this. Only the first real `mod <name> { .. }` test block is cut;
  // an earlier lone `#[cfg(test)]` on a single non-test-module item (e.g.
  // `main.rs`'s `find_msg_file_by_uid`) must not truncate real production
  // code that follows it.
  const MOD_TESTS_BLOCK = /#\[cfg\(test\)\]\s*\n\s*mod\s+\w+\s*\{/;
  const withoutTestModules = (body) => {
    const m = MOD_TESTS_BLOCK.exec(body);
    MOD_TESTS_BLOCK.lastIndex = 0;
    return m ? body.slice(0, m.index) : body;
  };
  const hasRawVaultWrite = (body) => {
    const src = withoutTestModules(body);
    const re = new RegExp(RAW_WRITE_CALL.source, 'g');
    let m;
    while ((m = re.exec(src))) {
      const window = src.slice(Math.max(0, m.index - 400), m.index + 200);
      if (VAULT_PATH_MARKER.test(window)) return true;
    }
    return false;
  };

  it('reads the real app sources', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('every vault write (vault_files:: or raw fs::write/fs::copy into a vault path) lives in an allowed writer file', () => {
    const offenders = files
      .filter((f) => !ALLOWED_WRITERS.includes(f))
      .map((f) => [f, readFileSync(`${dir}/${f}`, 'utf8')])
      .filter(([, body]) => writePattern.test(body) || hasRawVaultWrite(body))
      .map(([f]) => f);
    expect(offenders).toEqual([]);
  });

  // With ALLOWED_WRITERS empty the check above covers every file, so the
  // two patterns can no longer be proven non-vacuous against a current
  // offender — there is deliberately none left. What can be pinned is that
  // both patterns still MATCH the shapes they are meant to catch, so an
  // empty offender list means "nothing writes" and not "the regexes rotted".
  it('both patterns still recognise a real vault write (an empty offender list is not a broken regex)', () => {
    expect(writePattern.test('mailvault_core::vault_files::store(&root, "a", "INBOX", 1, &[], b"x")')).toBe(true);
    expect(hasRawVaultWrite('let cur_dir = maildir_cur_path(&app, &id, &mbox)?;\n fs::write(cur_dir.join(&n), &b)?;')).toBe(true);
    expect(hasRawVaultWrite('fs::write(settings_path, &json)?;')).toBe(false);
  });

  // Phase 3 remainder, Task 5: backup.rs was the last raw-write offender
  // (its Graph fetch loop and mirror pre-sync). Both moved to the daemon,
  // and archive.rs — the shim that handed the core runner the app's no-op
  // write gate — was deleted outright, so there is no app-side path to a
  // vault write left, in this directory's text or behind it.
  it('backup.rs no longer writes the vault or the mirror, and archive.rs is gone', () => {
    const body = readFileSync(`${dir}/backup.rs`, 'utf8');
    expect(writePattern.test(body)).toBe(false);
    expect(hasRawVaultWrite(body)).toBe(false);
    expect(existsSync(`${dir}/archive.rs`)).toBe(false);
  });

  // Not vacuous the other way either: backup.rs is still the bookmark broker
  // the daemon cannot be, and it still forwards rather than doing the work.
  it('backup.rs still resolves the mirror bookmark and forwards to the daemon', () => {
    const body = readFileSync(`${dir}/backup.rs`, 'utf8');
    expect(body).toMatch(/resolve_external_location/);
    expect(body).toMatch(/daemon_call_blocking/);
  });
});
