// The Sent mirror merged into INBOX threads holds the WHOLE Sent folder, for
// every provider. It used to be the newest 200 (one server page, one cache read
// capped at 200), so a thread's older replies were missing from it.
//   - the cache is read in full, not 200 rows of it;
//   - the server is paged to the end of the folder (IMAP and JMAP by page,
//     Graph by the date cursor), in the background, once at a time per account;
//   - a page never replaces what the cache already holds.
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
vi.mock('../../syncService', () => ({
  syncNow: vi.fn(), waitForSync: vi.fn(), watchAccount: vi.fn(), unwatchAccount: vi.fn(),
  getSyncStatus: vi.fn().mockResolvedValue({ backfilling: false }),
  toSyncAccount: (account, id = account?.id) => ({ id, email: account?.email, imapConfig: {} }),
}));

const { useMailStore } = await import('../../../stores/mailStore');
const { loadSentHeaders, _sentFillFor } = await import('../loadEmails');

const IMAP = { id: 'acct-i', email: 'i@mock.test', password: 'pw' };
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

beforeEach(() => {
  vi.clearAllMocks();
  db.getEmailHeadersMeta.mockResolvedValue({ totalCached: 0, totalEmails: 0 });
  db.getEmailHeadersPartial.mockResolvedValue({ emails: [], totalEmails: 0 });
  db.saveEmailHeaders.mockResolvedValue(undefined);
  db.getCachedMailboxes.mockResolvedValue(null);

  // IMAP: newest first, uid = position + 1, `limit` per page.
  api.fetchEmails.mockImplementation(async (account, mailbox, page = 1, limit = 200) => {
    const from = (page - 1) * limit;
    const emails = rows(from + 1, Math.max(0, Math.min(limit, TOTAL - from)));
    return { emails, total: TOTAL, hasMore: from + emails.length < TOTAL, page };
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
  it('IMAP: pages past the first 200 and merges every row', async () => {
    prime(IMAP);
    await loadSentHeaders(IMAP.id);
    await _sentFillFor(IMAP.id);

    expect(api.fetchEmails.mock.calls.map(c => c[2])).toEqual([1, 2, 3]);
    expect(new Set(sentUids()).size).toBe(TOTAL);
    // Every page is cached, with the server's own count.
    for (const call of db.saveEmailHeaders.mock.calls) expect(call[3]).toBe(TOTAL);
    expect(db.saveEmailHeaders).toHaveBeenCalledTimes(3);
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

  it('reads the whole cache, not 200 rows of it, and asks the server for page one only', async () => {
    db.getEmailHeadersMeta.mockResolvedValue({ totalCached: TOTAL, totalEmails: TOTAL });
    db.getEmailHeadersPartial.mockImplementation(async (accountId, mailbox, limit) => ({
      emails: rows(1, Math.min(limit, TOTAL)), totalEmails: TOTAL,
    }));
    prime(IMAP);
    await loadSentHeaders(IMAP.id);
    await _sentFillFor(IMAP.id);

    expect(db.getEmailHeadersPartial).toHaveBeenCalledWith(IMAP.id, 'Sent', TOTAL);
    expect(api.fetchEmails.mock.calls.map(c => c[2])).toEqual([1]);
    expect(new Set(sentUids()).size).toBe(TOTAL);
  });

  it('a cache-only read gives the whole cache', async () => {
    db.getEmailHeadersMeta.mockResolvedValue({ totalCached: TOTAL, totalEmails: TOTAL });
    db.getEmailHeadersPartial.mockImplementation(async (accountId, mailbox, limit) => ({
      emails: rows(1, Math.min(limit, TOTAL)), totalEmails: TOTAL,
    }));
    prime(IMAP);
    await loadSentHeaders(IMAP.id, { cacheOnly: true });

    expect(new Set(sentUids()).size).toBe(TOTAL);
    expect(api.fetchEmails).not.toHaveBeenCalled();
  });

  it('the first page does not replace what the cache holds', async () => {
    // 450 cached, a server page of 200: the merged list is still 450.
    db.getEmailHeadersMeta.mockResolvedValue({ totalCached: TOTAL, totalEmails: TOTAL });
    db.getEmailHeadersPartial.mockImplementation(async (a, m, limit) => ({ emails: rows(1, Math.min(limit, TOTAL)) }));
    prime(IMAP);
    await loadSentHeaders(IMAP.id);

    expect(new Set(sentUids()).size).toBe(TOTAL);
  });

  it('one fill per account at a time', async () => {
    prime(IMAP);
    await Promise.all([loadSentHeaders(IMAP.id), loadSentHeaders(IMAP.id)]);
    await _sentFillFor(IMAP.id);

    const pageTwo = api.fetchEmails.mock.calls.filter(c => c[2] === 2);
    expect(pageTwo).toHaveLength(1);
  });

  it('a failed page leaves what was merged and ends the fill', async () => {
    prime(IMAP);
    api.fetchEmails.mockImplementationOnce(async () => ({ emails: rows(1, PAGE), total: TOTAL, hasMore: true }))
      .mockRejectedValueOnce(new Error('connection lost'));
    await loadSentHeaders(IMAP.id);
    await _sentFillFor(IMAP.id);

    expect(new Set(sentUids()).size).toBe(PAGE);
    expect(api.fetchEmails).toHaveBeenCalledTimes(2);
  });
});
