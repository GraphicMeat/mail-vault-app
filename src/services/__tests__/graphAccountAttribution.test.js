/**
 * Network Activity names the account behind every Graph request, and the
 * daemon sends that account's own token (src-daemon/src/oauth_tokens.rs): each
 * wrapper names the account (`accountId`, `accountEmail`) and never carries a
 * token. The one exception is the probe of a token a sign-in just returned,
 * for an account not saved yet.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockSend = vi.fn();
vi.mock('../transport.js', () => ({ send: (...a) => mockSend(...a) }));
vi.mock('../../i18n/index.js', () => ({ t: (k) => k }));

globalThis.window = globalThis.window || {};
globalThis.window.__TAURI__ = { core: { invoke: () => {} } };

const api = await import('../api.js');

const OUTLOOK = {
  id: 'acc-outlook', email: 'padme@outlook.test', authType: 'oauth2', oauth2Transport: 'graph',
  oauth2AccessToken: 'header.payload.signature', oauth2RefreshToken: 'refresh', oauth2ExpiresAt: Date.now() + 3600_000,
};
// Read off the module, so a wrapper added later cannot slip past.
// graphAllocateUids is the vault's uid ledger: no network.
const WRAPPERS = Object.keys(api).filter(k => /^graph[A-Z]/.test(k) && k !== 'graphAllocateUids' && k !== 'graphProbeSignIn');

beforeEach(() => {
  mockSend.mockReset();
  mockSend.mockResolvedValue({});
});

describe('Graph calls name their account and carry no token', () => {
  it('covers every Graph wrapper', () => {
    expect(WRAPPERS).toEqual(expect.arrayContaining([
      'graphListFolders', 'graphListMessages', 'graphGetMessage', 'graphCacheMime', 'graphSetRead', 'graphSetFlagged',
      'graphDeleteMessage', 'graphMoveEmails', 'graphCreateFolder', 'graphRenameFolder', 'graphMoveFolder', 'graphDeleteFolder',
    ]));
  });

  it.each(WRAPPERS)('%s names the account by id and address, and sends no token', async (name) => {
    await api[name](OUTLOOK, 'arg-1', 'arg-2', 3);
    expect(mockSend).toHaveBeenCalledTimes(1);
    const params = mockSend.mock.calls[0][1];
    expect(params.accountId).toBe('acc-outlook');
    expect(params.accountEmail).toBe('padme@outlook.test');
    expect(params.accessToken).toBeUndefined();
    expect(JSON.stringify(params)).not.toContain(OUTLOOK.oauth2AccessToken);
  });

  it('a delete keeps its bin copy place, and the account named is the one it was given', async () => {
    await api.graphDeleteMessage(OUTLOOK, 'm1', { accountId: 'someone-else', mailbox: 'INBOX', uid: 7 });
    expect(mockSend.mock.calls[0][1]).toMatchObject({ accountId: 'acc-outlook', mailbox: 'INBOX', uid: 7, messageId: 'm1' });
  });

  it('the probe of a sign-in just returned is the one call that carries a token', async () => {
    await api.graphProbeSignIn('fresh.sign-in.token', 'padme@outlook.test');
    expect(mockSend).toHaveBeenCalledWith('graph_list_folders', { accessToken: 'fresh.sign-in.token', accountEmail: 'padme@outlook.test' });
  });
});
