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

  it('owns exactly the search index commands in phase 1', async () => {
    const src = (await import('node:fs')).readFileSync(new URL('../transport.js', import.meta.url), 'utf8');
    const block = src.slice(src.indexOf('export const DAEMON_OWNED'), src.indexOf(']);', src.indexOf('export const DAEMON_OWNED')));
    const names = [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(names).toEqual(['search_index_configure', 'search_index_destroy', 'search_index_rebuild', 'search_index_status', 'vault_rows', 'vault_search']);
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
