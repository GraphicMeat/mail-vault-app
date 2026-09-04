// server uid completeness on loadEmails()'s cold-fetch branches (no cached
// UIDVALIDITY/UIDNEXT yet, or UIDVALIDITY just changed) — the paths a
// mailbox's first-visit-this-session load actually takes. Task 1 originally
// only proved completeness inside the UID-search delta-sync branch, which
// requires a *prior* cached sync — leaving the true cold path with no way to
// ever earn the flag. See task-1-report.md, "Fix round 2".
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
const mockGetEmailHeadersMeta = vi.fn().mockResolvedValue(null);
const mockGetEmailHeadersPartial = vi.fn().mockResolvedValue({ emails: [], totalEmails: 0 });
const mockReadLocalEmailIndex = vi.fn().mockResolvedValue(null);
const mockGetArchivedEmails = vi.fn().mockResolvedValue([]);
const mockSaveEmailHeaders = vi.fn().mockResolvedValue(undefined);
const mockClearMailboxCache = vi.fn().mockResolvedValue(undefined);

vi.mock('../../db', () => ({
  getSavedEmailIds: (...a) => mockGetSavedEmailIds(...a),
  getArchivedEmailIds: (...a) => mockGetArchivedEmailIds(...a),
  getEmailHeadersMeta: (...a) => mockGetEmailHeadersMeta(...a),
  getEmailHeadersPartial: (...a) => mockGetEmailHeadersPartial(...a),
  readLocalEmailIndex: (...a) => mockReadLocalEmailIndex(...a),
  getArchivedEmails: (...a) => mockGetArchivedEmails(...a),
  saveEmailHeaders: (...a) => mockSaveEmailHeaders(...a),
  clearMailboxCache: (...a) => mockClearMailboxCache(...a),
}));

const mockFetchEmails = vi.fn();
const mockCheckMailboxStatus = vi.fn();
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

// header shaped like what api.fetchEmails returns for one page
const mkHeader = (uid) => ({ uid, subject: `Msg ${uid}`, date: '2026-08-01T00:00:00Z', flags: [] });

function primeCold(mailbox = 'INBOX') {
  useMailStore.setState({
    accounts: [ACCOUNT],
    activeAccountId: ACCOUNT.id,
    activeMailbox: mailbox,
    // A branch scope left behind sends the next load down the subtree path.
    mailboxScope: null,
    emails: [],
    localEmails: [],
    savedEmailIds: new Set(),
    archivedEmailIds: new Set(),
    serverUids: serverUids(new Set(), { complete: true }), // stale carry-over from a prior fully-synced mailbox
    deleteTombstones: new Set(),
    totalEmails: 0,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSavedEmailIds.mockResolvedValue(new Set());
  mockGetArchivedEmailIds.mockResolvedValue(new Set());
  mockGetEmailHeadersMeta.mockResolvedValue(null);
  mockGetEmailHeadersPartial.mockResolvedValue({ emails: [], totalEmails: 0 });
  mockSaveEmailHeaders.mockResolvedValue(undefined);
  mockSearchAllUids.mockResolvedValue([]);
});

// loadEmails() is the refresh cycle (after bulk actions, row menus, retries)
// and always talks IMAP directly. Its "nothing changed" exits used to carry
// the store's claim forward untouched — so a set that was unproven when the
// refresh started stayed unproven, and every row kept the "server unknown"
// icon. See activateAccountColdPath.test.js for the same rule on the
// activation path.
describe('loadEmails delta path — an unchanged verdict re-proves an unproven uid set', () => {
  function primeUnprovenWithCachedSync(highestModseq) {
    useMailStore.setState({
      accounts: [ACCOUNT],
      activeAccountId: ACCOUNT.id,
      activeMailbox: 'INBOX',
      emails: [mkHeader(1)],
      localEmails: [],
      savedEmailIds: new Set(),
      archivedEmailIds: new Set(),
      serverUids: serverUids(new Set(), { complete: false }),
      deleteTombstones: new Set(),
      totalEmails: 1,
    });
    mockGetEmailHeadersMeta.mockResolvedValue({ uidValidity: 1, uidNext: 2, highestModseq, totalEmails: 1, totalCached: 1 });
    mockCheckMailboxStatus.mockResolvedValue({ uidValidity: 1, uidNext: 2, highestModseq, exists: 1 });
  }

  it('CONDSTORE noop proves the set', async () => {
    primeUnprovenWithCachedSync(5);
    mockSearchAllUids.mockResolvedValue([1]);

    await useMailStore.getState().loadEmails();

    expect(mockSearchAllUids).toHaveBeenCalledTimes(1);
    expect(useMailStore.getState().serverUids.complete).toBe(true);
  });

  it('delta noop (no CONDSTORE) proves the set', async () => {
    primeUnprovenWithCachedSync(null);
    mockSearchAllUids.mockResolvedValue([1]);

    await useMailStore.getState().loadEmails();

    expect(mockSearchAllUids).toHaveBeenCalledTimes(1);
    expect(useMailStore.getState().serverUids.complete).toBe(true);
  });

  it('a proven set costs no search', async () => {
    primeUnprovenWithCachedSync(5);
    useMailStore.setState({ serverUids: serverUids(new Set([1]), { complete: true }) });

    await useMailStore.getState().loadEmails();

    expect(mockSearchAllUids).not.toHaveBeenCalled();
    expect(useMailStore.getState().serverUids.complete).toBe(true);
  });
});

describe('loadEmails cold path — no cached sync (first visit this session)', () => {
  it('proves completeness true when the page-1 fetch already covers serverTotal', async () => {
    primeCold();
    mockFetchEmails.mockResolvedValue({
      total: 3,
      emails: [mkHeader(1), mkHeader(2), mkHeader(3)],
    });
    mockCheckMailboxStatus.mockResolvedValue({ uidValidity: 1, uidNext: 4, highestModseq: null });

    await useMailStore.getState().loadEmails();

    const state = useMailStore.getState();
    expect(state.serverUids.complete).toBe(true);
    expect(state.serverUids.uids.size).toBe(3);
  });

  it('proves completeness false when the page-1 fetch does not cover serverTotal', async () => {
    primeCold();
    mockFetchEmails.mockResolvedValue({
      total: 500,
      emails: [mkHeader(1), mkHeader(2)], // far short of 500 — a large mailbox's first page
    });
    mockCheckMailboxStatus.mockResolvedValue({ uidValidity: 1, uidNext: 501, highestModseq: null });

    await useMailStore.getState().loadEmails();

    const state = useMailStore.getState();
    expect(state.serverUids.complete).toBe(false);
  });

  // The `if` branch of the no-cached-sync fetch mixes newly-fetched rows with
  // `cleanedExisting` (prior store emails past the checked overlap window) —
  // rows this fetch never verified. mergedEmails.length can coincidentally
  // reach serverTotal there without the listing actually being the whole
  // mailbox. Getting this wrong is exactly the false-amber bug Task 1 exists
  // to kill, so the guard must leave server uid completeness untouched here.
  it('does not claim complete when the fetch merges with unverified existing rows', async () => {
    primeCold();
    useMailStore.setState({
      emails: [mkHeader(1), mkHeader(2)],
      serverUids: serverUids(new Set(), { complete: false }),
    });
    // Page 1 overlaps uid 2 (already known) and adds uid 3 — triggers the
    // merge-with-existing branch. mergedEmails ends up [3, 1, 2] — 3 rows,
    // matching serverTotal below, even though this fetch alone only proves
    // uid 3 and (via overlap) uid 2.
    mockFetchEmails.mockResolvedValue({
      total: 3,
      emails: [mkHeader(2), mkHeader(3)],
    });
    mockCheckMailboxStatus.mockResolvedValue({ uidValidity: 1, uidNext: 4, highestModseq: null });

    await useMailStore.getState().loadEmails();

    const state = useMailStore.getState();
    expect(state.emails).toHaveLength(3); // sanity: confirms the merge branch actually ran
    expect(state.serverUids.complete).toBe(false);
  });
});

describe('loadEmails cold path — UIDVALIDITY changed (full reload)', () => {
  function primeWithStaleSync() {
    useMailStore.setState({
      accounts: [ACCOUNT],
      activeAccountId: ACCOUNT.id,
      activeMailbox: 'INBOX',
      emails: [mkHeader(1)], // non-empty so hasCachedSync's existingEmails check passes
      localEmails: [],
      savedEmailIds: new Set(),
      archivedEmailIds: new Set(),
      serverUids: serverUids(new Set([1]), { complete: true }), // proven complete under the OLD uidValidity — must not survive
      deleteTombstones: new Set(),
      totalEmails: 1,
    });
    mockGetEmailHeadersMeta.mockResolvedValue({
      uidValidity: 100, uidNext: 2, totalEmails: 1, totalCached: 1,
    });
  }

  it('proves completeness true when the post-reload page-1 fetch covers the new serverTotal', async () => {
    primeWithStaleSync();
    // uidValidity 200 != cached 100 -> full reload branch
    mockCheckMailboxStatus.mockResolvedValue({ uidValidity: 200, uidNext: 6, highestModseq: null });
    mockFetchEmails.mockResolvedValue({
      total: 5,
      emails: [mkHeader(10), mkHeader(11), mkHeader(12), mkHeader(13), mkHeader(14)],
    });

    await useMailStore.getState().loadEmails();

    const state = useMailStore.getState();
    expect(state.serverUids.complete).toBe(true);
  });

  it('flips a stale true to false when the reload only returns a partial page', async () => {
    primeWithStaleSync();
    mockCheckMailboxStatus.mockResolvedValue({ uidValidity: 200, uidNext: 999, highestModseq: null });
    mockFetchEmails.mockResolvedValue({
      total: 900,
      emails: [mkHeader(10), mkHeader(11)], // nowhere near 900
    });

    await useMailStore.getState().loadEmails();

    const state = useMailStore.getState();
    expect(state.serverUids.complete).toBe(false);
  });
});

// A refresh is issued for one (account, mailbox) pair and commits its rows
// later. Every delete ends in loadEmails(), and the user keeps clicking while
// the server works — so by the time the fetch returns, the view can be on a
// different folder of the SAME account. The account guard alone let INBOX's
// rows land under the Archive header (connected-storage-matrix's churn cases:
// "17 rows" in luke's 5-row Archive were luke's INBOX), and the switch-away
// then memoised the wrong list under Archive for the rest of the session.
describe('loadEmails — the view moves to another folder mid-flight', () => {
  it('drops a fetch issued for INBOX once the active mailbox is Archive', async () => {
    primeCold('INBOX');
    mockCheckMailboxStatus.mockResolvedValue({ uidValidity: 1, uidNext: 4, highestModseq: null });
    mockFetchEmails.mockImplementation(async () => {
      // The Archive click lands while INBOX's page-1 fetch is on the wire.
      useMailStore.setState({ activeMailbox: 'Archive', emails: [mkHeader(900)] });
      return { total: 3, emails: [mkHeader(1), mkHeader(2), mkHeader(3)] };
    });

    await useMailStore.getState().loadEmails();

    const state = useMailStore.getState();
    expect(state.activeMailbox).toBe('Archive');
    expect(state.emails.map((e) => e.uid)).toEqual([900]);
  });
});


// A branch listing (Sidebar click on a folder with folders under it) is not
// something this workflow can reload: it is single-mailbox by construction —
// SELECT, CONDSTORE, uid pagination. Every reload path ends here (a move, a
// delete, refreshAllAccounts), so without the delegation the list silently
// collapsed to the branch root while the heading still said "across N
// folders" — bson73, discussion #1.
describe('loadEmails on a branch listing', () => {
  it('hands the reload to loadSubtree and keeps the scope', async () => {
    const loadSubtree = vi.fn().mockResolvedValue(undefined);
    primeCold('Kunden');
    useMailStore.setState({
      mailboxScope: { root: 'Kunden', paths: ['Kunden', 'Kunden.Company XY'] },
      loadSubtree,
    });

    await useMailStore.getState().loadEmails();

    expect(loadSubtree).toHaveBeenCalledWith(ACCOUNT.id, 'Kunden');
    // Not one round trip of its own: the single-folder path never ran.
    expect(mockCheckMailboxStatus).not.toHaveBeenCalled();
    expect(mockFetchEmails).not.toHaveBeenCalled();
    expect(useMailStore.getState().mailboxScope?.root).toBe('Kunden');
  });

  it('leaves a plain folder alone', async () => {
    const loadSubtree = vi.fn().mockResolvedValue(undefined);
    primeCold('INBOX');
    useMailStore.setState({ loadSubtree });
    mockCheckMailboxStatus.mockResolvedValue({ uidValidity: 1, uidNext: 2, highestModseq: null });
    mockFetchEmails.mockResolvedValue({ total: 1, emails: [mkHeader(1)] });

    await useMailStore.getState().loadEmails();

    expect(loadSubtree).not.toHaveBeenCalled();
  });
});
