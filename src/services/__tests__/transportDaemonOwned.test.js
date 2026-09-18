import { describe, it, expect, vi, beforeEach } from 'vitest';

const daemonCall = vi.fn();
vi.mock('../daemonClient.js', () => ({
  daemonCall: (...a) => daemonCall(...a),
  DaemonError: class DaemonError extends Error { constructor(m, code) { super(m); this.code = code; } },
}));

const { send, DAEMON_OWNED } = await import('../transport.js');
const { DaemonError } = await import('../daemonClient.js');
const { t } = await import('../../i18n/index.js');

describe('daemon-owned commands', () => {
  beforeEach(() => { daemonCall.mockReset(); DAEMON_OWNED.clear(); });

  it('owns exactly the search index commands (phase 1) plus the vault read family and attachment cache (Task 2.6) plus the caches, ledger and journal (Task 2.7) plus the six simple vault writers (Task 2.8) plus custody and the three custody-backed vault writers (Task 2.9b) plus archive, bulk delete and verify (Task 3.5) plus the three insights snapshot commands (Task 3.7) plus fetch_remote_asset (Task 4.2) plus backup ZIP export/import (Task 4.4) plus mbox export/import (Task 4.6) plus migration and restore (Task 4.8) plus the IMAP read-path (Task 5.4a) plus the IMAP write-path and lifecycle (Task 5.4b) plus SMTP (Task 5.5) plus Graph (Task 5.6) plus OAuth2 (Task 5.7) plus DNS (Task 5.8) plus backup cancel (Phase 3 remainder, Task 6)', async () => {
    const src = (await import('node:fs')).readFileSync(new URL('../transport.js', import.meta.url), 'utf8');
    const block = src.slice(src.indexOf('export const DAEMON_OWNED'), src.indexOf(']);', src.indexOf('export const DAEMON_OWNED')));
    // Task 5.7: [a-z_]+ alone can't match 'oauth2_auth_url' etc. (the '2' isn't
    // in that class) -- widened to [a-z0-9_]+ so the new OAuth2 names are
    // actually captured, not silently skipped.
    const names = [...block.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]).sort();
    expect(names).toEqual([
      'archive_emails',
      // Phase 3 remainder, Task 6: the per-account cancel token lives in the
      // daemon (`DaemonState.backup_runs`); the app's global one is deleted.
      'backup_cancel',
      'bulk_delete_emails',
      'cache_attachment', 'cached_attachment_path',
      'cancel_archive', 'cancel_bulk_delete', 'cancel_migration', 'cancel_restore',
      'clear_email_cache', 'clear_migration_state_cmd', 'clear_pending_operation',
      'count_local_folder', 'count_migration_folders',
      'custody_status',
      'delete_mailbox_cache',
      'dns_mail_health',
      'export_backup',
      'export_mbox_all',
      'fetch_remote_asset',
      'get_folder_mappings', 'get_migration_state',
      'graph_allocate_uids',
      'graph_cache_mime', 'graph_create_folder',
      'graph_delete_folder', 'graph_delete_message',
      'graph_get_message',
      'graph_list_folders', 'graph_list_messages',
      'graph_move_emails', 'graph_move_folder',
      'graph_rename_folder',
      'graph_set_flagged', 'graph_set_read',
      'imap_check_mailbox_status', 'imap_create_mailbox', 'imap_delete_email', 'imap_delete_mailbox',
      'imap_disconnect', 'imap_ensure_sent_mailbox', 'imap_fetch_changed_flags', 'imap_fetch_headers_by_uids',
      'imap_find_message_id', 'imap_folder_status', 'imap_get_email', 'imap_get_email_light', 'imap_get_emails',
      'imap_get_mailboxes', 'imap_move_emails', 'imap_rename_mailbox', 'imap_search_all_uids', 'imap_search_emails',
      'imap_set_flags', 'imap_test_connection',
      'import_backup',
      'import_mbox',
      'insights_begin_snapshot', 'insights_read_page', 'insights_release_snapshot',
      'list_cached_uids',
      'load_email_cache', 'load_email_cache_by_uids', 'load_email_cache_meta', 'load_email_cache_partial',
      'load_graph_id_map', 'load_mailbox_cache',
      'local_index_append', 'local_index_read', 'local_index_remove',
      'maildir_clear_cache', 'maildir_delete', 'maildir_delete_many',
      'maildir_exists', 'maildir_list',
      'maildir_migrate_email_dirs', 'maildir_migrate_json_to_eml',
      'maildir_orphan_stats',
      'maildir_purge_orphans',
      'maildir_read', 'maildir_read_attachment', 'maildir_read_light', 'maildir_read_light_batch', 'maildir_read_raw_source',
      'maildir_repair_generation',
      'maildir_set_flags', 'maildir_storage_stats',
      'maildir_store',
      'oauth2_auth_url', 'oauth2_exchange', 'oauth2_refresh',
      'op_journal_clear', 'op_journal_queue', 'op_journal_read',
      'pause_migration',
      'prefetch_attachments',
      'read_pending_operation',
      'resolve_email_settings',
      'resume_migration',
      'save_email_cache', 'save_mailbox_cache', 'save_pending_operation',
      'search_index_configure', 'search_index_destroy', 'search_index_rebuild', 'search_index_status',
      'smtp_build_draft_mime', 'smtp_build_mime', 'smtp_send_email', 'smtp_test_connection',
      'start_migration', 'start_restore',
      'vault_rows', 'vault_search',
      'verify_archived_emails',
    ]);
  });

  it('routes a member to the daemon under its own name with camelCase args, no heartbeat needed', async () => {
    DAEMON_OWNED.add('owned_cmd');
    daemonCall.mockResolvedValue({ ok: 1 });
    await expect(send('owned_cmd', { account_id: 'a', mailbox: 'INBOX' })).resolves.toEqual({ ok: 1 });
    expect(daemonCall).toHaveBeenCalledWith('owned_cmd', { accountId: 'a', mailbox: 'INBOX' });
  });

  it('rejects with errors.daemonUnavailable on NO_TAURI, never falling back to invoke', async () => {
    DAEMON_OWNED.add('owned_cmd');
    daemonCall.mockRejectedValue(new DaemonError('Tauri invoke not available', 'NO_TAURI'));
    const err = await send('owned_cmd', {}).catch((e) => e);
    expect(err.code).toBe('DAEMON_UNAVAILABLE');
    expect(err.message).toBe(t('errors.daemonUnavailable'));
  });

  it('rejects with errors.daemonUnavailable when the daemon_rpc marker comes through as an RPC_ERROR', async () => {
    // daemonClient.js is untouched (R2): a real pre-response daemon_rpc
    // failure surfaces here classified RPC_ERROR, not DAEMON_OFFLINE — the
    // message itself is the marker sendToDaemon must still catch.
    DAEMON_OWNED.add('owned_cmd');
    daemonCall.mockRejectedValue(new DaemonError('errors.daemonUnavailable', 'RPC_ERROR'));
    const err = await send('owned_cmd', {}).catch((e) => e);
    expect(err.code).toBe('DAEMON_UNAVAILABLE');
    expect(err.message).toBe(t('errors.daemonUnavailable'));
  });

  it('maps errors.daemonOutdated to the outdated catalog key regardless of the daemonClient code', async () => {
    DAEMON_OWNED.add('owned_cmd');
    daemonCall.mockRejectedValue(new DaemonError('errors.daemonOutdated', 'RPC_ERROR'));
    const err = await send('owned_cmd', {}).catch((e) => e);
    expect(err.code).toBe('DAEMON_OUTDATED');
    expect(err.message).toBe(t('errors.daemonOutdated'));
  });

  it('a daemon-side error containing "connection refused" passes through unchanged (C6: DAEMON_OFFLINE is no longer trusted)', async () => {
    DAEMON_OWNED.add('owned_cmd');
    const rpc = new DaemonError('IMAP connection refused', 'DAEMON_OFFLINE');
    daemonCall.mockRejectedValue(rpc);
    await expect(send('owned_cmd', {})).rejects.toBe(rpc);
  });

  it('passes a daemon-side error through unchanged', async () => {
    DAEMON_OWNED.add('owned_cmd');
    const rpc = new DaemonError('Missing request', 'RPC_ERROR');
    daemonCall.mockRejectedValue(rpc);
    await expect(send('owned_cmd', {})).rejects.toBe(rpc);
  });
});
