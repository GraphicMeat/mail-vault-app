// activateAccount paints the cached rows, then awaits the server half (daemon
// sync, STATUS, UID SEARCH, FETCH) and commits the uidMap it kept: rows that
// were read off disk, or fetched, BEFORE the user opened a message. The open
// marks the row read in the store and the sidecar; the later commit used to put
// the old flags back in the list (and, on the IMAP path, in the sidecar write
// too). commitToStore now three-way merges the flags against the live store and
// writes the merged rows back into the uidMap, so the sidecar write carries them.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { serverUids } from '../../../stores/slices/serverUids';

if (!globalThis.window) {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
} else {
  globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
}
vi.stubGlobal('navigator', { onLine: true });

const mockGetEmailHeadersMeta = vi.fn().mockResolvedValue(null);
const mockGetEmailHeadersPartial = vi.fn().mockResolvedValue({ emails: [], totalEmails: 0 });
const mockSaveEmailHeaders = vi.fn().mockResolvedValue(undefined);

vi.mock('../../db', () => ({
  getCachedMailboxEntry: vi.fn().mockResolvedValue(null),
  getEmailHeadersMeta: (...a) => mockGetEmailHeadersMeta(...a),
  getEmailHeadersPartial: (...a) => mockGetEmailHeadersPartial(...a),
  getVaultUidSets: async () => ({ saved: new Set(), archived: new Set() }),
  saveEmailHeaders: (...a) => mockSaveEmailHeaders(...a),
  saveMailboxes: vi.fn().mockResolvedValue(undefined),
  listCachedUids: vi.fn(),
  getEmailHeadersByUids: vi.fn(),
  clearMailboxCache: vi.fn().mockResolvedValue(undefined),
  getArchivedEmails: vi.fn().mockResolvedValue(undefined),
}));

const mockFetchEmails = vi.fn();
const mockCheckMailboxStatus = vi.fn();
const mockSearchAllUids = vi.fn();
vi.mock('../../api', () => ({
  fetchEmails: (...a) => mockFetchEmails(...a),
  checkMailboxStatus: (...a) => mockCheckMailboxStatus(...a),
  fetchMailboxes: vi.fn().mockResolvedValue([]),
  searchAllUids: (...a) => mockSearchAllUids(...a),
  fetchHeadersByUids: vi.fn().mockResolvedValue({ emails: [] }),
  fetchChangedFlags: vi.fn().mockResolvedValue([]),
  fetchFolderStatus: vi.fn().mockResolvedValue([]),
  graphListFolders: vi.fn().mockResolvedValue([]),
  graphListMessages: vi.fn().mockResolvedValue({ headers: [], graphMessageIds: [] }),
  vaultApplyFlags: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../authUtils', () => ({
  ensureFreshToken: (a) => Promise.resolve(a),
  resolveServerAccount: (id, account) =>
    // Slower than the disk read, so the paint is the first commit.
    new Promise((r) => setTimeout(() => r({ ok: true, account }), 10)),
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
  listGraphMessages: vi.fn().mockResolvedValue({ headers: [], graphMessageIds: [] }),
  getGraphMessageId: vi.fn().mockReturnValue(null),
  resolveGraphMessageId: vi.fn().mockResolvedValue(null),
  restoreGraphIdMap: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../stores/settingsStore', () => ({
  useSettingsStore: {
    getState: () => ({
      hiddenAccounts: {},
      setLastMailbox: vi.fn(),
      setUnreadForAccount: vi.fn(),
      getLastMailbox: () => 'INBOX',
    }),
  },
}));
const mockGetDaemonHealth = vi.fn().mockReturnValue({ alive: false });
vi.mock('../../transport', () => ({
  getDaemonHealth: () => mockGetDaemonHealth(),
}));
const mockSyncNow = vi.fn().mockResolvedValue({ started: true, ticket: 1 });
const mockWaitForSync = vi.fn();
vi.mock('../../syncProbe', () => ({
  mailboxIsUnchanged: vi.fn().mockResolvedValue({ unchanged: false, reason: 'test' }),
  markVerified: vi.fn(),
  invalidate: vi.fn(),
}));
vi.mock('../../syncService', () => ({
  syncNow: (...a) => mockSyncNow(...a),
  waitForSync: (...a) => mockWaitForSync(...a),
  toSyncAccount: (account, id = account?.id) => ({ id, email: account?.email, imapConfig: {} }),
  watchAccount: vi.fn(),
  unwatchAccount: vi.fn(),
}));

const { useMailStore } = await import('../../../stores/mailStore');
const { applySeenLocally } = await import('../messageMutations');
const { forget: forgetMemo } = await import('../../headerMemo');

const ACCOUNT = { id: 'acct-1', email: 'me@mock.test', password: 'pw' };
const UIDS = [5, 4, 3, 2, 1];
const mkHeader = (uid, flags = []) => ({
  uid, subject: `Msg ${uid}`, date: '2026-08-01T00:00:00Z', flags, from: { address: 'sender@mock.test' },
});
const rows = () => UIDS.map(u => mkHeader(u));

function primeCold() {
  useMailStore.setState({
    accounts: [ACCOUNT],
    activeAccountId: null,
    activeMailbox: 'INBOX',
    emails: [],
    localEmails: [],
    sentEmails: [],
    sortedEmails: [],
    savedEmailIds: new Set(),
    archivedEmailIds: new Set(),
    serverUids: serverUids(new Set(), { complete: false }),
    deleteTombstones: new Set(),
    totalEmails: 0,
    mailboxes: [],
    unifiedInbox: false,
    loadSentHeaders: vi.fn(),
  });
}

function parked() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const markRead = (uid) =>
  applySeenLocally(useMailStore, { accountId: ACCOUNT.id, mailbox: 'INBOX', uid, read: true });
const storeRow = (uid) => useMailStore.getState().emails.find(e => e.uid === uid);
const savedRow = (uid) => mockSaveEmailHeaders.mock.calls.at(-1)?.[2]?.find(e => e.uid === uid);

beforeEach(() => {
  vi.clearAllMocks();
  mockGetEmailHeadersMeta.mockResolvedValue(null);
  mockGetEmailHeadersPartial.mockResolvedValue({ emails: rows(), totalEmails: 5, totalCached: 5, uidValidity: 1 });
  mockGetDaemonHealth.mockReturnValue({ alive: false });
  mockSearchAllUids.mockResolvedValue([]);
  forgetMemo(ACCOUNT.id);
  primeCold();
});

describe('activateAccount — a flag written after the first paint survives the server half\'s commit', () => {
  it('UID-search delta branch: the row keeps \\Seen, in the list and in the sidecar write', async () => {
    mockGetEmailHeadersMeta.mockResolvedValue({ uidValidity: 1, uidNext: 6, highestModseq: null, totalEmails: 5, totalCached: 5 });
    mockCheckMailboxStatus.mockResolvedValue({ uidValidity: 1, uidNext: 7, highestModseq: null, exists: 6 });
    const search = parked();
    mockSearchAllUids.mockReturnValue(search.promise);

    const done = useMailStore.getState().activateAccount(ACCOUNT.id, 'INBOX');
    await vi.waitFor(() => expect(mockSearchAllUids).toHaveBeenCalled());
    expect(storeRow(3)).toBeTruthy(); // the disk paint is on screen

    markRead(3);
    search.resolve([...UIDS]);
    await done;

    expect(storeRow(3).flags).toContain('\\Seen');
    expect(savedRow(3).flags).toContain('\\Seen');
    expect(storeRow(4).flags).toEqual([]);
  });

  it('full-fetch branch (server rows override the painted ones): the row keeps \\Seen', async () => {
    const page = parked();
    mockFetchEmails.mockReturnValue(page.promise);
    mockCheckMailboxStatus.mockResolvedValue({ uidValidity: 1, uidNext: 6, highestModseq: null, exists: 5 });

    const done = useMailStore.getState().activateAccount(ACCOUNT.id, 'INBOX');
    await vi.waitFor(() => expect(mockFetchEmails).toHaveBeenCalled());
    expect(storeRow(3)).toBeTruthy();

    markRead(3);
    page.resolve({ total: 5, emails: rows().map(r => ({ ...r })) });
    await done;

    expect(storeRow(3).flags).toContain('\\Seen');
    expect(savedRow(3).flags).toContain('\\Seen');
    expect(storeRow(4).flags).toEqual([]);
  });

  it('daemon branch (cache re-read after the sync): the row keeps \\Seen', async () => {
    mockGetDaemonHealth.mockReturnValue({ alive: true });
    const sync = parked();
    mockWaitForSync.mockReturnValue(sync.promise);

    const done = useMailStore.getState().activateAccount(ACCOUNT.id, 'INBOX');
    await vi.waitFor(() => expect(mockWaitForSync).toHaveBeenCalled());
    expect(storeRow(3)).toBeTruthy();

    markRead(3);
    // The re-read is served the same stale rows: the write's sidecar patch has
    // not landed when this read runs, which is the window this closes.
    sync.resolve({ success: true, new_emails: 0, total_emails: 5 });
    await done;

    expect(storeRow(3).flags).toContain('\\Seen');
    expect(storeRow(4).flags).toEqual([]);
  });
});
