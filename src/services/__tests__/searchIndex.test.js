import { beforeEach, describe, expect, it, vi } from 'vitest';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('../transport.js', () => ({ send: (...args) => send(...args) }));

let status;
let rebuild;

describe('search index service', () => {
  beforeEach(async () => {
    send.mockReset();
    vi.resetModules();
    ({ status, rebuild } = await import('../searchIndex.js'));
  });

  it('preserves status failure detail and maps an unavailable daemon to error state', async () => {
    const cause = new Error('daemon socket closed while reading index status');
    cause.code = 'DAEMON_UNAVAILABLE';
    send.mockRejectedValue(cause);

    await expect(status()).resolves.toEqual({
      available: false,
      state: 'error',
      errorKey: 'errors.daemonUnavailable',
      errorDetail: cause.message,
    });
  });

  it('keeps the special outdated daemon status key and cause', async () => {
    const cause = new Error("MailVault's background service is out of date. Quit and reopen MailVault.");
    cause.code = 'DAEMON_OUTDATED';
    send.mockRejectedValue(cause);

    await expect(status()).resolves.toEqual({
      available: false,
      state: 'error',
      errorKey: 'errors.daemonOutdated',
      errorDetail: cause.message,
    });
  });

  it('passes rebuild rejection details to the settings action', async () => {
    const cause = new Error('search_index_rebuild failed: vault is read-only');
    send.mockRejectedValue(cause);

    await expect(rebuild()).rejects.toBe(cause);
    expect(send).toHaveBeenCalledWith('search_index_rebuild', {});
  });
});
