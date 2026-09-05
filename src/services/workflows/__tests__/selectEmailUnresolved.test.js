// The viewer's half of B3.
//
// A spanning view's selection key names its account and its folder. When the
// key resolves to no row, `unified?.accountId || state.activeAccountId` aimed
// the whole open at the ACTIVE account's INBOX under the raw uid — a real
// message on a real server, belonging to somebody else's mailbox, rendered
// under the row the user clicked. From there mark-unread and reply act on it.
//
// Phase 1 closed the delete side (requireUnifiedContext throws rather than
// guess). This is the same refusal for the read side: no fetch, no viewer, and
// the reason on screen.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { t as tr } from '../../../i18n/index.js';
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

const ACCT_A = { id: 'acct-a', email: 'a@mock.test' };
const ACCT_B = { id: 'acct-b', email: 'b@mock.test' };

// Both accounts hold a message under uid 9 — the collision the whole rule is
// about. Only the key says which one a click means.
const ROWS = [
  {
    uid: 9, messageId: 'a9@mock', subject: 'From A', flags: [],
    from: { address: 'them@a.test' }, date: '2026-09-01T10:00:00Z',
    _accountId: ACCT_A.id, _mailbox: 'INBOX',
  },
  {
    uid: 9, messageId: 'b9@mock', subject: 'From B', flags: [],
    from: { address: 'them@b.test' }, date: '2026-09-01T09:00:00Z',
    _accountId: ACCT_B.id, _mailbox: 'INBOX',
  },
];

function primeUnified() {
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
    serverUids: serverUids(new Set([9]), { complete: false }),
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
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetLocalEmailLight.mockResolvedValue(null);
  mockFetchEmailLight.mockResolvedValue({ uid: 9, subject: 'From A', html: '<p>body</p>', flags: [] });
  primeUnified();
});

describe('selectEmail in a view that spans mailboxes', () => {
  it('refuses a key that names no row instead of opening the active account under that uid', async () => {
    await useMailStore.getState().selectEmail('ghost:INBOX:9');

    expect(mockFetchEmailLight).not.toHaveBeenCalled();
    const s = useMailStore.getState();
    expect(s.selectedEmail).toBe(null);
    expect(s.selectedThread).toBe(null);
    expect(s.loadingEmail).toBe(false);
  });

  it('says why, in the catalog copy the delete side already uses', async () => {
    await useMailStore.getState().selectEmail('ghost:INBOX:9');

    expect(useMailStore.getState().error)
      .toBe(tr('errors.unresolvedUnifiedRow', { key: 'ghost:INBOX:9' }));
  });

  // The control. A refusal that also refuses the ordinary case is not a guard,
  // it is an outage.
  //
  // Only the account and folder are asserted here: this path still spends the
  // whole key where a uid belongs (the second argument), which is a separate
  // defect from the one under test and not one this guard creates.
  it('still opens the message a resolvable key names, from that key\'s account', async () => {
    await useMailStore.getState().selectEmail(`${ACCT_B.id}:INBOX:9`);

    expect(mockFetchEmailLight).toHaveBeenCalledTimes(1);
    const [account, , mailbox, accountId] = mockFetchEmailLight.mock.calls[0];
    expect(account.id).toBe(ACCT_B.id);
    expect(mailbox).toBe('INBOX');
    expect(accountId).toBe(ACCT_B.id);
    expect(useMailStore.getState().error).toBe(null);
  });

  // The other shape the same view sends: EmailList clicks with the bare uid,
  // which resolves off the row rather than the key.
  it('still opens a bare uid that a row in the view answers to', async () => {
    await useMailStore.getState().selectEmail(9);

    expect(mockFetchEmailLight).toHaveBeenCalledTimes(1);
    const [account, uid, mailbox] = mockFetchEmailLight.mock.calls[0];
    expect(account.id).toBe(ACCT_A.id);
    expect(uid).toBe(9);
    expect(mailbox).toBe('INBOX');
    expect(useMailStore.getState().error).toBe(null);
  });

  // A single-folder list has one location, and there a bare uid IS the whole
  // key — the guard must not reach it.
  it('leaves an ordinary single-folder open alone', async () => {
    useMailStore.setState({ activeMailbox: 'INBOX', unifiedInbox: false, activeAccountId: ACCT_A.id });

    await useMailStore.getState().selectEmail(9);

    expect(mockFetchEmailLight).toHaveBeenCalledTimes(1);
    expect(useMailStore.getState().error).toBe(null);
  });
});
