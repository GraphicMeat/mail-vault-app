// @vitest-environment jsdom
/**
 * A page with an unreadable message is a page: the list moves on.
 *
 * `skippedUids` used to mean "the parse failed this time" — the page was
 * rolled back and re-requested five seconds later. Since the vendored
 * imap-proto reads past a FETCH line it cannot parse, the skip is a property
 * of the message, reproduced on every fetch: the old branch pinned pagination
 * at the first page holding such a message, for ever.
 *
 * This drives the real `loadMoreEmails` workflow against the real store, so
 * the assertion is on what the app does, not on a re-implementation of it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Store dependencies, mocked exactly as src/stores/__tests__/mailStore.test.js
// does (that file is the proof this store constructs), plus the three db calls
// the pagination path itself makes.
const mockGetEmailHeadersMeta = vi.fn().mockResolvedValue(null);
const mockSaveEmailHeaders = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/services/db', () => ({
  getLocalEmailLight: vi.fn().mockResolvedValue(null),
  getEmailHeadersMeta: (...args) => mockGetEmailHeadersMeta(...args),
  getEmailHeadersPartial: vi.fn().mockResolvedValue({ emails: [], totalEmails: 0 }),
  getArchivedEmailIds: vi.fn().mockResolvedValue(new Set()),
  getSavedEmailIds: vi.fn().mockResolvedValue(new Set()),
  getCachedMailboxEntry: vi.fn().mockResolvedValue(null),
  initDB: vi.fn().mockResolvedValue(undefined),
  getAccounts: vi.fn().mockResolvedValue([]),
  ensureAccountsInFile: vi.fn().mockResolvedValue(undefined),
  saveMailboxes: vi.fn().mockResolvedValue(undefined),
  readLocalEmailIndex: vi.fn().mockResolvedValue(null),
  getArchivedEmails: vi.fn().mockResolvedValue([]),
  getCachedMailboxes: vi.fn().mockResolvedValue([]),
  getLocalEmails: vi.fn().mockResolvedValue([]),
  // The pagination path's own calls.
  saveEmailHeaders: (...args) => mockSaveEmailHeaders(...args),
  listCachedUids: vi.fn().mockResolvedValue(null),
  getEmailHeadersByUids: vi.fn().mockResolvedValue([]),
}));

const mockFetchEmails = vi.fn();
vi.mock('../../src/services/api', () => ({
  fetchEmails: (...args) => mockFetchEmails(...args),
  fetchEmailsRange: vi.fn(),
  fetchEmailLight: vi.fn().mockResolvedValue(null),
  backupScanUids: vi.fn().mockResolvedValue(null),
  backupGetExternalLocation: vi.fn().mockResolvedValue({ status: 'ready' }),
}));

vi.mock('../../src/services/authUtils', () => ({
  hasValidCredentials: () => true,
  ensureFreshToken: (a) => Promise.resolve(a),
  resolveServerAccount: (id, account) => Promise.resolve({ ok: true, account }),
}));
vi.mock('../../src/services/attachmentUtils', () => ({
  hasRealAttachments: () => false,
}));
vi.mock('../../src/utils/emailParser', () => ({
  buildThreads: () => new Map(),
}));
const mockSettingsState = {
  cacheLimitMB: 128,
  hiddenAccounts: {},
  getLastMailbox: () => 'INBOX',
  setLastMailbox: () => {},
  emailListStyle: 'default',
  linkAlerts: {},
  setUnreadForAccount: () => {},
};
vi.mock('../../src/stores/settingsStore', () => ({
  useSettingsStore: { getState: () => mockSettingsState },
}));
vi.mock('../../src/stores/safeStorage', () => ({
  safeStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}));
vi.mock('../../src/services/cacheManager', () => ({
  getRestoreDescriptor: vi.fn().mockReturnValue(null),
  saveRestoreDescriptor: vi.fn(),
  invalidateRestoreDescriptors: () => {},
  getAccountCacheMailboxes: () => null,
  listGraphMessages: vi.fn().mockResolvedValue({ headers: [], graphMessageIds: [] }),
  getGraphMessageId: () => null,
  resolveGraphMessageId: async () => null,
  clearGraphIdMap: () => {},
}));

const { useMailStore } = await import('../../src/stores/mailStore');
const { loadMoreEmails } = await import('../../src/services/workflows/loadMoreEmails');

const mkEmail = (uid) => ({
  uid,
  subject: `m${uid}`,
  from: { address: 'a@b' },
  date: '2026-01-01T00:00:00Z',
  flags: [],
});

describe('loadMoreEmails with an unreadable row', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // The workflow schedules its state commit on idle; keep it on the timer
    // queue so `runAllTimersAsync` drains the whole chain.
    vi.stubGlobal('requestIdleCallback', (cb) => setTimeout(cb, 0));
    useMailStore.setState({
      accounts: [{ id: 'acc1', email: 'x@y', password: 'p' }],
      activeAccountId: 'acc1',
      activeMailbox: 'INBOX',
      emails: [mkEmail(1)],
      currentPage: 1,
      hasMoreEmails: true,
      loadingMore: false,
      totalEmails: 3,
      serverUids: { uids: new Set([1]), complete: false },
      // Not what these tests are about; the real ones drag in sorting and the
      // whole restart path.
      updateSortedEmails: vi.fn(),
      loadEmails: vi.fn(),
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    mockGetEmailHeadersMeta.mockResolvedValue(null);
    mockSaveEmailHeaders.mockResolvedValue(undefined);
  });

  it('moves on to the next page instead of re-requesting the one with the skip', async () => {
    mockFetchEmails
      .mockResolvedValueOnce({ emails: [mkEmail(2)], total: 3, hasMore: true, skippedUids: [null] })
      .mockResolvedValueOnce({ emails: [mkEmail(3)], total: 3, hasMore: false, skippedUids: [] });

    await loadMoreEmails();
    await vi.runAllTimersAsync();

    const pages = mockFetchEmails.mock.calls.map(c => c[2]);
    expect(pages).toEqual([2, 3]);
    expect(useMailStore.getState().currentPage).toBe(3);
    expect(useMailStore.getState().hasMoreEmails).toBe(false);
  });

  it('never schedules a re-request of the same page', async () => {
    mockFetchEmails.mockResolvedValue({
      emails: [mkEmail(2)], total: 3, hasMore: false, skippedUids: [null],
    });

    await loadMoreEmails();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(mockFetchEmails).toHaveBeenCalledTimes(1);
    expect(useMailStore.getState().currentPage).toBe(2);
  });
});
