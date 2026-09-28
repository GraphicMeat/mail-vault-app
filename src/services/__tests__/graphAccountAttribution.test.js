/**
 * Network Activity names the account behind every Graph request. A Graph call
 * carries only a token, so each wrapper tells the daemon which account that
 * token was handed out for (`accountEmail`); `ensureFreshToken`, which every
 * token a Graph call uses passes through, records the owner.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockSend = vi.fn();
vi.mock('../transport.js', () => ({ send: (...a) => mockSend(...a) }));
vi.mock('../../i18n/index.js', () => ({ t: (k) => k }));

globalThis.window = globalThis.window || {};
globalThis.window.__TAURI__ = { core: { invoke: () => {} } };

const api = await import('../api.js');
const { ensureFreshToken } = await import('../authUtils.js');

const TOKEN = 'header.payload.signature';
// Fresh and JWT-shaped: ensureFreshToken takes its fast path, no refresh.
const OUTLOOK = {
  id: 'acc-outlook', email: 'padme@outlook.test', authType: 'oauth2', oauth2Transport: 'graph',
  oauth2AccessToken: TOKEN, oauth2RefreshToken: 'refresh', oauth2ExpiresAt: Date.now() + 3600_000,
};
// Read off the module, so a wrapper added later cannot slip past.
// graphAllocateUids is the vault's uid ledger: no token, no network.
const WRAPPERS = Object.keys(api).filter(k => /^graph[A-Z]/.test(k) && k !== 'graphAllocateUids');

beforeEach(() => {
  mockSend.mockReset();
  mockSend.mockResolvedValue({});
});

describe('Graph calls name their account for Network Activity', () => {
  it('covers every Graph wrapper', () => {
    expect(WRAPPERS).toEqual(expect.arrayContaining([
      'graphListFolders', 'graphListMessages', 'graphGetMessage', 'graphCacheMime', 'graphSetRead', 'graphSetFlagged',
      'graphDeleteMessage', 'graphMoveEmails', 'graphCreateFolder', 'graphRenameFolder', 'graphMoveFolder', 'graphDeleteFolder',
    ]));
  });

  it.each(WRAPPERS)('%s sends the address of the account its token is for', async (name) => {
    await ensureFreshToken(OUTLOOK);
    await api[name](TOKEN);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][1].accountEmail).toBe('padme@outlook.test');
  });

  it.each(WRAPPERS)('%s names no account for a token nothing handed out', async (name) => {
    await api[name]('never.handed.out');
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][1].accountEmail).toBeUndefined();
  });

  it('a token refresh names its account', async () => {
    await api.refreshOAuth2Token('refresh', 'microsoft', null, null, true, 'padme@outlook.test');
    expect(mockSend).toHaveBeenCalledWith('oauth2_refresh', expect.objectContaining({ accountEmail: 'padme@outlook.test' }));
  });
});
