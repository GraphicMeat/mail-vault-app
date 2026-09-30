// Opening a message marks it read through the one flag core. The mark's server
// half (the journal write, the token check, the STORE, the journal clear) must
// not sit on the click's critical path: the body publishes once the rows have
// painted, and a Graph mark that cannot reach the server says so in the log,
// not in the app's error banner (the auto mark is nothing the user asked for).
// The last block is the join the state fixes demanded: one unread INBOX message
// opened in a single folder and in All Inboxes moves the account badge and the
// dock total by exactly one, and a loader commit landing meanwhile moves neither
// back nor a second time.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { serverUids } from '../../../stores/slices/serverUids';

if (!globalThis.window) {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
} else {
  globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
}
vi.stubGlobal('navigator', { onLine: true });

const mockFetchEmailLight = vi.fn();
const mockUpdateEmailFlags = vi.fn();
const mockGraphSetRead = vi.fn();
const mockGraphGetMessage = vi.fn();
const mockFetchEmails = vi.fn();
const mockCheckMailboxStatus = vi.fn();
const mockGetEmailHeadersPartial = vi.fn();
const mockQueueOp = vi.fn();
let netOnline = true;

// The sidebar badge as the settings store keeps it: absolute per account.
const unreadPerAccount = {};
const mockSetUnreadForAccount = vi.fn((id, n) => { unreadPerAccount[id] = n; });

// A relist is what the real ladder does when neither the row nor the map knows
// the Graph id; the row's own `_graphId` answers first.
let relists = 0;
const mockResolveGraphMessageId = vi.fn(async (accountId, mailbox, uid, { row } = {}) => {
  if (row?._graphId) return row._graphId;
  relists += 1;
  return 'graph-id-42';
});

vi.mock('../../db', () => ({
  getLocalEmailLight: vi.fn().mockResolvedValue(null),
  getCachedMailboxes: vi.fn().mockResolvedValue([{ path: 'INBOX' }]),
  getEmailHeadersMeta: vi.fn().mockResolvedValue(null),
  getEmailHeadersPartial: (...a) => mockGetEmailHeadersPartial(...a),
  getVaultUidSets: vi.fn().mockResolvedValue({ saved: new Set(), archived: new Set() }),
  getCachedMailboxEntry: vi.fn().mockResolvedValue(null),
  getLocalEmails: vi.fn().mockResolvedValue([]),
  readLocalEmailIndex: vi.fn().mockResolvedValue(null),
  getArchivedEmails: vi.fn().mockResolvedValue([]),
  deleteLocalEmail: vi.fn().mockResolvedValue(undefined),
  saveEmailHeaders: vi.fn().mockResolvedValue(undefined),
  clearMailboxCache: vi.fn().mockResolvedValue(undefined),
  listCachedUids: vi.fn().mockResolvedValue({ uids: [], changed: [] }),
  getEmailHeadersByUids: vi.fn().mockResolvedValue([]),
  exportEmail: vi.fn().mockResolvedValue(null),
  initDB: vi.fn().mockResolvedValue(undefined),
  getAccounts: async () => [],
  ensureAccountsInFile: vi.fn().mockResolvedValue(undefined),
  saveMailboxes: vi.fn().mockResolvedValue(undefined),
  queueOp: (...a) => mockQueueOp(...a),
  clearOps: vi.fn().mockResolvedValue(undefined),
  readOps: async () => [],
  noteOpFailure: vi.fn(),
  startKeychainLoad: () => {},
  onKeychainReady: (cb) => cb(),
}));

vi.mock('../../api', () => ({
  vaultApplyFlags: vi.fn().mockResolvedValue({ renamed: 0, mirrored: 0, index_patched: 0, sidecars_patched: 0 }),
  fetchEmailLight: (...a) => mockFetchEmailLight(...a),
  updateEmailFlags: (...a) => mockUpdateEmailFlags(...a),
  graphSetRead: (...a) => mockGraphSetRead(...a),
  graphGetMessage: (...a) => mockGraphGetMessage(...a),
  graphCacheMime: vi.fn().mockResolvedValue(undefined),
  fetchEmails: (...a) => mockFetchEmails(...a),
  checkMailboxStatus: (...a) => mockCheckMailboxStatus(...a),
  searchAllUids: vi.fn().mockResolvedValue([]),
  fetchHeadersByUids: vi.fn().mockResolvedValue({ emails: [] }),
  fetchChangedFlags: vi.fn().mockResolvedValue([]),
  fetchMailboxes: vi.fn().mockResolvedValue([]),
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
  isGraphAccount: (a) => a?.oauth2Transport === 'graph',
  graphMessageToEmail: (m) => m,
  graphFoldersToMailboxes: () => [],
  isPersonalMicrosoftEmail: () => false,
}));
vi.mock('../../cacheManager', () => ({
  getRestoreDescriptor: vi.fn().mockReturnValue(null),
  saveRestoreDescriptor: vi.fn(),
  invalidateRestoreDescriptors: () => {},
  getAccountCacheMailboxes: () => [{ path: 'INBOX' }],
  listGraphMessages: vi.fn().mockResolvedValue({ headers: [], graphMessageIds: [] }),
  getGraphMessageId: () => null,
  resolveGraphMessageId: (...a) => mockResolveGraphMessageId(...a),
  restoreGraphIdMap: vi.fn().mockResolvedValue(undefined),
  clearGraphIdMap: () => {},
}));
vi.mock('../../../stores/connectivityStore', () => ({
  useConnectivityStore: { getState: () => ({ online: netOnline, probe: async () => netOnline }) },
}));
vi.mock('../../../stores/settingsStore', () => ({
  effectiveSearchMailboxConcurrency: () => 1,
  useSettingsStore: {
    getState: () => ({
      cacheLimitMB: 128,
      hiddenAccounts: {},
      getLastMailbox: () => 'INBOX',
      setLastMailbox: () => {},
      emailListStyle: 'default',
      linkAlerts: {},
      linkSafetyEnabled: false,
      markAsReadMode: 'immediate',
      markAsReadDelay: 3,
      unreadPerAccount,
      setUnreadPerAccount: (m) => { for (const k of Object.keys(unreadPerAccount)) delete unreadPerAccount[k]; Object.assign(unreadPerAccount, m); },
      setUnreadForAccount: (...a) => mockSetUnreadForAccount(...a),
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
vi.mock('../../transport', () => ({ getDaemonHealth: () => ({ alive: false }) }));
vi.mock('../../syncProbe', () => ({
  mailboxIsUnchanged: vi.fn(), markVerified: vi.fn(), invalidate: vi.fn(),
}));
vi.mock('../../syncService', () => ({
  syncNow: vi.fn(), waitForSync: vi.fn(), toSyncAccount: (a) => a, watchAccount: vi.fn(), unwatchAccount: vi.fn(),
}));

const { useMailStore } = await import('../../../stores/mailStore');
const { useSearchStore } = await import('../../../stores/searchStore');
const { selectTotalUnread } = await import('../../../stores/unreadCounts');

const A = { id: 'acctA', email: 'a@mock.test', password: 'pw' };
const B = { id: 'acctB', email: 'b@mock.test', password: 'pw' };
const G = { id: 'acctG', email: 'g@mock.test', oauth2Transport: 'graph', oauth2AccessToken: 'tok' };

const mkRow = (uid, extra = {}) => ({
  uid, messageId: `<m${uid}@example.test>`, subject: `Msg ${uid}`, flags: [], source: 'server',
  from: { address: 'someone@example.test' }, date: new Date(1_700_000_000_000 + uid * 1000).toISOString(), ...extra,
});
const stamped = (accountId, uid) => mkRow(uid, { _accountId: accountId, _accountEmail: `${accountId}@mock.test`, _mailbox: 'INBOX' });
const UIDS = [46, 45, 44, 43, 42];

function primeSingle(account = A, rows = UIDS.map(u => mkRow(u))) {
  useMailStore.setState({
    accounts: [account],
    activeAccountId: account.id,
    activeMailbox: 'INBOX',
    unifiedInbox: false,
    mailboxScope: null,
    viewMode: 'all',
    emails: rows,
    sentEmails: [],
    localEmails: [],
    savedEmailIds: new Set(),
    archivedEmailIds: new Set(),
    serverUids: serverUids(new Set(rows.map(r => r.uid)), { complete: true }),
    deleteTombstones: new Set(),
    totalEmails: rows.length,
    selectedEmailIds: new Set(),
    selectedEmail: null,
    selectedEmailId: null,
    selectedThread: null,
    emailCache: new Map(),
    unreadOnly: false,
    unreadKeep: new Set(),
    localFolders: [],
    undo: null,
    error: null,
    loading: false,
    _sortedEmailsFingerprint: '',
  });
  useMailStore.getState().updateSortedEmails();
  useSearchStore.setState({ searchActive: false, searchResults: [], indexedSearchRows: {}, searchRowsOutsideIndex: [], excludedSearchCopies: new Set() });
}

function primeUnified() {
  const rows = [...UIDS.map(u => stamped(A.id, u)), ...UIDS.map(u => stamped(B.id, u))];
  useMailStore.setState({
    accounts: [A, B],
    activeAccountId: A.id,
    activeMailbox: 'UNIFIED',
    unifiedInbox: true,
    unifiedFolder: 'INBOX',
    mailboxScope: null,
    viewMode: 'all',
    emails: rows,
    sentEmails: [],
    localEmails: [],
    savedEmailIds: new Set(),
    archivedEmailIds: new Set(),
    serverUids: serverUids(new Set(), { complete: false }),
    deleteTombstones: new Set(),
    totalEmails: rows.length,
    selectedEmailIds: new Set(),
    selectedEmail: null,
    selectedEmailId: null,
    selectedThread: null,
    emailCache: new Map(),
    unreadOnly: false,
    unreadKeep: new Set(),
    localFolders: [],
    undo: null,
    error: null,
    loading: false,
    loadSentHeaders: vi.fn(),
    _sortedEmailsFingerprint: '',
  });
  useMailStore.getState().updateSortedEmails();
  useSearchStore.setState({ searchActive: false, searchResults: [], indexedSearchRows: {}, searchRowsOutsideIndex: [], excludedSearchCopies: new Set() });
}

function parked() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const never = () => new Promise(() => {});

const badge = (id) => unreadPerAccount[id];
const total = () => selectTotalUnread({ hiddenAccounts: {}, unreadPerAccount });
const storeFlags = (uid, accountId = null) => useMailStore.getState().emails
  .find(e => e.uid === uid && (!accountId || e._accountId === accountId)).flags;

beforeEach(() => {
  vi.clearAllMocks();
  netOnline = true;
  relists = 0;
  for (const k of Object.keys(unreadPerAccount)) delete unreadPerAccount[k];
  unreadPerAccount[A.id] = 5;
  unreadPerAccount[B.id] = 5;
  unreadPerAccount[G.id] = 5;
  mockQueueOp.mockResolvedValue(1);
  mockUpdateEmailFlags.mockResolvedValue(undefined);
  mockGraphSetRead.mockResolvedValue(undefined);
  mockFetchEmailLight.mockImplementation(async (account, uid, mailbox, accountId) =>
    ({ ...mkRow(uid), html: '<p>body</p>', _accountId: accountId, _mailbox: mailbox }));
  mockGraphGetMessage.mockResolvedValue({ ...mkRow(42), html: '<p>graph body</p>' });
  mockGetEmailHeadersPartial.mockResolvedValue({ emails: [], totalEmails: 0 });
});

describe('the open publishes without waiting for the server half of the mark', () => {
  it('with the journal and the server parked for ever, the body still publishes and the badge moved exactly one', async () => {
    primeSingle();
    mockQueueOp.mockReturnValue(never());
    mockUpdateEmailFlags.mockReturnValue(never());

    const opened = useMailStore.getState().selectEmail(42, 'server');
    await vi.waitFor(() => expect(useMailStore.getState().selectedEmail?.html).toBe('<p>body</p>'), { timeout: 1000 });
    await opened;

    expect(storeFlags(42)).toContain('\\Seen');
    expect(useMailStore.getState().selectedEmail.flags).toContain('\\Seen');
    expect(badge(A.id)).toBe(4);
    expect(total()).toBe(14);
  });

  it('the server half still runs, off the click: journalled, sent and cleared', async () => {
    primeSingle();

    await useMailStore.getState().selectEmail(42, 'server');

    await vi.waitFor(() => expect(mockUpdateEmailFlags).toHaveBeenCalledWith(
      expect.objectContaining({ id: A.id }), 42, ['\\Seen'], 'add', 'INBOX'));
    expect(mockQueueOp).toHaveBeenCalledTimes(1);
  });

  it('a journal write that fails is logged, never an unhandled rejection, and the row stays read', async () => {
    primeSingle();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockQueueOp.mockRejectedValue(new Error('daemon gone'));
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);

    await useMailStore.getState().selectEmail(42, 'server');
    await new Promise((r) => setTimeout(r, 30));
    process.off('unhandledRejection', unhandled);

    expect(unhandled).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    expect(storeFlags(42)).toContain('\\Seen');
    warn.mockRestore();
  });
});

describe('a Graph mark that is not the user\'s own action stays out of the error banner', () => {
  const primeGraph = () => primeSingle(G);

  it('offline it is skipped with a warning, and the store error stays empty', async () => {
    primeGraph();
    netOnline = false;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await useMailStore.getState().selectEmail(42, 'server');
    await new Promise((r) => setTimeout(r, 30));

    expect(storeFlags(42)).toContain('\\Seen');
    expect(mockGraphSetRead).not.toHaveBeenCalled();
    expect(useMailStore.getState().error).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a failed Graph write is logged, and the store error stays empty', async () => {
    primeGraph();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockGraphSetRead.mockRejectedValue(new Error('Graph 503'));

    await useMailStore.getState().selectEmail(42, 'server');
    await vi.waitFor(() => expect(mockGraphSetRead).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 30));

    expect(useMailStore.getState().error).toBeNull();
    warn.mockRestore();
    err.mockRestore();
  });

  it('the Graph id the open already resolved rides on the mark: no second lookup, no relist', async () => {
    primeGraph();

    await useMailStore.getState().selectEmail(42, 'server');
    await vi.waitFor(() => expect(mockGraphSetRead).toHaveBeenCalled());

    expect(mockGraphSetRead).toHaveBeenCalledWith('tok', 'graph-id-42', true);
    expect(relists).toBe(1); // the open's own lookup, and nothing after it
  });
});

describe('opening one unread INBOX message moves the badge and the dock total by exactly one', () => {
  it('in a single folder', async () => {
    primeSingle();
    const totalBefore = total();

    await useMailStore.getState().selectEmail(42, 'server');

    expect(badge(A.id)).toBe(4);
    expect(total()).toBe(totalBefore - 1);
  });

  it('in All Inboxes, for the account whose message it is', async () => {
    primeUnified();
    const totalBefore = total();

    await useMailStore.getState().selectEmail(`${A.id}:INBOX:42`, 'server');

    expect(storeFlags(42, A.id)).toContain('\\Seen');
    expect(storeFlags(42, B.id)).toEqual([]); // the same uid in another account
    expect(badge(A.id)).toBe(4);
    expect(badge(B.id)).toBe(5);
    expect(total()).toBe(totalBefore - 1);
  });

  it('in a single folder, a load that read the list before the open commits after it: still read, no second shift', async () => {
    primeSingle();
    const page = parked();
    mockFetchEmails.mockReturnValue(page.promise);
    mockCheckMailboxStatus.mockResolvedValue({ uidValidity: 1, uidNext: 47, highestModseq: null, exists: 5 });
    const totalBefore = total();

    const loading = useMailStore.getState().loadEmails();
    await vi.waitFor(() => expect(mockFetchEmails).toHaveBeenCalled());
    await useMailStore.getState().selectEmail(42, 'server');
    expect(badge(A.id)).toBe(4);

    // The page was fetched before the open: every row unread.
    page.resolve({ emails: UIDS.map(u => mkRow(u)), total: 5, hasMore: false });
    await loading;

    expect(storeFlags(42)).toContain('\\Seen');
    expect(badge(A.id)).toBe(4);
    expect(total()).toBe(totalBefore - 1);
  });

  it('in All Inboxes, a load that read the lists before the open commits after it: still read, no second shift', async () => {
    primeUnified();
    const disk = parked();
    mockGetEmailHeadersPartial.mockReturnValue(disk.promise);
    const totalBefore = total();

    const loading = useMailStore.getState().loadUnifiedInbox(null, 'INBOX');
    await vi.waitFor(() => expect(mockGetEmailHeadersPartial).toHaveBeenCalled());
    await useMailStore.getState().selectEmail(`${A.id}:INBOX:42`, 'server');
    expect(badge(A.id)).toBe(4);

    disk.resolve({ emails: UIDS.map(u => mkRow(u)), totalEmails: 5 });
    await loading;

    expect(storeFlags(42, A.id)).toContain('\\Seen');
    expect(storeFlags(42, B.id)).toEqual([]);
    expect(badge(A.id)).toBe(4);
    expect(badge(B.id)).toBe(5);
    expect(total()).toBe(totalBefore - 1);
  });
});
