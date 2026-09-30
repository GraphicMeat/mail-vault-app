// A flag change the daemon synced (a message read or starred on another
// device) lands in the header cache together with the mailbox's new modseq,
// before the change feed announces it. The reload the announcement triggers
// compares that modseq with the server's, finds them equal (condstore-noop)
// and never reads a cached row, and the drain only adds uids the store lacks:
// the open list kept the old flags until the user switched folders.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { serverUids } from '../slices/serverUids';

if (!globalThis.window) {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
} else {
  globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
}
vi.stubGlobal('navigator', { onLine: true });

const listeners = {};
vi.mock('@tauri-apps/api/event', () => ({
  listen: (name, cb) => { listeners[name] = cb; return Promise.resolve(() => {}); },
  emit: () => Promise.resolve(),
}));

vi.mock('../../services/daemonClient', async (importOriginal) => ({
  ...(await importOriginal()),
  daemonCall: vi.fn().mockResolvedValue([]),
}));

const mockGetEmailHeadersMeta = vi.fn();
const mockGetEmailHeadersPartial = vi.fn().mockResolvedValue(null);
const mockGetEmailHeadersByUids = vi.fn().mockResolvedValue([]);
vi.mock('../../services/db', () => ({
  getVaultUidSets: vi.fn().mockResolvedValue({ saved: new Set(), archived: new Set() }),
  getEmailHeadersMeta: (...a) => mockGetEmailHeadersMeta(...a),
  getEmailHeadersPartial: (...a) => mockGetEmailHeadersPartial(...a),
  getEmailHeaders: vi.fn().mockResolvedValue(null),
  listCachedUids: vi.fn().mockResolvedValue({ uids: [], changed: [] }),
  getEmailHeadersByUids: (...a) => mockGetEmailHeadersByUids(...a),
  getCachedMailboxes: vi.fn().mockResolvedValue([{ path: 'INBOX', name: 'INBOX' }]),
  readLocalEmailIndex: vi.fn().mockResolvedValue([]),
  getLocalEmails: vi.fn().mockResolvedValue([]),
  getArchivedEmails: vi.fn().mockResolvedValue([]),
  saveEmailHeaders: vi.fn().mockResolvedValue(undefined),
  clearMailboxCache: vi.fn().mockResolvedValue(undefined),
}));

const mockCheckMailboxStatus = vi.fn();
const mockFetchChangedFlags = vi.fn().mockResolvedValue([]);
vi.mock('../../services/api', () => ({
  checkMailboxStatus: (...a) => mockCheckMailboxStatus(...a),
  fetchChangedFlags: (...a) => mockFetchChangedFlags(...a),
  searchAllUids: vi.fn().mockResolvedValue([]),
  fetchHeadersByUids: vi.fn().mockResolvedValue({ emails: [] }),
  fetchEmails: vi.fn().mockResolvedValue({ emails: [], total: 0 }),
  updateEmailFlags: vi.fn().mockResolvedValue(undefined),
  vaultApplyFlags: vi.fn().mockResolvedValue({ renamed: 0, mirrored: 0, index_patched: 0, sidecars_patched: 0 }),
}));

vi.mock('../../services/authUtils', () => ({
  hasValidCredentials: () => true,
  ensureFreshToken: (a) => Promise.resolve(a),
  resolveServerAccount: (id, account) => Promise.resolve({ ok: true, account }),
}));
vi.mock('../../services/graphConfig', () => ({
  isGraphAccount: () => false,
  graphMessageToEmail: (m) => m,
  graphFoldersToMailboxes: () => [],
}));
vi.mock('../../services/mailSearch.js', () => ({
  startMailSearch: vi.fn(),
  cancelMailSearch: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../services/attachmentUtils', () => ({
  hasRealAttachments: () => false,
  hydrateInlineImages: (email) => Promise.resolve(email),
  getRealAttachments: () => [],
  replaceCidUrls: (html) => html,
}));
vi.mock('../../services/workflows/probeServerCopy', () => ({
  probeServerCopy: vi.fn().mockResolvedValue({ state: 'unknown' }),
}));
vi.mock('../../services/safeStorage', () => ({
  safeStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}));
// The banner is snoozeLocalWake.test.js's subject.
vi.mock('../../hooks/useEmailScheduler', () => ({ notifyArrival: vi.fn() }));

// All Inboxes reloads through a refetch of every account: parked here, so
// what the list shows is what the wake itself put there.
const mockRefreshCurrentView = vi.fn().mockResolvedValue(undefined);
vi.mock('../../services/workflows/refreshAccounts', async (importOriginal) => ({
  ...(await importOriginal()),
  refreshCurrentView: (...a) => mockRefreshCurrentView(...a),
}));

const mockSetUnread = vi.fn();
vi.mock('../settingsStore', () => ({
  effectiveSearchMailboxConcurrency: () => 1,
  useSettingsStore: {
    getState: () => ({
      cacheLimitMB: 128,
      hiddenAccounts: {},
      unreadPerAccount: {},
      getLastMailbox: () => 'INBOX',
      emailListStyle: 'default',
      linkAlerts: {},
      linkSafetyEnabled: false,
      markAsReadMode: 'manual',
      markAsReadDelay: 3,
      setUnreadForAccount: (...a) => mockSetUnread(...a),
      addSearchToHistory: () => {},
    }),
  },
}));

const { useMailStore } = await import('../mailStore');
const { useSearchStore } = await import('../searchStore');
const { invalidateChatAndThreadCaches } = await import('../slices/messageListSlice');
const { registerRows, unregisterRows } = await import('../messageRows');
const { useNotesStore } = await import('../notesStore');

const A1 = { id: 'a1', email: 'me@one.co', imapHost: 'h', password: 'x' };
const row = (uid, flags) => ({
  uid, messageId: `<m${uid}@x>`, flags, subject: `Message ${uid}`, source: 'server',
  from: { address: 'them@x.co' }, date: `2026-09-2${uid}T10:00:00Z`,
});
const flagsOf = (uid) => useMailStore.getState().emails.find(e => e.uid === uid)?.flags;
const lastUnread = () => mockSetUnread.mock.calls.filter(([id]) => id === 'a1').at(-1)?.[1];
const tick = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0)); };

describe('a flag change the daemon synced reaches the open folder list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useMailStore.setState({
      accounts: [A1], activeAccountId: 'a1', activeMailbox: 'INBOX', unifiedInbox: false, mailboxScope: null,
      unifiedFolder: 'INBOX', viewMode: 'all', localEmails: [], sentEmails: [],
      savedEmailIds: new Set(), archivedEmailIds: new Set(), deleteTombstones: new Set(),
      selectedEmail: null, selectedEmailId: null, selectedThread: null, emailCache: new Map(),
      loading: false, loadingMore: false, _sortedEmailsFingerprint: '',
      emails: [row(5, []), row(4, ['\\Seen'])],
      serverUids: serverUids(new Set([5, 4]), { complete: true }),
      totalEmails: 2,
    });
    invalidateChatAndThreadCaches();
    useMailStore.getState().updateSortedEmails();
    // What the daemon left behind: its sync wrote the server's modseq, and the
    // flags another device changed (5 read, 4 starred and unread), into the cache.
    mockGetEmailHeadersMeta.mockResolvedValue({ uidValidity: 1, uidNext: 6, highestModseq: 9, totalEmails: 2, totalCached: 2 });
    mockCheckMailboxStatus.mockResolvedValue({ uidValidity: 1, uidNext: 6, highestModseq: 9, exists: 2 });
    mockGetEmailHeadersByUids.mockImplementation(async (_a, _m, uids) =>
      [row(5, ['\\Seen']), row(4, ['\\Flagged'])].filter(r => uids.includes(r.uid)));
  });

  it('a plain reload reads no cached row (the noop exit)', async () => {
    await useMailStore.getState().loadEmails();
    await tick();

    expect(mockFetchChangedFlags).not.toHaveBeenCalled();
    expect(flagsOf(5)).toEqual([]);
  });

  it('a reload told flags changed shows them, and recounts the badge', async () => {
    await useMailStore.getState().loadEmails({ rereadFlags: true });
    await tick();

    expect(flagsOf(5)).toEqual(['\\Seen']);
    expect(flagsOf(4)).toEqual(['\\Flagged']);
    expect(lastUnread()).toBe(1);
  });

  it('keeps the other rows as they were', async () => {
    const before = useMailStore.getState().emails.find(e => e.uid === 5);
    mockGetEmailHeadersByUids.mockImplementation(async (_a, _m, uids) => [row(5, []), row(4, ['\\Seen'])].filter(r => uids.includes(r.uid)));
    await useMailStore.getState().loadEmails({ rereadFlags: true });
    await tick();

    expect(useMailStore.getState().emails.find(e => e.uid === 5)).toBe(before);
  });
});

// Another device marks the message open in the reader unread. The reread put it
// on the list row and nowhere else: the reader still said read (and offered
// "Mark unread"), the open thread, the cached body and a search hit kept the old
// state, and a same-numbered message of another folder was one bare-uid match away.
describe('a flag change the daemon synced reaches every container the message is in', () => {
  const stamped = (r) => ({ ...r, _accountId: 'a1', _mailbox: 'INBOX' });
  const BODY_KEY = 'a1-INBOX-5';

  function seed({ listFlags }) {
    const sentCopy = { ...row(5, ['\\Seen']), _accountId: 'a1', _mailbox: 'Sent', _fromSentFolder: true };
    useMailStore.setState({
      accounts: [A1], activeAccountId: 'a1', activeMailbox: 'INBOX', unifiedInbox: false, mailboxScope: null,
      unifiedFolder: 'INBOX', viewMode: 'all', localEmails: [], sentEmails: [sentCopy],
      savedEmailIds: new Set(), archivedEmailIds: new Set(), deleteTombstones: new Set(),
      loading: false, loadingMore: false, _sortedEmailsFingerprint: '',
      emails: [row(5, listFlags), row(4, ['\\Seen'])],
      serverUids: serverUids(new Set([5, 4]), { complete: true }),
      totalEmails: 2,
      selectedEmail: stamped(row(5, ['\\Seen'])),
      selectedEmailId: 5,
      selectedThread: { threadId: 't', emails: [stamped(row(5, ['\\Seen'])), stamped(row(4, ['\\Seen']))] },
      emailCache: new Map([[BODY_KEY, { email: stamped(row(5, ['\\Seen'])), timestamp: 1, size: 0 }]]),
    });
    useSearchStore.setState({
      searchActive: false,
      searchResults: [stamped(row(5, ['\\Seen']))],
      indexedSearchRows: { a1: [stamped(row(5, ['\\Seen']))] },
      searchRowsOutsideIndex: [],
      excludedSearchCopies: new Set(),
    });
    invalidateChatAndThreadCaches();
    useMailStore.getState().updateSortedEmails();
    mockGetEmailHeadersMeta.mockResolvedValue({ uidValidity: 1, uidNext: 6, highestModseq: 9, totalEmails: 2, totalCached: 2 });
    mockCheckMailboxStatus.mockResolvedValue({ uidValidity: 1, uidNext: 6, highestModseq: 9, exists: 2 });
    // The cache: 5 is unread now, 4 is as it was.
    mockGetEmailHeadersByUids.mockImplementation(async (_a, _m, uids) =>
      [row(5, []), row(4, ['\\Seen'])].filter(r => uids.includes(r.uid)));
  }

  const everywhere = () => {
    const mail = useMailStore.getState();
    const search = useSearchStore.getState();
    return {
      list: mail.emails.find(e => e.uid === 5).flags,
      reader: mail.selectedEmail.flags,
      thread: mail.selectedThread.emails.find(e => e.uid === 5).flags,
      cache: mail.emailCache.get(BODY_KEY).email.flags,
      searchList: search.searchResults[0].flags,
      searchPool: search.indexedSearchRows.a1[0].flags,
    };
  };

  beforeEach(() => vi.clearAllMocks());

  it('the list row, the reader, the open thread, the cached body and a search hit all turn unread', async () => {
    seed({ listFlags: ['\\Seen'] });
    await useMailStore.getState().loadEmails({ rereadFlags: true });
    await tick();

    expect(everywhere()).toEqual({ list: [], reader: [], thread: [], cache: [], searchList: [], searchPool: [] });
  });

  it('repaints the reader even when the list row already says unread', async () => {
    seed({ listFlags: [] });
    await useMailStore.getState().loadEmails({ rereadFlags: true });
    await tick();

    expect(everywhere().reader).toEqual([]);
    expect(everywhere().thread).toEqual([]);
  });

  it('does not touch a message of another folder that shares the uid', async () => {
    seed({ listFlags: ['\\Seen'] });
    await useMailStore.getState().loadEmails({ rereadFlags: true });
    await tick();

    expect(useMailStore.getState().sentEmails[0].flags).toEqual(['\\Seen']);
  });
});

// The daemon re-reads the flags of EVERY row the list holds (five figures on a
// big folder) after each synced change, and the echo of the user's own STORE
// differs in none of them. The repaint used to key every cached row and scan
// every container for each key; it now keys only the rows whose flags moved,
// plus the rows the reader, the thread, a search, the body cache and a Notes card
// hold outside the list.
describe('the flag sync repaint only works on what differs', () => {
  const N = 2000;
  const bigList = () => Array.from({ length: N }, (_, i) => row(i + 1, ['\\Seen']));
  const keysPainted = [];
  let off;

  beforeEach(() => {
    vi.clearAllMocks();
    keysPainted.length = 0;
    // One call per write the registry makes, with the keys of that write.
    registerRows({ name: 'probe', invalidate: (ctx) => keysPainted.push([...ctx.keys]) });
    off = () => unregisterRows('probe');
    useMailStore.setState({
      accounts: [A1], activeAccountId: 'a1', activeMailbox: 'INBOX', unifiedInbox: false, mailboxScope: null,
      unifiedFolder: 'INBOX', viewMode: 'all', localEmails: [], sentEmails: [],
      savedEmailIds: new Set(), archivedEmailIds: new Set(), deleteTombstones: new Set(),
      selectedEmail: null, selectedEmailId: null, selectedThread: null, emailCache: new Map(),
      loading: false, loadingMore: false, _sortedEmailsFingerprint: '',
      emails: bigList(),
      serverUids: serverUids(new Set(bigList().map(r => r.uid)), { complete: true }),
      totalEmails: N,
    });
    useSearchStore.setState({ searchActive: false, searchResults: [], indexedSearchRows: {}, searchRowsOutsideIndex: [], excludedSearchCopies: new Set() });
    useNotesStore.setState({ cards: [] });
    invalidateChatAndThreadCaches();
    useMailStore.getState().updateSortedEmails();
    mockGetEmailHeadersMeta.mockResolvedValue({ uidValidity: 1, uidNext: N + 1, highestModseq: 9, totalEmails: N, totalCached: N });
    mockCheckMailboxStatus.mockResolvedValue({ uidValidity: 1, uidNext: N + 1, highestModseq: 9, exists: N });
  });
  const afterEach_ = () => off();

  const cacheWith = (overrides = {}) =>
    mockGetEmailHeadersByUids.mockImplementation(async (_a, _m, uids) =>
      bigList().map(r => (overrides[r.uid] ? { ...r, flags: overrides[r.uid] } : r)).filter(r => uids.includes(r.uid)));

  it('the echo of the list\'s own flags paints nothing', async () => {
    cacheWith();
    await useMailStore.getState().loadEmails({ rereadFlags: true });
    await tick();
    afterEach_();

    expect(keysPainted).toEqual([]);
  });

  it('one changed row is the only key painted out of the whole list', async () => {
    cacheWith({ 7: [] });
    await useMailStore.getState().loadEmails({ rereadFlags: true });
    await tick();
    afterEach_();

    expect(keysPainted).toEqual([['a1-INBOX-7']]);
    expect(flagsOf(7)).toEqual([]);
  });

  it('a reader that is stale while the list is current is still repainted, and only it', async () => {
    const reader = { ...row(9, []), _accountId: 'a1', _mailbox: 'INBOX' }; // the list row says read
    useMailStore.setState({ selectedEmail: reader, selectedEmailId: 9 });
    cacheWith();
    await useMailStore.getState().loadEmails({ rereadFlags: true });
    await tick();
    afterEach_();

    expect(useMailStore.getState().selectedEmail.flags).toEqual(['\\Seen']);
    expect(keysPainted).toEqual([['a1-INBOX-9']]);
  });

  it('a Notes card copy that is stale while the list is current is still repainted', async () => {
    useNotesStore.setState({ cards: [{ key: 'c1', starred: false,
      copies: [{ accountId: 'a1', mailbox: 'INBOX', uid: 11, flags: [] }] }] });
    cacheWith();
    await useMailStore.getState().loadEmails({ rereadFlags: true });
    await tick();
    afterEach_();

    expect(useNotesStore.getState().cards[0].copies[0].flags).toEqual(['\\Seen']);
    expect(keysPainted).toEqual([['a1-INBOX-11']]);
  });
});
