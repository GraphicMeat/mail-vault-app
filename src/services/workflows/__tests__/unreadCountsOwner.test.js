// One owner for the sidebar's unread badge (src/stores/unreadCounts.js).
//
// The badge used to be written from four places that disagreed: a recount of
// whatever rows the list held (a window onto a folder, or the rows of ANOTHER
// folder in All Inboxes Sent or a branch listing) and a +-1 shift. The rule
// now: INBOX only, and only a complete list recounts; otherwise a message that
// leaves or changes state moves the badge by one.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { serverUids } from '../../../stores/slices/serverUids';

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
  useSettingsStore: {
    getState: () => ({
      cacheLimitMB: 128,
      hiddenAccounts: {},
      getLastMailbox: () => 'INBOX',
      emailListStyle: 'default',
      linkAlerts: {},
      linkSafetyEnabled: false,
      unreadPerAccount,
      setUnreadPerAccount: (m) => { for (const k of Object.keys(unreadPerAccount)) delete unreadPerAccount[k]; Object.assign(unreadPerAccount, m); },
      setUnreadForAccount: (...a) => mockSetUnreadForAccount(...a),
    }),
  },
}));

vi.mock('../../safeStorage', () => ({
  safeStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}));


const { useMailStore } = await import('../../../stores/mailStore');
const { invalidateChatAndThreadCaches } = await import('../../../stores/slices/messageListSlice');
const { applyFlagToTargets, applyServerRemoval, moveEmails, deleteEmailFromServer } = await import('../messageMutations');
const { recountInbox } = await import('../../../stores/unreadCounts');
const { useAutoTagStore } = await import('../../../stores/autoTagStore');
const { useTagStore, tagRowKey } = await import('../../../stores/tagStore');

const A1 = { id: 'a1', email: 'a1@x' };
const A2 = { id: 'a2', email: 'a2@x' };

const row = (uid, extra = {}) => ({
  uid, messageId: `m${uid}@mock`, subject: `m${uid}`, flags: [], source: 'server',
  from: { address: 'them@x' }, date: '2026-09-01T10:00:00Z', ...extra,
});

function prime({ emails, total = emails.length, activeMailbox = 'INBOX', unifiedFolder = null, mailboxScope = null, badge = { a1: 7, a2: 5 } }) {
  useMailStore.setState({
    accounts: [A1, A2],
    activeAccountId: 'a1',
    activeMailbox,
    unifiedInbox: activeMailbox === 'UNIFIED',
    unifiedFolder,
    mailboxScope,
    mailboxes: [],
    viewMode: 'all',
    emails,
    sentEmails: [],
    localEmails: [],
    savedEmailIds: new Set(),
    archivedEmailIds: new Set(),
    serverUids: serverUids(emails.map(e => e.uid), { complete: false }),
    deleteTombstones: new Set(),
    totalEmails: total,
    selectedEmailIds: new Set(),
    selectedEmail: null,
    selectedEmailId: null,
    selectedThread: null,
    emailCache: new Map(),
    loadEmails: vi.fn(),
    undo: null,
    error: null,
    _sortedEmailsFingerprint: '',
  });
  invalidateChatAndThreadCaches();
  useMailStore.getState().updateSortedEmails();
  // What the settings store held before the list was painted: priming derives
  // the list, which must not be what sets it.
  for (const id of Object.keys(unreadPerAccount)) delete unreadPerAccount[id];
  Object.assign(unreadPerAccount, badge);
}

const target = (accountId, mailbox, uid) => ({ account: accountId === 'a1' ? A1 : A2, accountId, mailbox, uid });
const inAll = (accountId, mailbox, uid, extra = {}) => row(uid, { _accountId: accountId, _mailbox: mailbox, ...extra });

beforeEach(() => {
  vi.clearAllMocks();
  netOnline = true;
  mockMoveEmails.mockResolvedValue({ success: true, moved: 1, newUids: [41] });
  mockUpdateEmailFlags.mockResolvedValue({ success: true, written: [] });
  mockFindMessageId.mockResolvedValue({ found: [], searched: 1, failed: 0, complete: true });
});

describe('mark read and the INBOX badge', () => {
  it('a Sent message marked read in All Inboxes leaves that account\'s INBOX badge alone', async () => {
    prime({ activeMailbox: 'UNIFIED', unifiedFolder: 'Sent', emails: [inAll('a1', 'Sent', 40), inAll('a2', 'Sent', 41)] });

    await applyFlagToTargets([target('a1', 'Sent', 40)], '\\Seen', true);

    expect(unreadPerAccount).toEqual({ a1: 7, a2: 5 });
  });

  it('an INBOX message marked read in All Inboxes moves its own account\'s badge by one, not to the window\'s count', async () => {
    // The list holds 2 of a1's 7 unread: a recount from it would say 1.
    prime({ activeMailbox: 'UNIFIED', unifiedFolder: 'INBOX', emails: [inAll('a1', 'INBOX', 1), inAll('a1', 'INBOX', 2), inAll('a2', 'INBOX', 3)] });

    await applyFlagToTargets([target('a1', 'INBOX', 1)], '\\Seen', true);

    expect(unreadPerAccount).toEqual({ a1: 6, a2: 5 });
  });

  it('marking unread moves it back up by one', async () => {
    prime({ activeMailbox: 'UNIFIED', unifiedFolder: 'INBOX', emails: [inAll('a1', 'INBOX', 1, { flags: ['\\Seen'] }), inAll('a2', 'INBOX', 3)] });

    await applyFlagToTargets([target('a1', 'INBOX', 1)], '\\Seen', false);

    expect(unreadPerAccount).toEqual({ a1: 8, a2: 5 });
  });

  it('a message of a branch listing leaves the INBOX badge alone', async () => {
    prime({
      activeMailbox: 'Projects',
      mailboxScope: { root: 'Projects', paths: ['Projects', 'Projects/Alpha'] },
      emails: [inAll('a1', 'Projects/Alpha', 34), inAll('a1', 'Projects', 35)],
    });

    await applyFlagToTargets([target('a1', 'Projects/Alpha', 34)], '\\Seen', true);

    expect(unreadPerAccount).toEqual({ a1: 7, a2: 5 });
  });

  it('a list that is only a window onto the INBOX does not overwrite the badge with its own count', async () => {
    prime({ emails: [row(1), row(2)], total: 500 });

    await applyFlagToTargets([target('a1', 'INBOX', 1)], '\\Seen', true);

    expect(unreadPerAccount.a1).toBe(6);
  });

  it('a list that is the whole INBOX still recounts, from its rows', async () => {
    prime({ emails: [row(1), row(2)], badge: { a1: 9 } }); // stale

    await applyFlagToTargets([target('a1', 'INBOX', 1)], '\\Seen', true);

    expect(unreadPerAccount.a1).toBe(1);
  });

  it('a message no row shows is not counted: its old read state is unknown', async () => {
    prime({ emails: [row(1)], total: 500 });

    await applyFlagToTargets([target('a1', 'INBOX', 99)], '\\Seen', true);

    expect(unreadPerAccount.a1).toBe(7);
  });
});

describe('other ways an unread message leaves a partial INBOX list', () => {
  it('a move out shifts the badge by one', async () => {
    prime({ emails: [row(1), row(2, { flags: ['\\Seen'] })], total: 500 });

    await moveEmails([1, 2], 'Archive');

    // one unread of the two moved
    expect(unreadPerAccount.a1).toBe(6);
  });

  it('a removal the server reported shifts it by one', async () => {
    prime({ emails: [row(1), row(2)], total: 500 });

    await applyServerRemoval(1, { accountId: 'a1', mailbox: 'INBOX', skipRefresh: true });

    expect(unreadPerAccount.a1).toBe(6);
  });

  it('a removal a delete already counted is not counted twice', async () => {
    prime({ emails: [row(1), row(2)], total: 500 });

    await applyServerRemoval(1, { accountId: 'a1', mailbox: 'INBOX', skipRefresh: true, counted: true });

    expect(unreadPerAccount.a1).toBe(7);
  });
});

// A delete the server refused keeps its row off the list (its tombstone) and its
// entry in the journal, while the server, and the cache every sync repaints the
// list from, still hold the message unread. The badge counted it: "1" beside
// the account, "No unread messages" in its list. The badge counts by the list's
// own rule set (rowVisibility), whichever writer recounts.
describe('a message the list holds back is not on the badge', () => {
  it('a delete still owed to the server, after a reload brought its row back from the cache', () => {
    prime({ emails: [row(1, { flags: ['\\Seen'] })], badge: { a1: 0 } });

    useMailStore.setState({ deleteTombstones: new Set(['a1|INBOX|368']), emails: [row(1, { flags: ['\\Seen'] }), row(368)], totalEmails: 2 });
    useMailStore.getState().updateSortedEmails();

    expect(useMailStore.getState().sortedEmails.map(e => e.uid)).toEqual([1]);
    expect(unreadPerAccount.a1).toBe(0);
  });

  it('counted from the cache of an account the list is not showing', () => {
    prime({ emails: [row(1, { flags: ['\\Seen'] })], badge: { a1: 0, a2: 1 } });
    useMailStore.setState({ deleteTombstones: new Set(['a2|INBOX|368']) });

    expect(recountInbox('a2', { emails: [row(368), row(5, { flags: ['\\Seen'] })], totalEmails: 2 })).toBe(true);

    expect(unreadPerAccount.a2).toBe(0);
  });

  it('a message flagged \\Deleted on the server and not yet expunged', () => {
    prime({ emails: [row(1, { flags: ['\\Seen'] })], badge: { a1: 0, a2: 1 } });

    recountInbox('a2', { emails: [row(9, { flags: ['\\Deleted'] }), row(10)], totalEmails: 2 });

    expect(unreadPerAccount.a2).toBe(1);
  });

  it('a message an auto-tag rule keeps off the Inbox', () => {
    prime({ emails: [row(1, { flags: ['\\Seen'] })], badge: { a1: 0, a2: 2 } });
    useAutoTagStore.setState({ rules: [{ id: 'r', tagId: 't1', enabled: true, inboxAction: 'hide' }] });
    useTagStore.setState({ byRow: { [tagRowKey('a2', 'INBOX', 7)]: ['t1'] } });
    try {
      recountInbox('a2', { emails: [row(7), row(8)], totalEmails: 2 });
    } finally {
      useAutoTagStore.setState({ rules: [] });
      useTagStore.setState({ byRow: {} });
    }

    expect(unreadPerAccount.a2).toBe(1);
  });

  // A partial INBOX never recounts, so the shift is all the badge hears: it
  // moves for a message only as a recount would count it.
  it('marking unread a message an auto-tag rule keeps off a partial Inbox leaves the badge alone', async () => {
    useAutoTagStore.setState({ rules: [{ id: 'r', tagId: 't1', enabled: true, inboxAction: 'hide' }] });
    useTagStore.setState({ byRow: { [tagRowKey('a1', 'INBOX', 7)]: ['t1'], [tagRowKey('a1', 'INBOX', 8)]: [] } });
    try {
      prime({ emails: [row(7, { flags: ['\\Seen'] }), row(8)], total: 500 });
      await applyFlagToTargets([target('a1', 'INBOX', 7)], '\\Seen', false);
    } finally {
      useAutoTagStore.setState({ rules: [] });
      useTagStore.setState({ byRow: {} });
    }

    expect(unreadPerAccount.a1).toBe(7);
  });

  // The delete lays its tombstone before it shifts: the message leaving is
  // exactly what the shift counts, so the tombstone must not hide it from it.
  it('a delete from a partial Inbox still takes its unread message off the badge', async () => {
    netOnline = false;
    prime({ emails: [row(1), row(2)], total: 500 });

    await deleteEmailFromServer(1);

    expect(useMailStore.getState().deleteTombstones.has('a1|INBOX|1')).toBe(true);
    expect(unreadPerAccount.a1).toBe(6);
  });

  it('still counts every unread message the list shows', () => {
    prime({ emails: [row(1, { flags: ['\\Seen'] })], badge: { a1: 0, a2: 0 } });

    recountInbox('a2', { emails: [row(7), row(8), row(9, { flags: ['\\Seen'] })], totalEmails: 3 });

    expect(unreadPerAccount.a2).toBe(2);
  });
});
