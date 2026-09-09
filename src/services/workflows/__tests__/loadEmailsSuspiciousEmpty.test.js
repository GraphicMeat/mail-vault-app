// The "server says this mailbox is empty" branch of loadEmails().
//
// The old guard refused such an answer for ever and parked the "Showing cached
// data" banner: it returned BEFORE the cache write, so `cachedHeaders`
// (and `lastKnownGoodTotalEmails`, which caches.js preserves across empty
// saves) kept the stale count, and vault copies count as evidence too. Any
// folder that genuinely emptied re-tripped the same guard on every load, for
// ever. These specs pin the replacement: refuse ONCE per (account, mailbox),
// re-ask, then believe the server.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { serverUids } from '../../../stores/slices/serverUids';
import { clearEmptyRefusals, EMPTY_REVERIFY_MS } from '../../../stores/slices/syncSlice';

if (!globalThis.window) {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
} else {
  globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
}
vi.stubGlobal('navigator', { onLine: true });

const mockGetSavedEmailIds = vi.fn().mockResolvedValue(new Set());
const mockGetArchivedEmailIds = vi.fn().mockResolvedValue(new Set());
const mockGetEmailHeadersMeta = vi.fn().mockResolvedValue(null);
const mockGetEmailHeadersPartial = vi.fn().mockResolvedValue({ emails: [], totalEmails: 0 });
const mockSaveEmailHeaders = vi.fn().mockResolvedValue(undefined);

vi.mock('../../db', () => ({
  getSavedEmailIds: (...a) => mockGetSavedEmailIds(...a),
  getArchivedEmailIds: (...a) => mockGetArchivedEmailIds(...a),
  getEmailHeadersMeta: (...a) => mockGetEmailHeadersMeta(...a),
  getEmailHeadersPartial: (...a) => mockGetEmailHeadersPartial(...a),
  readLocalEmailIndex: vi.fn().mockResolvedValue(null),
  getArchivedEmails: vi.fn().mockResolvedValue([]),
  saveEmailHeaders: (...a) => mockSaveEmailHeaders(...a),
  clearMailboxCache: vi.fn().mockResolvedValue(undefined),
}));

const mockCheckMailboxStatus = vi.fn();
const mockSearchAllUids = vi.fn().mockResolvedValue([]);
vi.mock('../../api', () => ({
  fetchEmails: vi.fn(),
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
  listGraphMessages: vi.fn().mockResolvedValue({ headers: [], graphMessageIds: [] }),
  getGraphMessageId: vi.fn().mockReturnValue(null),
  resolveGraphMessageId: vi.fn().mockResolvedValue(null),
  restoreGraphIdMap: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../stores/settingsStore', () => ({
  useSettingsStore: {
    getState: () => ({ setUnreadForAccount: vi.fn() }),
  },
}));

const { useMailStore } = await import('../../../stores/mailStore');

const ACCOUNT = { id: 'acct-1', email: 'me@mock.test', password: 'pw' };
const KEY = `${ACCOUNT.id}:INBOX`;
const mkHeader = (uid) => ({ uid, subject: `Msg ${uid}`, date: '2026-08-01T00:00:00Z', flags: [] });

/** Two cached rows on screen and a cached sync stamp, so an empty server answer contradicts them. */
function primeCachedTwo() {
  useMailStore.setState({
    accounts: [ACCOUNT],
    activeAccountId: ACCOUNT.id,
    activeMailbox: 'INBOX',
    mailboxScope: null,
    emails: [mkHeader(1), mkHeader(2)],
    localEmails: [],
    savedEmailIds: new Set(),
    archivedEmailIds: new Set(),
    serverUids: serverUids(new Set([1, 2]), { complete: true }),
    deleteTombstones: new Set(),
    totalEmails: 2,
    suspectEmptyServerData: null,
  });
  mockGetEmailHeadersMeta.mockResolvedValue({
    uidValidity: 1, uidNext: 3, highestModseq: null, totalEmails: 2, totalCached: 2,
  });
}

const serverSays = (exists) => mockCheckMailboxStatus.mockResolvedValue({
  uidValidity: 1, uidNext: 3, highestModseq: null, exists,
});

/** The rows the last cache write recorded, or undefined when nothing was written. */
const lastSavedRows = () => mockSaveEmailHeaders.mock.calls.at(-1)?.[2];

beforeEach(() => {
  vi.clearAllMocks();
  clearEmptyRefusals(KEY);
  mockGetSavedEmailIds.mockResolvedValue(new Set());
  mockGetArchivedEmailIds.mockResolvedValue(new Set());
  mockSaveEmailHeaders.mockResolvedValue(undefined);
  mockSearchAllUids.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
  clearEmptyRefusals(KEY);
});

describe('loadEmails — an empty answer that contradicts the cache', () => {
  it('keeps the cached rows on the first empty answer and writes nothing', async () => {
    primeCachedTwo();
    serverSays(0);

    await useMailStore.getState().loadEmails();

    const state = useMailStore.getState();
    expect(state.emails.map(e => e.uid)).toEqual([1, 2]);
    expect(state.totalEmails).toBe(2);
    expect(mockSaveEmailHeaders).not.toHaveBeenCalled();
  });

  it('never raises the cached-data banner — the re-verify is silent', async () => {
    primeCachedTwo();
    serverSays(0);

    await useMailStore.getState().loadEmails();

    // The banner promised "while verifying" and nothing verified; the refusal
    // is now a re-ask, so the user is told nothing at all.
    expect(useMailStore.getState().suspectEmptyServerData).toBeNull();
    expect(useMailStore.getState().connectionStatus).toBe('connected');
    expect(useMailStore.getState().loading).toBe(false);
  });

  it('schedules the re-verify instead of waiting for the user', async () => {
    vi.useFakeTimers();
    primeCachedTwo();
    serverSays(0);

    await useMailStore.getState().loadEmails();

    expect(vi.getTimerCount()).toBeGreaterThan(0);
    expect(EMPTY_REVERIFY_MS).toBeGreaterThan(0);
  });

  it('believes the second empty answer: list, total and cache all go to zero', async () => {
    primeCachedTwo();
    serverSays(0);

    await useMailStore.getState().loadEmails(); // refused
    await useMailStore.getState().loadEmails(); // the re-verify's answer

    const state = useMailStore.getState();
    expect(state.emails).toEqual([]);
    expect(state.totalEmails).toBe(0);
    // The write is the whole point: without it `cachedHeaders.totalEmails`
    // stays at 2 and the guard re-trips on every later load, for ever.
    expect(lastSavedRows()).toEqual([]);
    expect(mockSaveEmailHeaders.mock.calls.at(-1)?.[3]).toBe(0);
    expect(state.suspectEmptyServerData).toBeNull();
  });

  it('a real answer re-arms the single refusal for a mailbox that empties later', async () => {
    primeCachedTwo();
    serverSays(0);
    await useMailStore.getState().loadEmails(); // refusal spent

    // Server comes back with mail: the refusal is re-armed.
    primeCachedTwo();
    serverSays(2);
    mockSearchAllUids.mockResolvedValue([1, 2]);
    await useMailStore.getState().loadEmails();
    expect(useMailStore.getState().emails.map(e => e.uid)).toEqual([1, 2]);

    // It empties again later, and gets its own free look rather than being
    // believed straight away.
    mockSearchAllUids.mockResolvedValue([]);
    serverSays(0);
    await useMailStore.getState().loadEmails();
    expect(useMailStore.getState().emails.map(e => e.uid)).toEqual([1, 2]);
  });

  it('does not spend a refusal on a mailbox that was already empty', async () => {
    // Nothing cached, nothing in the vault: an empty answer contradicts
    // nothing, so it is taken at face value the first time.
    useMailStore.setState({
      accounts: [ACCOUNT],
      activeAccountId: ACCOUNT.id,
      activeMailbox: 'INBOX',
      mailboxScope: null,
      emails: [mkHeader(1)],
      localEmails: [],
      savedEmailIds: new Set(),
      archivedEmailIds: new Set(),
      serverUids: serverUids(new Set([1]), { complete: true }),
      deleteTombstones: new Set(),
      totalEmails: 1,
      suspectEmptyServerData: null,
    });
    mockGetEmailHeadersMeta.mockResolvedValue({
      uidValidity: 1, uidNext: 2, highestModseq: null, totalEmails: 0, totalCached: 0,
    });
    serverSays(0);

    await useMailStore.getState().loadEmails();

    expect(useMailStore.getState().emails).toEqual([]);
    expect(lastSavedRows()).toEqual([]);
  });
});
