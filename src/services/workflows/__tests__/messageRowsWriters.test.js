// One change of a row reaches every place that row lives.
//
// A message can sit in `emails`, `localEmails`, `sentEmails`, the derived list,
// the open reader and its thread, the body cache, a search's rows (the list and
// both pools) and a Notes card. Each writer used to patch a hand-picked subset
// of those, and the rest kept showing the old value: a star from the list never
// reached the Notes card, a tracker verdict never reached the merged Sent copy
// or the open thread. Every writer of a row's flags or verdicts goes through
// messageRows' patchEverywhere, so each one reaches every container.
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
      trackerAlerts: {},
      setTrackerAlert: () => {},
      setLinkAlert: () => {},
    }),
  },
}));

vi.mock('../../safeStorage', () => ({
  safeStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}));

const { useMailStore } = await import('../../../stores/mailStore');
const { useSearchStore } = await import('../../../stores/searchStore');
const { useNotesStore } = await import('../../../stores/notesStore');
const { invalidateChatAndThreadCaches } = await import('../../../stores/slices/messageListSlice');
const { applySeenLocally, applyFlagToTargets } = await import('../messageMutations');
const { recordTrackerSummary } = await import('../../trackerVerdicts');

const ACCOUNT = { id: 'a1', email: 'a1@x' };
const KEY = 'a1-INBOX-7';

const msg = (uid, extra = {}) => ({
  uid, messageId: `m${uid}@mock`, subject: `m${uid}`, flags: [], source: 'server',
  _accountId: 'a1', _mailbox: 'INBOX',
  from: { address: 'them@x' }, date: '2026-09-01T10:00:00Z', ...extra,
});

// Message 7 in every container there is, and message 8 beside it in each of the
// ones that hold more than one row: 8 must come out of every change untouched.
function seedEverywhere() {
  const emails = [msg(7), msg(8)];
  useMailStore.setState({
    accounts: [ACCOUNT],
    activeAccountId: 'a1',
    activeMailbox: 'INBOX',
    unifiedInbox: false,
    unifiedFolder: null,
    mailboxScope: null,
    mailboxes: [],
    viewMode: 'all',
    emails,
    sentEmails: [msg(7)],
    localEmails: [msg(7)],
    savedEmailIds: new Set(),
    archivedEmailIds: new Set(),
    serverUids: serverUids([7, 8], { complete: false }),
    deleteTombstones: new Set(),
    totalEmails: 2,
    selectedEmailIds: new Set(),
    selectedEmail: msg(7),
    selectedEmailId: 7,
    selectedThread: { threadId: 't', emails: [msg(7), msg(8)] },
    emailCache: new Map([[KEY, { email: msg(7), timestamp: 1, size: 0 }]]),
    loadEmails: vi.fn(),
    undo: null,
    error: null,
    _sortedEmailsFingerprint: '',
  });
  useSearchStore.setState({
    searchActive: false,
    searchResults: [msg(7), msg(8)],
    indexedSearchRows: { a1: [msg(7), msg(8)] },
    searchRowsOutsideIndex: [msg(7), msg(8)],
    excludedSearchCopies: new Set(),
  });
  useNotesStore.setState({
    cards: [{ key: 'k', starred: false, copies: [{ accountId: 'a1', mailbox: 'INBOX', uid: 7, flags: [] }] }],
  });
  invalidateChatAndThreadCaches();
  useMailStore.getState().updateSortedEmails();
}

// [container, the row of message 7 in it, the row of message 8 (if it holds one)]
function holders() {
  const mail = useMailStore.getState();
  const search = useSearchStore.getState();
  const of = (rows, uid) => rows.find(r => r.uid === uid);
  return [
    ['emails', of(mail.emails, 7), of(mail.emails, 8)],
    ['sortedEmails', of(mail.sortedEmails, 7), of(mail.sortedEmails, 8)],
    ['sentEmails', of(mail.sentEmails, 7)],
    ['localEmails', of(mail.localEmails, 7)],
    ['selectedEmail', mail.selectedEmail],
    ['selectedThread', of(mail.selectedThread.emails, 7), of(mail.selectedThread.emails, 8)],
    ['emailCache', mail.emailCache.get(KEY).email],
    ['searchResults', of(search.searchResults, 7), of(search.searchResults, 8)],
    ['indexedSearchRows', of(search.indexedSearchRows.a1, 7), of(search.indexedSearchRows.a1, 8)],
    ['searchRowsOutsideIndex', of(search.searchRowsOutsideIndex, 7), of(search.searchRowsOutsideIndex, 8)],
    ['notes card copy', useNotesStore.getState().cards[0].copies[0]],
  ];
}

const writers = [
  ['applySeenLocally', '\\Seen', 'flags',
    () => applySeenLocally(useMailStore, { accountId: 'a1', mailbox: 'INBOX', uid: 7, read: true })],
  ['applyFlagToTargets', '\\Flagged', 'flags',
    () => applyFlagToTargets([{ account: ACCOUNT, accountId: 'a1', mailbox: 'INBOX', uid: 7 }], '\\Flagged', true)],
  ['recordTrackerSummary', { count: 1, vendors: ['Mailchimp'] }, '_trackerInfo',
    () => recordTrackerSummary(KEY, { count: 1, vendors: ['Mailchimp'] })],
];

beforeEach(() => {
  vi.clearAllMocks();
  netOnline = true;
  mockUpdateEmailFlags.mockResolvedValue({ success: true, written: [] });
  seedEverywhere();
});

describe('a writer reaches every container a message is in', () => {
  it.each(writers)('%s', async (_name, expected, field, write) => {
    await write();

    const missed = holders()
      .filter(([, row]) => (field === 'flags' ? !row.flags?.includes(expected) : row._trackerInfo?.count !== expected.count))
      .map(([container]) => container);
    expect(missed).toEqual([]);

    // Nor does it change the message beside it.
    for (const [container, , other] of holders()) {
      if (!other) continue;
      expect([container, other.flags, other._trackerInfo]).toEqual([container, [], undefined]);
    }
  });
});

describe('applySeenLocally in a view spanning accounts', () => {
  // The auto mark-read on open is the main caller. The body cache entry and a
  // Notes copy name their message by key / by `accountId`, not by the `_accountId`
  // a list row carries: the account guard must not read them as "another account's".
  it('reaches the cached body and the Notes copy, and not another account\'s row', () => {
    useMailStore.setState({
      activeMailbox: 'UNIFIED',
      emails: [msg(7), msg(7, { _accountId: 'a2' })],
      sentEmails: [], localEmails: [], selectedEmail: null, selectedThread: null,
      emailCache: new Map([[KEY, { email: { uid: 7, flags: [] }, timestamp: 1, size: 0 }]]),
    });

    applySeenLocally(useMailStore, { accountId: 'a1', mailbox: 'INBOX', uid: 7, read: true, isUnified: true });

    const mail = useMailStore.getState();
    expect(mail.emails[0].flags).toContain('\\Seen');
    expect(mail.emails[1].flags).toEqual([]);
    expect(mail.emailCache.get(KEY).email.flags).toContain('\\Seen');
    expect(useNotesStore.getState().cards[0].copies[0].flags).toContain('\\Seen');
  });
});
