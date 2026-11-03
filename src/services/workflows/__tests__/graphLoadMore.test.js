// A Microsoft (Graph) folder bigger than one page of 200.
//
// Graph has no IMAP, so the list pages it through `listGraphMessages` with a
// skip. Before the fix the first page was all there was: loadMoreEmails went
// to `imap_get_emails` for a Graph account, which cannot page it, failed
// without a word and stopped retrying because totalEmails was the page length
// (200) and 200 rows were already loaded.
//   - load-more reads the next Graph page from the number of server rows held;
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
const { getLoadMoreTimer } = await import('../../../stores/slices/messageListSlice');

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
    loadingMore: false,
    mailboxes: [INBOX, SENT],
    localFolders: {},
    loadSentHeaders: vi.fn(),
    ...extra,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
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
  api.fetchEmails.mockRejectedValue(new Error('E_GRAPH_NOT_IMAP'));
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

  it('counts only server rows when it picks the skip (a local draft row is not a Graph message)', async () => {
    prime({ emails: [...rows(1, PAGE), { uid: 9001, subject: 'draft', source: 'local', isLocal: true, flags: ['draft'] }] });
    await useMailStore.getState().loadMoreEmails();
    clearTimeout(getLoadMoreTimer());

    expect(graph.listGraphMessages).toHaveBeenCalledWith(
      ACCOUNT.id, 'INBOX', ACCOUNT, 'fld-inbox', { top: PAGE, skip: PAGE });
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
    const saved = db.saveEmailHeaders.mock.calls.find(c => c[1] === 'INBOX');
    expect(saved[3]).toBe(FOLDER_TOTAL);
  });
});
