// The T10 defect: a composite selection key spent as a uid.
//
// In a view that spans mailboxes, App.jsx's j/k `step()` calls selectEmail with
// a whole selection key ("a1:INBOX:7"). `_resolveUnifiedContext` resolves it,
// so the account and the folder came out right — but the raw argument was then
// spent everywhere a uid belongs: the row lookup, the body-cache key, the
// selection key written back, and `api.fetchEmailLight`, which was handed the
// string. Keyboard navigation could not open a message in All Inboxes at all.
//
// Same family as Phase 1's B3, and the same rule as deleteEmailFromServer:
// resolve the key once, then address the message by the number the server
// knows.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { serverUids } from '../../../stores/slices/serverUids';

if (!globalThis.window) {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
} else {
  globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
}

const mockFetchEmailLight = vi.fn();
const mockGetLocalEmailLight = vi.fn().mockResolvedValue(null);

vi.mock('../../db', () => ({
  getLocalEmailLight: (...a) => mockGetLocalEmailLight(...a),
  getSavedEmailIds: vi.fn().mockResolvedValue(new Set()),
  getEmailHeadersMeta: vi.fn().mockResolvedValue(null),
  getEmailHeadersPartial: vi.fn().mockResolvedValue({ emails: [], totalEmails: 0 }),
  getArchivedEmailIds: vi.fn().mockResolvedValue(new Set()),
  getCachedMailboxEntry: vi.fn().mockResolvedValue(null),
  getLocalEmails: vi.fn().mockResolvedValue([]),
  readLocalEmailIndex: vi.fn().mockResolvedValue(null),
  getArchivedEmails: vi.fn().mockResolvedValue([]),
  deleteLocalEmail: vi.fn().mockResolvedValue(undefined),
  saveEmailHeaders: vi.fn().mockResolvedValue(undefined),
  exportEmail: vi.fn().mockResolvedValue(null),
  initDB: vi.fn().mockResolvedValue(undefined),
  getAccounts: vi.fn().mockResolvedValue([]),
  ensureAccountsInFile: vi.fn().mockResolvedValue(undefined),
  saveMailboxes: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../api', () => ({
  vaultApplyFlags: vi.fn().mockResolvedValue({ renamed: 0, mirrored: 0, index_patched: 0, sidecars_patched: 0 }),
  fetchEmailLight: (...a) => mockFetchEmailLight(...a),
  updateEmailFlags: vi.fn().mockResolvedValue(undefined),
  graphSetRead: vi.fn().mockResolvedValue(undefined),
  graphGetMessage: vi.fn().mockResolvedValue(null),
  graphListFolders: vi.fn().mockResolvedValue([]),
  graphListMessages: vi.fn().mockResolvedValue({ headers: [], graphMessageIds: [] }),
  graphCacheMime: vi.fn().mockResolvedValue(undefined),
  deleteEmail: vi.fn().mockResolvedValue(undefined),
  moveEmails: vi.fn().mockResolvedValue(undefined),
  removeFromLocalIndex: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../authUtils', () => ({
  hasValidCredentials: () => true,
  ensureFreshToken: (a) => Promise.resolve(a),
  resolveServerAccount: (id, account) => Promise.resolve({ ok: true, account }),
}));

vi.mock('../../attachmentUtils', () => ({
  hasRealAttachments: () => false,
  hydrateInlineImages: (email) => Promise.resolve(email),
  getRealAttachments: () => [],
  replaceCidUrls: (html) => html,
}));

vi.mock('../../graphConfig', () => ({
  isGraphAccount: () => false,
  graphMessageToEmail: (m) => m,
  normalizeGraphFolderName: (n) => n,
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
      markAsReadMode: 'manual',
      markAsReadDelay: 3,
      setUnreadForAccount: () => {},
    }),
  },
}));

vi.mock('../probeServerCopy', () => ({
  probeServerCopy: vi.fn().mockResolvedValue({ state: 'unknown' }),
}));

vi.mock('../../safeStorage', () => ({
  safeStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}));

const { useMailStore } = await import('../../../stores/mailStore');
const ACCT_A = { id: 'a1', email: 'a@mock.test' };
const ACCT_B = { id: 'a2', email: 'b@mock.test' };

const ROWS = [
  {
    uid: 7, messageId: 'a7@mock', subject: 'From A', flags: [],
    from: { address: 'them@a.test' }, date: '2026-09-01T10:00:00Z',
    _accountId: ACCT_A.id, _mailbox: 'INBOX',
  },
  {
    uid: 4, messageId: 'b4@mock', subject: 'From B', flags: [],
    from: { address: 'them@b.test' }, date: '2026-09-01T09:00:00Z',
    _accountId: ACCT_B.id, _mailbox: 'INBOX',
  },
];

function prime(over = {}) {
  useMailStore.setState({
    accounts: [ACCT_A, ACCT_B],
    activeAccountId: ACCT_A.id,
    activeMailbox: 'UNIFIED',
    unifiedInbox: true,
    unifiedFolder: 'INBOX',
    mailboxScope: null,
    viewMode: 'all',
    emails: [...ROWS],
    sortedEmails: [...ROWS],
    sentEmails: [],
    localEmails: [],
    savedEmailIds: new Set(),
    archivedEmailIds: new Set(),
    serverUids: serverUids(new Set([7, 4]), { complete: false }),
    deleteTombstones: new Set(),
    totalEmails: ROWS.length,
    selectedEmailIds: new Set(),
    selectedEmail: null,
    selectedEmailId: null,
    selectedThread: null,
    loadingEmail: false,
    error: null,
    emailCache: new Map(),
    loadEmails: vi.fn(),
    _sortedEmailsFingerprint: '',
    ...over,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetLocalEmailLight.mockResolvedValue(null);
  mockFetchEmailLight.mockResolvedValue({ uid: 7, subject: 'From A', html: '<p>body</p>', flags: [] });
  prime();
});

describe('selectEmail with a composite selection key', () => {
  // What j/k sends. The number, not the key, has to reach the server.
  it('fetches the uid the key names, not the key', async () => {
    await useMailStore.getState().selectEmail('a1:INBOX:7');

    expect(mockFetchEmailLight).toHaveBeenCalledTimes(1);
    const [account, uid, mailbox, accountId] = mockFetchEmailLight.mock.calls[0];
    expect(uid).toBe(7);
    expect(typeof uid).toBe('number');
    expect(account.id).toBe(ACCT_A.id);
    expect(mailbox).toBe('INBOX');
    expect(accountId).toBe(ACCT_A.id);
  });

  it('writes the row\'s own key back as the selection, and opens that message', async () => {
    await useMailStore.getState().selectEmail('a1:INBOX:7');

    const s = useMailStore.getState();
    expect(s.selectedEmailId).toBe('a1:INBOX:7');
    expect(s.selectedEmail.uid).toBe(7);
    expect(s.error).toBe(null);
    expect(s.loadingEmail).toBe(false);
  });

  // The other account's row, so a fixed key cannot pass by accident.
  it('opens the second account\'s message from its own key', async () => {
    mockFetchEmailLight.mockResolvedValue({ uid: 4, subject: 'From B', html: '<p>b</p>', flags: [] });

    await useMailStore.getState().selectEmail('a2:INBOX:4');

    expect(mockFetchEmailLight.mock.calls[0][1]).toBe(4);
    expect(mockFetchEmailLight.mock.calls[0][0].id).toBe(ACCT_B.id);
    expect(useMailStore.getState().selectedEmailId).toBe('a2:INBOX:4');
  });

  // The control: a single folder's list keys by bare uid, and that path never
  // had a key to unwind. A fix that breaks it is not a fix.
  it('still opens a bare uid in a single-folder view', async () => {
    prime({ activeMailbox: 'INBOX', unifiedInbox: false, activeAccountId: ACCT_A.id });

    await useMailStore.getState().selectEmail(7);

    expect(mockFetchEmailLight).toHaveBeenCalledTimes(1);
    expect(mockFetchEmailLight.mock.calls[0][1]).toBe(7);
    expect(useMailStore.getState().selectedEmailId).toBe(7);
    expect(useMailStore.getState().error).toBe(null);
  });
});
