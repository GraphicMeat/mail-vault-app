// A banner click from All Inboxes: openNotificationTarget switches to the
// folder the message arrived in, then opens it. The reader must end on that
// message, whichever path activateAccount paints the folder from.
import { describe, it, expect, beforeEach, vi } from 'vitest';

if (!globalThis.window) {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
} else {
  globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
}

const mockFetchEmailLight = vi.fn();
const mockGetLocalEmailLight = vi.fn().mockResolvedValue(null);
const mockSaveEmailHeaders = vi.fn().mockResolvedValue(undefined);
const mockDeleteLocalEmail = vi.fn().mockResolvedValue(undefined);

vi.mock('../../db', () => ({
  getLocalEmailLight: (...a) => mockGetLocalEmailLight(...a),
  getEmailHeadersMeta: vi.fn().mockResolvedValue(null),
  getEmailHeadersPartial: vi.fn().mockResolvedValue({ emails: [], totalEmails: 0 }),
  getVaultUidSets: vi.fn().mockResolvedValue({ saved: new Set(), archived: new Set() }),
  getCachedMailboxEntry: vi.fn().mockResolvedValue(null),
  getLocalEmails: vi.fn().mockResolvedValue([]),
  readLocalEmailIndex: vi.fn().mockResolvedValue(null),
  getArchivedEmails: vi.fn().mockResolvedValue([]),
  deleteLocalEmail: (...a) => mockDeleteLocalEmail(...a),
  saveEmailHeaders: (...a) => mockSaveEmailHeaders(...a),
  exportEmail: vi.fn().mockResolvedValue(null),
  initDB: vi.fn().mockResolvedValue(undefined),
  getAccounts: vi.fn().mockResolvedValue([]),
  ensureAccountsInFile: vi.fn().mockResolvedValue(undefined),
  saveMailboxes: vi.fn().mockResolvedValue(undefined),
}));

const mockVaultApplyFlags = vi.fn().mockResolvedValue({ renamed: 0, mirrored: 0, index_patched: 0, sidecars_patched: 0 });
vi.mock('../../api', () => ({
  vaultApplyFlags: (...a) => mockVaultApplyFlags(...a),
  fetchEmailLight: (...a) => mockFetchEmailLight(...a),
  updateEmailFlags: vi.fn().mockResolvedValue(undefined),
  graphSetRead: vi.fn().mockResolvedValue(undefined),
  graphGetMessage: vi.fn().mockResolvedValue(null),
  graphListFolders: vi.fn().mockResolvedValue([]),
  graphListMessages: vi.fn().mockResolvedValue({ headers: [], graphMessageIds: [] }),
  graphCacheMime: vi.fn().mockResolvedValue(undefined),
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
      setLastMailbox: () => {},
      emailListStyle: 'default',
      linkAlerts: {},
      linkSafetyEnabled: false,
      markAsReadMode: 'manual',
      markAsReadDelay: 3,
      setUnreadForAccount: () => {},
    }),
  },
}));


vi.mock('../../transport', () => ({ getDaemonHealth: () => ({ alive: false }), send: vi.fn().mockResolvedValue(null) }));
vi.mock('../../syncProbe', () => ({ mailboxIsUnchanged: vi.fn().mockResolvedValue(false), markVerified: vi.fn(), invalidate: vi.fn() }));
vi.mock('../../syncService', () => ({
  syncNow: vi.fn().mockResolvedValue({ started: false }),
  waitForSync: vi.fn().mockResolvedValue(null),
  toSyncAccount: (account, id = account?.id) => ({ id, email: account?.email, imapConfig: {} }),
  watchAccount: vi.fn(),
  unwatchAccount: vi.fn(),
}));
vi.mock('../folderStatus', () => ({ refreshFolderStatus: vi.fn().mockResolvedValue(null) }));

const { useMailStore } = await import('../../../stores/mailStore');
await import('../bindStoreActions');
const cacheManager = await import('../../cacheManager');
const { openNotificationTarget } = await import('../../../utils/notificationOpen');

const ACCOUNT = { id: 'acct1', email: 'someone@mock.test', password: 'pw' };
const OLD = { uid: 3, subject: 'Older', from: { address: 'b@example.test' }, date: '2026-09-13T10:00:00Z', flags: ['\\Seen'] };
const ARRIVED = { uid: 7, subject: 'Just arrived', from: { address: 'ada@example.test' }, date: '2026-09-14T10:00:00Z', flags: [] };
const MAILBOXES = [{ path: 'INBOX', name: 'INBOX', children: [] }];
const settle = () => new Promise(r => setTimeout(r, 50));

beforeEach(() => {
  vi.clearAllMocks();
  mockFetchEmailLight.mockResolvedValue({ ...ARRIVED, html: '<p>hi</p>' });
  useMailStore.setState({
    accounts: [ACCOUNT],
    activeAccountId: ACCOUNT.id,
    activeMailbox: 'UNIFIED',
    unifiedInbox: true,
    mailboxScope: null,
    viewMode: 'all',
    emails: [{ ...OLD, _accountId: ACCOUNT.id, _mailbox: 'INBOX' }],
    sortedEmails: [{ ...OLD, _accountId: ACCOUNT.id, _mailbox: 'INBOX' }],
    sentEmails: [],
    localEmails: [],
    mailboxes: MAILBOXES,
    savedEmailIds: new Set(),
    archivedEmailIds: new Set(),
    deleteTombstones: new Set(),
    totalEmails: 1,
    selectedEmailIds: new Set(),
    selectedEmail: null,
    selectedEmailId: null,
    emailCache: new Map(),
    loadSentHeaders: vi.fn(),
    _sortedEmailsFingerprint: '',
  });
});

const expectOpened = () => {
  const s = useMailStore.getState();
  expect(s.selectedEmail?.uid).toBe(7);
  expect(s.selectedEmail?._accountId).toBe(ACCOUNT.id);
  expect(s.selectedEmail?._mailbox).toBe('INBOX');
  expect(s.loadingEmail).toBeFalsy();
};

describe('a banner click while All Inboxes is on screen', () => {
  it('opens the message when the folder loads cold', async () => {
    await openNotificationTarget({ accountId: ACCOUNT.id, mailbox: 'INBOX', uid: 7 }, useMailStore.getState);
    await settle();
    expectOpened();
  });

  it('opens the message when the folder paints from its restore descriptor', async () => {
    cacheManager.getRestoreDescriptor.mockImplementation((id, mailbox) => (id === ACCOUNT.id && mailbox === 'INBOX' ? {
      accountId: ACCOUNT.id, mailbox: 'INBOX', viewMode: 'all', totalEmails: 1, topVisibleIndex: 0,
      selectedUid: null, mailboxes: MAILBOXES, mailboxesFetchedAt: Date.now(),
      firstWindow: [OLD], firstWindowSavedUids: [], firstWindowArchivedUids: [],
    } : null));
    await openNotificationTarget({ accountId: ACCOUNT.id, mailbox: 'INBOX', uid: 7 }, useMailStore.getState);
    await settle();
    expectOpened();
  });
});
