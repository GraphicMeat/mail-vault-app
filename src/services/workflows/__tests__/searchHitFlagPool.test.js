// A search hit that no list holds, acted on in bulk.
//
// A hit is in searchStore's `searchResults` and in none of the lists a mutation
// reads its rows from. Which rows a workflow may resolve a key against was
// decided per workflow, so two of them — the flag core's read of the flags the
// rows carry NOW (the undo covers only what the call changed), and the move's
// map of the rows it moves (the undo finds the copies by their Message-ID) —
// never saw a hit, while the workflows beside them did.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { serverUids } from '../../../stores/slices/serverUids';

vi.mock('../../mailSearch.js', () => ({
  startMailSearch: vi.fn(),
  cancelMailSearch: vi.fn().mockResolvedValue(undefined),
}));

if (!globalThis.window) {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
} else {
  globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
}

const mockMoveEmails = vi.fn();
const mockDeleteEmail = vi.fn();
const mockUpdateEmailFlags = vi.fn().mockResolvedValue({ success: true, written: [] });
const mockFindMessageId = vi.fn();
const mockGetLocalIndexEntry = vi.fn();
const mockAppendLocalIndex = vi.fn().mockResolvedValue(undefined);
const mockQueueOp = vi.fn().mockResolvedValue(1);
const mockClearOps = vi.fn().mockResolvedValue(undefined);
const mockSaveEmailHeaders = vi.fn().mockResolvedValue(undefined);
const mockRefreshCurrentView = vi.fn().mockResolvedValue(undefined);
const mockVaultRebindUids = vi.fn().mockResolvedValue({ rebound: [] });
// The server holds the restored message under its new uid only: the retired
// one answers "gone", as uid_still_present proves it in the app.
const gone = () => Object.assign(new Error('gone'), { messageGone: true });
const mockFetchEmailLight = vi.fn();
// The sidebar badge, as the settings store keeps it: absolute per account.
const unreadPerAccount = {};
const mockSetUnreadForAccount = vi.fn((id, n) => { unreadPerAccount[id] = n; });

let netOnline = true;

vi.mock('../../db', () => ({
  getLocalEmailLight: vi.fn().mockResolvedValue(null),
  getEmailHeadersMeta: vi.fn().mockResolvedValue(null),
  getEmailHeadersPartial: vi.fn().mockResolvedValue({ emails: [], totalEmails: 0 }),
  getVaultUidSets: vi.fn().mockResolvedValue({ saved: new Set(), archived: new Set() }),
  getCachedMailboxEntry: vi.fn().mockResolvedValue(null),
  getLocalEmails: vi.fn().mockResolvedValue([]),
  readLocalEmailIndex: vi.fn().mockResolvedValue(null),
  getLocalIndexEntry: (...a) => mockGetLocalIndexEntry(...a),
  getArchivedEmails: vi.fn().mockResolvedValue([]),
  deleteLocalEmail: vi.fn().mockResolvedValue(undefined),
  saveEmailHeaders: (...a) => mockSaveEmailHeaders(...a),
  queueOp: (...a) => mockQueueOp(...a),
  clearOps: (...a) => mockClearOps(...a),
  initDB: vi.fn().mockResolvedValue(undefined),
  getAccounts: vi.fn().mockResolvedValue([]),
  ensureAccountsInFile: vi.fn().mockResolvedValue(undefined),
  saveMailboxes: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../api', () => ({
  vaultApplyFlags: vi.fn().mockResolvedValue({ renamed: 0, mirrored: 0, index_patched: 0, sidecars_patched: 0 }),
  fetchEmailLight: (...a) => mockFetchEmailLight(...a),
  updateEmailFlags: (...a) => mockUpdateEmailFlags(...a),
  graphSetRead: vi.fn().mockResolvedValue(undefined),
  graphSetFlagged: vi.fn().mockResolvedValue(undefined),
  graphMoveEmails: vi.fn().mockResolvedValue(undefined),
  graphDeleteMessage: vi.fn().mockResolvedValue(undefined),
  deleteEmail: (...a) => mockDeleteEmail(...a),
  moveEmails: (...a) => mockMoveEmails(...a),
  findMessageId: (...a) => mockFindMessageId(...a),
  appendLocalIndex: (...a) => mockAppendLocalIndex(...a),
  removeFromLocalIndex: vi.fn().mockResolvedValue(undefined),
  vaultRebindUids: (...a) => mockVaultRebindUids(...a),
}));

// The daemon's deleted-mail bin.
const mockDaemonCall = vi.fn();
vi.mock('../../daemonClient', async (importOriginal) => ({
  ...(await importOriginal()),
  daemonCall: (...a) => mockDaemonCall(...a),
}));

// The unified view's reload verb. Real, it refetches every account — here it
// only has to prove which reload the undo chose.
vi.mock('../refreshAccounts', () => ({
  refreshCurrentView: (...a) => mockRefreshCurrentView(...a),
  refreshAllAccounts: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../authUtils', () => ({
  hasValidCredentials: () => true,
  ensureFreshToken: (a) => Promise.resolve(a),
  resolveServerAccount: (id, account) => Promise.resolve({ ok: true, account }),
}));

vi.mock('../../attachmentUtils', () => ({ hasRealAttachments: () => false, hydrateInlineImages: async (e) => e }));

vi.mock('../../graphConfig', () => ({
  isGraphAccount: (a) => a?.oauth2Transport === 'graph',
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
      unreadPerAccount,
      setUnreadForAccount: (...a) => mockSetUnreadForAccount(...a),
      addSearchToHistory: () => {},
    }),
  },
}));

vi.mock('../../safeStorage', () => ({
  safeStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}));

const { useMailStore } = await import('../../../stores/mailStore');
const { useSearchStore } = await import('../../../stores/searchStore');
const { invalidateChatAndThreadCaches } = await import('../../../stores/slices/messageListSlice');

const ACCOUNT = { id: 'a1', email: 'a1@x' };

// Hits in ARCHIVE while the view is INBOX: a full selection key, and a row
// no loaded list holds.
const hit = (uid, extra = {}) => ({
  uid, messageId: `m${uid}@mock`, subject: `m${uid}`, flags: [], source: 'local',
  _accountId: 'a1', _mailbox: 'Archive',
  from: { address: 'them@x' }, date: '2026-09-01T10:00:00Z', ...extra,
});
const keyOf = (uid) => `a1:Archive:${uid}`;

function primeSearch(rows, selected = []) {
  useMailStore.setState({
    accounts: [ACCOUNT],
    activeAccountId: ACCOUNT.id,
    activeMailbox: 'INBOX',
    unifiedInbox: false,
    unifiedFolder: null,
    mailboxScope: null,
    mailboxes: [],
    viewMode: 'all',
    emails: [],
    sentEmails: [],
    localEmails: [],
    savedEmailIds: new Set(),
    archivedEmailIds: new Set(),
    serverUids: serverUids([], { complete: false }),
    deleteTombstones: new Set(),
    totalEmails: 0,
    selectedEmailIds: new Set(selected),
    selectedEmail: null,
    selectedEmailId: null,
    selectedThread: null,
    emailCache: new Map(),
    loadEmails: vi.fn(),
    undo: null,
    error: null,
    _sortedEmailsFingerprint: '',
  });
  // Not `searchActive`: the undo re-runs an active query, which is no part of this.
  useSearchStore.setState({
    searchActive: false,
    searchResults: rows,
    indexedSearchRows: {},
    searchRowsOutsideIndex: rows,
    excludedSearchCopies: new Set(),
  });
  invalidateChatAndThreadCaches();
  useMailStore.getState().updateSortedEmails();
}

const searchRow = (uid) => useSearchStore.getState().searchResults.find(r => r.uid === uid);

beforeEach(() => {
  vi.clearAllMocks();
  netOnline = true;
  mockMoveEmails.mockResolvedValue({ success: true, moved: 1, newUids: null });
  mockFindMessageId.mockResolvedValue({ found: [], searched: 1, failed: 0, complete: true });
  mockUpdateEmailFlags.mockResolvedValue({ success: true, written: [] });
  for (const id of Object.keys(unreadPerAccount)) delete unreadPerAccount[id];
});

describe('a bulk flag change over search hits', () => {
  const ALREADY_READ = [2, 5, 9];
  const ALL = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const CHANGED = ALL.filter(uid => !ALREADY_READ.includes(uid));

  it('offers back exactly the messages it changed: 10 marked read, 3 already read, undo restores the 7', async () => {
    primeSearch(ALL.map(uid => hit(uid, ALREADY_READ.includes(uid) ? { flags: ['\\Seen'] } : {})), ALL.map(keyOf));

    await useMailStore.getState().markSelectedAsRead();

    expect(useMailStore.getState().undo).toMatchObject({
      labelKey: 'undo.markedRead', labelParams: { count: 7 }, canUndo: true,
    });

    mockUpdateEmailFlags.mockClear();
    await useMailStore.getState().runUndo();

    // Only the seven this action moved go back to unread on the server ...
    expect(mockUpdateEmailFlags.mock.calls.map(c => c[1]).sort((a, b) => a - b)).toEqual(CHANGED);
    for (const call of mockUpdateEmailFlags.mock.calls) {
      expect(call.slice(2)).toEqual([['\\Seen'], 'remove', 'Archive']);
    }
    // ... and on screen the three the user had already read are still read.
    await vi.waitFor(() => expect(CHANGED.every(uid => !searchRow(uid).flags.includes('\\Seen'))).toBe(true));
    for (const uid of ALREADY_READ) expect(searchRow(uid).flags).toContain('\\Seen');
  });

  it('offers nothing when every hit was already in the state asked for', async () => {
    primeSearch([hit(1, { flags: ['\\Seen'] }), hit(2, { flags: ['\\Seen'] })], [keyOf(1), keyOf(2)]);

    await useMailStore.getState().markSelectedAsRead();

    expect(useMailStore.getState().undo).toBeNull();
  });
});

describe('a move of search hits', () => {
  it('undoes by Message-ID on a server with no UIDPLUS, because the hit is a row the move knows', async () => {
    mockFindMessageId.mockResolvedValue({
      found: [{ mailbox: 'Trash', uid: 9 }, { mailbox: 'Archive', uid: 1 }],
      searched: 2, failed: 0, complete: true,
    });
    primeSearch([hit(7)], [keyOf(7)]);

    await useMailStore.getState().moveEmails([keyOf(7)], 'Trash');
    expect(useMailStore.getState().undo.labelKey).toBe('undo.moved');

    mockMoveEmails.mockClear();
    await expect(useMailStore.getState().runUndo()).resolves.toBe(true);

    // The Message-ID came off the hit; without the row it is null and the
    // undo has nothing to look the copy up by.
    expect(mockFindMessageId).toHaveBeenCalledWith(ACCOUNT, 'm7@mock', { stopOnFirst: false });
    expect(mockMoveEmails).toHaveBeenCalledWith(ACCOUNT, [9], 'Trash', 'Archive');
    expect(useMailStore.getState().error).toBeNull();
  });
});
