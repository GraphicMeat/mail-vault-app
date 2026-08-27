/**
 * `saveEmailLocally` has two branches and only one of them was ever covered.
 *
 * When `db.isEmailSaved` says the vault already holds the message, the workflow
 * skips the fetch-and-store entirely and only flips the flag via
 * `db.archiveEmail`. That branch is the one the daemon shape bug drove every
 * archive down — `{exists:false}` read as truthy — so the copy never happened
 * and archiveEmail threw on a uid the vault did not have:
 *
 *   Could not copy that email into your vault. Nothing was removed from the
 *   server. (Email UID 30 not found in Maildir)
 *
 * These pin what each branch actually does, including that a failure surfaces
 * as an error the user can read and does NOT leave the row looking archived.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { serverUids } from '../../../stores/slices/serverUids';

if (!globalThis.window) {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
} else {
  globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
}

const mockIsEmailSaved = vi.fn();
const mockArchiveEmail = vi.fn().mockResolvedValue(undefined);
const mockFetchEmail = vi.fn();
const mockAppendLocalIndex = vi.fn().mockResolvedValue(undefined);
const mockGetSavedEmailIds = vi.fn().mockResolvedValue(new Set());
const mockGetArchivedEmailIds = vi.fn().mockResolvedValue(new Set());
const mockTauriInvoke = vi.fn().mockResolvedValue(undefined);

vi.mock('../../db', () => ({
  isEmailSaved: (...a) => mockIsEmailSaved(...a),
  archiveEmail: (...a) => mockArchiveEmail(...a),
  getSavedEmailIds: (...a) => mockGetSavedEmailIds(...a),
  getArchivedEmailIds: (...a) => mockGetArchivedEmailIds(...a),
  getLocalEmails: vi.fn().mockResolvedValue([]),
  getLocalEmailLight: vi.fn().mockResolvedValue(null),
  getEmailHeadersMeta: vi.fn().mockResolvedValue(null),
  getEmailHeadersPartial: vi.fn().mockResolvedValue({ emails: [], totalEmails: 0 }),
  getCachedMailboxEntry: vi.fn().mockResolvedValue(null),
  readLocalEmailIndex: vi.fn().mockResolvedValue(null),
  getArchivedEmails: vi.fn().mockResolvedValue([]),
  deleteLocalEmail: vi.fn().mockResolvedValue(undefined),
  saveEmailHeaders: vi.fn().mockResolvedValue(undefined),
  initDB: vi.fn().mockResolvedValue(undefined),
  getAccounts: vi.fn().mockResolvedValue([]),
  ensureAccountsInFile: vi.fn().mockResolvedValue(undefined),
  saveMailboxes: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../api', () => ({
  fetchEmail: (...a) => mockFetchEmail(...a),
  appendLocalIndex: (...a) => mockAppendLocalIndex(...a),
  fetchEmailLight: vi.fn().mockResolvedValue(null),
  updateEmailFlags: vi.fn().mockResolvedValue(undefined),
  removeFromLocalIndex: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../authUtils', () => ({
  hasValidCredentials: () => true,
  ensureFreshToken: (a) => Promise.resolve(a),
  resolveServerAccount: (id, account) => Promise.resolve({ ok: true, account }),
}));

vi.mock('../../attachmentUtils', () => ({ hasRealAttachments: () => false }));

vi.mock('../../graphConfig', () => ({
  isGraphAccount: () => false,
  graphMessageToEmail: (m) => m,
}));

vi.mock('../../cacheManager', () => ({
  getRestoreDescriptor: vi.fn().mockReturnValue(null),
  saveRestoreDescriptor: vi.fn(),
  invalidateRestoreDescriptors: () => {},
  getAccountCacheMailboxes: () => null,
  listGraphMessages: vi.fn().mockResolvedValue({ headers: [], graphMessageIds: [] }),
  getGraphMessageId: () => null,
  resolveGraphMessageId: async () => null,
  clearGraphIdMap: () => {},
}));

vi.mock('../../../stores/settingsStore', () => ({
  useSettingsStore: {
    getState: () => ({
      cacheLimitMB: 128,
      hiddenAccounts: {},
      getLastMailbox: () => 'INBOX',
      emailListStyle: 'default',
      linkAlerts: {},
      linkSafetyEnabled: false,
      setUnreadForAccount: () => {},
    }),
  },
}));

vi.mock('../../safeStorage', () => ({
  safeStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}));

const { useMailStore } = await import('../../../stores/mailStore');
const { saveEmailLocally } = await import('../messageMutations.js');

const ACCOUNT = { id: 'acct1', email: 'luke@mock.test' };
const ROW = {
  uid: 30, messageId: 'luke30@mock', subject: 'Luke message 30', flags: [],
  from: { address: 'luke@mock.test' }, date: '2026-08-27T09:00:00Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockArchiveEmail.mockResolvedValue(undefined);
  mockGetSavedEmailIds.mockResolvedValue(new Set());
  mockGetArchivedEmailIds.mockResolvedValue(new Set());
  mockTauriInvoke.mockResolvedValue(undefined);
  globalThis.window.__TAURI__ = { core: { invoke: (...a) => mockTauriInvoke(...a) } };

  useMailStore.setState({
    accounts: [ACCOUNT],
    activeAccountId: ACCOUNT.id,
    activeMailbox: 'INBOX',
    viewMode: 'all',
    emails: [ROW],
    sentEmails: [],
    localEmails: [],
    savedEmailIds: new Set(),
    archivedEmailIds: new Set(),
    serverUids: serverUids([ROW.uid], { complete: false }),
    deleteTombstones: new Set(),
    totalEmails: 1,
    selectedEmailIds: new Set(),
    error: null,
    _sortedEmailsFingerprint: '',
  });
});

describe('saveEmailLocally — already-cached branch', () => {
  it('flags the vault copy instead of refetching it', async () => {
    mockIsEmailSaved.mockResolvedValue(true);

    await saveEmailLocally(30);

    expect(mockArchiveEmail).toHaveBeenCalledWith(ACCOUNT.id, 'INBOX', 30);
    expect(mockFetchEmail).not.toHaveBeenCalled();
    // Nothing is re-stored: the .eml on disk is already the message.
    expect(mockTauriInvoke).not.toHaveBeenCalledWith('maildir_store', expect.anything());
    expect(useMailStore.getState().error).toBeNull();
  });

  it('still refreshes the vault sets, so the row can repaint as archived', async () => {
    mockIsEmailSaved.mockResolvedValue(true);
    mockGetArchivedEmailIds.mockResolvedValue(new Set([30]));

    await saveEmailLocally(30);

    expect(useMailStore.getState().archivedEmailIds.has(30)).toBe(true);
  });

  it('reports the failure and does not claim the message was archived', async () => {
    mockIsEmailSaved.mockResolvedValue(true);
    mockArchiveEmail.mockRejectedValue(new Error('Email UID 30 not found in Maildir'));

    await expect(saveEmailLocally(30)).rejects.toThrow('Email UID 30 not found in Maildir');

    const { error, archivedEmailIds } = useMailStore.getState();
    expect(error).toContain('Nothing was removed from the server');
    expect(error).toContain('Email UID 30 not found in Maildir');
    expect(archivedEmailIds.has(30)).toBe(false);
  });
});

describe('saveEmailLocally — not-yet-cached branch', () => {
  it('fetches the message and writes it to the vault', async () => {
    mockIsEmailSaved.mockResolvedValue(false);
    mockFetchEmail.mockResolvedValue({ ...ROW, rawSource: 'cmF3' });

    await saveEmailLocally(30);

    expect(mockFetchEmail).toHaveBeenCalledWith(ACCOUNT, 30, 'INBOX');
    expect(mockTauriInvoke).toHaveBeenCalledWith('maildir_store', expect.objectContaining({
      accountId: ACCOUNT.id, mailbox: 'INBOX', uid: 30,
      rawSourceBase64: 'cmF3', flags: ['archived', 'seen'],
    }));
    expect(mockArchiveEmail).not.toHaveBeenCalled();
  });

  it('refuses a fetch that came back with no raw source', async () => {
    mockIsEmailSaved.mockResolvedValue(false);
    mockFetchEmail.mockResolvedValue({ ...ROW, rawSource: null });

    await expect(saveEmailLocally(30)).rejects.toThrow('Email has no raw source data');
    expect(mockTauriInvoke).not.toHaveBeenCalledWith('maildir_store', expect.anything());
    expect(useMailStore.getState().error).toContain('Nothing was removed from the server');
  });
});
