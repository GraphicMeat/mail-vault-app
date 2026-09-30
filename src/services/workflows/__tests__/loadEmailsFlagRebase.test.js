// loadEmails reads the list on screen, awaits STATUS / CONDSTORE / SEARCH /
// FETCH, builds the merged list from that snapshot and commits it, to the store
// and to the header sidecar. A flag write that lands during those awaits (the
// auto mark-read of a message the user just opened) used to be reverted by the
// commit, in the list AND in the sidecar. The commit now three-way merges the
// flags against the live store (rebaseFlags), whichever branch built the list.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { serverUids } from '../../../stores/slices/serverUids';

if (!globalThis.window) {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
} else {
  globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
}
vi.stubGlobal('navigator', { onLine: true });

const mockGetEmailHeadersMeta = vi.fn();
const mockSaveEmailHeaders = vi.fn().mockResolvedValue(undefined);
const mockGetEmailHeadersPartial = vi.fn().mockResolvedValue({ emails: [], totalEmails: 0 });

vi.mock('../../db', () => ({
  getVaultUidSets: async () => ({ saved: new Set(), archived: new Set() }),
  getEmailHeadersMeta: (...a) => mockGetEmailHeadersMeta(...a),
  getEmailHeadersPartial: (...a) => mockGetEmailHeadersPartial(...a),
  listCachedUids: vi.fn().mockResolvedValue({ uids: [], changed: [] }),
  getEmailHeadersByUids: vi.fn().mockResolvedValue([]),
  readLocalEmailIndex: vi.fn().mockResolvedValue(null),
  getArchivedEmails: vi.fn().mockResolvedValue([]),
  saveEmailHeaders: (...a) => mockSaveEmailHeaders(...a),
  clearMailboxCache: vi.fn().mockResolvedValue(undefined),
  // Graph only: a complete, fresh folder list, so the loader goes straight to the listing.
  getCachedMailboxEntry: vi.fn().mockResolvedValue({
    mailboxes: [{ path: 'INBOX', _graphFolderId: 'gid' }, { path: 'Sent', _graphFolderId: 'gsent' }],
    fetchedAt: Date.now(),
  }),
  saveMailboxes: vi.fn(),
}));

const mockCheckMailboxStatus = vi.fn();
const mockFetchEmails = vi.fn();
const mockSearchAllUids = vi.fn();
const mockFetchHeadersByUids = vi.fn();
const mockFetchChangedFlags = vi.fn();
vi.mock('../../api', () => ({
  fetchEmails: (...a) => mockFetchEmails(...a),
  checkMailboxStatus: (...a) => mockCheckMailboxStatus(...a),
  searchAllUids: (...a) => mockSearchAllUids(...a),
  fetchHeadersByUids: (...a) => mockFetchHeadersByUids(...a),
  fetchChangedFlags: (...a) => mockFetchChangedFlags(...a),
  vaultApplyFlags: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../authUtils', () => ({
  hasValidCredentials: () => true,
  ensureFreshToken: (a) => Promise.resolve(a),
  resolveServerAccount: (id, account) => Promise.resolve({ ok: true, account }),
}));
const mockIsGraph = vi.fn(() => false);
vi.mock('../../graphConfig', () => ({
  isGraphAccount: (...a) => mockIsGraph(...a),
  graphFoldersToMailboxes: () => [],
  graphMessageToEmail: (m) => m,
}));
const mockListGraphMessages = vi.fn();
vi.mock('../../cacheManager', () => ({
  saveRestoreDescriptor: vi.fn(),
  getRestoreDescriptor: vi.fn().mockReturnValue(null),
  getAccountCacheMailboxes: vi.fn().mockReturnValue([]),
  listGraphMessages: (...a) => mockListGraphMessages(...a),
  getGraphMessageId: vi.fn().mockReturnValue(null),
  resolveGraphMessageId: vi.fn().mockResolvedValue(null),
  restoreGraphIdMap: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../stores/settingsStore', () => ({
  useSettingsStore: {
    getState: () => ({ setUnreadForAccount: vi.fn(), hiddenAccounts: {} }),
  },
}));

const { useMailStore } = await import('../../../stores/mailStore');
const { applySeenLocally } = await import('../messageMutations');

const ACCOUNT = { id: 'acct-1', email: 'me@mock.test', password: 'pw' };
const UIDS = Array.from({ length: 10 }, (_, i) => 10 - i); // 10..1
const mkHeader = (uid, flags = []) => ({
  uid,
  subject: `Msg ${uid}`,
  date: new Date(1_700_000_000_000 + uid * 1000).toISOString(),
  flags,
  from: { address: 'sender@mock.test' },
});

function primeInbox(uids = UIDS) {
  useMailStore.setState({
    accounts: [ACCOUNT],
    activeAccountId: ACCOUNT.id,
    activeMailbox: 'INBOX',
    mailboxScope: null,
    emails: uids.map(u => mkHeader(u)),
    localEmails: [],
    sentEmails: [],
    savedEmailIds: new Set(),
    archivedEmailIds: new Set(),
    serverUids: serverUids(new Set(uids), { complete: true }),
    deleteTombstones: new Set(),
    totalEmails: uids.length,
    loading: false,
  });
}

// A promise the test settles by hand: the network call "still on the wire".
function parked() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const tick = async () => {
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0));
};

const markRead = (uid) =>
  applySeenLocally(useMailStore, { accountId: ACCOUNT.id, mailbox: 'INBOX', uid, read: true });
const storeRow = (uid) => useMailStore.getState().emails.find(e => e.uid === uid);
const savedRow = (uid) => mockSaveEmailHeaders.mock.calls.at(-1)?.[2]?.find(e => e.uid === uid);

beforeEach(() => {
  vi.clearAllMocks();
  mockIsGraph.mockReturnValue(false);
  mockSaveEmailHeaders.mockResolvedValue(undefined);
  mockSearchAllUids.mockResolvedValue([]);
  mockFetchHeadersByUids.mockResolvedValue({ emails: [] });
  mockFetchChangedFlags.mockResolvedValue([]);
});

describe('loadEmails — a flag written while the load is on the wire survives its commit', () => {
  it('CONDSTORE flag-only branch: the row keeps \\Seen, in the list and in the sidecar write', async () => {
    primeInbox();
    mockGetEmailHeadersMeta.mockResolvedValue({
      uidValidity: 1, uidNext: 11, highestModseq: 5, totalEmails: 10, totalCached: 10,
    });
    mockCheckMailboxStatus.mockResolvedValue({ uidValidity: 1, uidNext: 11, highestModseq: 6, exists: 10 });
    const changes = parked();
    mockFetchChangedFlags.mockReturnValue(changes.promise);

    const done = useMailStore.getState().loadEmails();
    await tick();
    expect(mockFetchChangedFlags).toHaveBeenCalledTimes(1); // the load IS mid-flight

    markRead(7); // the user opens message 7
    expect(storeRow(7).flags).toContain('\\Seen');
    changes.resolve([{ uid: 3, flags: ['\\Flagged'] }]); // another device starred 3
    await done;

    expect(storeRow(7).flags).toContain('\\Seen');
    expect(savedRow(7).flags).toContain('\\Seen');
    // The server's own change still lands.
    expect(storeRow(3).flags).toEqual(['\\Flagged']);
    expect(savedRow(3).flags).toEqual(['\\Flagged']);
  });

  it('UID-search delta branch: the row keeps \\Seen, in the list and in the sidecar write', async () => {
    primeInbox();
    mockGetEmailHeadersMeta.mockResolvedValue({
      uidValidity: 1, uidNext: 11, highestModseq: null, totalEmails: 10, totalCached: 10,
    });
    mockCheckMailboxStatus.mockResolvedValue({ uidValidity: 1, uidNext: 12, highestModseq: null, exists: 11 });
    const search = parked();
    mockSearchAllUids.mockReturnValue(search.promise);
    mockFetchHeadersByUids.mockResolvedValue({ emails: [mkHeader(11)] });

    const done = useMailStore.getState().loadEmails();
    await tick();
    expect(mockSearchAllUids).toHaveBeenCalledTimes(1);

    markRead(7);
    search.resolve([...UIDS, 11]);
    await done;

    expect(storeRow(11)).toBeTruthy(); // the new arrival landed
    expect(storeRow(7).flags).toContain('\\Seen');
    expect(savedRow(7).flags).toContain('\\Seen');
  });

  it('full-fetch branch: the row keeps \\Seen, in the list and in the sidecar write', async () => {
    primeInbox();
    mockGetEmailHeadersMeta.mockResolvedValue(null); // no sync stamp: page 1 is fetched
    const page = parked();
    mockFetchEmails.mockReturnValue(page.promise);
    mockCheckMailboxStatus.mockResolvedValue({ uidValidity: 1, uidNext: 11, highestModseq: null, exists: 10 });

    const done = useMailStore.getState().loadEmails();
    await tick();
    expect(mockFetchEmails).toHaveBeenCalledTimes(1);

    markRead(7);
    // The page was fetched before the server saw the mark: message 7 unread.
    page.resolve({ emails: UIDS.map(u => mkHeader(u)), total: 10, hasMore: false });
    await done;

    expect(storeRow(7).flags).toContain('\\Seen');
    expect(savedRow(7).flags).toContain('\\Seen');
    // Untouched rows still come from the load.
    expect(storeRow(6).flags).toEqual([]);
  });

  it('a reissued UIDVALIDITY starts over: an old-epoch uid is not the same message', async () => {
    primeInbox();
    mockGetEmailHeadersMeta.mockResolvedValue({
      uidValidity: 1, uidNext: 11, highestModseq: 5, totalEmails: 10, totalCached: 10,
    });
    mockCheckMailboxStatus.mockResolvedValue({ uidValidity: 2, uidNext: 11, highestModseq: 5, exists: 10 });
    const page = parked();
    mockFetchEmails.mockReturnValue(page.promise);

    const done = useMailStore.getState().loadEmails();
    await tick();
    expect(mockFetchEmails).toHaveBeenCalledTimes(1);

    markRead(7); // a write to the OLD message that had uid 7
    page.resolve({ emails: UIDS.map(u => mkHeader(u)), total: 10, hasMore: false });
    await done;

    expect(storeRow(7).flags).toEqual([]);
    expect(savedRow(7).flags).toEqual([]);
  });

  it('Graph listing: the row keeps \\Seen, in the list and in the sidecar write', async () => {
    mockIsGraph.mockReturnValue(true);
    primeInbox();
    mockGetEmailHeadersMeta.mockResolvedValue(null);
    const listing = parked();
    mockListGraphMessages.mockReturnValue(listing.promise);

    const done = useMailStore.getState().loadEmails();
    await tick();
    expect(mockListGraphMessages).toHaveBeenCalledTimes(1);

    markRead(7);
    listing.resolve({ headers: UIDS.map(u => mkHeader(u)), nextLink: null });
    await done;

    expect(storeRow(7).flags).toContain('\\Seen');
    expect(savedRow(7).flags).toContain('\\Seen');
  });
});
