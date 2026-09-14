// Bug report (2026-09-14): a message found by search in the vault will not
// open - "Cannot tell which account and folder hold message 282. Reload the
// list and try again."
//
// That string comes from one guard (selectEmail.js, `isUnified && !unified`),
// and it only runs in a view that spans mailboxes (`spansMailboxes`): the
// Unified Inbox, or a folder branch opened through loadSubtree. A search from
// an ordinary single folder never reaches it.
//
// In both views a search hit lives only in searchStore's `searchResults`.
// `_resolveUnifiedContext` answers from emails/sortedEmails/localEmails/
// sentEmails and nothing else, so a hit outside the loaded window resolves to
// nothing even when the key names its account and folder in full - the shape
// Explorer already sends (EmailList.jsx, `selectEmail(selKey(email), ...)`).
// The list row's own click sends a bare uid; that half is pinned in
// EmailRowSpanningSelect.test.jsx. The Unified Inbox case, on the real
// account's shape (a Sent hit found by performSearch), is
// selectEmailVaultSearchHitInSent.test.js; this file keeps the folder branch.
//
// `ghost:INBOX:9` in selectEmailUnresolved.test.js names no account and must
// still be refused. These keys name a real one.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { serverUids } from '../../../stores/slices/serverUids';

if (!globalThis.window) {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
} else {
  globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
}

const mockFetchEmailLight = vi.fn();
const mockFetchEmails = vi.fn();
const mockGetEmailHeadersPartial = vi.fn();
const mockGetLocalEmailLight = vi.fn().mockResolvedValue(null);

vi.mock('../../db', () => ({
  getLocalEmailLight: (...a) => mockGetLocalEmailLight(...a),
  getSavedEmailIds: vi.fn().mockResolvedValue(new Set()),
  getEmailHeadersMeta: vi.fn().mockResolvedValue(null),
  getEmailHeadersPartial: (...a) => mockGetEmailHeadersPartial(...a),
  getCachedMailboxes: vi.fn().mockResolvedValue([{ path: 'INBOX', name: 'INBOX' }]),
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
  fetchEmails: (...a) => mockFetchEmails(...a),
  checkMailboxStatus: vi.fn().mockResolvedValue({ exists: 0 }),
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

const ACCT_A = { id: 'acct-a', email: 'a@mock.test', imapHost: 'h', password: 'x' };

// What the vault answers for the hit: an old message in a folder the loaded
// window never reached.
const VAULT_COPY = { uid: 282, messageId: '<282@mock>', html: '<p>didelis laiskas body</p>', flags: [] };
const LOADED_ROW = { uid: 900, messageId: '<900@mock>', subject: 'recent', date: '2026-09-01T10:00:00Z', flags: ['\\Seen'] };

function baseState() {
  useMailStore.setState({
    accounts: [ACCT_A],
    activeAccountId: ACCT_A.id,
    activeMailbox: 'INBOX',
    unifiedInbox: false,
    unifiedFolder: 'INBOX',
    mailboxScope: null,
    mailboxes: [],
    viewMode: 'all',
    emails: [],
    sortedEmails: [],
    sentEmails: [],
    localEmails: [],
    savedEmailIds: new Set(),
    archivedEmailIds: new Set(),
    serverUids: serverUids(new Set(), { complete: false }),
    deleteTombstones: new Set(),
    totalEmails: 0,
    selectedEmailIds: new Set(),
    selectedEmail: null,
    selectedEmailId: null,
    selectedThread: null,
    loadingEmail: false,
    error: null,
    emailCache: new Map(),
    loadEmails: vi.fn(),
    _sortedEmailsFingerprint: '',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetLocalEmailLight.mockResolvedValue(null);
  mockGetEmailHeadersPartial.mockResolvedValue({ emails: [LOADED_ROW], totalEmails: 1 });
  mockFetchEmails.mockResolvedValue({ emails: [LOADED_ROW] });
  baseState();
});

function expectOpened(accountId, mailbox) {
  const state = useMailStore.getState();
  expect(state.error).toBe(null);
  expect(state.selectedEmail?.uid).toBe(282);
  expect(state.selectedEmail?._accountId).toBe(accountId);
  expect(state.selectedEmail?._mailbox).toBe(mailbox);
  expect(mockGetLocalEmailLight).toHaveBeenCalledWith(accountId, mailbox, 282);
}

describe('selectEmail for a vault search hit a folder branch has not loaded', () => {
  it('opens it in a folder branch by its full selection key', async () => {
    useMailStore.setState({
      activeMailbox: 'Projects',
      mailboxes: [
        { path: 'Projects', name: 'Projects', delimiter: '/' },
        { path: 'Projects/2017', name: '2017', delimiter: '/' },
      ],
    });
    await useMailStore.getState().loadSubtree(ACCT_A.id, 'Projects');
    expect(useMailStore.getState().mailboxScope?.paths).toEqual(['Projects', 'Projects/2017']);
    mockGetLocalEmailLight.mockResolvedValue(VAULT_COPY);

    await useMailStore.getState().selectEmail(`${ACCT_A.id}:Projects/2017:282`, 'local', 'Projects/2017');

    expectOpened(ACCT_A.id, 'Projects/2017');
  });
});
