// A vault-only folder (MBOX import mode 3, "Import as a separate folder") is
// not on any server. Opening one must:
//   - not be switched to INBOX by the "mailbox not in the server list" guards,
//     neither the first one (cached list) nor the one on the server refresh;
//   - list its mail from the vault only, with no IMAP/Graph request for it and
//     no sync or probe of it;
//   - survive the server folder list being fetched again (the local folders
//     are kept apart from it and never saved into it);
//   - reload from the vault on a reload (loadEmails), and never paginate the
//     server (loadMoreEmails).
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
vi.mock('../../transport', () => ({ getDaemonHealth: () => ({ alive: h.daemonAlive }) }));
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

const shownUids = () => useMailStore.getState().sortedEmails.map(e => e.uid).sort();

describe('opening a local folder', () => {
  it('is not switched to INBOX although no server lists it (cold start on the remembered folder)', async () => {
    prime();
    await useMailStore.getState().activateAccount(ACCOUNT.id, NAME);

    const s = useMailStore.getState();
    expect(s.activeMailbox).toBe(NAME);
    expect(setLastMailbox).not.toHaveBeenCalledWith(ACCOUNT.id, 'INBOX');
    expect(s.localFolders[ACCOUNT.id]).toEqual([FOLDER]);
    // The mail comes from the vault, and the list is complete and settled.
    expect(shownUids()).toEqual([1, 2]);
    expect(s.loading).toBe(false);
    expect(s.hasMoreEmails).toBe(false);
    expectNoServerCallFor(NAME);
  });

  it('makes no sync or probe of it with the daemon up either', async () => {
    h.daemonAlive = true;
    prime();
    await useMailStore.getState().activateAccount(ACCOUNT.id, NAME);

    expect(useMailStore.getState().activeMailbox).toBe(NAME);
    expect(shownUids()).toEqual([1, 2]);
    expectNoServerCallFor(NAME);
  });

  it('stays open, with its mail, when the server folder list comes back without it', async () => {
    // A stale cached list: activation fetches the server's again, which has
    // changed (a new folder) and of course does not hold the local one.
    h.cachedEntry = { mailboxes: SERVER_LIST, fetchedAt: 1 };
    prime();
    await useMailStore.getState().activateAccount(ACCOUNT.id, NAME);

    const s = useMailStore.getState();
    expect(api.fetchMailboxes).toHaveBeenCalled();
    expect(s.mailboxes.map(m => m.path)).toEqual(['INBOX', 'Archive', 'Projects']);
    expect(s.activeMailbox).toBe(NAME);
    expect(setLastMailbox).not.toHaveBeenCalledWith(ACCOUNT.id, 'INBOX');
    expect(s.localFolders[ACCOUNT.id]).toEqual([FOLDER]);
    expect(shownUids()).toEqual([1, 2]);
    // The local folders are never written into the server list's cache.
    for (const [, list] of db.saveMailboxes.mock.calls) {
      expect(list.some(m => m.path === NAME || m.local)).toBe(false);
    }
    expectNoServerCallFor(NAME);
  });

  it('keeps the folders it knew when the local list cannot be read', async () => {
    api.listLocalFolders.mockRejectedValue(new Error('daemon unreachable'));
    prime({ localFolders: { [ACCOUNT.id]: [FOLDER] } });
    await useMailStore.getState().activateAccount(ACCOUNT.id, NAME);

    expect(useMailStore.getState().activeMailbox).toBe(NAME);
    expect(useMailStore.getState().localFolders[ACCOUNT.id]).toEqual([FOLDER]);
  });

  it('never makes a click on a server folder wait on the local listing', async () => {
    let answer;
    api.listLocalFolders.mockImplementation(() => new Promise(resolve => { answer = resolve; }));
    prime();
    const opened = useMailStore.getState().activateAccount(ACCOUNT.id, 'Archive');
    const verdict = await Promise.race([
      opened.then(() => 'opened'),
      new Promise(resolve => setTimeout(() => resolve('waiting on the listing'), 1000)),
    ]);
    answer([FOLDER]);
    await opened;

    expect(verdict).toBe('opened');
    expect(useMailStore.getState().activeMailbox).toBe('Archive');
    // The listing still lands, for the sidebar.
    await vi.waitFor(() => expect(useMailStore.getState().localFolders[ACCOUNT.id]).toEqual([FOLDER]));
  });

  it('still falls back to INBOX for a folder that is neither on the server nor local', async () => {
    prime();
    await useMailStore.getState().activateAccount(ACCOUNT.id, 'Gone');
    expect(useMailStore.getState().activeMailbox).toBe('INBOX');
  });
});

describe('reloading a local folder', () => {
  const primeOpen = () => prime({
    activeMailbox: NAME,
    localFolders: { [ACCOUNT.id]: [FOLDER] },
    localEmails: h.rows.map(r => ({ ...r })),
    savedEmailIds: new Set([1, 2]),
    archivedEmailIds: new Set([1, 2]),
    hasMoreEmails: false,
  });

  it('re-reads the vault and nothing else (a delete took uid 2 out of it)', async () => {
    primeOpen();
    useMailStore.getState().updateSortedEmails();
    h.vault = { saved: new Set([1]), archived: new Set([1]) };

    await useMailStore.getState().loadEmails();

    expect(db.getVaultUidSets).toHaveBeenCalledWith(ACCOUNT.id, NAME);
    expect(shownUids()).toEqual([1]);
    expect(useMailStore.getState().loading).toBe(false);
    expectNoServerCallFor(NAME);
  });

  it('keeps the rows on screen when the vault cannot be read', async () => {
    primeOpen();
    useMailStore.getState().updateSortedEmails();
    h.vault = null;

    await useMailStore.getState().loadEmails();

    expect(shownUids()).toEqual([1, 2]);
    expectNoServerCallFor(NAME);
  });

  it('never pages the server for more', async () => {
    primeOpen();
    useMailStore.setState({ hasMoreEmails: true, loadingMore: false });

    await useMailStore.getState().loadMoreEmails();

    expectNoServerCallFor(NAME);
  });
});

// A search or saved-view hit can come from an account nobody opened this
// session (All Inboxes search, a cross-account view). Every account's local
// folders are listed at start, so a hit from one is known as local, not
// taken for a server folder.
describe('every account\'s local folders, from the start', () => {
  const B = { id: 'acct-b', email: 'b@mock.test', password: 'pw' };
  const FOLDER_B = { name: 'MBOX import 2026-09-28', dir: 'MBOX_import_2026-09-28', kind: 'import', created: 2, source: 'b.mbox' };
  const HIT_B = { uid: 3, _accountId: B.id, _mailbox: FOLDER_B.dir, _localOnlyFolder: true, source: 'local', isArchived: true };

  beforeEach(() => {
    db.initDB.mockResolvedValue(undefined);
    db.getAccounts.mockResolvedValue([ACCOUNT, B]);
    db.ensureAccountsInFile.mockResolvedValue(undefined);
  });

  it('knows a hit from an account never opened as local once the app has started', async () => {
    api.listLocalFolders.mockImplementation(async (accountId) => (accountId === B.id ? [FOLDER_B] : []));
    prime({ accounts: [ACCOUNT, B] });
    await useMailStore.getState().init();

    await vi.waitFor(() => expect(useMailStore.getState().localFolders[B.id]).toEqual([FOLDER_B]));
    expect(inLocalFolder(HIT_B, useMailStore.getState())).toBe(true);
  });

  it('keeps the list it knew for an account whose listing fails', async () => {
    api.listLocalFolders.mockImplementation(async (accountId) => {
      if (accountId === B.id) throw new Error('daemon unreachable');
      return [];
    });
    prime({ accounts: [ACCOUNT, B], localFolders: { [B.id]: [FOLDER_B] } });
    await useMailStore.getState().init();

    await vi.waitFor(() => expect(api.listLocalFolders).toHaveBeenCalledWith(B.id));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(useMailStore.getState().localFolders[B.id]).toEqual([FOLDER_B]);
    expect(inLocalFolder(HIT_B, useMailStore.getState())).toBe(true);
  });
});
