// The Sent mirror merged into INBOX threads holds the WHOLE Sent folder, for
// every provider. It used to be the newest 200 (one server page, one cache read
// capped at 200, and the page REPLACED the cache's rows), so a thread's older
// replies were missing from it.
//   - the cache is read in full, not 200 rows of it;
//   - IMAP: the daemon syncs and backfills the Sent folder (sync.now), and the
//     mirror re-reads the cache when that is done: the app does not page IMAP;
//   - JMAP and Graph: the folder is paged in the background (Graph by the date
//     cursor), once at a time per account, once per session per folder;
//   - the fill only ADDS rows, once at its end: a reply sent or a message
//     deleted while it ran is not undone, and the list is rebuilt once;
//   - Graph: a row gone from the server is pruned when the walk reached the end.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { serverUids } from '../../../stores/slices/serverUids';
import { graphCursorAfter } from '../../graphCursor';

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
const { loadSentHeaders, _sentFillFor, _resetSentFills, _sentTimings } = await import('../loadEmails');

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

function prime(account, sentFolder = {}) {
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
    emails: [],
    serverUids: serverUids(new Set(), { complete: false }),
  });
}

const sentUids = () => (useMailStore.getState().sentEmails || []).map(e => e.uid);

// The header cache the daemon keeps: newest first. A save adds rows; removedUids drops them.
let cache;
let cacheStamp;

beforeEach(() => {
  vi.clearAllMocks();
  _resetSentFills();
  _sentTimings.pauseMs = 1;
  _sentTimings.pollMs = 1;
  cache = [];
  cacheStamp = 1;
  db.getEmailHeadersMeta.mockImplementation(async () => ({ totalCached: cache.length, totalEmails: cache.length, lastSynced: cacheStamp }));
  db.getEmailHeadersPartial.mockImplementation(async (a, m, limit) => ({ emails: cache.slice(0, limit).map(r => ({ ...r })), totalEmails: cache.length }));
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

describe('the Sent mirror holds the whole folder', () => {
  it('IMAP: the daemon fills the cache and the mirror re-reads it; the app pages nothing', async () => {
    prime(IMAP);
    await loadSentHeaders(IMAP.id);
    await _sentFillFor(IMAP.id);

    expect(api.fetchEmails.mock.calls.map(c => c[2])).toEqual([1]);
    expect(sync.syncNow).toHaveBeenCalledWith({ id: IMAP.id, email: IMAP.email, imapConfig: {} }, 'Sent');
    expect(sync.waitForSync).toHaveBeenCalledWith(7);
    expect(sync.getSyncStatus).toHaveBeenCalledWith(IMAP.id);
    expect(new Set(sentUids()).size).toBe(TOTAL);
  });

  it('JMAP: pages past the first 200 in the background and merges every row', async () => {
    prime(JMAP);
    await loadSentHeaders(JMAP.id);
    await _sentFillFor(JMAP.id);

    expect(api.fetchEmails.mock.calls.map(c => c[2])).toEqual([1, 2, 3]);
    expect(sync.syncNow).not.toHaveBeenCalled();
    expect(new Set(sentUids()).size).toBe(TOTAL);
    for (const call of db.saveEmailHeaders.mock.calls) expect(call[3]).toBe(TOTAL);
  });

  it('Graph: pages past the first 200 by the date cursor and merges every row', async () => {
    prime(GRAPH);
    await loadSentHeaders(GRAPH.id);
    await _sentFillFor(GRAPH.id);

    const calls = graph.listGraphMessages.mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls[0].slice(0, 4)).toEqual([GRAPH.id, 'Sent', GRAPH, 'fld-sent']);
    const afterOne = graphCursorAfter(`${GRAPH.id}:Sent`, rows(1, PAGE), null);
    expect(calls[1][4]).toEqual({ top: PAGE, skip: afterOne.skip, before: afterOne.before });
    expect(new Set(sentUids()).size).toBe(TOTAL);
  });

  it('reads the whole cache, not 200 rows of it, and starts no fill when the cache is whole', async () => {
    cache = rows(1, TOTAL);
    prime(IMAP);
    await loadSentHeaders(IMAP.id);
    await _sentFillFor(IMAP.id);

    expect(db.getEmailHeadersPartial).toHaveBeenCalledWith(IMAP.id, 'Sent', TOTAL);
    expect(sync.syncNow).not.toHaveBeenCalled();
    expect(new Set(sentUids()).size).toBe(TOTAL);
  });

  it('a cache-only read gives the whole cache, and does not read an unchanged cache again', async () => {
    cache = rows(1, TOTAL);
    prime(IMAP);
    await loadSentHeaders(IMAP.id, { cacheOnly: true });
    expect(new Set(sentUids()).size).toBe(TOTAL);
    expect(api.fetchEmails).not.toHaveBeenCalled();

    db.getEmailHeadersPartial.mockClear();
    await loadSentHeaders(IMAP.id, { cacheOnly: true });
    expect(db.getEmailHeadersPartial).not.toHaveBeenCalled();
    expect(new Set(sentUids()).size).toBe(TOTAL);

    cache = [{ ...row(777), date: '2025-01-01T00:00:00Z' }, ...cache]; // the cache moved
    await loadSentHeaders(IMAP.id, { cacheOnly: true });
    expect(db.getEmailHeadersPartial).toHaveBeenCalledTimes(1);
  });

  it('the first page does not replace what the cache holds', async () => {
    cache = rows(1, TOTAL);
    prime(JMAP);
    await loadSentHeaders(JMAP.id);

    expect(new Set(sentUids()).size).toBe(TOTAL);
  });

  it('one fill per account at a time, and one per session per folder', async () => {
    prime(JMAP);
    await Promise.all([loadSentHeaders(JMAP.id), loadSentHeaders(JMAP.id)]);
    await _sentFillFor(JMAP.id);
    await loadSentHeaders(JMAP.id);
    await _sentFillFor(JMAP.id);

    expect(api.fetchEmails.mock.calls.filter(c => c[2] === 2)).toHaveLength(1);
  });

  it('a failed page leaves what was merged, ends the fill, and is not retried at once', async () => {
    prime(JMAP);
    api.fetchEmails.mockImplementationOnce(async () => ({ emails: rows(1, PAGE), total: TOTAL, hasMore: true }))
      .mockRejectedValueOnce(new Error('connection lost'));
    await loadSentHeaders(JMAP.id);
    await _sentFillFor(JMAP.id);
    await loadSentHeaders(JMAP.id);
    await _sentFillFor(JMAP.id);

    expect(new Set(sentUids()).size).toBe(PAGE);
    // page one twice (two loads), page two once: the failed fill is not restarted.
    expect(api.fetchEmails.mock.calls.map(c => c[2])).toEqual([1, 2, 1]);
  });

  it('the fill ends by adding rows: a reply sent while it ran stays, a message deleted while it ran stays gone', async () => {
    prime(JMAP);
    let release;
    api.fetchEmails.mockImplementation(async (account, mailbox, page = 1, limit = 200) => {
      if (page === 2) await new Promise(resolve => { release = resolve; });
      const from = (page - 1) * limit;
      const emails = rows(from + 1, Math.max(0, Math.min(limit, TOTAL - from)));
      return { emails, total: TOTAL, hasMore: from + emails.length < TOTAL, page };
    });
    await loadSentHeaders(JMAP.id);
    // While page two is on the wire: a reply goes out, uid 5 is deleted.
    const reply = { uid: 90001, subject: 'Re:', _optimistic: true, _accountId: JMAP.id, flags: [], date: '2026-02-01T00:00:00Z' };
    useMailStore.setState(s => ({
      sentEmails: [...s.sentEmails.filter(e => e.uid !== 5), reply],
      deleteTombstones: new Set([`${JMAP.id}|Sent|5`]),
    }));
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release();
    await _sentFillFor(JMAP.id);

    const uids = sentUids();
    expect(uids).toContain(90001);
    expect(uids).not.toContain(5);
    expect(new Set(uids).size).toBe(TOTAL); // 450 server rows, minus the deleted one, plus the reply
  });

  it('IMAP: a first status read that says "not backfilling" before the backfill starts does not end the wait', async () => {
    prime(IMAP);
    await loadSentHeaders(IMAP.id);
    await _sentFillFor(IMAP.id);

    // false (too early), true, true, false, false: the wait outlasts the first false.
    expect(sync.getSyncStatus.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(new Set(sentUids()).size).toBe(TOTAL);
  });

  it('IMAP: a backfill that never ends is a failed fill, retried later, not a recorded success', async () => {
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

  it('Graph: a cached row tied with a page edge that the walk missed is not pruned', async () => {
    // 190..260 share one second: page one ends inside the run, and Graph leaves
    // uid 255 off the next page. It is not on the server's list this time; it is
    // not gone.
    const T = row(190).date;
    const server = rows(1, TOTAL).map(r => (r.uid >= 190 && r.uid <= 260 ? { ...r, date: T } : r));
    cache = [...server.slice(0, 260).map(r => ({ ...r })), { ...row(9999), date: '2020-01-01T00:00:00Z' }];
    graph.listGraphMessages.mockImplementation(async (accountId, mailbox, account, folderId, { top = 200, skip = 0, before } = {}) => {
      const list = before ? server.filter(r => r.date <= before) : server;
      let page = list.slice(skip, skip + top);
      if (before) page = page.filter(r => r.uid !== 255);
      return { headers: page.map(r => ({ ...r })), nextLink: skip + top < list.length ? 'next' : null };
    });
    prime(GRAPH);
    await loadSentHeaders(GRAPH.id);
    await _sentFillFor(GRAPH.id);

    expect(sentUids()).toContain(255);
    expect(sentUids()).not.toContain(9999);
    expect(db.saveEmailHeaders.mock.calls.some(c => c[4]?.removedUids?.includes(255))).toBe(false);
  });

  it('Graph: a cache with MORE rows than the folder is walked, so the stale rows are pruned', async () => {
    const stale = Array.from({ length: 10 }, (_, i) => ({ ...row(8000 + i), date: '2019-01-01T00:00:00Z' }));
    cache = [...rows(1, TOTAL), ...stale];
    prime(GRAPH);
    await loadSentHeaders(GRAPH.id);
    await _sentFillFor(GRAPH.id);

    expect(sentUids().some(uid => uid >= 8000)).toBe(false);
    expect(new Set(sentUids()).size).toBe(TOTAL);
  });

  it('a load that started before the fill ended does not put its older read over the fill\'s rows', async () => {
    prime(JMAP);
    let releaseTwo;
    let releaseLate;
    let pageOneCalls = 0;
    api.fetchEmails.mockImplementation(async (account, mailbox, page = 1, limit = 200) => {
      if (page === 1) { pageOneCalls += 1; if (pageOneCalls === 2) await new Promise(resolve => { releaseLate = resolve; }); }
      if (page === 2) await new Promise(resolve => { releaseTwo = resolve; });
      const from = (page - 1) * limit;
      const emails = rows(from + 1, Math.max(0, Math.min(limit, TOTAL - from)));
      return { emails, total: TOTAL, hasMore: from + emails.length < TOTAL, page };
    });
    await loadSentHeaders(JMAP.id);                         // starts the fill; page two is on the wire
    const late = loadSentHeaders(JMAP.id);                  // reads the cache now, page one is on the wire
    await vi.waitFor(() => expect(releaseLate).toBeTypeOf('function'));
    await vi.waitFor(() => expect(releaseTwo).toBeTypeOf('function'));
    releaseTwo();
    await _sentFillFor(JMAP.id);                            // the fill ends and adds every row
    expect(new Set(sentUids()).size).toBe(TOTAL);
    releaseLate();
    await late;

    expect(new Set(sentUids()).size).toBe(TOTAL);
  });

  it('the fill replaces a staged reply with its server copy instead of listing both', async () => {
    prime(JMAP);
    let release;
    api.fetchEmails.mockImplementation(async (account, mailbox, page = 1, limit = 200) => {
      if (page === 2) await new Promise(resolve => { release = resolve; });
      const from = (page - 1) * limit;
      const emails = rows(from + 1, Math.max(0, Math.min(limit, TOTAL - from)));
      return { emails, total: TOTAL, hasMore: from + emails.length < TOTAL, page };
    });
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

  it('a fill stops paging when its account is removed', async () => {
    prime(JMAP);
    let release;
    api.fetchEmails.mockImplementation(async (account, mailbox, page = 1, limit = 200) => {
      if (page === 2) await new Promise(resolve => { release = resolve; });
      const from = (page - 1) * limit;
      const emails = rows(from + 1, Math.max(0, Math.min(limit, TOTAL - from)));
      return { emails, total: TOTAL, hasMore: from + emails.length < TOTAL, page };
    });
    await loadSentHeaders(JMAP.id);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    useMailStore.setState({ accounts: [] });
    release();
    await _sentFillFor(JMAP.id);

    expect(api.fetchEmails.mock.calls.map(c => c[2])).toEqual([1, 2]);
  });

  it('a full load of an unchanged, already merged cache does not read the whole cache again', async () => {
    cache = rows(1, TOTAL);
    prime(IMAP);
    await loadSentHeaders(IMAP.id);
    await _sentFillFor(IMAP.id);
    db.getEmailHeadersPartial.mockClear();
    api.fetchEmails.mockClear();
    await loadSentHeaders(IMAP.id);

    expect(db.getEmailHeadersPartial).not.toHaveBeenCalled();
    expect(api.fetchEmails).toHaveBeenCalledTimes(1); // page one still checks the server
    expect(new Set(sentUids()).size).toBe(TOTAL);
  });

  it('Graph: a row the walk did not see, gone from the server, is pruned from the mirror and the cache', async () => {
    cache = [{ ...row(9999), date: '2020-01-01T00:00:00Z' }, ...rows(1, PAGE)];
    prime(GRAPH);
    await loadSentHeaders(GRAPH.id);
    await _sentFillFor(GRAPH.id);

    expect(sentUids()).not.toContain(9999);
    expect(db.saveEmailHeaders.mock.calls.some(c => c[4]?.removedUids?.includes(9999))).toBe(true);
    expect(new Set(sentUids()).size).toBe(TOTAL);
  });

  it('Graph: nothing is pruned when the walk did not reach the end', async () => {
    cache = [{ ...row(9999), date: '2020-01-01T00:00:00Z' }];
    prime(GRAPH);
    graph.listGraphMessages
      .mockImplementationOnce(async () => ({ headers: rows(1, PAGE).map(r => ({ ...r })), nextLink: 'next' }))
      .mockRejectedValue(new Error('429'));
    await loadSentHeaders(GRAPH.id);
    await _sentFillFor(GRAPH.id);

    expect(db.saveEmailHeaders.mock.calls.some(c => c[4]?.removedUids?.length)).toBe(false);
    expect(sentUids()).toContain(9999);
  });
});
