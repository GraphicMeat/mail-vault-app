// serverUidsKnown on activateAccount()'s cold-open paths — this is the
// function every sidebar/folder click and app-launch quick-load actually
// calls (see Sidebar.jsx, App.jsx), so it is the real first-visit-this-
// session path, not just loadEmails()'s refresh cycle. See
// task-1-report.md, "Fix round 2".
import { describe, it, expect, beforeEach, vi } from 'vitest';

if (!globalThis.window) {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
} else {
  globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
}
vi.stubGlobal('navigator', { onLine: true });

const mockGetCachedMailboxEntry = vi.fn().mockResolvedValue(null);
const mockGetEmailHeadersMeta = vi.fn().mockResolvedValue(null);
const mockGetEmailHeadersPartial = vi.fn().mockResolvedValue({ emails: [], totalEmails: 0 });
const mockGetArchivedEmailIds = vi.fn().mockResolvedValue(new Set());
const mockGetSavedEmailIds = vi.fn().mockResolvedValue(new Set());
const mockSaveEmailHeaders = vi.fn().mockResolvedValue(undefined);
const mockSaveMailboxes = vi.fn().mockResolvedValue(undefined);
const mockClearMailboxCache = vi.fn().mockResolvedValue(undefined);
const mockGetArchivedEmails = vi.fn().mockResolvedValue(undefined);

vi.mock('../../db', () => ({
  getCachedMailboxEntry: (...a) => mockGetCachedMailboxEntry(...a),
  getEmailHeadersMeta: (...a) => mockGetEmailHeadersMeta(...a),
  getEmailHeadersPartial: (...a) => mockGetEmailHeadersPartial(...a),
  getArchivedEmailIds: (...a) => mockGetArchivedEmailIds(...a),
  getSavedEmailIds: (...a) => mockGetSavedEmailIds(...a),
  saveEmailHeaders: (...a) => mockSaveEmailHeaders(...a),
  saveMailboxes: (...a) => mockSaveMailboxes(...a),
  // Referenced as plain properties (not necessarily called) when
  // loadLocalEmails() builds headerMemo.recall()'s `io` argument — accessing
  // an unmocked property throws under vitest's strict module mock, even
  // though recall() only invokes them on a memo hit (never true here).
  listCachedUids: vi.fn(),
  getEmailHeadersByUids: vi.fn(),
  clearMailboxCache: (...a) => mockClearMailboxCache(...a),
  getArchivedEmails: (...a) => mockGetArchivedEmails(...a),
}));

const mockFetchEmails = vi.fn();
const mockCheckMailboxStatus = vi.fn();
const mockFetchMailboxes = vi.fn().mockResolvedValue([]);
vi.mock('../../api', () => ({
  fetchEmails: (...a) => mockFetchEmails(...a),
  checkMailboxStatus: (...a) => mockCheckMailboxStatus(...a),
  fetchMailboxes: (...a) => mockFetchMailboxes(...a),
  searchAllUids: vi.fn().mockResolvedValue([]),
  fetchHeadersByUids: vi.fn().mockResolvedValue({ emails: [] }),
  fetchChangedFlags: vi.fn().mockResolvedValue([]),
  graphListFolders: vi.fn().mockResolvedValue([]),
  graphListMessages: vi.fn().mockResolvedValue({ headers: [], graphMessageIds: [] }),
}));

vi.mock('../../authUtils', () => ({
  ensureFreshToken: (a) => Promise.resolve(a),
  resolveServerAccount: (id, account) => Promise.resolve({ ok: true, account }),
}));
vi.mock('../../graphConfig', () => ({
  isGraphAccount: () => false,
  GRAPH_FOLDER_NAME_MAP: {},
  graphFoldersToMailboxes: () => [],
  inferSpecialUse: () => null,
  graphMessageToEmail: (m) => m,
  isPersonalMicrosoftEmail: () => false,
}));
const mockGetRestoreDescriptor = vi.fn().mockReturnValue(null);
vi.mock('../../cacheManager', () => ({
  saveRestoreDescriptor: vi.fn(),
  getRestoreDescriptor: (...a) => mockGetRestoreDescriptor(...a),
  setGraphIdMap: vi.fn(),
  getGraphMessageId: vi.fn().mockReturnValue(null),
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
const mockMailboxIsUnchanged = vi.fn();
const mockSyncNow = vi.fn().mockResolvedValue(undefined);
const mockWaitForSync = vi.fn();
vi.mock('../../syncProbe', () => ({
  mailboxIsUnchanged: (...a) => mockMailboxIsUnchanged(...a),
  markVerified: vi.fn(),
  invalidate: vi.fn(),
}));
vi.mock('../../syncService', () => ({
  syncNow: (...a) => mockSyncNow(...a),
  waitForSync: (...a) => mockWaitForSync(...a),
}));

const { useMailStore } = await import('../../../stores/mailStore');
// Real module — an in-memory, module-level cache (see headerMemo.js). Not
// mocked, but explicitly cleared per test below so a header set memoized by
// one test's activation can't be recalled (and reconciled against an io that
// this file doesn't mock) by the next.
const { forget: forgetMemo } = await import('../../headerMemo');

const ACCOUNT = { id: 'acct-1', email: 'me@mock.test', password: 'pw' };
const mkHeader = (uid) => ({ uid, subject: `Msg ${uid}`, date: '2026-08-01T00:00:00Z', flags: [] });

function primeCold() {
  useMailStore.setState({
    accounts: [ACCOUNT],
    activeAccountId: null, // not yet active — forces the non-background-refresh clear path
    activeMailbox: 'INBOX',
    emails: [],
    localEmails: [],
    sentEmails: [],
    sortedEmails: [],
    savedEmailIds: new Set(),
    archivedEmailIds: new Set(),
    serverUidSet: new Set(),
    serverUidsKnown: true, // stale carry-over from a prior fully-synced mailbox
    deleteTombstones: new Set(),
    totalEmails: 0,
    mailboxes: [],
    unifiedInbox: false,
    loadSentHeaders: vi.fn(),
  });
}

// For _backgroundRefresh: true calls specifically: that option makes
// activateAccount skip its own "clear stale data on switch" setState (the
// one that already, independently of this fix, resets serverUidsKnown to
// false — see messageListSlice.js's original Task 1 sites). Priming as
// already-active and refreshing in the background means the ONLY thing that
// can move serverUidsKnown is the code this fix adds, so these tests prove
// something a plain activateAccount() call can't distinguish from "nothing
// touched it, the old clear already left it false".
function primeActiveForBackgroundRefresh() {
  useMailStore.setState({
    accounts: [ACCOUNT],
    activeAccountId: ACCOUNT.id,
    activeMailbox: 'INBOX',
    emails: [mkHeader(1)],
    localEmails: [],
    sentEmails: [],
    sortedEmails: [],
    savedEmailIds: new Set(),
    archivedEmailIds: new Set(),
    serverUidSet: new Set([1]),
    serverUidsKnown: true, // stale carry-over — must not survive an incomplete refresh
    deleteTombstones: new Set(),
    totalEmails: 1,
    mailboxes: [],
    unifiedInbox: false,
    loadSentHeaders: vi.fn(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCachedMailboxEntry.mockResolvedValue(null);
  mockGetEmailHeadersMeta.mockResolvedValue(null);
  mockGetEmailHeadersPartial.mockResolvedValue({ emails: [], totalEmails: 0 });
  mockGetArchivedEmailIds.mockResolvedValue(new Set());
  mockGetSavedEmailIds.mockResolvedValue(new Set());
  mockFetchMailboxes.mockResolvedValue([]);
  mockGetRestoreDescriptor.mockReturnValue(null);
  mockGetDaemonHealth.mockReturnValue({ alive: false });
  forgetMemo(ACCOUNT.id);
});

describe('activateAccount IMAP-fallback cold path (daemon not alive, first visit)', () => {
  it('proves serverUidsKnown true when the page-1 fetch already covers serverTotal', async () => {
    primeCold();
    mockFetchEmails.mockResolvedValue({ total: 3, emails: [mkHeader(1), mkHeader(2), mkHeader(3)] });
    mockCheckMailboxStatus.mockResolvedValue({ uidValidity: 1, uidNext: 4, highestModseq: null });

    await useMailStore.getState().activateAccount(ACCOUNT.id, 'INBOX');

    const state = useMailStore.getState();
    expect(state.serverUidsKnown).toBe(true);
    expect(state.serverUidSet.size).toBe(3);
  });

  it('proves serverUidsKnown false when the page-1 fetch does not cover serverTotal', async () => {
    primeCold();
    mockFetchEmails.mockResolvedValue({ total: 500, emails: [mkHeader(1), mkHeader(2)] });
    mockCheckMailboxStatus.mockResolvedValue({ uidValidity: 1, uidNext: 501, highestModseq: null });

    await useMailStore.getState().activateAccount(ACCOUNT.id, 'INBOX');

    const state = useMailStore.getState();
    expect(state.serverUidsKnown).toBe(false);
  });

  // See primeActiveForBackgroundRefresh's comment: isolates this fix's own
  // logic from the pre-existing clear-on-switch, which would otherwise mask
  // a broken (no-op) version of this fix behind its own correct default.
  it('background refresh: flips a stale true to false on an incomplete page, with no other reset in play', async () => {
    primeActiveForBackgroundRefresh();
    mockGetEmailHeadersMeta.mockResolvedValue(null); // no cached sync -> IMAP-fallback branch
    mockFetchEmails.mockResolvedValue({ total: 500, emails: [mkHeader(1), mkHeader(2)] });
    mockCheckMailboxStatus.mockResolvedValue({ uidValidity: 1, uidNext: 501, highestModseq: null });

    await useMailStore.getState().activateAccount(ACCOUNT.id, 'INBOX', { _backgroundRefresh: true });

    expect(useMailStore.getState().serverUidsKnown).toBe(false);
  });

  // loadLocalEmails() and loadServerEmails() run concurrently off the same
  // uidMap (Promise.all in activateAccount). The disk-cache paint here
  // contributes a row (uid 99) the live page-1 fetch never saw or confirmed.
  // Naively checking "did the fetch reach serverTotal" would say yes (1 >=
  // 1) and wrongly certify a uidMap that actually holds 2 unreconciled rows
  // — exactly the false-amber risk the coordinator flagged. The guard
  // (sorted.length === serverEmails.length) must catch this.
  it('does not claim complete when a concurrent local-cache paint left an extra row in uidMap', async () => {
    primeActiveForBackgroundRefresh();
    mockGetEmailHeadersMeta.mockResolvedValue(null); // no cached sync -> IMAP-fallback branch
    mockGetEmailHeadersPartial.mockResolvedValue({
      emails: [mkHeader(99)], // stale disk-only row, unrelated to the live fetch below
      totalEmails: 1,
    });
    mockFetchEmails.mockResolvedValue({ total: 1, emails: [mkHeader(1)] }); // live fetch: 1 == serverTotal
    mockCheckMailboxStatus.mockResolvedValue({ uidValidity: 1, uidNext: 2, highestModseq: null });

    await useMailStore.getState().activateAccount(ACCOUNT.id, 'INBOX', { _backgroundRefresh: true });

    const state = useMailStore.getState();
    expect(state.emails.map(e => e.uid).sort()).toEqual([1, 99]); // sanity: both rows really did land in uidMap
    expect(state.serverUidsKnown).toBe(false);
  });
});

describe('activateAccount daemon-sync cold path (daemon alive, first visit)', () => {
  beforeEach(() => {
    mockGetDaemonHealth.mockReturnValue({ alive: true });
    mockMailboxIsUnchanged.mockResolvedValue({ unchanged: false, reason: 'never-synced' });
    mockSyncNow.mockResolvedValue(undefined);
  });

  it('proves serverUidsKnown true when the post-sync disk read (capped at 500) already covers totalEmails', async () => {
    primeActiveForBackgroundRefresh();
    mockWaitForSync.mockResolvedValue({ success: true, new_emails: 3, total_emails: 3 });
    mockGetEmailHeadersPartial.mockResolvedValue({
      emails: [mkHeader(1), mkHeader(2), mkHeader(3)],
      totalEmails: 3,
    });

    await useMailStore.getState().activateAccount(ACCOUNT.id, 'INBOX', { _backgroundRefresh: true });

    const state = useMailStore.getState();
    expect(state.serverUidsKnown).toBe(true);
    expect([...state.serverUidSet].sort()).toEqual([1, 2, 3]);
  });

  it('proves serverUidsKnown false when the post-sync disk read is short of totalEmails (mailbox past the 500 cap)', async () => {
    primeActiveForBackgroundRefresh();
    mockWaitForSync.mockResolvedValue({ success: true, new_emails: 1, total_emails: 5000 });
    mockGetEmailHeadersPartial.mockResolvedValue({
      emails: [mkHeader(1)], // far short of 5000
      totalEmails: 5000,
    });

    await useMailStore.getState().activateAccount(ACCOUNT.id, 'INBOX', { _backgroundRefresh: true });

    expect(useMailStore.getState().serverUidsKnown).toBe(false);
  });

  it('leaves serverUidsKnown untouched when the disk cache already carries a (possibly stale) serverUids field', async () => {
    primeActiveForBackgroundRefresh();
    mockWaitForSync.mockResolvedValue({ success: true, new_emails: 0, total_emails: 1 });
    mockGetEmailHeadersPartial.mockResolvedValue({
      emails: [mkHeader(1)],
      totalEmails: 1,
      serverUids: [7, 8, 9], // pre-existing field takes the old code path, unrelated to this fix
    });

    await useMailStore.getState().activateAccount(ACCOUNT.id, 'INBOX', { _backgroundRefresh: true });

    const state = useMailStore.getState();
    expect([...state.serverUidSet].sort()).toEqual([7, 8, 9]);
    // Primed true, and this branch doesn't touch the flag either way — pre-existing behavior, not this fix's concern.
    expect(state.serverUidsKnown).toBe(true);
  });
});

// mailboxIsUnchanged's "unchanged" verdict answers "has the server moved
// since the cache was written" — a different question from "do we have a
// complete enumeration". A descriptor-restore paint legitimately empties
// serverUidSet (and sets serverUidsKnown: false) on every switch back to a
// mailbox — see activateAccount.js's own serverUidsKnown: false sites — and
// short-circuiting on probe.unchanged regardless of that flag is what let
// the reset survive forever: an unchanged verdict never itself re-proves
// anything, and the probe's own 10s TTL shortcut re-extends on every hit
// (markVerified runs unconditionally), so a live check might never run again
// to give the flag a chance to recover. The fix: gate the shortcut on
// serverUidsKnown already being true; fall through to a real sync otherwise.
describe('activateAccount probe.unchanged branch (daemon alive)', () => {
  beforeEach(() => {
    mockGetDaemonHealth.mockReturnValue({ alive: true });
    mockSyncNow.mockResolvedValue(undefined);
  });

  it('a proven true survives a subsequent activation without paying for a sync', async () => {
    primeActiveForBackgroundRefresh(); // serverUidsKnown primed true
    mockMailboxIsUnchanged.mockResolvedValue({ unchanged: true, reason: 'uidnext-exists-match' });

    await useMailStore.getState().activateAccount(ACCOUNT.id, 'INBOX', { _backgroundRefresh: true });

    const state = useMailStore.getState();
    expect(state.serverUidsKnown).toBe(true);
    expect([...state.serverUidSet]).toEqual([1]); // untouched — the shortcut was taken, nothing re-derived
    // The latency guarantee: once proven, an unchanged mailbox costs one
    // probe, never a sync.now/wait.for round trip.
    expect(mockSyncNow).not.toHaveBeenCalled();
  });

  it('an unproven false falls through to a real sync instead of short-circuiting', async () => {
    primeActiveForBackgroundRefresh();
    useMailStore.setState({ serverUidsKnown: false }); // e.g. just reset by a descriptor-restore paint
    mockMailboxIsUnchanged.mockResolvedValue({ unchanged: true, reason: 'modseq-match' });
    mockWaitForSync.mockResolvedValue({ success: true, new_emails: 0, total_emails: 1 });
    mockGetEmailHeadersPartial.mockResolvedValue({ emails: [mkHeader(1)], totalEmails: 1 });

    await useMailStore.getState().activateAccount(ACCOUNT.id, 'INBOX', { _backgroundRefresh: true });

    // Fell through despite probe.unchanged: true — this is the assertion
    // that actually distinguishes this fix from a no-op.
    expect(mockSyncNow).toHaveBeenCalled();
    expect(mockWaitForSync).toHaveBeenCalled();
    // And the fall-through did its job: the sync's own completeness proof
    // (already covered by the daemon-sync describe block above) re-establishes true.
    expect(useMailStore.getState().serverUidsKnown).toBe(true);
  });

  it('probed-recently does not exempt an unproven false from falling through', async () => {
    primeActiveForBackgroundRefresh();
    useMailStore.setState({ serverUidsKnown: false });
    // The TTL shortcut reason specifically — proves the fix does not special-
    // case it back into a preserve-only branch, which is what let the TTL
    // re-extend itself indefinitely in the original bug.
    mockMailboxIsUnchanged.mockResolvedValue({ unchanged: true, reason: 'probed-recently' });
    mockWaitForSync.mockResolvedValue({ success: true, new_emails: 0, total_emails: 1 });
    mockGetEmailHeadersPartial.mockResolvedValue({ emails: [mkHeader(1)], totalEmails: 1 });

    await useMailStore.getState().activateAccount(ACCOUNT.id, 'INBOX', { _backgroundRefresh: true });

    expect(mockSyncNow).toHaveBeenCalled();
    expect(useMailStore.getState().serverUidsKnown).toBe(true);
  });
});
