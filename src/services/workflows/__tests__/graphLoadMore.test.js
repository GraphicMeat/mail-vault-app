// A Microsoft (Graph) folder bigger than one page of 200.
//
// Graph has no IMAP, so the list pages it through `listGraphMessages` with a
// skip. Before the fix the first page was all there was: loadMoreEmails went
// to `imap_get_emails` for a Graph account, which cannot page it, failed
// without a word and stopped retrying because totalEmails was the page length
// (200) and 200 rows were already loaded.
//   - load-more reads the next Graph page from a cursor the first listing set,
//     not from a count of the rows held (the cache paint and the cache drain
//     add rows that are not the server's newest N, and a count over them
//     leaves a gap that never closes);
//   - the folder total is the folder's own count, not the length of page one;
//   - the last page (no nextLink) ends the paging, whatever the total said.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { serverUids } from '../../../stores/slices/serverUids';
import { graphFoldersToMailboxes } from '../../graphConfig';

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
const { forget: forgetMemo } = await import('../../headerMemo');
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

// The server side: FOLDER_TOTAL messages, newest first, uid = position + 1.
function serveFolder() {
  graph.listGraphMessages.mockImplementation(async (accountId, mailbox, account, folderId, { top = 200, skip = 0 } = {}) => {
    const n = Math.max(0, Math.min(top, FOLDER_TOTAL - skip));
    return { headers: rows(skip + 1, n), nextLink: skip + n < FOLDER_TOTAL ? `link-${skip + n}` : null };
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
    _graphCursor: { key: `${ACCOUNT.id}:INBOX`, skip: PAGE },
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
      ACCOUNT.id, 'INBOX', ACCOUNT, 'fld-inbox', { top: PAGE, skip: PAGE });
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
      ACCOUNT.id, 'INBOX', ACCOUNT, 'fld-inbox', { top: PAGE, skip: PAGE });
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
      ACCOUNT.id, 'INBOX', ACCOUNT, 'fld-inbox', { top: PAGE, skip: PAGE });
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
    expect(useMailStore.getState()._graphCursor).toEqual({ key: `${ACCOUNT.id}:INBOX`, skip: 2 * PAGE });

    await useMailStore.getState().loadMoreEmails();
    clearTimeout(getLoadMoreTimer());
    expect(graph.listGraphMessages).toHaveBeenLastCalledWith(
      ACCOUNT.id, 'INBOX', ACCOUNT, 'fld-inbox', { top: PAGE, skip: 2 * PAGE });
    expect(new Set(useMailStore.getState().emails.map(e => e.uid)).size).toBe(FOLDER_TOTAL);
  });

  it('starts from the top when no listing set a cursor (a list painted from the cache)', async () => {
    prime({ _graphCursor: null });
    await useMailStore.getState().loadMoreEmails();
    clearTimeout(getLoadMoreTimer());

    expect(graph.listGraphMessages).toHaveBeenCalledWith(
      ACCOUNT.id, 'INBOX', ACCOUNT, 'fld-inbox', { top: PAGE, skip: 0 });
    expect(useMailStore.getState().emails).toHaveLength(PAGE); // all of it already held
    expect(useMailStore.getState()._graphCursor.skip).toBe(PAGE);
  });

  it('ignores a cursor that belongs to another folder', async () => {
    prime({ _graphCursor: { key: `${ACCOUNT.id}:Sent`, skip: 3 } });
    await useMailStore.getState().loadMoreEmails();
    clearTimeout(getLoadMoreTimer());

    expect(graph.listGraphMessages).toHaveBeenCalledWith(
      ACCOUNT.id, 'INBOX', ACCOUNT, 'fld-inbox', { top: PAGE, skip: 0 });
  });

  it('drops a page that a refresh outran: the refresh reset the list and the cursor', async () => {
    prime({ emails: rows(1, 2 * PAGE), _graphCursor: { key: `${ACCOUNT.id}:INBOX`, skip: 2 * PAGE } });
    graph.listGraphMessages.mockImplementationOnce(async () => {
      // A reload lands while the page is on the wire: page one again.
      useMailStore.setState({ emails: rows(1, PAGE), _graphCursor: { key: `${ACCOUNT.id}:INBOX`, skip: PAGE } });
      return { headers: rows(2 * PAGE + 1, PAGE), nextLink: 'x' };
    });
    await useMailStore.getState().loadMoreEmails();
    clearTimeout(getLoadMoreTimer());

    const s = useMailStore.getState();
    expect(s.emails).toHaveLength(PAGE); // page three was not appended onto page one
    expect(s._graphCursor.skip).toBe(PAGE);
    expect(s.loadingMore).toBe(false);
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
    expect(s._graphCursor).toEqual({ key: `${ACCOUNT.id}:INBOX`, skip: PAGE });
    const saved = db.saveEmailHeaders.mock.calls.find(c => c[1] === 'INBOX');
    expect(saved[3]).toBe(FOLDER_TOTAL);
  });
});
