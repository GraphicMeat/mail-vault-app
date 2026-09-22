/**
 * What a refresh is allowed to call "new mail".
 *
 * The count in the banner was a set difference taken against whatever happened
 * to be loaded: the open list (which renders 500 rows from cache and drains the
 * rest behind it) for the active account, the disk cache (capped at one
 * 500-header page by a cold daemon sync) for the others. A 1634-message INBOX
 * with 500 rows loaded therefore announced "1134 new emails", and a 14k
 * mailbox announced 10473.
 *
 * The baseline is the disk cache now, and only when it provably holds the whole
 * folder. Nothing arrived during a backfill, so nothing is announced during one.
 *
 * Second defect in the same lines: `from` is an object, so every banner body
 * read "[object Object]: <subject>".
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

let state;
let cachedByKey;

vi.mock('../../../stores/mailStore', () => ({
  useMailStore: {
    getState: () => state,
    setState: (patch) => { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }; },
  },
}));

// The baseline reads the cache's meta and uid listing, never its rows: this
// runs for every account on every scheduled refresh.
const mockGetEmailHeaders = vi.fn();
const mockGetEmailHeadersMeta = vi.fn(async (accountId, mailbox) => {
  const entry = cachedByKey[`${accountId}|${mailbox}`];
  return entry ? { totalEmails: entry.totalEmails, totalCached: entry.uids.length } : null;
});
const mockListCachedUids = vi.fn(async (accountId, mailbox) => {
  const entry = cachedByKey[`${accountId}|${mailbox}`];
  return entry ? { uids: entry.uids, changed: [] } : null;
});
const mockFetchEmails = vi.fn();
vi.mock('../../db', () => ({
  getEmailHeaders: (...a) => mockGetEmailHeaders(...a),
  getEmailHeadersMeta: (...a) => mockGetEmailHeadersMeta(...a),
  listCachedUids: (...a) => mockListCachedUids(...a),
  saveEmailHeaders: vi.fn().mockResolvedValue(undefined),
  getCachedMailboxes: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../api', () => ({
  fetchEmails: (...a) => mockFetchEmails(...a),
  graphListFolders: vi.fn(),
}));
vi.mock('../../cacheManager', () => ({
  invalidateRestoreDescriptors: vi.fn(),
  getAccountCacheMailboxes: () => null,
  listGraphMessages: vi.fn(),
}));
vi.mock('../../syncProbe', () => ({ invalidate: vi.fn() }));
vi.mock('../helpers/mailboxRefetch', () => ({
  forceMailboxRefetch: vi.fn(),
  takeForcedMailboxRefetch: () => false,
}));
vi.mock('../folderStatus', () => ({
  refreshFolderStatus: vi.fn().mockResolvedValue(null),
  invalidateFolderStatus: vi.fn(),
}));
vi.mock('../adoptGraphFolderKeys', () => ({ adoptGraphFolderKeysFromListing: vi.fn() }));
vi.mock('../../graphConfig', () => ({ isGraphAccount: () => false, storageKeyOf: (f) => f?.displayName }));
vi.mock('../../authUtils', () => ({
  hasValidCredentials: () => true,
  ensureFreshToken: async (a) => a,
}));
vi.mock('../../../stores/slices/unifiedHelpers', () => ({ _resolveMailboxPath: (_m, target) => target }));
vi.mock('../../../stores/settingsStore', () => ({
  useSettingsStore: {
    getState: () => ({
      isAccountHidden: () => false,
      unreadPerAccount: {},
      hiddenAccounts: {},
      setUnreadPerAccount: vi.fn(),
    }),
  },
  hasPremiumAccess: () => false,
}));

const { refreshAllAccounts } = await import('../refreshAccounts');

const header = (uid, extra = {}) => ({ uid, subject: `msg ${uid}`, flags: ['\\Seen'], ...extra });
const cacheEntry = (uids, totalEmails) => ({ uids, totalEmails });

beforeEach(() => {
  cachedByKey = {};
  mockGetEmailHeaders.mockClear();
  mockGetEmailHeadersMeta.mockClear();
  mockListCachedUids.mockClear();
  mockFetchEmails.mockReset();
  state = {
    accounts: [{ id: 'acct-1', email: 'me@example.com' }],
    activeAccountId: 'acct-1',
    activeMailbox: 'INBOX',
    emails: [],
    unifiedInbox: false,
    unifiedFolder: null,
    totalUnreadCount: 0,
    loadEmails: vi.fn().mockResolvedValue(undefined),
  };
});

describe('the active account (the open list)', () => {
  it('announces nothing while the cache is still backfilling', async () => {
    // 500 of a 1634-message INBOX cached, and the list drains to the full
    // folder during the refresh: the 1134 the user was notified about.
    const loaded = Array.from({ length: 500 }, (_, i) => i + 1);
    cachedByKey['acct-1|INBOX'] = cacheEntry(loaded, 1634);
    state.emails = loaded.map(u => header(u));
    state.loadEmails = vi.fn(async () => {
      state.emails = Array.from({ length: 1634 }, (_, i) => header(i + 1));
    });

    const { perAccountResults } = await refreshAllAccounts();

    expect(perAccountResults).toEqual([]);
    // Short of the folder by its meta alone, so the uids are never listed.
    expect(mockGetEmailHeadersMeta).toHaveBeenCalledWith('acct-1', 'INBOX');
    expect(mockListCachedUids).not.toHaveBeenCalled();
  });

  it('counts only what the complete cache did not hold', async () => {
    cachedByKey['acct-1|INBOX'] = cacheEntry([1, 2, 3], 3);
    state.emails = [1, 2, 3].map(u => header(u));
    state.loadEmails = vi.fn(async () => {
      state.emails = [
        header(5, { from: { name: 'Rokas', address: 'rokas@example.com' }, subject: 'hello' }),
        header(4),
        ...[1, 2, 3].map(u => header(u)),
      ];
    });

    const { perAccountResults } = await refreshAllAccounts();

    expect(perAccountResults).toHaveLength(1);
    expect(perAccountResults[0]).toMatchObject({
      accountId: 'acct-1',
      folder: 'INBOX',
      newCount: 2,
      newestUid: 5,
      newestSubject: 'hello',
      newestSender: 'Rokas',
    });
    expect(mockListCachedUids).toHaveBeenCalledWith('acct-1', 'INBOX');
    expect(mockGetEmailHeaders).not.toHaveBeenCalled();
  });
});

describe('a background account (the disk cache)', () => {
  const backgroundAccount = () => {
    state.accounts = [{ id: 'acct-2', email: 'other@example.com' }];
    state.activeAccountId = 'acct-1';
  };

  it('announces nothing when the cache holds less than the folder', async () => {
    backgroundAccount();
    cachedByKey['acct-2|INBOX'] = cacheEntry([1, 2, 3], 900);
    mockFetchEmails.mockResolvedValue({
      emails: Array.from({ length: 900 }, (_, i) => header(i + 1)),
      total: 900,
      hasMore: false,
    });

    const { perAccountResults } = await refreshAllAccounts();

    expect(perAccountResults).toEqual([]);
  });

  // A failed listing is "unknown", not "nothing cached": every fetched header
  // would read as an arrival.
  it('announces nothing when the uid listing fails', async () => {
    backgroundAccount();
    cachedByKey['acct-2|INBOX'] = cacheEntry([1, 2], 2);
    mockListCachedUids.mockResolvedValueOnce(null);
    mockFetchEmails.mockResolvedValue({
      emails: [header(3), header(2), header(1)],
      total: 3,
      hasMore: false,
    });

    const { perAccountResults } = await refreshAllAccounts();

    expect(perAccountResults).toEqual([]);
  });

  it('names the sender by address when the header carries no display name', async () => {
    backgroundAccount();
    cachedByKey['acct-2|INBOX'] = cacheEntry([1, 2], 2);
    mockFetchEmails.mockResolvedValue({
      emails: [
        header(3, { from: { address: 'bank@example.com' }, subject: 'statement' }),
        header(2),
        header(1),
      ],
      total: 3,
      hasMore: false,
    });

    const { perAccountResults } = await refreshAllAccounts();

    expect(perAccountResults).toHaveLength(1);
    expect(perAccountResults[0]).toMatchObject({
      newCount: 1,
      newestSender: 'bank@example.com',
      newestSubject: 'statement',
    });
    expect(mockGetEmailHeaders).not.toHaveBeenCalled();
  });
});
