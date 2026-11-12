// The Sent mirror merged into INBOX threads is a WINDOW onto the folder, and the
// daemon owns the whole of it. The folder can hold tens of thousands of rows;
// the app keeps in memory only what the list can show:
//   - the rows from the oldest loaded INBOX row to the newest, never fewer than
//     the newest 200; scrolling the INBOX back adds the rows it now reaches;
//   - the cache is read for that window (newest N, N grown until it reaches
//     the floor), never whole;
//   - the rest of the folder is filled by the daemon (sync.now, complete) for
//     every provider, and pruned by it; the app waits for it and reads the window
//     again. A fill ADDS rows once at its end: a reply sent or a message deleted
//     or moved while it ran is not undone.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { serverUids } from '../../../stores/slices/serverUids';

if (!globalThis.window) {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
} else {
  globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
}
vi.stubGlobal('navigator', { onLine: true });

const db = vi.hoisted(() => ({
  getCachedMailboxEntry: vi.fn(),
  getCachedMailboxes: vi.fn(),
  getEmailHeadersMeta: vi.fn(),
  getEmailHeadersPartial: vi.fn(),
  getEmailHeadersWindow: vi.fn(),
  getVaultUidSets: vi.fn(),
  getArchivedEmails: vi.fn(),
  readLocalEmailIndex: vi.fn(),
  saveEmailHeaders: vi.fn(),
  saveMailboxes: vi.fn(),
  initDB: vi.fn(),
  getAccounts: vi.fn(),
  ensureAccountsInFile: vi.fn(),
}));
vi.mock('../../db', () => db);

const api = vi.hoisted(() => ({
  fetchEmails: vi.fn(),
  graphListFolders: vi.fn(),
  graphListMessages: vi.fn(),
  listLocalFolders: vi.fn(),
}));
vi.mock('../../api', () => api);

const graph = vi.hoisted(() => ({ listGraphMessages: vi.fn() }));
vi.mock('../../cacheManager', () => ({
  saveRestoreDescriptor: vi.fn(),
  getRestoreDescriptor: vi.fn().mockReturnValue(null),
  invalidateRestoreDescriptors: vi.fn(),
  getAccountCacheMailboxes: () => null,
  listGraphMessages: graph.listGraphMessages,
  getGraphMessageId: vi.fn().mockReturnValue(null),
  resolveGraphMessageId: vi.fn().mockResolvedValue(null),
  restoreGraphIdMap: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../authUtils', () => ({
  ensureFreshToken: (a) => Promise.resolve(a),
  resolveServerAccount: (id, account) => Promise.resolve({ ok: true, account }),
  hasValidCredentials: () => true,
}));
vi.mock('../../../stores/settingsStore', () => ({
  useSettingsStore: {
    getState: () => ({
      hiddenAccounts: {}, setLastMailbox: vi.fn(), setUnreadForAccount: vi.fn(), getLastMailbox: () => 'INBOX',
      isAccountHidden: () => false,
    }),
  },
}));
vi.mock('../../transport', () => ({ getDaemonHealth: () => ({ alive: false }), send: vi.fn().mockResolvedValue({ drafts: [], managed: [] }) }));
vi.mock('../../syncProbe', () => ({ mailboxIsUnchanged: vi.fn(), markVerified: vi.fn(), invalidate: vi.fn() }));
const sync = vi.hoisted(() => ({
  syncNow: vi.fn(), waitForSync: vi.fn(), getSyncStatus: vi.fn(),
}));
vi.mock('../../syncService', () => ({
  ...sync, watchAccount: vi.fn(), unwatchAccount: vi.fn(),
  toSyncAccount: (account, id = account?.id) => ({ id, email: account?.email, imapConfig: {} }),
}));

const { useMailStore } = await import('../../../stores/mailStore');
await import('../bindStoreActions');
const { loadSentHeaders, extendSentWindows, _sentFillFor, _resetSentFills, _sentTimings } = await import('../loadEmails');

const IMAP = { id: 'acct-i', email: 'i@mock.test', password: 'pw' };
const JMAP = { id: 'acct-j', email: 'j@mock.test', jmapSessionUrl: 'https://jmap.mock.test/session' };
const GRAPH = { id: 'acct-g', email: 'g@hotmail.test', oauth2Transport: 'graph' };
const TOTAL = 450;
const PAGE = 200;

const row = (uid) => ({
  uid, subject: `s${uid}`, flags: ['\\Seen'], messageId: `<s${uid}@x>`,
  date: new Date(Date.UTC(2026, 0, 1) - uid * 60000).toISOString(),
});
const rows = (from, n) => Array.from({ length: n }, (_, i) => row(from + i));

// The INBOX list reaches back to uid `reach`'s date (default: past the whole
// folder). `reach: null` is an INBOX with nothing loaded yet.
function prime(account, sentFolder = {}, { reach = TOTAL + 50 } = {}) {
  useMailStore.setState({
    accounts: [account],
    activeAccountId: account.id,
    activeMailbox: 'INBOX',
    unifiedInbox: false,
    mailboxScope: null,
    connectionStatus: 'connected',
    mailboxes: [
      { path: 'INBOX', name: 'INBOX', children: [], _graphFolderId: 'fld-inbox' },
      { path: 'Sent', name: 'Sent', specialUse: '\\Sent', children: [], _graphFolderId: 'fld-sent', _graphTotal: TOTAL, ...sentFolder },
    ],
    sentEmails: [],
    deleteTombstones: new Set(),
    emails: reach == null ? [] : [{ uid: 1, subject: 'oldest', date: row(reach).date, flags: [] }],
    serverUids: serverUids(new Set(), { complete: false }),
  });
}

const sentUids = () => (useMailStore.getState().sentEmails || []).map(e => e.uid);

// The header cache the daemon keeps: newest first. A save adds rows; removedUids drops them.
let cache;
let cacheStamp;
let servedMax;

beforeEach(() => {
  vi.clearAllMocks();
  _resetSentFills();
  _sentTimings.pollMs = 1;
  cache = [];
  cacheStamp = 1;
  db.getEmailHeadersMeta.mockImplementation(async () => ({ totalCached: cache.length, totalEmails: cache.length, lastSynced: cacheStamp }));
  // The daemon's date window: newest by date back to `since`, at least `min`
  // rows, whatever order the cache is kept in.
  servedMax = 0;
  db.getEmailHeadersWindow.mockImplementation(async (a, m, since, min) => {
    const byDate = [...cache].sort((x, y) => (x.date < y.date ? 1 : -1));
    const within = byDate.filter(r => Date.parse(r.date) >= since).length;
    const emails = byDate.slice(0, Math.max(within, min)).map(r => ({ ...r }));
    servedMax = Math.max(servedMax, emails.length);
    return { emails, totalEmails: cache.length, totalCached: cache.length };
  });
  db.saveEmailHeaders.mockImplementation(async (a, m, rows, total, opts = {}) => {
    const drop = new Set(opts.removedUids || []);
    const byUid = new Map(cache.filter(r => !drop.has(r.uid)).map(r => [r.uid, r]));
    for (const r of rows) byUid.set(r.uid, r);
    cache = [...byUid.values()].sort((x, y) => (x.date < y.date ? 1 : -1));
    cacheStamp += 1;
  });
  db.getCachedMailboxes.mockResolvedValue(null);

  // IMAP/JMAP server: newest first, uid = position + 1, `limit` per page.
  api.fetchEmails.mockImplementation(async (account, mailbox, page = 1, limit = 200) => {
    const from = (page - 1) * limit;
    const emails = rows(from + 1, Math.max(0, Math.min(limit, TOTAL - from)));
    return { emails, total: TOTAL, hasMore: from + emails.length < TOTAL, page };
  });
  // The daemon's sync.now: syncs, then backfills the cache in the background.
  // The ticket resolves before the daemon marks the backfill as running: the
  // first status read can say "not backfilling" while nothing is filled yet.
  let polls = 0;
  sync.syncNow.mockImplementation(async () => { polls = 0; return { ticket: 7 }; });
  sync.waitForSync.mockResolvedValue({ success: true });
  sync.getSyncStatus.mockImplementation(async () => {
    polls += 1;
    if (polls === 3) { cache = rows(1, TOTAL); cacheStamp += 1; } // the backfill lands
    return { backfilling: polls === 2 || polls === 3 };           // false, true, true, false, false
  });
  // Graph: newest first, `before` is "received at or before", then a skip.
  const server = rows(1, TOTAL);
  graph.listGraphMessages.mockImplementation(async (accountId, mailbox, account, folderId, { top = 200, skip = 0, before } = {}) => {
    const list = before ? server.filter(r => r.date <= before) : server;
    const page = list.slice(skip, skip + top);
    return { headers: page.map(r => ({ ...r })), nextLink: skip + page.length < list.length ? 'next' : null };
  });
});

const biggestRead = () => servedMax;

describe('the Sent mirror is a window onto the folder', () => {
  it('reads the rows from the oldest loaded INBOX row on, not the whole cache', async () => {
    cache = rows(1, TOTAL);
    prime(IMAP, {}, { reach: 250 });
    await loadSentHeaders(IMAP.id);
    await _sentFillFor(IMAP.id);

    expect(new Set(sentUids()).size).toBe(250);
    expect(sentUids()).not.toContain(251);
    expect(biggestRead()).toBeLessThan(TOTAL);
    expect(sync.syncNow).not.toHaveBeenCalled();
  });

  it('50,000 cached rows: the read and the mirror stay the size of the window', async () => {
    cache = rows(1, 50000);
    api.fetchEmails.mockImplementation(async () => ({ emails: rows(1, PAGE), total: 50000, hasMore: true, page: 1 }));
    prime(IMAP, {}, { reach: 300 });
    await loadSentHeaders(IMAP.id);
    await _sentFillFor(IMAP.id);

    expect(new Set(sentUids()).size).toBe(300);
    expect(biggestRead()).toBeLessThanOrEqual(300);
  });

  it('an INBOX with nothing loaded yet shows the newest 200', async () => {
    cache = rows(1, TOTAL);
    prime(IMAP, {}, { reach: null });
    await loadSentHeaders(IMAP.id, { cacheOnly: true });

    expect(new Set(sentUids()).size).toBe(PAGE);
  });

  it('never fewer than the newest 200, however short the INBOX list is', async () => {
    cache = rows(1, TOTAL);
    prime(IMAP, {}, { reach: 50 });
    await loadSentHeaders(IMAP.id, { cacheOnly: true });

    expect(new Set(sentUids()).size).toBe(PAGE);
  });

  it('scrolling the INBOX back adds the rows it now reaches, and reads nothing when it has not moved', async () => {
    cache = rows(1, TOTAL);
    prime(IMAP, {}, { reach: 250 });
    await loadSentHeaders(IMAP.id, { cacheOnly: true });
    const first = useMailStore.getState().sentEmails[0];
    db.getEmailHeadersWindow.mockClear();

    await extendSentWindows();
    expect(db.getEmailHeadersWindow).not.toHaveBeenCalled();

    useMailStore.setState({ emails: [{ uid: 1, subject: 'older', date: row(400).date, flags: [] }] });
    await extendSentWindows();

    expect(new Set(sentUids()).size).toBe(400);
    expect(useMailStore.getState().sentEmails[0]).toBe(first); // added to, not rebuilt
  });

  it('the INBOX list moving back reaches the mirror without a call from the list', async () => {
    cache = rows(1, TOTAL);
    prime(IMAP, {}, { reach: 250 });
    await loadSentHeaders(IMAP.id, { cacheOnly: true });

    useMailStore.setState({ emails: [{ uid: 1, subject: 'older', date: row(400).date, flags: [] }] });

    await vi.waitFor(() => expect(new Set(sentUids()).size).toBe(400));
  });

  it('the rows a fill brings are shown only as far as the window reaches', async () => {
    prime(IMAP, {}, { reach: 250 });
    await loadSentHeaders(IMAP.id);
    await _sentFillFor(IMAP.id);

    // The daemon backfilled all 450; the mirror shows the 250 the list can use.
    expect(cache).toHaveLength(TOTAL);
    expect(new Set(sentUids()).size).toBe(250);
  });
});

describe('the daemon fills the whole folder, for every provider', () => {
  it('IMAP: sync.now completes the cache and the mirror re-reads its window; the app pages nothing', async () => {
    prime(IMAP);
    await loadSentHeaders(IMAP.id);
    await _sentFillFor(IMAP.id);

    expect(api.fetchEmails.mock.calls.map(c => c[2])).toEqual([1]);
    expect(sync.syncNow).toHaveBeenCalledWith({ id: IMAP.id, email: IMAP.email, imapConfig: {} }, 'Sent', { complete: true });
    expect(sync.waitForSync).toHaveBeenCalledWith(7);
    expect(sync.getSyncStatus).toHaveBeenCalledWith(IMAP.id);
    expect(new Set(sentUids()).size).toBe(TOTAL);
  });

  it('JMAP: the daemon fills it too; the app pages nothing past page one', async () => {
    prime(JMAP);
    await loadSentHeaders(JMAP.id);
    await _sentFillFor(JMAP.id);

    expect(api.fetchEmails.mock.calls.map(c => c[2])).toEqual([1]);
    expect(sync.syncNow).toHaveBeenCalledWith(expect.objectContaining({ id: JMAP.id }), 'Sent', { complete: true });
    expect(new Set(sentUids()).size).toBe(TOTAL);
  });

  it('Graph: the daemon fills it too; the app lists page one and nothing past it', async () => {
    prime(GRAPH);
    await loadSentHeaders(GRAPH.id);
    await _sentFillFor(GRAPH.id);

    expect(graph.listGraphMessages).toHaveBeenCalledTimes(1);
    expect(sync.syncNow).toHaveBeenCalledWith(expect.objectContaining({ id: GRAPH.id }), 'Sent', { complete: true });
    expect(new Set(sentUids()).size).toBe(TOTAL);
  });

  it('starts no fill when the cache holds as many rows as the folder', async () => {
    cache = rows(1, TOTAL);
    prime(IMAP);
    await loadSentHeaders(IMAP.id);
    await _sentFillFor(IMAP.id);

    expect(sync.syncNow).not.toHaveBeenCalled();
    expect(new Set(sentUids()).size).toBe(TOTAL);
  });

  it('a row the daemon pruned from the cache leaves the mirror', async () => {
    cache = [...rows(1, TOTAL), row(9999)];
    prime(JMAP, {}, { reach: 9999 });
    await loadSentHeaders(JMAP.id);
    expect(sentUids()).toContain(9999);
    await _sentFillFor(JMAP.id);

    expect(sentUids()).not.toContain(9999);
    expect(new Set(sentUids()).size).toBe(TOTAL);
  });

  it('a first page that is the whole folder prunes what the cache holds beyond it', async () => {
    const WHOLE = 150;
    cache = [...rows(1, WHOLE), row(9999)];
    graph.listGraphMessages.mockImplementation(async () => ({ headers: rows(1, WHOLE).map(r => ({ ...r })), nextLink: null }));
    prime(GRAPH, { _graphTotal: WHOLE }, { reach: 9999 });
    await loadSentHeaders(GRAPH.id);
    await _sentFillFor(GRAPH.id);

    expect(sentUids()).not.toContain(9999);
    expect(db.saveEmailHeaders.mock.calls.some(c => c[4]?.removedUids?.includes(9999))).toBe(true);
    expect(sync.syncNow).not.toHaveBeenCalled();
  });

  it('one fill per account at a time, and one per session per folder', async () => {
    prime(JMAP);
    await Promise.all([loadSentHeaders(JMAP.id), loadSentHeaders(JMAP.id)]);
    await _sentFillFor(JMAP.id);
    await loadSentHeaders(JMAP.id);
    await _sentFillFor(JMAP.id);

    expect(sync.syncNow).toHaveBeenCalledTimes(1);
  });

  it('a failed fill leaves the mirror as it was, and is not retried at once', async () => {
    prime(JMAP);
    sync.syncNow.mockRejectedValue(new Error('daemon busy'));
    await loadSentHeaders(JMAP.id);
    await _sentFillFor(JMAP.id);
    await loadSentHeaders(JMAP.id);
    await _sentFillFor(JMAP.id);

    expect(new Set(sentUids()).size).toBe(PAGE);
    expect(sync.syncNow).toHaveBeenCalledTimes(1);
  });

  it('the fill ends by adding rows: a reply sent while it ran stays, a deleted or moved message stays gone', async () => {
    prime(JMAP);
    let release;
    sync.waitForSync.mockImplementation(() => new Promise(resolve => { release = () => resolve({ success: true }); }));
    await loadSentHeaders(JMAP.id);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    // While the daemon fills: a reply goes out, uid 5 is deleted, uid 300 is moved away.
    const reply = { uid: 90001, subject: 'Re:', _optimistic: true, _accountId: JMAP.id, flags: [], date: '2026-02-01T00:00:00Z' };
    useMailStore.setState(s => ({
      sentEmails: [...s.sentEmails.filter(e => e.uid !== 5), reply],
      deleteTombstones: new Set([`${JMAP.id}|Sent|5`, `${JMAP.id}|Sent|300`]),
    }));
    release();
    await _sentFillFor(JMAP.id);

    const uids = sentUids();
    expect(uids).toContain(90001);
    expect(uids).not.toContain(5);
    expect(uids).not.toContain(300);
    expect(new Set(uids).size).toBe(TOTAL - 1); // 450 rows, minus the moved one and the deleted one, plus the reply
  });

  it('IMAP: a first status read that says "not backfilling" before the backfill starts does not end the wait', async () => {
    prime(IMAP);
    await loadSentHeaders(IMAP.id);
    await _sentFillFor(IMAP.id);

    // false (too early), true, true, false, false: the wait outlasts the first false.
    expect(sync.getSyncStatus.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(new Set(sentUids()).size).toBe(TOTAL);
  });

  it('a backfill that never ends is a failed fill, retried later, not a recorded success', async () => {
    prime(IMAP);
    sync.getSyncStatus.mockResolvedValue({ backfilling: true });
    await loadSentHeaders(IMAP.id);
    await _sentFillFor(IMAP.id);
    sync.syncNow.mockClear();
    await loadSentHeaders(IMAP.id);
    await _sentFillFor(IMAP.id);

    // Within the retry window: not started again, and not forgotten as done either.
    expect(sync.syncNow).not.toHaveBeenCalled();
  });

  it('a load that started before the fill ended does not put its older read over the fill\'s rows', async () => {
    prime(JMAP);
    let releaseFill;
    let releaseLate;
    let pageOneCalls = 0;
    sync.waitForSync.mockImplementation(() => new Promise(resolve => { releaseFill = () => resolve({ success: true }); }));
    api.fetchEmails.mockImplementation(async (account, mailbox, page = 1, limit = 200) => {
      pageOneCalls += 1;
      if (pageOneCalls === 2) await new Promise(resolve => { releaseLate = resolve; });
      return { emails: rows(1, limit), total: TOTAL, hasMore: true, page };
    });
    await loadSentHeaders(JMAP.id);                         // starts the fill; the daemon is working
    const late = loadSentHeaders(JMAP.id);                  // reads the cache now, page one is on the wire
    await vi.waitFor(() => expect(releaseLate).toBeTypeOf('function'));
    await vi.waitFor(() => expect(releaseFill).toBeTypeOf('function'));
    releaseFill();
    await _sentFillFor(JMAP.id);                            // the fill ends and adds every row
    expect(new Set(sentUids()).size).toBe(TOTAL);
    releaseLate();
    await late;

    expect(new Set(sentUids()).size).toBe(TOTAL);
  });

  it('the fill replaces a staged reply with its server copy instead of listing both', async () => {
    prime(JMAP);
    let release;
    sync.waitForSync.mockImplementation(() => new Promise(resolve => { release = () => resolve({ success: true }); }));
    await loadSentHeaders(JMAP.id);
    const staged = { uid: 90002, messageId: '<s300@x>', subject: 'staged', _optimistic: true, _accountId: JMAP.id, flags: [], date: '2026-02-01T00:00:00Z' };
    useMailStore.setState(s => ({ sentEmails: [...s.sentEmails, staged] }));
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release();
    await _sentFillFor(JMAP.id);

    const copies = (useMailStore.getState().sentEmails || []).filter(e => e.messageId === '<s300@x>');
    expect(copies).toHaveLength(1);
    expect(copies[0]._optimistic).toBeFalsy();
  });

  it('a fill stops waiting when its account is removed', async () => {
    prime(JMAP);
    let release;
    sync.waitForSync.mockImplementation(() => new Promise(resolve => { release = () => resolve({ success: true }); }));
    await loadSentHeaders(JMAP.id);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    useMailStore.setState({ accounts: [] });
    db.getEmailHeadersWindow.mockClear();
    release();
    await _sentFillFor(JMAP.id);

    expect(db.getEmailHeadersWindow).not.toHaveBeenCalled();
  });
});

describe('an unchanged cache is not read again', () => {
  it('a cache-only read gives the window, and does not read an unchanged cache again', async () => {
    cache = rows(1, TOTAL);
    prime(IMAP);
    await loadSentHeaders(IMAP.id, { cacheOnly: true });
    expect(new Set(sentUids()).size).toBe(TOTAL);
    expect(api.fetchEmails).not.toHaveBeenCalled();

    db.getEmailHeadersWindow.mockClear();
    await loadSentHeaders(IMAP.id, { cacheOnly: true });
    expect(db.getEmailHeadersWindow).not.toHaveBeenCalled();
    expect(new Set(sentUids()).size).toBe(TOTAL);

    cache = [{ ...row(777), date: '2026-06-01T00:00:00Z' }, ...cache]; // the cache moved
    await loadSentHeaders(IMAP.id, { cacheOnly: true });
    expect(db.getEmailHeadersWindow).toHaveBeenCalled();
    expect(sentUids()).toContain(777);
  });

  it('the first page does not replace what the cache holds', async () => {
    cache = rows(1, TOTAL);
    prime(JMAP);
    await loadSentHeaders(JMAP.id);

    expect(new Set(sentUids()).size).toBe(TOTAL);
  });

  it('a full load of an unchanged, already merged cache does not read the cache again', async () => {
    cache = rows(1, TOTAL);
    prime(IMAP);
    await loadSentHeaders(IMAP.id);
    await _sentFillFor(IMAP.id);
    db.getEmailHeadersWindow.mockClear();
    api.fetchEmails.mockClear();
    await loadSentHeaders(IMAP.id);

    expect(db.getEmailHeadersWindow).not.toHaveBeenCalled();
    expect(api.fetchEmails).toHaveBeenCalledTimes(1); // page one still checks the server
    expect(new Set(sentUids()).size).toBe(TOTAL);
  });
});

describe('review defects of the window', () => {
  it('a message moved in long after it was sent (top uid, old date) does not stop the window short', async () => {
    cache = [{ ...row(9000), date: '2001-01-01T00:00:00Z' }, ...rows(1, TOTAL)];
    prime(IMAP, {}, { reach: 250 });
    await loadSentHeaders(IMAP.id, { cacheOnly: true });

    expect(new Set(sentUids()).size).toBe(250);
    expect(sentUids()).not.toContain(9000);
  });

  it('one stray old row at the head of the INBOX list does not set how far back the window reaches', async () => {
    cache = rows(1, TOTAL);
    prime(IMAP, {}, { reach: 250 });
    useMailStore.setState({ emails: [
      { uid: 90, subject: 'moved back', date: '2001-01-01T00:00:00Z', flags: [] },
      { uid: 91, subject: 'oldest of the page', date: row(250).date, flags: [] },
    ] });
    await loadSentHeaders(IMAP.id, { cacheOnly: true });

    expect(new Set(sentUids()).size).toBe(250);
  });

  it('another account\'s rows in the list do not set this account\'s reach', async () => {
    cache = rows(1, TOTAL);
    prime(IMAP, {}, { reach: 250 });
    useMailStore.setState({ emails: [
      { uid: 1, subject: 'mine', date: row(250).date, flags: [] },
      { uid: 2, subject: 'theirs', date: '2001-01-01T00:00:00Z', flags: [], _accountId: 'someone-else' },
    ] });
    await loadSentHeaders(IMAP.id, { cacheOnly: true });

    expect(new Set(sentUids()).size).toBe(250);
  });

  it('a list that does not thread Sent in (another folder) asks for the newest 200 only', async () => {
    cache = rows(1, TOTAL);
    prime(IMAP, {}, { reach: TOTAL });
    useMailStore.setState({ activeMailbox: 'Archive' });
    await loadSentHeaders(IMAP.id, { cacheOnly: true });

    expect(new Set(sentUids()).size).toBe(PAGE);
  });

  it('a cache read that failed leaves the mirror as it was and is read again later', async () => {
    cache = rows(1, TOTAL);
    prime(IMAP, {}, { reach: null });
    db.getEmailHeadersWindow.mockResolvedValueOnce(null);
    await loadSentHeaders(IMAP.id, { cacheOnly: true });
    expect(sentUids()).toEqual([]);

    await loadSentHeaders(IMAP.id, { cacheOnly: true });
    expect(new Set(sentUids()).size).toBe(PAGE);
  });

  it('a fill whose cache read failed does not wipe the mirror, and counts as failed', async () => {
    prime(IMAP);
    await loadSentHeaders(IMAP.id, { cacheOnly: false });
    // the fill is running now; its reread fails
    db.getEmailHeadersWindow.mockResolvedValue(null);
    await _sentFillFor(IMAP.id);

    expect(new Set(sentUids()).size).toBe(PAGE);
    sync.syncNow.mockClear();
    await loadSentHeaders(IMAP.id);
    await _sentFillFor(IMAP.id);
    expect(sync.syncNow).not.toHaveBeenCalled(); // failed fills wait out the retry window
  });

  it('a row moved away while a read was on the wire is not merged back', async () => {
    cache = rows(1, TOTAL);
    prime(IMAP, {}, { reach: null });
    useMailStore.setState({ deleteTombstones: new Set([`${IMAP.id}|Sent|5`]) });
    await loadSentHeaders(IMAP.id, { cacheOnly: true });

    expect(sentUids()).not.toContain(5);
    expect(new Set(sentUids()).size).toBe(PAGE - 1);
  });

  it('a reply that reached the mirror while the fill re-read the cache is not dropped by it', async () => {
    prime(IMAP);
    let reread;
    let release;
    // page one is read already; the fill's re-read is the next window read
    await loadSentHeaders(IMAP.id);
    const impl = db.getEmailHeadersWindow.getMockImplementation();
    db.getEmailHeadersWindow.mockImplementation(async (...a) => {
      reread = true;
      await new Promise(resolve => { release = resolve; });
      return impl(...a);
    });
    await vi.waitFor(() => expect(reread).toBe(true));
    const sent = { uid: 90003, messageId: '<new@x>', subject: 'new', flags: [], date: row(1).date, _accountId: IMAP.id, _fromSentFolder: true };
    useMailStore.setState(s => ({ sentEmails: [...s.sentEmails, sent] }));
    release();
    await _sentFillFor(IMAP.id);

    expect(sentUids()).toContain(90003);
  });
});
