// Regression 71779b49: activateAccount's folder fetch was called with the
// accounts.json copy, which never carries a password. On base it only
// "worked" by IMAP-pool/init() accident; starting the daemon at app launch
// (71779b49) removes both accidents, so the fetch (and its retry) always saw
// "Password missing". See .superpowers/sdd/2026-09-14-daemon-shell-phase0-
// foundations/regression-71779b49-rootcause.md.
//
// fetchAccountMailboxes must resolve credentials (resolveServerAccount, with
// an ensureFreshToken fallback) before calling out, the same way
// loadServerEmails already does.
import { describe, it, expect, vi } from 'vitest';

if (!globalThis.window) {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
}
vi.stubGlobal('navigator', { onLine: true });

const mockFetchMailboxes = vi.fn(async (account) => {
  if (!account.password) throw new Error('Password missing');
  return Array.from({ length: 12 }, (_, i) => ({ name: `Box${i}`, path: `Box${i}` }));
});
vi.mock('../../api', () => ({
  fetchMailboxes: (...a) => mockFetchMailboxes(...a),
  graphListFolders: vi.fn().mockResolvedValue([]),
}));

const mockResolveServerAccount = vi.fn(async (id, account) =>
  ({ ok: true, account: { ...account, password: 'pw' } }));
const mockEnsureFreshToken = vi.fn(async (account) => account);
vi.mock('../../authUtils', () => ({
  resolveServerAccount: (...a) => mockResolveServerAccount(...a),
  ensureFreshToken: (...a) => mockEnsureFreshToken(...a),
  hasValidCredentials: (a) => !!(a?.password || a?.oauth2AccessToken),
}));

vi.mock('../../graphConfig', () => ({
  isGraphAccount: () => false,
  graphFoldersToMailboxes: () => [],
  graphMessageToEmail: (m) => m,
  isPersonalMicrosoftEmail: () => false,
}));
vi.mock('../adoptGraphFolderKeys', () => ({
  adoptGraphFolderKeys: vi.fn(),
  adoptGraphFolderKeysFromListing: vi.fn(),
}));
vi.mock('../../db', () => ({
  getCachedMailboxEntry: vi.fn().mockResolvedValue(null),
  saveMailboxes: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../stores/settingsStore', () => ({
  useSettingsStore: { getState: () => ({ hiddenAccounts: {}, setLastMailbox: vi.fn(), getLastMailbox: () => 'INBOX' }) },
}));
vi.mock('../../../stores/connectivityStore', () => ({
  useConnectivityStore: { getState: () => ({}) },
}));
vi.mock('../../transport', () => ({ getDaemonHealth: () => ({ alive: false }) }));
vi.mock('../../syncService', () => ({
  syncNow: vi.fn(), waitForSync: vi.fn(), toSyncAccount: (a) => a, watchAccount: vi.fn(), unwatchAccount: vi.fn(),
}));
vi.mock('../../syncProbe', () => ({ mailboxIsUnchanged: vi.fn(), markVerified: vi.fn(), invalidate: vi.fn() }));
vi.mock('../../cacheManager', () => ({
  saveRestoreDescriptor: vi.fn(), getRestoreDescriptor: vi.fn().mockReturnValue(null),
  listGraphMessages: vi.fn(), getGraphMessageId: vi.fn(), restoreGraphIdMap: vi.fn(),
}));

const { fetchAccountMailboxes } = await import('../activateAccount');

describe('fetchAccountMailboxes resolves credentials before the server call', () => {
  it('resolves the password-less accounts.json account via resolveServerAccount before fetching', async () => {
    const account = { id: 'luke', email: 'luke@mock.test', imapHost: '127.0.0.1' }; // no password — the QuickLoad shape

    const mailboxes = await fetchAccountMailboxes(account);

    expect(mockResolveServerAccount).toHaveBeenCalledWith('luke', account);
    expect(mockFetchMailboxes).toHaveBeenCalledWith(expect.objectContaining({ password: 'pw' }));
    expect(mailboxes).toHaveLength(12);
  });

  it('falls back to ensureFreshToken when resolveServerAccount cannot recover credentials', async () => {
    mockResolveServerAccount.mockResolvedValueOnce({ ok: false, reason: 'missing_credentials' });
    const account = { id: 'luke', email: 'luke@mock.test', imapHost: '127.0.0.1' };
    mockEnsureFreshToken.mockResolvedValueOnce({ ...account, password: 'from-fallback' });

    const mailboxes = await fetchAccountMailboxes(account);

    expect(mockEnsureFreshToken).toHaveBeenCalledWith(account);
    expect(mockFetchMailboxes).toHaveBeenCalledWith(expect.objectContaining({ password: 'from-fallback' }));
    expect(mailboxes).toHaveLength(12);
  });
});
