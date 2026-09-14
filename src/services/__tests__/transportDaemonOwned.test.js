import { describe, it, expect, vi, beforeEach } from 'vitest';

const daemonCall = vi.fn();
vi.mock('../daemonClient.js', () => ({
  daemonCall: (...a) => daemonCall(...a),
  DaemonError: class DaemonError extends Error { constructor(m, code) { super(m); this.code = code; } },
}));

const { send, DAEMON_OWNED } = await import('../transport.js');
const { DaemonError } = await import('../daemonClient.js');
const { t } = await import('../../i18n/index.js');

// Captured before any test calls DAEMON_OWNED.clear() in beforeEach below —
// proves Phase 0 ships the set empty, without pinning to source text.
const initialSize = DAEMON_OWNED.size;

describe('daemon-owned commands', () => {
  beforeEach(() => { daemonCall.mockReset(); DAEMON_OWNED.clear(); });

  it('starts empty in phase 0', () => {
    expect(initialSize).toBe(0);
  });

  it('routes a member to the daemon under its own name with camelCase args, no heartbeat needed', async () => {
    DAEMON_OWNED.add('owned_cmd');
    daemonCall.mockResolvedValue({ ok: 1 });
    await expect(send('owned_cmd', { account_id: 'a', mailbox: 'INBOX' })).resolves.toEqual({ ok: 1 });
    expect(daemonCall).toHaveBeenCalledWith('owned_cmd', { accountId: 'a', mailbox: 'INBOX' });
  });

  it.each(['DAEMON_OFFLINE', 'NO_TAURI'])('rejects with errors.daemonUnavailable on %s, never falling back to invoke', async (code) => {
    DAEMON_OWNED.add('owned_cmd');
    daemonCall.mockRejectedValue(new DaemonError('gone', code));
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

  it('passes a daemon-side error through unchanged', async () => {
    DAEMON_OWNED.add('owned_cmd');
    const rpc = new DaemonError('Missing request', 'RPC_ERROR');
    daemonCall.mockRejectedValue(rpc);
    await expect(send('owned_cmd', {})).rejects.toBe(rpc);
  });
});
