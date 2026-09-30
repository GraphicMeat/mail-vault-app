// Opening a message marks it read through the one flag core (applyFlagToTargets):
// the row change everywhere, the journal, the server. It used to be a second,
// weaker path of its own: the server write first, the rows only once the server
// had answered, and a refusal only warned — the message stayed bold with no
// journal entry, so nothing ever finished the change.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { serverUids } from '../../../stores/slices/serverUids';

if (!globalThis.window) {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
} else {
  globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
}

const mockFetchEmailLight = vi.fn();
const mockGetLocalEmailLight = vi.fn().mockResolvedValue(null);
const mockUpdateEmailFlags = vi.fn();
const mockVaultApplyFlags = vi.fn().mockResolvedValue({ renamed: 0, mirrored: 0, index_patched: 0, sidecars_patched: 0 });
let netOnline = true;

// The journal as the daemon keeps it: entries in, entries out by exact match.
let journal = [];
const sameEntry = (a, b) => JSON.stringify([a.op, a.accountId, a.mailbox, a.uids, a.arg || {}])
  === JSON.stringify([b.op, b.accountId, b.mailbox, b.uids, b.arg || {}]);
const mockQueueOp = vi.fn(async (entry) => { journal.push(entry); return journal.length; });
const mockClearOps = vi.fn(async (entry) => { journal = journal.filter(e => !sameEntry(e, entry)); });

const ACCOUNT = { id: 'acctA', email: 'rare@mock.test' };

vi.mock('../../db', () => ({
  getLocalEmailLight: (...a) => mockGetLocalEmailLight(...a),
  getEmailHeadersMeta: vi.fn().mockResolvedValue(null),
  getEmailHeadersPartial: vi.fn().mockResolvedValue({ emails: [], totalEmails: 0 }),
  getVaultUidSets: vi.fn().mockResolvedValue({ saved: new Set(), archived: new Set() }),
  getCachedMailboxEntry: vi.fn().mockResolvedValue(null),
  getLocalEmails: vi.fn().mockResolvedValue([]),
  readLocalEmailIndex: vi.fn().mockResolvedValue(null),
  getArchivedEmails: vi.fn().mockResolvedValue([]),
  deleteLocalEmail: vi.fn().mockResolvedValue(undefined),
  saveEmailHeaders: vi.fn().mockResolvedValue(undefined),
  exportEmail: vi.fn().mockResolvedValue(null),
  initDB: vi.fn().mockResolvedValue(undefined),
  getAccounts: async () => [ACCOUNT],
  ensureAccountsInFile: vi.fn().mockResolvedValue(undefined),
  saveMailboxes: vi.fn().mockResolvedValue(undefined),
  queueOp: (...a) => mockQueueOp(...a),
  clearOps: (...a) => mockClearOps(...a),
  readOps: async () => journal.map(e => ({ ...e })),
  noteOpFailure: vi.fn(),
  startKeychainLoad: () => {},
  onKeychainReady: (cb) => cb(),
}));

vi.mock('../../api', () => ({
  vaultApplyFlags: (...a) => mockVaultApplyFlags(...a),
  fetchEmailLight: (...a) => mockFetchEmailLight(...a),
  updateEmailFlags: (...a) => mockUpdateEmailFlags(...a),
  graphSetRead: vi.fn().mockResolvedValue(undefined),
  graphGetMessage: vi.fn().mockResolvedValue(null),
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
vi.mock('../../../stores/connectivityStore', () => ({
  useConnectivityStore: { getState: () => ({ online: netOnline }) },
}));
vi.mock('../../../stores/settingsStore', () => ({
  effectiveSearchMailboxConcurrency: () => 1,
  useSettingsStore: {
    getState: () => ({
      cacheLimitMB: 128,
      hiddenAccounts: {},
      getLastMailbox: () => 'INBOX',
      emailListStyle: 'default',
      linkAlerts: {},
      linkSafetyEnabled: false,
      markAsReadMode: 'immediate',
      markAsReadDelay: 3,
      setUnreadForAccount: () => {},
      addSearchToHistory: () => {},
      trackerAlerts: {},
      setTrackerAlert: () => {},
      setLinkAlert: () => {},
    }),
  },
}));
vi.mock('../../safeStorage', () => ({
  safeStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}));
vi.mock('../../mailSearch.js', () => ({
  startMailSearch: vi.fn(),
  cancelMailSearch: vi.fn().mockResolvedValue(undefined),
}));

const { useMailStore } = await import('../../../stores/mailStore');
const { useSearchStore } = await import('../../../stores/searchStore');
const { replayOps } = await import('../replayOps');

const UNREAD = {
  uid: 42, messageId: '<msg42@example.test>', subject: 'Price for what?', flags: [], source: 'server',
  from: { address: 'someone@example.test' }, date: '2026-08-26T21:27:00Z',
};
const CACHE_KEY = 'acctA-INBOX-42';
const FLAG_OP = { op: 'flag', accountId: 'acctA', mailbox: 'INBOX', uids: [42], arg: { flags: ['\\Seen'], action: 'add' } };

function prime(row = UNREAD) {
  useMailStore.setState({
    accounts: [ACCOUNT],
    activeAccountId: ACCOUNT.id,
    activeMailbox: 'INBOX',
    unifiedInbox: false,
    mailboxScope: null,
    viewMode: 'all',
    emails: [row],
    sentEmails: [],
    localEmails: [],
    savedEmailIds: new Set(),
    archivedEmailIds: new Set(),
    serverUids: serverUids(new Set([row.uid]), { complete: true }),
    deleteTombstones: new Set(),
    totalEmails: 1,
    selectedEmailIds: new Set(),
    selectedEmail: null,
    selectedEmailId: null,
    selectedThread: null,
    emailCache: new Map(),
    unreadOnly: false,
    unreadKeep: new Set(),
    localFolders: [],
    loadEmails: vi.fn(),
    undo: null,
    error: null,
    _sortedEmailsFingerprint: '',
  });
  useMailStore.getState().updateSortedEmails();
  useSearchStore.setState({
    searchActive: false,
    searchResults: [{ ...row, _accountId: ACCOUNT.id, _mailbox: 'INBOX' }],
    indexedSearchRows: {},
    searchRowsOutsideIndex: [{ ...row, _accountId: ACCOUNT.id, _mailbox: 'INBOX' }],
    excludedSearchCopies: new Set(),
  });
}

const listFlags = () => useMailStore.getState().emails.find(e => e.uid === 42).flags;

beforeEach(() => {
  vi.clearAllMocks();
  journal = [];
  netOnline = true;
  mockGetLocalEmailLight.mockResolvedValue(null);
  mockFetchEmailLight.mockResolvedValue({ ...UNREAD, html: '<p>body</p>' });
  mockUpdateEmailFlags.mockResolvedValue(undefined);
});

describe('opening a message marks it read through the one flag core', () => {
  it('paints every copy before the server has answered', async () => {
    prime();
    let answer;
    mockUpdateEmailFlags.mockReturnValue(new Promise((resolve) => { answer = resolve; }));

    const opened = useMailStore.getState().selectEmail(42, 'server');
    await vi.waitFor(() => expect(mockUpdateEmailFlags).toHaveBeenCalled());

    // The server has not answered: the list row, a search hit and the cached
    // body are already read (it used to wait for the round trip).
    expect(listFlags()).toContain('\\Seen');
    expect(useSearchStore.getState().searchResults[0].flags).toContain('\\Seen');
    expect(useMailStore.getState().emailCache.get(CACHE_KEY).email.flags).toContain('\\Seen');

    answer();
    await opened;
    // The journal clears behind the open (the mark's server half is detached).
    await vi.waitFor(() => expect(journal).toEqual([]));
  });

  it('a server that refuses the write leaves the row read and the op in the journal, and the replay finishes it', async () => {
    prime();
    mockUpdateEmailFlags.mockRejectedValue(new Error('connection lost'));

    await useMailStore.getState().selectEmail(42, 'server');

    expect(listFlags()).toContain('\\Seen');
    expect(useMailStore.getState().selectedEmail.flags).toContain('\\Seen');
    expect(journal).toEqual([FLAG_OP]);

    // The next launch, or the link coming back: the server takes it now.
    mockUpdateEmailFlags.mockClear();
    mockUpdateEmailFlags.mockResolvedValue(undefined);
    await replayOps({ reason: 'test' });

    expect(mockUpdateEmailFlags).toHaveBeenCalledWith(expect.objectContaining({ id: 'acctA' }), 42, ['\\Seen'], 'add', 'INBOX');
    expect(journal).toEqual([]);
  });

  it('offline it journals the op and sends nothing', async () => {
    prime();
    netOnline = false;

    await useMailStore.getState().selectEmail(42, 'server');

    expect(listFlags()).toContain('\\Seen');
    expect(mockUpdateEmailFlags).not.toHaveBeenCalled();
    expect(journal).toEqual([FLAG_OP]);
  });

  it('holds the row on screen under the unread filter, as it always did', async () => {
    prime();
    useMailStore.setState({ unreadOnly: true });

    await useMailStore.getState().selectEmail(42, 'server');

    expect([...useMailStore.getState().unreadKeep]).toEqual([42]);
  });

  it('a message the server no longer holds is read in the vault only: nothing is journalled or sent', async () => {
    prime({ ...UNREAD, serverAbsent: true });
    mockGetLocalEmailLight.mockResolvedValue({ ...UNREAD, html: '<p>vault body</p>' });

    await useMailStore.getState().selectEmail(42, 'server');

    expect(listFlags()).toContain('\\Seen');
    expect(mockVaultApplyFlags).toHaveBeenCalled();
    expect(mockUpdateEmailFlags).not.toHaveBeenCalled();
    expect(journal).toEqual([]);
  });
});
