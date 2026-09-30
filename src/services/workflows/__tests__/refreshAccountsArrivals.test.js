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
const mockSetUnreadPerAccount = vi.fn();
vi.mock('../../../stores/settingsStore', () => ({
  useSettingsStore: {
    getState: () => ({
      isAccountHidden: () => false,
      unreadPerAccount: {},
      hiddenAccounts: {},
      setUnreadPerAccount: (...a) => mockSetUnreadPerAccount(...a),
    }),
  },
  hasPremiumAccess: () => false,
}));

const { refreshAllAccounts } = await import('../refreshAccounts');
const { useSnoozeStore } = await import('../../../stores/snoozeStore');

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

  // The badge counts what the inbox shows, and a local snooze holds its
  // message out of it while the server still lists it there, unread.
  it('leaves a message a local snooze holds out of the inbox off the badge', async () => {
    backgroundAccount();
    cachedByKey['acct-2|INBOX'] = cacheEntry([1, 2], 2);
    mockFetchEmails.mockResolvedValue({
      emails: [header(2, { flags: [], messageId: '<held@x>' }), header(1, { flags: [], messageId: '<other@x>' })],
      total: 2,
      hasMore: false,
    });
    useSnoozeStore.setState({ rows: [{ id: 's1', accountId: 'acct-2', fromMailbox: 'INBOX', snoozedMailbox: '', messageId: '<held@x>', state: 'snoozed' }] });
    mockSetUnreadPerAccount.mockClear();
    try {
      await refreshAllAccounts();
    } finally {
      useSnoozeStore.setState({ rows: [] });
    }
    expect(mockSetUnreadPerAccount).toHaveBeenLastCalledWith({ 'acct-2': 1 });
  });
});

describe('All Inboxes', () => {
  // The scheduled refresh wrote every account's cache and never repainted the
  // unified list: only a manual Refresh (refreshCurrentView) called
  // loadUnifiedInbox, so new mail sat in the cache until the user clicked.
  it('repaints the unified list after the scheduled refresh has synced', async () => {
    state.activeMailbox = 'UNIFIED';
    state.unifiedInbox = true;
    state.unifiedFolder = 'INBOX';
    state.loadUnifiedInbox = vi.fn().mockResolvedValue(undefined);
    cachedByKey['acct-1|INBOX'] = cacheEntry([1], 1);
    mockFetchEmails.mockResolvedValue({ emails: [header(2), header(1)], total: 2, hasMore: false });

    await refreshAllAccounts();

    expect(state.loadUnifiedInbox).toHaveBeenCalledWith(null, 'INBOX');
    expect(state.loadEmails).not.toHaveBeenCalled();
  });
});

// Retry on the connection notice in All Inboxes: that one account asks its
// server again, the merged list is repainted, and the account's status says
// how it went, so the notice stays gone or comes back.
describe('retrying one account from All Inboxes', () => {
  beforeEach(() => {
    state.accounts = [{ id: 'acct-1', email: 'me@example.com' }, { id: 'acct-2', email: 'work@example.com' }];
    Object.assign(state, {
      activeAccountId: 'acct-2', activeMailbox: 'UNIFIED', unifiedInbox: true, unifiedFolder: 'INBOX',
      connectionStatus: 'error', connectionError: 'Connection failed', connectionErrorType: 'serverError',
      loadUnifiedInbox: vi.fn().mockResolvedValue(undefined),
    });
  });

  it('refreshes only that account, repaints All Inboxes and marks it connected', async () => {
    mockFetchEmails.mockResolvedValue({ emails: [header(1)], total: 1, hasMore: false });

    await refreshAllAccounts({ accountId: 'acct-2' });

    expect(mockFetchEmails).toHaveBeenCalledOnce();
    expect(mockFetchEmails.mock.calls[0][0].id).toBe('acct-2');
    expect(mockFetchEmails.mock.calls[0][1]).toBe('INBOX');
    expect(state.loadUnifiedInbox).toHaveBeenCalledWith(null, 'INBOX');
    expect(state).toMatchObject({ connectionStatus: 'connected', connectionError: null, connectionErrorType: null });
  });

  it('leaves the error standing when the server still fails', async () => {
    mockFetchEmails.mockRejectedValue(new Error('IMAP greeting failed'));

    await refreshAllAccounts({ accountId: 'acct-2' });

    expect(state).toMatchObject({ connectionStatus: 'error', connectionError: 'Connection failed', connectionErrorType: 'serverError' });
  });
});
