// loadMailboxes (activateAccount's folder-list load) hands the cache-or-server
// decision, the fetch, the retry, the empty-list rejection and the cache write
// to the daemon (`mailboxes.load`, api.loadMailboxes). What stays in the app is
// the store: this file pins that the store ends up as it did when the app made
// those decisions itself. A Graph account keeps its own path (its listing is
// converted and key-adopted in the app).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { serverUids } from '../../../stores/slices/serverUids';
import { forceMailboxRefetch, takeForcedMailboxRefetch } from '../helpers/mailboxRefetch';
import { INBOX_PLACEHOLDER } from '../mailboxTree';
import { t } from '../../../i18n/index.js';

if (!globalThis.window) {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
} else {
  globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
}
vi.stubGlobal('navigator', { onLine: true });

const mockGetCachedMailboxEntry = vi.fn().mockResolvedValue(null);
const mockSaveMailboxes = vi.fn().mockResolvedValue(undefined);
vi.mock('../../db', () => ({
  getCachedMailboxEntry: (...a) => mockGetCachedMailboxEntry(...a),
  getEmailHeadersMeta: vi.fn().mockResolvedValue(null),
  getEmailHeadersPartial: vi.fn().mockResolvedValue({ emails: [], totalEmails: 0 }),
  getArchivedEmailIds: vi.fn().mockResolvedValue(new Set()),
  getSavedEmailIds: vi.fn().mockResolvedValue(new Set()),
  getVaultUidSets: vi.fn().mockResolvedValue({ saved: new Set(), archived: new Set() }),
  saveEmailHeaders: vi.fn().mockResolvedValue(undefined),
  saveMailboxes: (...a) => mockSaveMailboxes(...a),
  listCachedUids: vi.fn(),
  getEmailHeadersByUids: vi.fn(),
  clearMailboxCache: vi.fn().mockResolvedValue(undefined),
  getArchivedEmails: vi.fn().mockResolvedValue(undefined),
}));

const mockLoadMailboxes = vi.fn();
const mockFetchMailboxes = vi.fn().mockResolvedValue([]);
const mockGraphListFolders = vi.fn().mockResolvedValue([]);
vi.mock('../../api', () => ({
  loadMailboxes: (...a) => mockLoadMailboxes(...a),
  fetchMailboxes: (...a) => mockFetchMailboxes(...a),
  graphListFolders: (...a) => mockGraphListFolders(...a),
  graphListMessages: vi.fn().mockResolvedValue({ headers: [], graphMessageIds: [] }),
  fetchEmails: vi.fn().mockResolvedValue({ total: 0, emails: [] }),
  checkMailboxStatus: vi.fn().mockResolvedValue({ uidValidity: 1, uidNext: 1, highestModseq: null }),
  searchAllUids: vi.fn().mockResolvedValue([]),
  fetchHeadersByUids: vi.fn().mockResolvedValue({ emails: [] }),
  fetchChangedFlags: vi.fn().mockResolvedValue([]),
  fetchFolderStatus: vi.fn().mockResolvedValue([]),
}));

const mockResolveServerAccount = vi.fn((id, account) => Promise.resolve({ ok: true, account }));
vi.mock('../../authUtils', () => ({
  ensureFreshToken: (a) => Promise.resolve(a),
  resolveServerAccount: (...a) => mockResolveServerAccount(...a),
  hasValidCredentials: (a) => !!(a?.password || a?.oauth2AccessToken),
}));
const mockIsGraphAccount = vi.fn(() => false);
vi.mock('../../graphConfig', () => ({
  isGraphAccount: (...a) => mockIsGraphAccount(...a),
  graphFoldersToMailboxes: (folders) => folders.map(f => ({
    name: f.displayName, path: f.displayName, children: [], _graphFolderId: f.id, _graphTotal: f.totalItemCount,
  })),
  graphMessageToEmail: (m) => m,
  isPersonalMicrosoftEmail: () => false,
}));
vi.mock('../adoptGraphFolderKeys', () => ({
  adoptGraphFolderKeys: vi.fn(),
  adoptGraphFolderKeysFromListing: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../cacheManager', () => ({
  saveRestoreDescriptor: vi.fn(),
  getRestoreDescriptor: vi.fn().mockReturnValue(null),
  listGraphMessages: vi.fn().mockResolvedValue({ headers: [], graphMessageIds: [] }),
  getGraphMessageId: vi.fn().mockReturnValue(null),
  resolveGraphMessageId: vi.fn().mockResolvedValue(null),
  restoreGraphIdMap: vi.fn().mockResolvedValue(undefined),
}));
const setLastMailbox = vi.fn();
vi.mock('../../../stores/settingsStore', () => ({
  useSettingsStore: {
    getState: () => ({
      hiddenAccounts: {},
      setLastMailbox,
      setUnreadForAccount: vi.fn(),
      getLastMailbox: () => 'INBOX',
    }),
  },
}));
vi.mock('../../transport', () => ({
  getDaemonHealth: () => ({ alive: false }),
  send: async (method, params) => {
    if (method === 'get_app_data_dir') return '/synthetic';
    if (method === 'folders.status' && params?.op === 'refresh') return { rows: [] };
    if (method === 'folders.status' && params?.op === 'invalidate') return { invalidated: true };
    throw new Error(`unexpected native transport method: ${method}`);
  },
}));
vi.mock('../../syncProbe', () => ({
  mailboxIsUnchanged: vi.fn().mockResolvedValue({ unchanged: false, reason: 'test' }),
  markVerified: vi.fn().mockResolvedValue({ marked: true }),
  invalidate: vi.fn(),
}));
vi.mock('../../syncService', () => ({
  syncNow: vi.fn().mockResolvedValue({ started: true, ticket: 1 }),
  waitForSync: vi.fn().mockResolvedValue({ success: true }),
  toSyncAccount: (account, id = account?.id) => ({ id, email: account?.email, imapConfig: {} }),
  watchAccount: vi.fn(),
  unwatchAccount: vi.fn(),
}));

const { useMailStore } = await import('../../../stores/mailStore');
await import('../bindStoreActions');
const { forget: forgetMemo } = await import('../../headerMemo');

const ACCOUNT = { id: 'acct-1', email: 'me@mock.test', password: 'pw' };
const GRAPH_ACCOUNT = { id: 'acct-g', email: 'me@live.test', authType: 'oauth2', oauth2Transport: 'graph', oauth2AccessToken: 'tok' };
const CACHED = [{ path: 'INBOX', name: 'INBOX', children: [] }, { path: 'Archive', name: 'Archive', children: [] }];
const SERVER = [...CACHED, { path: 'Projects', name: 'Projects', children: [] }];
const answer = (mailboxes, extra = {}) => ({ mailboxes, fetchedAt: 1_800_000_000_000, source: 'server', suspectEmpty: false, ...extra });

function primeCold(account = ACCOUNT) {
  useMailStore.setState({
    accounts: [account],
    activeAccountId: null,
    activeMailbox: 'INBOX',
    emails: [],
    localEmails: [],
    sentEmails: [],
    sortedEmails: [],
    savedEmailIds: new Set(),
    archivedEmailIds: new Set(),
    serverUids: serverUids(new Set(), { complete: true }),
    deleteTombstones: new Set(),
    totalEmails: 0,
    mailboxes: [],
    mailboxesFetchedAt: null,
    suspectEmptyServerData: null,
    unifiedInbox: false,
    loadSentHeaders: vi.fn(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  takeForcedMailboxRefetch(ACCOUNT.id);
  takeForcedMailboxRefetch(GRAPH_ACCOUNT.id);
  mockGetCachedMailboxEntry.mockResolvedValue(null);
  mockLoadMailboxes.mockResolvedValue(answer(SERVER));
  mockFetchMailboxes.mockResolvedValue([]);
  mockGraphListFolders.mockResolvedValue([]);
  mockIsGraphAccount.mockImplementation((a) => a?.oauth2Transport === 'graph');
  mockResolveServerAccount.mockImplementation((id, account) => Promise.resolve({ ok: true, account }));
  forgetMemo(ACCOUNT.id);
  forgetMemo(GRAPH_ACCOUNT.id);
});

const state = () => useMailStore.getState();

describe('loadMailboxes asks the daemon (mailboxes.load) instead of deciding in the app', () => {
  // RED before: nothing called api.loadMailboxes; the app read the cache, judged it, and
  // called api.fetchMailboxes itself, so this call list would be empty.
  it('passes force when a Refresh left a forced refetch pending', async () => {
    primeCold();
    forceMailboxRefetch(ACCOUNT.id);

    await state().activateAccount(ACCOUNT.id, 'INBOX');

    expect(mockLoadMailboxes).toHaveBeenCalledTimes(1);
    expect(mockLoadMailboxes).toHaveBeenLastCalledWith(expect.objectContaining({ id: ACCOUNT.id }), { force: true });
    // Consumed by that load: it does not leak into the next one.
    expect(takeForcedMailboxRefetch(ACCOUNT.id)).toBe(false);
  });

  it('passes force false when no Refresh is pending', async () => {
    primeCold();

    await state().activateAccount(ACCOUNT.id, 'INBOX');

    expect(mockLoadMailboxes).toHaveBeenCalledTimes(1);
    expect(mockLoadMailboxes).toHaveBeenLastCalledWith(expect.objectContaining({ id: ACCOUNT.id }), { force: false });
  });

  // RED before: no daemon call at all, and a fetch went to api.fetchMailboxes when the cache was stale.
  it('sends the account with its credentials resolved, never the password-less copy', async () => {
    primeCold();
    mockResolveServerAccount.mockResolvedValue({ ok: true, account: { ...ACCOUNT, password: 'resolved' } });

    await state().activateAccount(ACCOUNT.id, 'INBOX');

    expect(mockResolveServerAccount).toHaveBeenCalledWith(ACCOUNT.id, ACCOUNT);
    expect(mockLoadMailboxes).toHaveBeenCalledWith(expect.objectContaining({ password: 'resolved' }), { force: false });
    expect(mockFetchMailboxes).not.toHaveBeenCalled();
  });

  // RED before: the fresh path still called api.loadMailboxes (an IPC round trip the old
  // code never made) with the password-less account; HEAD resolved to null without any call.
  it('a fresh stored list makes no api.loadMailboxes call and resolves no credentials', async () => {
    const bare = { id: ACCOUNT.id, email: ACCOUNT.email };
    mockResolveServerAccount.mockResolvedValue({ ok: true, account: { ...ACCOUNT, password: 'resolved' } });
    primeCold(bare);
    mockGetCachedMailboxEntry.mockResolvedValue({ mailboxes: CACHED, fetchedAt: Date.now() - 1000 });

    await state().activateAccount(bare.id, 'INBOX');

    expect(mockLoadMailboxes).not.toHaveBeenCalled();
    // The email load (loadServerEmails) legitimately resolves the account once; the folder
    // list used to add a second resolve on the stale path. A fresh list adds none.
    expect(mockResolveServerAccount.mock.calls.length).toBeLessThanOrEqual(1);
    expect(state().mailboxes).toEqual(CACHED);
  });

  it('a fresh stored list with a Refresh pending still asks the daemon, forced', async () => {
    primeCold();
    forceMailboxRefetch(ACCOUNT.id);
    mockGetCachedMailboxEntry.mockResolvedValue({ mailboxes: CACHED, fetchedAt: Date.now() - 1000 });

    await state().activateAccount(ACCOUNT.id, 'INBOX');

    expect(mockLoadMailboxes).toHaveBeenCalledTimes(1);
    expect(mockLoadMailboxes).toHaveBeenLastCalledWith(expect.objectContaining({ id: ACCOUNT.id }), { force: true });
  });

  it('sends the account resolved when the stored list is stale', async () => {
    const bare = { id: ACCOUNT.id, email: ACCOUNT.email };
    const resolvedAccount = { ...ACCOUNT, password: 'resolved' };
    mockResolveServerAccount.mockResolvedValue({ ok: true, account: resolvedAccount });
    primeCold(bare);
    mockGetCachedMailboxEntry.mockResolvedValue({ mailboxes: CACHED, fetchedAt: 1 });

    await state().activateAccount(bare.id, 'INBOX');

    expect(mockLoadMailboxes).toHaveBeenCalledWith(resolvedAccount, { force: false });
  });

  // The app judged the list stale but the daemon found it fresh after all (a race with another
  // writer): its cache answer leaves the store alone.
  it('a source "cache" answer leaves the store on the cached list and makes no further api call', async () => {
    primeCold();
    const cachedAt = 1;
    mockGetCachedMailboxEntry.mockResolvedValue({ mailboxes: CACHED, fetchedAt: cachedAt });
    mockLoadMailboxes.mockResolvedValue({ mailboxes: CACHED, fetchedAt: cachedAt, source: 'cache' });

    await state().activateAccount(ACCOUNT.id, 'INBOX');

    expect(mockLoadMailboxes).toHaveBeenCalledTimes(1);
    expect(mockFetchMailboxes).not.toHaveBeenCalled();
    expect(mockGraphListFolders).not.toHaveBeenCalled();
    expect(mockSaveMailboxes).not.toHaveBeenCalled();
    expect(state().mailboxes).toEqual(CACHED);
    expect(state().mailboxesFetchedAt).toBe(cachedAt);
    expect(state().suspectEmptyServerData).toBeNull();
  });

  // RED before: the app wrote the cache itself (db.saveMailboxes) after every server list;
  // now the daemon has, so the app must not write it a second time.
  it('a server answer replaces the folder list, is stamped as the daemon stamped it, and is not saved again by the app', async () => {
    primeCold();
    mockGetCachedMailboxEntry.mockResolvedValue({ mailboxes: CACHED, fetchedAt: 1 });
    mockLoadMailboxes.mockResolvedValue(answer(SERVER, { fetchedAt: 1_800_000_123_456 }));

    await state().activateAccount(ACCOUNT.id, 'INBOX');

    expect(state().mailboxes).toEqual(SERVER);
    expect(state().mailboxesFetchedAt).toBe(1_800_000_123_456);
    expect(mockSaveMailboxes).not.toHaveBeenCalled();
  });

  it('a server answer that matches the list on screen only restamps it', async () => {
    primeCold();
    mockGetCachedMailboxEntry.mockResolvedValue({ mailboxes: CACHED, fetchedAt: 1 });
    mockLoadMailboxes.mockResolvedValue(answer(CACHED, { fetchedAt: 1_800_000_000_042 }));

    await state().activateAccount(ACCOUNT.id, 'INBOX');

    expect(state().mailboxes).toEqual(CACHED);
    expect(state().mailboxesFetchedAt).toBe(1_800_000_000_042);
  });

  // RED before: the empty list never came through the daemon, so a suspectEmpty flag from it did nothing.
  it('suspectEmpty raises the same banner as before and keeps the cached list', async () => {
    primeCold();
    mockGetCachedMailboxEntry.mockResolvedValue({ mailboxes: CACHED, fetchedAt: 1 });
    // The server answers after the local and email streams are done, as a real listing does:
    // a verified email sync (serverVerifiedPatch) clears this banner by design, so an answer
    // that lands before it would be wiped by a later step unrelated to the folder list.
    mockLoadMailboxes.mockImplementation(async () => {
      await new Promise(r => setTimeout(r, 50));
      return { mailboxes: CACHED, fetchedAt: 1, source: 'server', suspectEmpty: true };
    });

    await state().activateAccount(ACCOUNT.id, 'INBOX');

    expect(state().suspectEmptyServerData).toMatchObject({
      accountId: ACCOUNT.id,
      type: 'mailboxes',
      message: t('svc.activateAccount.serverReturnedEmptyFolderList'),
    });
    expect(state().mailboxes).toEqual(CACHED);
    expect(state().mailboxesFetchedAt).toBe(1);
    expect(mockSaveMailboxes).not.toHaveBeenCalled();
  });

  it('a good answer clears the empty-list banner it raised earlier for this account', async () => {
    primeCold();
    useMailStore.setState({ suspectEmptyServerData: { accountId: ACCOUNT.id, type: 'mailboxes', message: 'x', timestamp: 1 } });

    await state().activateAccount(ACCOUNT.id, 'INBOX');

    expect(state().suspectEmptyServerData).toBeNull();
  });

  // RED before: the old error path ran through fetchAccountMailboxes/retryOnce in the app, so
  // the daemon was never called; the store outcome below is the same as that path left.
  it('an api rejection leaves the placeholder tree when nothing was cached, and asks only once (the daemon retries)', async () => {
    primeCold();
    mockLoadMailboxes.mockRejectedValue(new Error('Failed to fetch mailboxes'));

    await state().activateAccount(ACCOUNT.id, 'INBOX');

    expect(mockLoadMailboxes).toHaveBeenCalledTimes(1);
    expect(state().mailboxes).toEqual(INBOX_PLACEHOLDER);
    expect(state().mailboxesFetchedAt).toBeNull();
    expect(state().suspectEmptyServerData).toBeNull();
    expect(mockSaveMailboxes).not.toHaveBeenCalled();
  });

  it('an api rejection leaves the cached list and its stamp when there was one', async () => {
    primeCold();
    mockGetCachedMailboxEntry.mockResolvedValue({ mailboxes: CACHED, fetchedAt: 5 });
    mockLoadMailboxes.mockRejectedValue(new Error('errors.daemonUnavailable'));

    await state().activateAccount(ACCOUNT.id, 'INBOX');

    expect(state().mailboxes).toEqual(CACHED);
    expect(state().mailboxesFetchedAt).toBe(5);
    expect(mockSaveMailboxes).not.toHaveBeenCalled();
  });

  it('an answer without a list is ignored like a failed fetch', async () => {
    primeCold();
    mockGetCachedMailboxEntry.mockResolvedValue({ mailboxes: CACHED, fetchedAt: 5 });
    mockLoadMailboxes.mockResolvedValue({ source: 'server' });

    await state().activateAccount(ACCOUNT.id, 'INBOX');

    expect(state().mailboxes).toEqual(CACHED);
    expect(state().mailboxesFetchedAt).toBe(5);
  });

  // RED before: n/a (control). A Graph listing is converted with the UI's labels and its folder
  // keys adopted in the app, so it never goes to the daemon's mailboxes.load.
  it('a Graph account is listed by the app, not the daemon, and stored by the app', async () => {
    primeCold(GRAPH_ACCOUNT);
    mockGraphListFolders.mockResolvedValue([{ id: 'f1', displayName: 'INBOX', totalItemCount: 3 }]);

    await state().activateAccount(GRAPH_ACCOUNT.id, 'INBOX');

    expect(mockLoadMailboxes).not.toHaveBeenCalled();
    expect(mockGraphListFolders).toHaveBeenCalled();
    expect(mockSaveMailboxes).toHaveBeenCalledWith(GRAPH_ACCOUNT.id, [expect.objectContaining({ path: 'INBOX', _graphFolderId: 'f1', _graphTotal: 3 })]);
  });
});
