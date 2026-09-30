// The registry of message rows (stores/messageRows.js): the one list of every
// container a row lives in, the one way a writer changes it, and the one pool a
// key is resolved against.
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
const { registeredFields, registeredContainers, patchEverywhere, resolvePool } = await import('../../../stores/messageRows');

// What each store holds, as it was created: read before any test seeds it.
const initial = new Map([
  [useMailStore, { ...useMailStore.getState() }],
  [useSearchStore, { ...useSearchStore.getState() }],
  [useNotesStore, { ...useNotesStore.getState() }],
]);
const storeName = new Map([[useMailStore, 'mailStore'], [useSearchStore, 'searchStore'], [useNotesStore, 'notesStore']]);

const ACCOUNT = { id: 'a1', email: 'a1@x' };
const msg = (uid, extra = {}) => ({
  uid, messageId: `m${uid}@mock`, subject: `m${uid}`, flags: [], source: 'server',
  _accountId: 'a1', _mailbox: 'INBOX',
  from: { address: 'them@x' }, date: '2026-09-01T10:00:00Z', ...extra,
});

function seed() {
  useMailStore.setState({
    accounts: [ACCOUNT], activeAccountId: 'a1', activeMailbox: 'INBOX',
    unifiedInbox: false, unifiedFolder: null, mailboxScope: null, viewMode: 'all',
    emails: [msg(7, { subject: 'emails' }), msg(8)],
    sentEmails: [msg(7, { subject: 'sentEmails' })],
    localEmails: [msg(7, { subject: 'localEmails' })],
    selectedEmail: msg(7, { subject: 'selectedEmail' }),
    selectedThread: { threadId: 't', emails: [msg(7), msg(8)] },
    emailCache: new Map(),
  });
  useSearchStore.setState({
    searchResults: [msg(7, { subject: 'search' }), msg(8)],
    indexedSearchRows: { a1: [msg(7), msg(8)] },
    searchRowsOutsideIndex: [msg(7), msg(8)],
    excludedSearchCopies: new Set(),
  });
  useNotesStore.setState({ cards: [] });
}

const count = (store) => {
  const seen = { n: 0 };
  const off = store.subscribe(() => { seen.n += 1; });
  return { seen, off };
};
const stamp = (row) => ({ ...row, _mark: true });

beforeEach(seed);

describe('the guard: a store field that holds rows is registered or exempted', () => {
  // A collection (or a field named for one) a store keeps is either a place a
  // message row lives, and then registered so no writer forgets it, or it is
  // not, and says why here. A new field fails this until it is one or the other.
  const EXEMPT = {
    mailStore: {
      accounts: 'account records',
      mailboxes: 'the folder list',
      savedEmailIds: 'a set of uids, no row',
      archivedEmailIds: 'a set of uids, no row',
      loadedRanges: 'index ranges of the list',
      selectedEmailIds: 'the ticked rows\' selection keys',
      deleteTombstones: 'keys of deleted messages',
      unreadKeep: 'selection keys held on screen',
      pendingSends: 'messages being sent, not received ones',
      outboxItems: 'the outbox, not received messages',
      _cancelledOutboxIds: 'ids of cancelled sends',
    },
    searchStore: {
      excludedSearchCopies: 'keys of copies a search dropped, no row',
    },
    notesStore: {
      accounts: 'account descriptors the board asks the daemon about',
    },
  };
  const ROWLIKE_NAME = /(emails?|threads?|messages?|rows?|cards?|results?)$/i;
  const isCandidate = (key, value) => typeof value !== 'function' && (
    Array.isArray(value) || value instanceof Map || value instanceof Set
    || ((value === null || (typeof value === 'object')) && ROWLIKE_NAME.test(key)));

  for (const [store, state] of initial) {
    it(`${storeName.get(store)}: every collection is registered or exempted`, () => {
      const registered = registeredFields(store);
      const undecided = Object.entries(state)
        .filter(([key, value]) => isCandidate(key, value))
        .map(([key]) => key)
        .filter(key => !registered.has(key) && !(key in EXEMPT[storeName.get(store)]));
      expect(undecided).toEqual([]);
    });
  }

  it('an exemption names a field that still exists, and is not also registered', () => {
    for (const [store, state] of initial) {
      const exempt = EXEMPT[storeName.get(store)];
      const registered = registeredFields(store);
      for (const key of Object.keys(exempt)) {
        expect([storeName.get(store), key, key in state]).toEqual([storeName.get(store), key, true]);
        expect([storeName.get(store), key, registered.has(key)]).toEqual([storeName.get(store), key, false]);
      }
      for (const key of registered) expect([storeName.get(store), key, key in state]).toEqual([storeName.get(store), key, true]);
    }
  });

  it('every container is one of the three stores', () => {
    for (const container of registeredContainers()) expect(storeName.has(container.store)).toBe(true);
  });
});

describe('patchEverywhere', () => {
  it('lands one mail-store update for the whole batch, however many containers hold the row', () => {
    const mail = count(useMailStore);
    const search = count(useSearchStore);

    patchEverywhere(['a1-INBOX-7'], stamp);

    // emails, sentEmails, localEmails, sortedEmails, selectedEmail, selectedThread
    // in one setState — `emails` runs to five figures and a click pays per render.
    expect(mail.seen.n).toBe(1);
    expect(search.seen.n).toBe(1);
    mail.off();
    search.off();
    expect(useMailStore.getState().sentEmails[0]._mark).toBe(true);
    expect(useMailStore.getState().selectedThread.emails[0]._mark).toBe(true);
  });

  it('touches nothing, and tells nobody, when no row is the message', () => {
    const before = { emails: useMailStore.getState().emails, results: useSearchStore.getState().searchResults };
    const mail = count(useMailStore);
    const search = count(useSearchStore);

    patchEverywhere(['a1-INBOX-99'], stamp);

    expect([mail.seen.n, search.seen.n]).toEqual([0, 0]);
    mail.off();
    search.off();
    expect(useMailStore.getState().emails).toBe(before.emails);
    expect(useSearchStore.getState().searchResults).toBe(before.results);
  });

  it('keeps every row that is not the message, by identity', () => {
    const [, eight] = useMailStore.getState().emails;

    patchEverywhere(['a1-INBOX-7'], stamp);

    expect(useMailStore.getState().emails[1]).toBe(eight);
  });

  it('skips a derived container when the writer re-derives it', () => {
    useMailStore.setState({ sortedEmails: [msg(7)] });

    patchEverywhere(['a1-INBOX-7'], stamp, { skipDerived: true });
    expect(useMailStore.getState().sortedEmails[0]._mark).toBeUndefined();

    patchEverywhere(['a1-INBOX-7'], stamp);
    expect(useMailStore.getState().sortedEmails[0]._mark).toBe(true);
  });

  it('matches a row by its own folder: the same uid in another folder is another message', () => {
    useMailStore.setState({ sentEmails: [msg(7, { _mailbox: 'Sent', _fromSentFolder: true })] });
    useSearchStore.setState({ searchResults: [msg(7, { _mailbox: 'Archive' })], searchRowsOutsideIndex: [] , indexedSearchRows: {} });

    patchEverywhere(['a1-INBOX-7'], stamp);

    expect(useMailStore.getState().sentEmails[0]._mark).toBeUndefined();
    expect(useSearchStore.getState().searchResults[0]._mark).toBeUndefined();
    expect(useMailStore.getState().emails[0]._mark).toBe(true);
  });

  it('finds a row whose uid is negative (a sample row), not the positive one after the last dash', () => {
    useMailStore.setState({ emails: [msg(-5), msg(5)] });

    patchEverywhere(['a1-INBOX--5'], stamp);

    expect(useMailStore.getState().emails.map(row => row._mark)).toEqual([true, undefined]);
  });

  it('leaves a search row that names no folder alone rather than guessing', () => {
    useSearchStore.setState({ searchResults: [msg(7, { _mailbox: undefined })], searchRowsOutsideIndex: [], indexedSearchRows: {} });

    patchEverywhere(['a1-INBOX-7'], stamp);

    expect(useSearchStore.getState().searchResults[0]._mark).toBeUndefined();
  });
});

describe('resolvePool', () => {
  it('lists the copies in view first, then the reader, then a search\'s hits', () => {
    expect(resolvePool(useMailStore.getState()).filter(row => row.uid === 7).map(row => row.subject))
      .toEqual(['emails', 'sentEmails', 'localEmails', 'selectedEmail', 'search']);
  });

  it('places a hit by the account it names in either field, like every other row', () => {
    useSearchStore.setState({ searchResults: [msg(33, { _mailbox: 'Archive', _accountId: undefined, _srcAccountId: 'a1' })] });

    expect(resolvePool(useMailStore.getState()).map(row => row.uid)).toContain(33);

    patchEverywhere(['a1-Archive-33'], stamp);
    expect(useSearchStore.getState().searchResults[0]._mark).toBe(true);
  });

  it('holds a search hit no list has, and no hit that names no folder', () => {
    useSearchStore.setState({
      searchResults: [msg(31, { _mailbox: 'Archive' }), msg(32, { _mailbox: undefined })],
    });

    const uids = resolvePool(useMailStore.getState()).map(row => row.uid);

    expect(uids).toContain(31);
    expect(uids).not.toContain(32);
  });
});
