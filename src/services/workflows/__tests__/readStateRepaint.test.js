// Read state reaching every row that shows the message (reported against
// v2.16.0):
//
// 1. "mark as read timer does mark message as read on timer complete, but
//    does not update the cell in mail list". The delayed mark wrote \Seen to
//    the server and then re-checked the reader before painting: anything that
//    moved the selection during the round trip (the next message, the close
//    button, a thread) left the server read and the row bold.
// 2. A saved View's rows live in searchStore, and one from another folder or
//    account was opened under the ACTIVE account (a single folder's list), so
//    the write and the repaint both aimed at a message the View never showed.
// 3. Marking the open message unread from the reader must leave it open, on
//    every surface, and must not be re-marked by the countdown it cancelled.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { selectionKey, rowKey, spansMailboxes } from '../../../stores/slices/unifiedHelpers';
import { serverUids } from '../../../stores/slices/serverUids';
import { filterUnread } from '../../../utils/emailParser';

if (!globalThis.window) {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
} else {
  globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
}

const mockUpdateEmailFlags = vi.fn().mockResolvedValue(undefined);
const mockFetchEmailLight = vi.fn();
const mockGetLocalEmailLight = vi.fn().mockResolvedValue(null);
const mockSearch = vi.hoisted(() => ({
  start: vi.fn(),
  cancel: vi.fn().mockResolvedValue(undefined),
}));

let markAsReadMode = 'delay';

vi.mock('../../mailSearch.js', () => ({
  startMailSearch: (...args) => mockSearch.start(...args),
  cancelMailSearch: (...args) => mockSearch.cancel(...args),
}));

vi.mock('../../db', () => ({
  getLocalEmailLight: (...a) => mockGetLocalEmailLight(...a),
  getEmailHeadersMeta: vi.fn().mockResolvedValue(null),
  getEmailHeadersPartial: vi.fn().mockResolvedValue({ emails: [], totalEmails: 0 }),
  getCachedMailboxes: vi.fn().mockResolvedValue([{ path: 'INBOX', name: 'INBOX' }]),
  getVaultUidSets: vi.fn().mockResolvedValue({ saved: new Set(), archived: new Set() }),
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
  queueOp: vi.fn().mockResolvedValue(1),
  clearOps: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../api', () => ({
  vaultApplyFlags: vi.fn().mockResolvedValue({ renamed: 0, mirrored: 0, index_patched: 0, sidecars_patched: 0 }),
  fetchEmailLight: (...a) => mockFetchEmailLight(...a),
  updateEmailFlags: (...a) => mockUpdateEmailFlags(...a),
  graphSetRead: vi.fn().mockResolvedValue(undefined),
  graphGetMessage: vi.fn().mockResolvedValue(null),
  graphListFolders: vi.fn().mockResolvedValue([]),
  graphListMessages: vi.fn().mockResolvedValue({ headers: [], graphMessageIds: [] }),
  graphCacheMime: vi.fn().mockResolvedValue(undefined),
  deleteEmail: vi.fn().mockResolvedValue(undefined),
  moveEmails: vi.fn().mockResolvedValue(undefined),
  removeFromLocalIndex: vi.fn().mockResolvedValue(undefined),
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
  effectiveSearchMailboxConcurrency: () => 1,
  useSettingsStore: {
    getState: () => ({
      cacheLimitMB: 128,
      hiddenAccounts: {},
      getLastMailbox: () => 'INBOX',
      emailListStyle: 'default',
      linkAlerts: {},
      linkSafetyEnabled: false,
      get markAsReadMode() { return markAsReadMode; },
      markAsReadDelay: 3,
      setUnreadForAccount: () => {},
      addSearchToHistory: () => {},
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
const { useSearchStore } = await import('../../../stores/searchStore');
const { invalidateChatAndThreadCaches } = await import('../../../stores/slices/messageListSlice');
const { applyFlagToKeys } = await import('../messageMutations');

const ACCT_A = { id: 'acct-a', email: 'a@mock.test', imapHost: 'h', password: 'x' };
const ACCT_B = { id: 'acct-b', email: 'b@mock.test', imapHost: 'h', password: 'x' };

const row = (uid, extra = {}) => ({
  uid, messageId: `<${uid}@mock>`, subject: `Message ${uid}`, flags: [], source: 'server',
  from: { address: 'them@mock.test' }, date: `2026-09-0${uid}T10:00:00Z`, ...extra,
});
const bodyOf = (r) => ({ uid: r.uid, messageId: r.messageId, subject: r.subject, flags: r.flags, html: '<p>b</p>', text: 'b' });

function primeFolder(emails = [row(1), row(2)]) {
  useMailStore.setState({
    accounts: [ACCT_A, ACCT_B],
    activeAccountId: ACCT_A.id,
    activeMailbox: 'INBOX',
    unifiedInbox: false,
    mailboxScope: null,
    mailboxes: [{ path: 'INBOX', name: 'INBOX', children: [] }, { path: 'Work', name: 'Work', children: [] }],
    viewMode: 'all',
    emails,
    sentEmails: [],
    localEmails: [],
    savedEmailIds: new Set(),
    archivedEmailIds: new Set(),
    serverUids: serverUids(new Set(emails.map(e => e.uid)), { complete: false }),
    deleteTombstones: new Set(),
    totalEmails: emails.length,
    selectedEmailIds: new Set(),
    selectedEmail: null,
    selectedEmailId: null,
    selectedThread: null,
    loadingEmail: false,
    error: null,
    emailCache: new Map(),
    unreadOnly: false,
    unreadKeep: new Set(),
    loadEmails: vi.fn(),
    _sortedEmailsFingerprint: '',
  });
  invalidateChatAndThreadCaches();
  useMailStore.getState().updateSortedEmails();
}

// What EmailRow's click sends, and what the explorer's sends.
const clickRow = (r) => useMailStore.getState().selectEmail(
  rowKey(r, spansMailboxes(useMailStore.getState())), r.source, r._mailbox, null, r);
const clickExplorerRow = (r) => useMailStore.getState().selectEmail(
  selectionKey(r, useMailStore.getState()), r.source, r._mailbox, null, r);

const listSeen = (uid) => useMailStore.getState().emails.find(e => e.uid === uid)?.flags?.includes('\\Seen');
const searchRow = (accountId, mailbox, uid) => useSearchStore.getState().searchResults
  .find(r => r._accountId === accountId && r._mailbox === mailbox && r.uid === uid);
const readerKey = () => selectionKey(useMailStore.getState().selectedEmail, useMailStore.getState());

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  markAsReadMode = 'delay';
  mockGetLocalEmailLight.mockResolvedValue(null);
  mockUpdateEmailFlags.mockResolvedValue(undefined);
  primeFolder();
  mockFetchEmailLight.mockImplementation(async (account, uid) => bodyOf(row(uid)));
  useSearchStore.setState({ searchActive: false, searchResults: [], searchQuery: '' });
});
afterEach(() => vi.useRealTimers());

describe('delay mode: a server write that landed always repaints the row', () => {
  // Deferred server write: the timer fires, and the user acts before it answers.
  const holdServerWrite = () => {
    let release;
    mockUpdateEmailFlags.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    return () => release();
  };

  it('paints the row read when the user opened the next message during the write', async () => {
    const release = holdServerWrite();
    await clickRow(row(1));
    await vi.advanceTimersByTimeAsync(3000);
    expect(mockUpdateEmailFlags).toHaveBeenCalledWith(ACCT_A, 1, ['\\Seen'], 'add', 'INBOX');

    await clickRow(row(2));
    release();

    await vi.waitFor(() => expect(listSeen(1)).toBe(true));
    // The reader belongs to message 2 now: its copy is not message 1's.
    expect(useMailStore.getState().selectedEmailId).toBe(2);
    expect(useMailStore.getState().selectedEmail?.flags || []).not.toContain('\\Seen');
    expect(listSeen(2)).toBe(false);
  });

  it('paints the row read when the reader was closed during the write, and keeps it closed', async () => {
    const release = holdServerWrite();
    await clickRow(row(1));
    await vi.advanceTimersByTimeAsync(3000);

    useMailStore.getState().closeEmail();
    release();

    await vi.waitFor(() => expect(listSeen(1)).toBe(true));
    expect(useMailStore.getState().selectedEmail).toBeNull();
    expect(useMailStore.getState().selectedEmailId).toBeNull();
  });

  it('paints the open thread when the user switched to one holding the message', async () => {
    const release = holdServerWrite();
    await clickRow(row(1));
    await vi.advanceTimersByTimeAsync(3000);

    const member = useMailStore.getState().emails.find(e => e.uid === 1);
    useMailStore.getState().selectThread({ threadId: 't1', lastEmail: member, emails: [member], messageCount: 1 });
    release();

    await vi.waitFor(() => expect(listSeen(1)).toBe(true));
    expect(useMailStore.getState().selectedThread.emails[0].flags).toContain('\\Seen');
  });

  it('never paints a same-uid row of the account the user switched to', async () => {
    const release = holdServerWrite();
    await clickRow(row(1));
    await vi.advanceTimersByTimeAsync(3000);

    // Account B's INBOX, bare rows as a single folder's list holds them.
    useMailStore.setState({
      activeAccountId: ACCT_B.id, activeMailbox: 'INBOX',
      emails: [row(1, { subject: 'B one' })], selectedEmail: null, selectedEmailId: null,
    });
    release();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    expect(useMailStore.getState().emails[0].subject).toBe('B one');
    expect(listSeen(1)).toBe(false);
  });

  it('paints the View row read when the selection moved during the write', async () => {
    const hit = row(5, { _accountId: ACCT_A.id, _mailbox: 'Work' });
    useSearchStore.getState().showRows([hit, row(6, { _accountId: ACCT_A.id, _mailbox: 'Work' })]);
    const release = holdServerWrite();

    await clickRow(searchRow(ACCT_A.id, 'Work', 5));
    await vi.advanceTimersByTimeAsync(3000);
    expect(mockUpdateEmailFlags).toHaveBeenCalledWith(ACCT_A, 5, ['\\Seen'], 'add', 'Work');

    await clickRow(searchRow(ACCT_A.id, 'Work', 6));
    release();

    await vi.waitFor(() => expect(searchRow(ACCT_A.id, 'Work', 5).flags).toContain('\\Seen'));
    expect(searchRow(ACCT_A.id, 'Work', 6).flags).not.toContain('\\Seen');
  });
});

describe('a saved View row from another account, in a single folder\'s list', () => {
  const foreign = () => row(5, { _accountId: ACCT_B.id, _mailbox: 'Work' });

  it('opens from its own account and folder when the row is clicked', async () => {
    markAsReadMode = 'manual';
    useSearchStore.getState().showRows([foreign()]);

    await clickRow(searchRow(ACCT_B.id, 'Work', 5));

    expect(mockFetchEmailLight).toHaveBeenCalledWith(ACCT_B, 5, 'Work', ACCT_B.id);
    expect(useMailStore.getState().selectedEmail?._accountId).toBe(ACCT_B.id);
    expect(useMailStore.getState().selectedEmailId).toBe(`${ACCT_B.id}:Work:5`);
  });

  it('opens from its own account and folder when the explorer sends its full key', async () => {
    markAsReadMode = 'manual';
    useSearchStore.getState().showRows([foreign()]);

    await clickExplorerRow(searchRow(ACCT_B.id, 'Work', 5));

    expect(mockFetchEmailLight).toHaveBeenCalledWith(ACCT_B, 5, 'Work', ACCT_B.id);
    expect(useMailStore.getState().selectedEmail?.uid).toBe(5);
  });

  it('marks it read on its own account after the delay, and repaints its View row', async () => {
    useSearchStore.getState().showRows([foreign()]);

    await clickRow(searchRow(ACCT_B.id, 'Work', 5));
    await vi.advanceTimersByTimeAsync(3000);

    expect(mockUpdateEmailFlags).toHaveBeenCalledWith(ACCT_B, 5, ['\\Seen'], 'add', 'Work');
    expect(mockUpdateEmailFlags).not.toHaveBeenCalledWith(ACCT_A, expect.anything(), expect.anything(), expect.anything(), expect.anything());
    await vi.waitFor(() => expect(searchRow(ACCT_B.id, 'Work', 5).flags).toContain('\\Seen'));
  });

  it('opens a merged-in row by the full key the explorer sends (another folder, same account)', async () => {
    markAsReadMode = 'manual';
    const other = row(7, { _accountId: ACCT_A.id, _mailbox: 'Work' });
    useSearchStore.getState().showRows([other]);

    await clickExplorerRow(searchRow(ACCT_A.id, 'Work', 7));

    expect(mockFetchEmailLight).toHaveBeenCalledWith(ACCT_A, 7, 'Work', ACCT_A.id);
    expect(useMailStore.getState().selectedEmailId).toBe(`${ACCT_A.id}:Work:7`);
  });
});

describe('marking the open message from the reader', () => {
  // The reader's toggle (EmailViewer, ThreadView, the full view) is
  // applyFlagToKeys over the open copy's selection key — not
  // markEmailReadStatus, which no control calls.
  const toggleFromReader = (read) => applyFlagToKeys([readerKey()], '\\Seen', read);

  it('keeps a View\'s message open and repaints its row when marked unread', async () => {
    markAsReadMode = 'manual';
    useSearchStore.getState().showRows([row(5, { _accountId: ACCT_A.id, _mailbox: 'Work', flags: ['\\Seen'] })]);
    mockFetchEmailLight.mockResolvedValueOnce({ ...bodyOf(row(5)), flags: ['\\Seen'] });
    await clickRow(searchRow(ACCT_A.id, 'Work', 5));
    expect(useMailStore.getState().selectedEmail.flags).toContain('\\Seen');
    const openedId = useMailStore.getState().selectedEmailId;

    await toggleFromReader(false);

    expect(useMailStore.getState().selectedEmail?.uid).toBe(5);
    expect(useMailStore.getState().selectedEmailId).toBe(openedId);
    expect(useMailStore.getState().selectedEmail.flags).not.toContain('\\Seen');
    await vi.waitFor(() => expect(searchRow(ACCT_A.id, 'Work', 5).flags).not.toContain('\\Seen'));
    expect(mockUpdateEmailFlags).toHaveBeenCalledWith(ACCT_A, 5, ['\\Seen'], 'remove', 'Work');
  });

  for (const unreadOnly of [false, true]) {
    it(`keeps a folder message open and listed through read and unread (unread filter ${unreadOnly ? 'on' : 'off'})`, async () => {
      markAsReadMode = 'manual';
      useMailStore.setState({ unreadOnly });
      await clickRow(row(1));
      const visible = () => {
        const s = useMailStore.getState();
        return filterUnread(s.sortedEmails, s.unreadOnly, s.selectedEmailId, e => selectionKey(e, s), s.unreadKeep)
          .some(e => e.uid === 1);
      };

      await toggleFromReader(true);
      expect(listSeen(1)).toBe(true);
      expect(useMailStore.getState().selectedEmailId).toBe(1);
      expect(useMailStore.getState().selectedEmail?.uid).toBe(1);
      expect(visible()).toBe(true);

      await toggleFromReader(false);
      expect(listSeen(1)).toBe(false);
      expect(useMailStore.getState().selectedEmailId).toBe(1);
      expect(useMailStore.getState().selectedEmail?.flags).not.toContain('\\Seen');
      expect(visible()).toBe(true);
    });
  }

  it('cancels the pending delayed mark when the user sets the read state by hand', async () => {
    await clickRow(row(1));
    expect(useMailStore.getState().markReadProgress).not.toBeNull();

    await toggleFromReader(true);
    await toggleFromReader(false);
    await vi.advanceTimersByTimeAsync(3000);

    expect(listSeen(1)).toBe(false);
    expect(useMailStore.getState().selectedEmail?.flags).not.toContain('\\Seen');
    expect(useMailStore.getState().markReadProgress).toBeNull();
    // add, remove — and no third write from the countdown.
    expect(mockUpdateEmailFlags).toHaveBeenCalledTimes(2);
    expect(mockUpdateEmailFlags).toHaveBeenLastCalledWith(ACCT_A, 1, ['\\Seen'], 'remove', 'INBOX');
  });

  it('leaves the countdown of the open message alone when another row is marked', async () => {
    await clickRow(row(1));

    await applyFlagToKeys([2], '\\Seen', true);
    await vi.advanceTimersByTimeAsync(3000);

    expect(listSeen(1)).toBe(true);
  });

  it('repaints the open thread when one of its messages is marked', async () => {
    markAsReadMode = 'manual';
    const member = useMailStore.getState().emails.find(e => e.uid === 1);
    useMailStore.getState().selectThread({ threadId: 't1', lastEmail: member, emails: [member], messageCount: 1 });

    await applyFlagToKeys([selectionKey(member, useMailStore.getState())], '\\Seen', true);

    expect(useMailStore.getState().selectedThread.emails[0].flags).toContain('\\Seen');
    expect(useMailStore.getState().selectedThread.threadId).toBe('t1');
  });
});
