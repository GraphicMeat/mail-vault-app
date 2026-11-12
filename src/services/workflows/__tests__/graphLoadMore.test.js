// A Microsoft (Graph) folder bigger than one page of 200.
//
// Graph has no IMAP, so the list pages it through `listGraphMessages` with a
// skip. Before the fix the first page was all there was: loadMoreEmails went
// to `imap_get_emails` for a Graph account, which cannot page it, failed
// without a word and stopped retrying because totalEmails was the page length
// (200) and 200 rows were already loaded.
//   - load-more reads the next Graph page from a cursor the first listing set
//     (the oldest moment listed, and how many rows sit on it), not from a count
//     of the rows held (the cache paint and the cache drain add rows that are
//     not the server's newest N) and not from a bare skip (a message deleted
//     elsewhere between two pages moves every row behind it up one place);
//   - a reload keeps the older rows already paged in;
//   - the folder total is the folder's own count, not the length of page one;
//   - the last page (no nextLink) ends the paging, whatever the total said.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { serverUids } from '../../../stores/slices/serverUids';
import { graphFoldersToMailboxes } from '../../graphConfig';
import { graphCursorAfter } from '../../graphCursor';

if (!globalThis.window) {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
} else {
  globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
}
vi.stubGlobal('navigator', { onLine: true });

const db = vi.hoisted(() => ({
  getCachedMailboxEntry: vi.fn(),
  getEmailHeadersMeta: vi.fn(),
  getEmailHeadersPartial: vi.fn(),
  getVaultUidSets: vi.fn(),
  getArchivedEmails: vi.fn(),
  readLocalEmailIndex: vi.fn(),
  saveEmailHeaders: vi.fn(),
  saveMailboxes: vi.fn(),
  listCachedUids: vi.fn(),
  getEmailHeadersByUids: vi.fn(),
  clearMailboxCache: vi.fn(),
  initDB: vi.fn(),
  getAccounts: vi.fn(),
  ensureAccountsInFile: vi.fn(),
}));
vi.mock('../../db', () => db);

const api = vi.hoisted(() => ({
  fetchMailboxes: vi.fn(),
  fetchEmails: vi.fn(),
  checkMailboxStatus: vi.fn(),
  searchAllUids: vi.fn(),
  fetchHeadersByUids: vi.fn(),
  fetchChangedFlags: vi.fn(),
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
vi.mock('../../syncService', () => ({
  syncNow: vi.fn(), waitForSync: vi.fn(), watchAccount: vi.fn(), unwatchAccount: vi.fn(),
  getSyncStatus: vi.fn().mockResolvedValue({ backfilling: false }),
  toSyncAccount: (account, id = account?.id) => ({ id, email: account?.email, imapConfig: {} }),
}));

const { useMailStore } = await import('../../../stores/mailStore');
await import('../bindStoreActions');
const { forget: forgetMemo } = await import('../../headerMemo');
const { _graphRevalidationFor, _resetGraphRevalidation } = await import('../loadEmails');
const { getLoadMoreTimer, setLoadMoreTimer } = await import('../../../stores/slices/messageListSlice');

const ACCOUNT = { id: 'acct-g', email: 'g@hotmail.test', oauth2Transport: 'graph' };
const PAGE = 200;
const FOLDER_TOTAL = 450;
const INBOX = { path: 'INBOX', name: 'INBOX', delimiter: '/', children: [], _graphFolderId: 'fld-inbox', _graphTotal: FOLDER_TOTAL };
const SENT = { path: 'Sent', name: 'Sent', delimiter: '/', children: [], _graphFolderId: 'fld-sent', _graphTotal: 3 };

const row = (uid) => ({
  uid, subject: `m${uid}`, date: new Date(Date.UTC(2026, 0, 1) - uid * 60000).toISOString(),
  flags: [], source: 'server', _graphId: `g${uid}`,
});
const rows = (from, n) => Array.from({ length: n }, (_, i) => row(from + i));

// The server side: newest first, `before` is "received at or before", then a skip.
let server;
const KEY = `${ACCOUNT.id}:INBOX`;
const cursorAfter = (n) => graphCursorAfter(KEY, server.slice(0, n), null);
function serveFolder() {
  server = rows(1, FOLDER_TOTAL);
  graph.listGraphMessages.mockImplementation(async (accountId, mailbox, account, folderId, { top = 200, skip = 0, before } = {}) => {
    const list = before ? server.filter(r => r.date <= before) : server;
    const page = list.slice(skip, skip + top);
    return { headers: page.map(r => ({ ...r })), nextLink: skip + page.length < list.length ? `link-${skip + page.length}` : null };
  });
}

function prime(extra = {}) {
  useMailStore.setState({
    accounts: [ACCOUNT],
    activeAccountId: ACCOUNT.id,
    activeMailbox: 'INBOX',
    mailboxScope: null,
    unifiedInbox: false,
    viewMode: 'all',
    emails: rows(1, PAGE), sortedEmails: [], localEmails: [], sentEmails: [],
    savedEmailIds: new Set(), archivedEmailIds: new Set(),
    serverUids: serverUids(new Set(), { complete: false }),
    deleteTombstones: new Set(),
    totalEmails: FOLDER_TOTAL,
    hasMoreEmails: true,
    currentPage: 1,
    _graphCursor: cursorAfter(PAGE),
    loadingMore: false,
    mailboxes: [INBOX, SENT],
    localFolders: {},
    loadSentHeaders: vi.fn(),
    ...extra,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  clearTimeout(getLoadMoreTimer());
  setLoadMoreTimer(null);
  _resetGraphRevalidation();
  forgetMemo(ACCOUNT.id);
  db.getCachedMailboxEntry.mockResolvedValue({ mailboxes: [INBOX, SENT], fetchedAt: Date.now() });
  db.getEmailHeadersMeta.mockResolvedValue(null);
  db.getEmailHeadersPartial.mockResolvedValue({ emails: [], totalEmails: 0 });
  db.getVaultUidSets.mockResolvedValue({ saved: new Set(), archived: new Set() });
  db.getArchivedEmails.mockResolvedValue([]);
  db.readLocalEmailIndex.mockResolvedValue(null);
  db.saveEmailHeaders.mockResolvedValue(undefined);
  db.saveMailboxes.mockResolvedValue(undefined);
  api.listLocalFolders.mockResolvedValue([]);
  api.fetchEmails.mockRejectedValue(new Error('IMAP cannot page a Graph account'));
  serveFolder();
});

describe('a Graph folder bigger than one page', () => {
  it('load-more reads the next Graph page by skip, never over IMAP', async () => {
    prime();
    await useMailStore.getState().loadMoreEmails();
    clearTimeout(getLoadMoreTimer());

    expect(api.fetchEmails).not.toHaveBeenCalled();
    expect(graph.listGraphMessages).toHaveBeenCalledWith(
      ACCOUNT.id, 'INBOX', ACCOUNT, 'fld-inbox', { top: PAGE, skip: 1, before: row(PAGE).date });
    const s = useMailStore.getState();
    expect(s.emails.map(e => e.uid)).toEqual(rows(1, 2 * PAGE).map(e => e.uid));
    expect(s.hasMoreEmails).toBe(true);
    expect(s.totalEmails).toBe(FOLDER_TOTAL);
    expect(s.loadingMore).toBe(false);
  });

  it('pages to the end of the folder, then stops', async () => {
    prime();
    for (let i = 0; i < 3; i++) {
      await useMailStore.getState().loadMoreEmails();
      clearTimeout(getLoadMoreTimer());
    }

    const s = useMailStore.getState();
    expect(s.emails).toHaveLength(FOLDER_TOTAL);
    expect(new Set(s.emails.map(e => e.uid)).size).toBe(FOLDER_TOTAL);
    expect(s.hasMoreEmails).toBe(false);
    expect(s.totalEmails).toBe(FOLDER_TOTAL);
    // Two pages were left (200, then 50); a third call has nothing to fetch.
    expect(graph.listGraphMessages).toHaveBeenCalledTimes(2);
    expect(api.fetchEmails).not.toHaveBeenCalled();
  });

  it('skips by the cursor, not by the rows held: cached rows beside page one leave no gap', async () => {
    // 300 arrivals since the cache was written: the store holds page one (the
    // newest 200) plus 1000 older rows the cache painted. Counting rows would
    // skip 1200 and never fetch the arrivals in between.
    const cached = Array.from({ length: 1000 }, (_, i) => ({ ...row(5001 + i), source: 'cache' }));
    prime({ emails: [...rows(1, PAGE), ...cached] });
    await useMailStore.getState().loadMoreEmails();
    clearTimeout(getLoadMoreTimer());

    expect(graph.listGraphMessages).toHaveBeenCalledWith(
      ACCOUNT.id, 'INBOX', ACCOUNT, 'fld-inbox', { top: PAGE, skip: 1, before: row(PAGE).date });
  });

  it('shows the cache\'s older rows, and still asks the server for the next page', async () => {
    // The cache's own "nothing left" is a count off a total that was one page
    // long: it must neither end the paging nor hide what the cache holds when
    // the server cannot be reached.
    db.getEmailHeadersMeta.mockResolvedValue({ totalCached: 1000, totalEmails: PAGE });
    db.listCachedUids.mockResolvedValue({ uids: Array.from({ length: 1000 }, (_, i) => i + 1) });
    db.getEmailHeadersByUids.mockResolvedValue(rows(5001, 800));
    prime();
    await useMailStore.getState().loadMoreEmails();
    clearTimeout(getLoadMoreTimer());

    const s = useMailStore.getState();
    expect(s.emails.length).toBeGreaterThanOrEqual(PAGE + 800);
    expect(graph.listGraphMessages).toHaveBeenCalledWith(
      ACCOUNT.id, 'INBOX', ACCOUNT, 'fld-inbox', { top: PAGE, skip: 1, before: row(PAGE).date });
    expect(s.hasMoreEmails).toBe(true);
  });

  it('keeps the cache\'s rows when the server cannot be reached', async () => {
    db.getEmailHeadersMeta.mockResolvedValue({ totalCached: 1000, totalEmails: PAGE });
    db.listCachedUids.mockResolvedValue({ uids: Array.from({ length: 1000 }, (_, i) => i + 1) });
    db.getEmailHeadersByUids.mockResolvedValue(rows(5001, 800));
    graph.listGraphMessages.mockRejectedValue(new Error('429'));
    prime();
    await useMailStore.getState().loadMoreEmails();
    clearTimeout(getLoadMoreTimer());

    expect(useMailStore.getState().emails.length).toBeGreaterThanOrEqual(PAGE + 800);
  });

  it('advances the cursor by what the server returned, repeats or not', async () => {
    // Page two overlaps rows the store already holds (a cache paint).
    prime({ emails: [...rows(1, PAGE), ...rows(201, 100).map(e => ({ ...e, source: 'cache' }))] });
    await useMailStore.getState().loadMoreEmails();
    clearTimeout(getLoadMoreTimer());
    expect(useMailStore.getState()._graphCursor).toEqual({ key: KEY, before: row(2 * PAGE).date, skip: 1 });

    await useMailStore.getState().loadMoreEmails();
    clearTimeout(getLoadMoreTimer());
    expect(graph.listGraphMessages).toHaveBeenLastCalledWith(
      ACCOUNT.id, 'INBOX', ACCOUNT, 'fld-inbox', { top: PAGE, skip: 1, before: row(2 * PAGE).date });
    expect(new Set(useMailStore.getState().emails.map(e => e.uid)).size).toBe(FOLDER_TOTAL);
  });

  it('starts from the top when no listing set a cursor (a list painted from the cache)', async () => {
    prime({ _graphCursor: null });
    await useMailStore.getState().loadMoreEmails();
    clearTimeout(getLoadMoreTimer());

    expect(graph.listGraphMessages).toHaveBeenCalledWith(
      ACCOUNT.id, 'INBOX', ACCOUNT, 'fld-inbox', { top: PAGE, skip: 0 });
    expect(useMailStore.getState().emails).toHaveLength(PAGE); // all of it already held
    expect(useMailStore.getState()._graphCursor).toEqual({ key: KEY, before: row(PAGE).date, skip: 1 });
  });

  it('ignores a cursor that belongs to another folder', async () => {
    prime({ _graphCursor: { key: `${ACCOUNT.id}:Sent`, before: row(3).date, skip: 3 } });
    await useMailStore.getState().loadMoreEmails();
    clearTimeout(getLoadMoreTimer());

    expect(graph.listGraphMessages).toHaveBeenCalledWith(
      ACCOUNT.id, 'INBOX', ACCOUNT, 'fld-inbox', { top: PAGE, skip: 0 });
  });

  it('drops a page that a refresh outran: the refresh reset the list and the cursor', async () => {
    prime({ emails: rows(1, 2 * PAGE), _graphCursor: cursorAfter(2 * PAGE) });
    graph.listGraphMessages.mockImplementationOnce(async () => {
      // A reload lands while the page is on the wire: page one again.
      useMailStore.setState({ emails: rows(1, PAGE), _graphCursor: cursorAfter(PAGE) });
      return { headers: rows(2 * PAGE + 1, PAGE), nextLink: 'x' };
    });
    await useMailStore.getState().loadMoreEmails();
    clearTimeout(getLoadMoreTimer());

    const s = useMailStore.getState();
    expect(s.emails).toHaveLength(PAGE); // page three was not appended onto page one
    expect(s._graphCursor).toEqual(cursorAfter(PAGE));
    expect(s.loadingMore).toBe(false);
  });

  it('a message deleted elsewhere between two pages leaves no gap', async () => {
    prime();
    // Gone on the server after page one was read: every row behind it moves up
    // one place, so a bare skip of 200 would start at uid 202 and lose uid 201.
    server.splice(9, 1);
    for (let i = 0; i < 3; i++) {
      await useMailStore.getState().loadMoreEmails();
      clearTimeout(getLoadMoreTimer());
    }

    const held = new Set(useMailStore.getState().emails.map(e => e.uid));
    for (const r of server) expect(held.has(r.uid), `uid ${r.uid}`).toBe(true);
  });

  it('pages through a run of mail that arrived at the same moment', async () => {
    // A migrated mailbox: 200 messages stamped with one received time, wider
    // than a page. A moment alone would never advance; the tie count does.
    const T = row(150).date;
    server = server.map(r => (r.uid >= 150 && r.uid <= 349 ? { ...r, date: T } : r));
    prime({ emails: server.slice(0, PAGE).map(r => ({ ...r })), _graphCursor: cursorAfter(PAGE) });
    for (let i = 0; i < 4; i++) {
      await useMailStore.getState().loadMoreEmails();
      clearTimeout(getLoadMoreTimer());
    }

    const held = new Set(useMailStore.getState().emails.map(e => e.uid));
    for (const r of server) expect(held.has(r.uid), `uid ${r.uid}`).toBe(true);
    expect(useMailStore.getState().hasMoreEmails).toBe(false);
  });

  it('a reload keeps the older rows already paged in, and the cursor that covers them', async () => {
    const deep = { key: KEY, before: row(400).date, skip: 1 };
    prime({ emails: rows(1, 400), _graphCursor: deep, totalEmails: FOLDER_TOTAL });
    await useMailStore.getState().loadEmails();
    clearTimeout(getLoadMoreTimer());

    const s = useMailStore.getState();
    expect(graph.listGraphMessages).toHaveBeenCalledTimes(1);
    expect(graph.listGraphMessages).toHaveBeenCalledWith(ACCOUNT.id, 'INBOX', ACCOUNT, 'fld-inbox');
    expect(s.emails).toHaveLength(400);
    expect(new Set(s.emails.map(e => e.uid)).size).toBe(400);
    expect(s._graphCursor).toEqual(deep);
    expect(s.hasMoreEmails).toBe(true);
  });

  it('a reload re-checks the older rows it kept: gone elsewhere leaves, a changed flag arrives', async () => {
    const deep = { key: KEY, before: row(400).date, skip: 1 };
    prime({ emails: rows(1, 400), _graphCursor: deep });
    // On the server now: uid 250 deleted, uid 300 read.
    server = server.filter(r => r.uid !== 250).map(r => (r.uid === 300 ? { ...r, flags: ['\\Seen'] } : r));
    await useMailStore.getState().loadEmails();
    await _graphRevalidationFor(KEY);
    clearTimeout(getLoadMoreTimer());

    const s = useMailStore.getState();
    expect(s.emails.some(e => e.uid === 250)).toBe(false);
    expect(s.emails.find(e => e.uid === 300).flags).toContain('\\Seen');
    expect(s.emails.some(e => e.uid === 399)).toBe(true);
    expect(s.serverUids.uids.has(250)).toBe(false);
    expect(db.saveEmailHeaders.mock.calls.some(c => c[4]?.removedUids?.includes(250))).toBe(true);
    // The walk stayed inside what was kept: it never reached uid 450's page.
    for (const call of graph.listGraphMessages.mock.calls.slice(1)) expect(call[4].top).toBe(PAGE);
  });

  it('a walk that failed is not restarted by the next reload at once', async () => {
    prime({ emails: rows(1, 400), _graphCursor: { key: KEY, before: row(400).date, skip: 1 } });
    const listing = graph.listGraphMessages.getMockImplementation();
    graph.listGraphMessages
      .mockImplementationOnce(listing)
      .mockRejectedValueOnce(new Error('429'));
    await useMailStore.getState().loadEmails();
    await _graphRevalidationFor(KEY);
    const calls = graph.listGraphMessages.mock.calls.length;
    await useMailStore.getState().loadEmails();
    await _graphRevalidationFor(KEY);

    expect(graph.listGraphMessages.mock.calls.length).toBe(calls + 1); // page one only
  });

  it('a row tied with the page\'s oldest moment that the walk missed is not taken for deleted', async () => {
    const T = row(190).date;
    server = server.map(r => (r.uid >= 190 && r.uid <= 260 ? { ...r, date: T } : r));
    prime({ emails: server.slice(0, 400).map(r => ({ ...r })), _graphCursor: cursorAfter(400) });
    // Graph has no order inside a tie: the walk's page leaves uid 255 out.
    const listing = graph.listGraphMessages.getMockImplementation();
    graph.listGraphMessages
      .mockImplementationOnce(listing)
      .mockImplementationOnce(async (...args) => {
        const page = await listing(...args);
        return { ...page, headers: page.headers.filter(h => h.uid !== 255) };
      });
    await useMailStore.getState().loadEmails();
    await _graphRevalidationFor(KEY);

    expect(useMailStore.getState().emails.some(e => e.uid === 255)).toBe(true);
    expect(db.saveEmailHeaders.mock.calls.some(c => c[4]?.removedUids?.includes(255))).toBe(false);
  });

  it('a row tied with the edge between two walk pages that the walk missed is not taken for deleted', async () => {
    const T = row(395).date;
    server = server.map(r => (r.uid >= 395 && r.uid <= 420 ? { ...r, date: T } : r));
    prime({ emails: server.slice(0, 450).map(r => ({ ...r })), _graphCursor: cursorAfter(450) });
    const listing = graph.listGraphMessages.getMockImplementation();
    graph.listGraphMessages
      .mockImplementationOnce(listing)   // page one
      .mockImplementationOnce(listing)   // walk page A: ends inside the run
      .mockImplementationOnce(async (...args) => {   // walk page B: Graph leaves uid 410 off
        const page = await listing(...args);
        return { ...page, headers: page.headers.filter(h => h.uid !== 410) };
      });
    await useMailStore.getState().loadEmails();
    await _graphRevalidationFor(KEY);

    expect(useMailStore.getState().emails.some(e => e.uid === 410)).toBe(true);
    expect(db.saveEmailHeaders.mock.calls.some(c => c[4]?.removedUids?.includes(410))).toBe(false);
  });

  it('a reload does not walk the kept rows again within minutes', async () => {
    prime({ emails: rows(1, 400), _graphCursor: { key: KEY, before: row(400).date, skip: 1 } });
    await useMailStore.getState().loadEmails();
    await _graphRevalidationFor(KEY);
    const calls = graph.listGraphMessages.mock.calls.length;
    await useMailStore.getState().loadEmails();
    await _graphRevalidationFor(KEY);

    // Only the new page one: no second walk.
    expect(graph.listGraphMessages.mock.calls.length).toBe(calls + 1);
  });

  it('a reload that keeps nothing walks nothing', async () => {
    prime({ emails: rows(1, PAGE), _graphCursor: cursorAfter(PAGE) });
    await useMailStore.getState().loadEmails();
    await _graphRevalidationFor(KEY);

    expect(graph.listGraphMessages).toHaveBeenCalledTimes(1);
  });

  it('a message that came back from another client is listed by the walk', async () => {
    prime({ emails: rows(1, 400), _graphCursor: { key: KEY, before: row(400).date, skip: 1 } });
    // uid 1000 was restored with an old receivedDateTime between 250 and 251.
    const back = { ...row(1000), date: new Date(new Date(row(250).date).getTime() - 1000).toISOString() };
    server = [...server.filter(r => r.date > back.date), back, ...server.filter(r => r.date <= back.date)];
    await useMailStore.getState().loadEmails();
    await _graphRevalidationFor(KEY);

    expect(useMailStore.getState().emails.some(e => e.uid === 1000)).toBe(true);
  });

  it('a reload that page one does not meet leaves the older rows to paging', async () => {
    // 100 mails arrived while the app was away: page one is the newest 200, the
    // held rows start 100 further down. Keeping them under the old cursor would
    // never list the gap between.
    server = server.slice(0, 450);
    const held = server.slice(300, 450).map(r => ({ ...r }));
    prime({ emails: held, _graphCursor: cursorAfter(450) });
    await useMailStore.getState().loadEmails();
    clearTimeout(getLoadMoreTimer());

    const s = useMailStore.getState();
    expect(s.emails.map(e => e.uid)).toEqual(rows(1, PAGE).map(e => e.uid));
    expect(s._graphCursor).toEqual(cursorAfter(PAGE));
  });

  it('a reload keeps rows that tie with the last row of page one', async () => {
    const T = row(190).date;
    server = server.map(r => (r.uid >= 190 && r.uid <= 260 ? { ...r, date: T } : r));
    prime({ emails: server.slice(0, 400).map(r => ({ ...r })), _graphCursor: cursorAfter(400) });
    await useMailStore.getState().loadEmails();
    clearTimeout(getLoadMoreTimer());

    expect(new Set(useMailStore.getState().emails.map(e => e.uid)).size).toBe(400);
  });

  it('a reload does not vouch for older rows the server never listed', async () => {
    // Rows 201-300 came from the cache paint: not in the server's uid set.
    const cached = rows(201, 100).map(e => ({ ...e, source: 'cache' }));
    prime({
      emails: [...rows(1, PAGE), ...cached],
      _graphCursor: cursorAfter(300),
      serverUids: serverUids(rows(1, PAGE).map(e => e.uid), { complete: false }),
    });
    await useMailStore.getState().loadEmails();
    clearTimeout(getLoadMoreTimer());

    const s = useMailStore.getState();
    expect(s.emails).toHaveLength(300);
    expect(s.serverUids.uids.has(250)).toBe(false);
    expect(s.serverUids.uids.has(150)).toBe(true);
  });

  it('a reload with no cursor to vouch for the older rows lists page one alone', async () => {
    prime({ emails: rows(1, 400), _graphCursor: null });
    await useMailStore.getState().loadEmails();
    clearTimeout(getLoadMoreTimer());

    const s = useMailStore.getState();
    expect(s.emails).toHaveLength(PAGE);
    expect(s._graphCursor).toEqual(cursorAfter(PAGE));
  });

  it('a failed page is retried: the list still knows more is there', async () => {
    prime();
    graph.listGraphMessages.mockRejectedValueOnce(new Error('network'));
    await useMailStore.getState().loadMoreEmails();

    const s = useMailStore.getState();
    expect(s.loadingMore).toBe(false);
    expect(s.hasMoreEmails).toBe(true);
    expect(s.emails).toHaveLength(PAGE);
    // The retry timer is armed (emails 200 < folder total 450).
    expect(getLoadMoreTimer()).toBeTruthy();
    clearTimeout(getLoadMoreTimer());
  });

  it('retries a failed page even when the folder count is unknown', async () => {
    // A folder list cached before _graphTotal existed: the total is the page.
    prime({ totalEmails: PAGE, mailboxes: [{ ...INBOX, _graphTotal: undefined }, SENT] });
    graph.listGraphMessages.mockRejectedValueOnce(new Error('429'));
    await useMailStore.getState().loadMoreEmails();

    expect(useMailStore.getState().hasMoreEmails).toBe(true);
    expect(getLoadMoreTimer()).toBeTruthy();
    clearTimeout(getLoadMoreTimer());
  });

  it('the folder listing carries the folder\'s own message count', () => {
    const [inbox] = graphFoldersToMailboxes([
      { id: 'fld-inbox', displayName: 'Inbox', storageKey: 'INBOX', wellKnownName: 'inbox', totalItemCount: 4321 },
    ]);
    expect(inbox._graphTotal).toBe(4321);
  });

  it('the first page reports the folder total, not the length of the page', async () => {
    prime({ emails: [], totalEmails: 0, hasMoreEmails: true, currentPage: 0 });
    await useMailStore.getState().loadEmails();
    clearTimeout(getLoadMoreTimer());

    const s = useMailStore.getState();
    expect(s.emails).toHaveLength(PAGE);
    expect(s.hasMoreEmails).toBe(true);
    expect(s.totalEmails).toBe(FOLDER_TOTAL);
    expect(s._graphCursor).toEqual(cursorAfter(PAGE));
    const saved = db.saveEmailHeaders.mock.calls.find(c => c[1] === 'INBOX');
    expect(saved[3]).toBe(FOLDER_TOTAL);
  });
});

// The list said 200 until a scroll: the first page counts the folder with
// `_graphTotal`, and a folder list cached before that field existed has none.
// Refreshing the list saved the count to disk and left the store without it,
// because a listing with the same folders did not count as a change. The jump
// on scroll was the cache drain filling the list, not the folder's count.
describe('the count of a Graph folder', () => {
  const COUNTLESS = { ...INBOX, _graphTotal: undefined };
  const STALE_MS = 11 * 60 * 1000;
  const listing = (total) => [
    { id: 'fld-inbox', displayName: 'Inbox', storageKey: 'INBOX', wellKnownName: 'inbox', totalItemCount: total },
    { id: 'fld-sent', displayName: 'Sent Items', storageKey: 'Sent', wellKnownName: 'sentitems', totalItemCount: 3 },
  ];
  const deferred = () => {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
  };
  const state = () => useMailStore.getState();
  const inboxCount = () => state().mailboxes.find(m => m.path === 'INBOX')?._graphTotal;
  const activate = () => state().activateAccount(ACCOUNT.id, 'INBOX', { _backgroundRefresh: true });
  const cached = (inbox, fetchedAt = Date.now()) => db.getCachedMailboxEntry.mockResolvedValue({ mailboxes: [inbox, SENT], fetchedAt });

  it('a reload lists the folders again when the fresh cached list has no count', async () => {
    cached(COUNTLESS);
    api.graphListFolders.mockResolvedValue(listing(FOLDER_TOTAL));
    prime({ emails: [], totalEmails: 0, mailboxes: [COUNTLESS, SENT] });
    await state().loadEmails();
    clearTimeout(getLoadMoreTimer());

    expect(state().emails).toHaveLength(PAGE);
    expect(state().totalEmails).toBe(FOLDER_TOTAL);
  });

  it('opening a folder lists the folders again when the fresh cached list has no count', async () => {
    cached(COUNTLESS);
    api.graphListFolders.mockResolvedValue(listing(FOLDER_TOTAL));
    prime({ emails: [], totalEmails: 0, mailboxes: [COUNTLESS, SENT] });
    await activate();
    clearTimeout(getLoadMoreTimer());

    await vi.waitFor(() => expect(state().totalEmails).toBe(FOLDER_TOTAL));
    expect(state().emails).toHaveLength(PAGE);
    expect(inboxCount()).toBe(FOLDER_TOTAL);
  });

  it('a listing that lands after page one corrects the count while the folder still pages', async () => {
    // A folder that grew past a page since the list was cached: 150 < 200.
    const grew = { ...INBOX, _graphTotal: 150 };
    cached(grew, Date.now() - STALE_MS);
    const folders = deferred();
    api.graphListFolders.mockReturnValue(folders.promise);
    prime({ emails: [], totalEmails: 0, mailboxes: [grew, SENT] });
    const opening = activate();
    await vi.waitFor(() => expect(state().emails).toHaveLength(PAGE));
    expect(state().totalEmails).toBe(PAGE);

    folders.resolve(listing(FOLDER_TOTAL));
    await opening;

    await vi.waitFor(() => expect(state().totalEmails).toBe(FOLDER_TOTAL));
    expect(inboxCount()).toBe(FOLDER_TOTAL);
    expect(state().emails).toHaveLength(PAGE);
  });

  it('page one that lands after the listing counts with what the listing said', async () => {
    cached(COUNTLESS, Date.now() - STALE_MS);
    api.graphListFolders.mockResolvedValue(listing(FOLDER_TOTAL));
    const page = deferred();
    const serve = graph.listGraphMessages.getMockImplementation();
    graph.listGraphMessages.mockImplementationOnce(async (...args) => {
      await page.promise;
      return serve(...args);
    });
    prime({ emails: [], totalEmails: 0, mailboxes: [COUNTLESS, SENT] });
    const opening = activate();
    await vi.waitFor(() => expect(inboxCount()).toBe(FOLDER_TOTAL));

    page.resolve();
    await opening;
    clearTimeout(getLoadMoreTimer());

    await vi.waitFor(() => expect(state().emails).toHaveLength(PAGE));
    expect(state().totalEmails).toBe(FOLDER_TOTAL);
  });

  it('a listing leaves the total alone once the server said there is no next page', async () => {
    // The last page ends the paging, whatever the folder count says.
    server = rows(1, 3);
    cached({ ...INBOX, _graphTotal: 3 }, Date.now() - STALE_MS);
    const folders = deferred();
    api.graphListFolders.mockReturnValue(folders.promise);
    prime({ emails: [], totalEmails: 0, hasMoreEmails: false, mailboxes: [{ ...INBOX, _graphTotal: 3 }, SENT] });
    const opening = activate();
    await vi.waitFor(() => expect(state().emails).toHaveLength(3));

    folders.resolve(listing(5));
    await opening;

    await vi.waitFor(() => expect(inboxCount()).toBe(5));
    expect(state().totalEmails).toBe(3);
  });
});
