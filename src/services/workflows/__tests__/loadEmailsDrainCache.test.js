// The daemon writes a new message's sidecar BEFORE it announces the change, so
// by the time the app repaints, the row is already on disk. Every "nothing
// changed" exit in loadEmails compares the daemon's own post-sync
// uidNext/highestModseq against the server, finds them identical — the daemon
// made them so — and returns without ever reading a cache ROW. The only call
// that reads rows lives in the branch reachable solely when the store is empty,
// which a visible inbox never is. Result: the notification fired and the list
// never moved until the user switched accounts (which empties `emails` and
// forces the cache read).
//
// So the drain has to happen BEFORE the server reconcile, in the reuse branch
// every repaint passes through — that is what makes it branch-independent
// rather than a patch on whichever early return the report happened to hit.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { serverUids } from '../../../stores/slices/serverUids';

if (!globalThis.window) {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
} else {
  globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
}
vi.stubGlobal('navigator', { onLine: true });

const mockGetSavedEmailIds = vi.fn().mockResolvedValue(new Set());
const mockGetArchivedEmailIds = vi.fn().mockResolvedValue(new Set());
const mockGetEmailHeadersMeta = vi.fn();
const mockGetEmailHeadersPartial = vi.fn().mockResolvedValue({ emails: [], totalEmails: 0 });
const mockListCachedUids = vi.fn();
const mockGetEmailHeadersByUids = vi.fn();

vi.mock('../../db', () => ({
  getSavedEmailIds: (...a) => mockGetSavedEmailIds(...a),
  getArchivedEmailIds: (...a) => mockGetArchivedEmailIds(...a),
  getEmailHeadersMeta: (...a) => mockGetEmailHeadersMeta(...a),
  getEmailHeadersPartial: (...a) => mockGetEmailHeadersPartial(...a),
  listCachedUids: (...a) => mockListCachedUids(...a),
  getEmailHeadersByUids: (...a) => mockGetEmailHeadersByUids(...a),
  readLocalEmailIndex: vi.fn().mockResolvedValue(null),
  getArchivedEmails: vi.fn().mockResolvedValue([]),
  saveEmailHeaders: vi.fn().mockResolvedValue(undefined),
  clearMailboxCache: vi.fn().mockResolvedValue(undefined),
}));

const mockCheckMailboxStatus = vi.fn();
const mockFetchEmails = vi.fn();
const mockSearchAllUids = vi.fn().mockResolvedValue([]);
vi.mock('../../api', () => ({
  fetchEmails: (...a) => mockFetchEmails(...a),
  checkMailboxStatus: (...a) => mockCheckMailboxStatus(...a),
  searchAllUids: (...a) => mockSearchAllUids(...a),
  fetchHeadersByUids: vi.fn().mockResolvedValue({ emails: [] }),
  fetchChangedFlags: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../authUtils', () => ({
  hasValidCredentials: () => true,
  ensureFreshToken: (a) => Promise.resolve(a),
  resolveServerAccount: (id, account) => Promise.resolve({ ok: true, account }),
}));
vi.mock('../../graphConfig', () => ({
  isGraphAccount: () => false,
  normalizeGraphFolderName: (x) => x,
  graphFoldersToMailboxes: () => [],
  graphMessageToEmail: (m) => m,
}));
vi.mock('../../cacheManager', () => ({
  saveRestoreDescriptor: vi.fn(),
  getRestoreDescriptor: vi.fn().mockReturnValue(null),
  getAccountCacheMailboxes: vi.fn().mockReturnValue([]),
  listGraphMessages: vi.fn().mockResolvedValue({ headers: [], graphMessageIds: [] }),
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

const ACCOUNT = { id: 'acct-1', email: 'me@mock.test', password: 'pw' };
const mkHeader = (uid) => ({
  uid,
  subject: `Msg ${uid}`,
  date: new Date(1_700_000_000_000 + uid * 1000).toISOString(),
  flags: ['\\Seen'],
  from: { address: 'sender@mock.test' },
});

// The list as the user left it: a full window of 100 rows, nothing loading.
function primeVisibleInbox(uids) {
  const emails = uids.map(mkHeader);
  useMailStore.setState({
    accounts: [ACCOUNT],
    activeAccountId: ACCOUNT.id,
    activeMailbox: 'INBOX',
    mailboxScope: null,
    emails,
    localEmails: [],
    savedEmailIds: new Set(),
    archivedEmailIds: new Set(),
    serverUids: serverUids(new Set(uids), { complete: true }),
    deleteTombstones: new Set(),
    totalEmails: uids.length,
  });
  return emails;
}

// Real timers: the point of these tests is what the store holds while the
// server call is still on the wire, so the microtask queue has to actually run.
const tick = async () => {
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0));
};

const STORE_UIDS = Array.from({ length: 100 }, (_, i) => 100 - i); // 100..1

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSavedEmailIds.mockResolvedValue(new Set());
  mockGetArchivedEmailIds.mockResolvedValue(new Set());
  mockGetEmailHeadersPartial.mockResolvedValue({ emails: [], totalEmails: 0 });
  mockSearchAllUids.mockResolvedValue([]);
});

describe('loadEmails — new mail the daemon already cached lands without an account switch', () => {
  it('merges the cached row into the list before the server call answers, and keeps it after the noop', async () => {
    primeVisibleInbox(STORE_UIDS);
    // Post-sync meta: the daemon wrote uid 101's sidecar and then announced it.
    mockGetEmailHeadersMeta.mockResolvedValue({
      uidValidity: 1, uidNext: 102, highestModseq: 5, totalEmails: 101, totalCached: 101,
    });
    mockListCachedUids.mockResolvedValue({ uids: [...STORE_UIDS, 101], changed: [] });
    mockGetEmailHeadersByUids.mockResolvedValue([mkHeader(101)]);

    // Parked: nothing downstream of the reconcile may be what puts the row on
    // screen, or this passes for the wrong reason.
    let answerStatus;
    mockCheckMailboxStatus.mockImplementation(() => new Promise((r) => { answerStatus = r; }));

    const done = useMailStore.getState().loadEmails();
    await tick();

    expect(mockCheckMailboxStatus).toHaveBeenCalledTimes(1); // the reconcile IS in flight
    expect(useMailStore.getState().emails.map((e) => e.uid)).toContain(101);
    expect(useMailStore.getState().sortedEmails.map((e) => e.uid)).toContain(101);
    expect(mockGetEmailHeadersByUids).toHaveBeenCalledWith(ACCOUNT.id, 'INBOX', [101]);

    // The condstore-noop exit — identical modseq and uidNext, because the
    // daemon wrote both — must no longer be able to hide the row.
    answerStatus({ uidValidity: 1, uidNext: 102, highestModseq: 5, exists: 101 });
    await done;

    expect(useMailStore.getState().emails.map((e) => e.uid)).toContain(101);
    expect(useMailStore.getState().totalEmails).toBe(101);
  });

  it('leaves the list untouched when the cache holds nothing the store does not', async () => {
    const emails = primeVisibleInbox(STORE_UIDS);
    mockGetEmailHeadersMeta.mockResolvedValue({
      uidValidity: 1, uidNext: 101, highestModseq: 5, totalEmails: 100, totalCached: 100,
    });
    mockCheckMailboxStatus.mockResolvedValue({ uidValidity: 1, uidNext: 101, highestModseq: 5, exists: 100 });

    await useMailStore.getState().loadEmails();

    // Same array, not a rebuilt copy — a repaint that rewrites `emails` every
    // time re-derives every row and drops the sorted memo for nothing.
    expect(useMailStore.getState().emails).toBe(emails);
    // One meta read, and not a single sidecar touched.
    expect(mockListCachedUids).not.toHaveBeenCalled();
    expect(mockGetEmailHeadersByUids).not.toHaveBeenCalled();
  });
});
