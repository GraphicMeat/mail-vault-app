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

  it('owns exactly the search index commands (phase 1) plus the vault read family and attachment cache (Task 2.6) plus the caches, ledger and journal (Task 2.7) plus the six simple vault writers (Task 2.8)', async () => {
    const src = (await import('node:fs')).readFileSync(new URL('../transport.js', import.meta.url), 'utf8');
    const block = src.slice(src.indexOf('export const DAEMON_OWNED'), src.indexOf(']);', src.indexOf('export const DAEMON_OWNED')));
    const names = [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(names).toEqual([
      'cache_attachment', 'cached_attachment_path',
      'clear_email_cache', 'clear_pending_operation',
      'delete_mailbox_cache',
      'graph_allocate_uids',
      'list_cached_uids',
      'load_email_cache', 'load_email_cache_by_uids', 'load_email_cache_meta', 'load_email_cache_partial',
      'load_graph_id_map', 'load_mailbox_cache',
      'maildir_clear_cache', 'maildir_delete',
      'maildir_exists', 'maildir_list',
      'maildir_migrate_email_dirs', 'maildir_migrate_json_to_eml',
      'maildir_orphan_stats',
      'maildir_read', 'maildir_read_attachment', 'maildir_read_light', 'maildir_read_light_batch', 'maildir_read_raw_source',
      'maildir_set_flags', 'maildir_storage_stats',
      'maildir_store',
      'op_journal_clear', 'op_journal_queue', 'op_journal_read',
      'prefetch_attachments',
      'read_pending_operation',
      'save_email_cache', 'save_mailbox_cache', 'save_pending_operation',
      'search_index_configure', 'search_index_destroy', 'search_index_rebuild', 'search_index_status',
      'vault_rows', 'vault_search',
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
