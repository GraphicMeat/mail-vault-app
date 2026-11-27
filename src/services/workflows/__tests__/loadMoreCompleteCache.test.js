// A cache the daemon reports as complete (its rows plus the UIDs the server
// lists but cannot serve cover the mailbox) is the whole mailbox. Once the
// store holds every cached row, scrolling to the bottom must end the paging:
// asking the server for page after page re-downloaded headers already on
// disk on every launch, for mail it could never return anyway.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { serverUids } from '../../../stores/slices/serverUids';

if (!globalThis.window) {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
} else {
  globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
}
vi.stubGlobal('navigator', { onLine: true });

const NAME = 'MBOX import 2026-09-29';
const FOLDER = { name: NAME, dir: 'MBOX_import_2026-09-29', kind: 'import', created: 1, source: 'takeout.mbox' };
const SERVER_LIST = [
  { path: 'INBOX', name: 'INBOX', delimiter: '/', children: [] },
  { path: 'Archive', name: 'Archive', delimiter: '/', specialUse: '\\Archive', children: [] },
];
const vaultRow = (uid) => ({ uid, subject: `Imported ${uid}`, date: `2026-08-0${uid}T00:00:00Z`, flags: [], isArchived: true });

const h = vi.hoisted(() => ({
  cachedEntry: null,
  vault: null,
  rows: [],
  daemonAlive: false,
  localFolders: [],
}));

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

// Every server-facing call the list workflows make, as spies.
const api = vi.hoisted(() => ({
  fetchMailboxes: vi.fn(),
  loadMailboxes: vi.fn(),
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

vi.mock('../../authUtils', () => ({
  ensureFreshToken: (a) => Promise.resolve(a),
  resolveServerAccount: (id, account) => Promise.resolve({ ok: true, account }),
  hasValidCredentials: (a) => !!(a?.password || a?.oauth2AccessToken),
}));
vi.mock('../../graphConfig', () => ({
  isGraphAccount: () => false,
  graphFoldersToMailboxes: () => [],
  graphMessageToEmail: (m) => m,
  isPersonalMicrosoftEmail: () => false,
}));
vi.mock('../../cacheManager', () => ({
  saveRestoreDescriptor: vi.fn(),
  getRestoreDescriptor: vi.fn().mockReturnValue(null),
  invalidateRestoreDescriptors: vi.fn(),
  getAccountCacheMailboxes: () => null,
  listGraphMessages: vi.fn().mockResolvedValue({ headers: [], graphMessageIds: [] }),
  getGraphMessageId: vi.fn().mockReturnValue(null),
  resolveGraphMessageId: vi.fn().mockResolvedValue(null),
  restoreGraphIdMap: vi.fn().mockResolvedValue(undefined),
}));
const setLastMailbox = vi.fn();
vi.mock('../../../stores/settingsStore', () => ({
  useSettingsStore: {
    getState: () => ({
      hiddenAccounts: {}, setLastMailbox, setUnreadForAccount: vi.fn(), getLastMailbox: () => 'INBOX',
      isAccountHidden: () => false,
    }),
  },
}));
vi.mock('../../transport', () => ({ getDaemonHealth: () => ({ alive: h.daemonAlive }), send: vi.fn().mockResolvedValue({ drafts: [], managed: [] }) }));
const probe = vi.hoisted(() => ({ mailboxIsUnchanged: vi.fn(), markVerified: vi.fn(), invalidate: vi.fn() }));
vi.mock('../../syncProbe', () => probe);
const sync = vi.hoisted(() => ({
  syncNow: vi.fn(), waitForSync: vi.fn(), watchAccount: vi.fn(), unwatchAccount: vi.fn(),
}));
vi.mock('../../syncService', () => ({
  ...sync,
  toSyncAccount: (account, id = account?.id) => ({ id, email: account?.email, imapConfig: {} }),
}));

const { useMailStore } = await import('../../../stores/mailStore');
await import('../bindStoreActions');
const { forget: forgetMemo } = await import('../../headerMemo');
const { inLocalFolder } = await import('../../../stores/slices/unifiedHelpers');

const ACCOUNT = { id: 'acct-a', email: 'a@mock.test', password: 'pw' };

// No server call may name the local folder: not a SELECT, not a STATUS, not a
// fetch, not a sync or a probe of it.
function expectNoServerCallFor(name) {
  for (const [fn, spy] of Object.entries(api)) {
    if (fn === 'listLocalFolders') continue;
    for (const args of spy.mock.calls) {
      expect(JSON.stringify(args), `api.${fn}`).not.toContain(name);
    }
  }
  expect(probe.mailboxIsUnchanged).not.toHaveBeenCalled();
  expect(sync.syncNow).not.toHaveBeenCalled();
}

function prime(extra = {}) {
  useMailStore.setState({
    accounts: [ACCOUNT],
    activeAccountId: ACCOUNT.id,
    activeMailbox: 'INBOX',
    mailboxScope: null,
    unifiedInbox: false,
    viewMode: 'all',
    emails: [], sortedEmails: [], localEmails: [], sentEmails: [],
    savedEmailIds: new Set(), archivedEmailIds: new Set(),
    serverUids: serverUids(new Set(), { complete: false }),
    deleteTombstones: new Set(),
    totalEmails: 0,
    mailboxes: SERVER_LIST,
    localFolders: {},
    loadSentHeaders: vi.fn(),
    ...extra,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  forgetMemo(ACCOUNT.id);
  h.daemonAlive = false;
  // A fresh, complete cached list: no server LIST for the folder list.
  h.cachedEntry = { mailboxes: SERVER_LIST, fetchedAt: Date.now() };
  h.vault = { saved: new Set([1, 2]), archived: new Set([1, 2]) };
  h.rows = [vaultRow(1), vaultRow(2)];
  h.localFolders = [FOLDER];

  db.getCachedMailboxEntry.mockImplementation(async () => h.cachedEntry);
  db.getEmailHeadersMeta.mockResolvedValue(null);
  db.getEmailHeadersPartial.mockResolvedValue({ emails: [], totalEmails: 0 });
  db.getVaultUidSets.mockImplementation(async (accountId, mailbox) => (mailbox === NAME ? h.vault : { saved: new Set(), archived: new Set() }));
  db.getArchivedEmails.mockImplementation(async (accountId, mailbox, uids, onBatch) => {
    const rows = mailbox === NAME ? h.rows.filter(r => uids.has(r.uid)) : [];
    if (rows.length) onBatch?.([...rows]);
    return rows;
  });
  db.readLocalEmailIndex.mockResolvedValue(null);
  db.saveEmailHeaders.mockResolvedValue(undefined);
  db.saveMailboxes.mockResolvedValue(undefined);
  db.clearMailboxCache.mockResolvedValue(undefined);

  api.fetchMailboxes.mockResolvedValue([...SERVER_LIST, { path: 'Projects', name: 'Projects', delimiter: '/', children: [] }]);
  api.loadMailboxes.mockResolvedValue({
    mailboxes: [...SERVER_LIST, { path: 'Projects', name: 'Projects', delimiter: '/', children: [] }],
    source: 'server', suspectEmpty: false, changed: true,
  });
  api.fetchEmails.mockResolvedValue({ emails: [], total: 0 });
  api.checkMailboxStatus.mockResolvedValue({ exists: 0, uidValidity: 1, uidNext: 1 });
  api.searchAllUids.mockResolvedValue([]);
  api.fetchHeadersByUids.mockResolvedValue({ emails: [] });
  api.fetchChangedFlags.mockResolvedValue([]);
  api.graphListFolders.mockResolvedValue([]);
  api.graphListMessages.mockResolvedValue({ headers: [] });
  api.listLocalFolders.mockImplementation(async () => h.localFolders);

  probe.mailboxIsUnchanged.mockResolvedValue({ unchanged: false, reason: 'test' });
  sync.syncNow.mockResolvedValue({ ticket: 1 });
  sync.waitForSync.mockResolvedValue({ success: true });
});


describe('paging a mailbox whose cache is complete', () => {
  it('stops instead of re-downloading pages from the server', async () => {
    prime({
      emails: [3, 2, 1].map(uid => ({ uid, subject: `m${uid}`, date: '2026-11-01T00:00:00Z', flags: [] })),
      totalEmails: 5,
      hasMoreEmails: true,
      loadingMore: false,
      currentPage: 1,
    });
    // 3 rows on disk + 2 the server cannot serve: accounted for, all 5.
    db.getEmailHeadersMeta.mockResolvedValue({ totalEmails: 5, totalCached: 5 });
    db.listCachedUids.mockResolvedValue({ uids: [3, 2, 1] });
    db.getEmailHeadersByUids.mockResolvedValue([]);

    await useMailStore.getState().loadMoreEmails();

    expect(api.fetchEmails).not.toHaveBeenCalled();
    expect(useMailStore.getState().hasMoreEmails).toBe(false);
    expect(useMailStore.getState().loadingMore).toBe(false);
  });
});
