/**
 * Task 3.8 F2 (R3.3): `archivedEmailIds` is a per-(account,mailbox) union,
 * not one flat set that never forgets a group once it has been seen.
 *
 * Before this fix, a failed re-read of one mailbox's archived ids fell back
 * to the store's WHOLE prior value (`rawArchivedEmailIds ?? get().archivedEmailIds`
 * in uiSlice.js, and the equivalent seeded-Set pattern in loadUnifiedInbox.js).
 * That kept every account ever seen in the union forever, including ones no
 * longer in view. See messageListSlice.js's `_archivedIdsByGroup`.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

if (!globalThis.window) {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
} else {
  globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
}

const mockGetLocalEmailLight = vi.fn().mockResolvedValue(null);
const mockGetEmailHeadersMeta = vi.fn().mockResolvedValue(null);
const mockGetEmailHeadersPartial = vi.fn().mockResolvedValue({ emails: [], totalEmails: 0 });
const mockGetArchivedEmailIds = vi.fn().mockResolvedValue(new Set());
const mockGetSavedEmailIds = vi.fn().mockResolvedValue(new Set());
const mockGetCachedMailboxEntry = vi.fn().mockResolvedValue(null);
const mockInitDB = vi.fn().mockResolvedValue(undefined);
const mockGetAccounts = vi.fn().mockResolvedValue([]);
const mockEnsureAccountsInFile = vi.fn().mockResolvedValue(undefined);
const mockSaveMailboxes = vi.fn().mockResolvedValue(undefined);
const mockReadLocalEmailIndex = vi.fn().mockResolvedValue(null);
const mockGetArchivedEmails = vi.fn().mockResolvedValue([]);
const mockGetCachedMailboxes = vi.fn().mockResolvedValue([]);
const mockGetLocalEmails = vi.fn().mockResolvedValue([]);
const mockSaveEmailHeaders = vi.fn().mockResolvedValue(undefined);
const mockIsEmailSaved = vi.fn().mockResolvedValue(true);
const mockArchiveEmail = vi.fn().mockResolvedValue(undefined);
const mockDeleteLocalEmail = vi.fn().mockResolvedValue(undefined);

vi.mock('../../services/db', () => ({
  getLocalEmailLight: (...args) => mockGetLocalEmailLight(...args),
  getEmailHeadersMeta: (...args) => mockGetEmailHeadersMeta(...args),
  getEmailHeadersPartial: (...args) => mockGetEmailHeadersPartial(...args),
  getArchivedEmailIds: (...args) => mockGetArchivedEmailIds(...args),
  getSavedEmailIds: (...args) => mockGetSavedEmailIds(...args),
  // The registry read the callers use now, derived from the two getters
  // above so every test's per-case values still drive it (null archived =
  // the whole read unknown).
  getVaultUidSets: async (...args) => {
    const archived = await mockGetArchivedEmailIds(...args);
    if (archived == null) return null;
    return { saved: (await mockGetSavedEmailIds(...args)) ?? new Set(), archived };
  },
  getCachedMailboxEntry: (...args) => mockGetCachedMailboxEntry(...args),
  initDB: (...args) => mockInitDB(...args),
  getAccounts: (...args) => mockGetAccounts(...args),
  ensureAccountsInFile: (...args) => mockEnsureAccountsInFile(...args),
  saveMailboxes: (...args) => mockSaveMailboxes(...args),
  readLocalEmailIndex: (...args) => mockReadLocalEmailIndex(...args),
  getArchivedEmails: (...args) => mockGetArchivedEmails(...args),
  getCachedMailboxes: (...args) => mockGetCachedMailboxes(...args),
  getLocalEmails: (...args) => mockGetLocalEmails(...args),
  saveEmailHeaders: (...args) => mockSaveEmailHeaders(...args),
  isEmailSaved: (...args) => mockIsEmailSaved(...args),
  archiveEmail: (...args) => mockArchiveEmail(...args),
  deleteLocalEmail: (...args) => mockDeleteLocalEmail(...args),
}));
const mockFetchEmailLight = vi.fn().mockResolvedValue(null);
const mockBackupScanUids = vi.fn().mockResolvedValue(null);
const mockBackupGetExternalLocation = vi.fn().mockResolvedValue({ status: 'ready' });
const mockRemoveFromLocalIndex = vi.fn().mockResolvedValue(undefined);
vi.mock('../../services/api', () => ({
  fetchEmailLight: (...args) => mockFetchEmailLight(...args),
  backupScanUids: (...args) => mockBackupScanUids(...args),
  backupGetExternalLocation: (...args) => mockBackupGetExternalLocation(...args),
  removeFromLocalIndex: (...args) => mockRemoveFromLocalIndex(...args),
}));
vi.mock('../../services/authUtils', () => ({
  hasValidCredentials: () => true,
  ensureFreshToken: (a) => Promise.resolve(a),
  resolveServerAccount: (id, account) => Promise.resolve({ ok: true, account }),
}));
vi.mock('../../services/attachmentUtils', () => ({
  hasRealAttachments: () => false,
}));
vi.mock('../../utils/emailParser', () => ({
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
vi.mock('../settingsStore', () => ({
  useSettingsStore: {
    getState: () => mockSettingsState,
  },
}));
vi.mock('../safeStorage', () => ({
  safeStorage: {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  },
}));

const mockGetRestoreDescriptor = vi.fn().mockReturnValue(null);
const mockSaveRestoreDescriptor = vi.fn();
const mockGetAccountCacheMailboxes = vi.fn(() => null);
vi.mock('../../services/cacheManager', () => ({
  getRestoreDescriptor: (...args) => mockGetRestoreDescriptor(...args),
  saveRestoreDescriptor: (...args) => mockSaveRestoreDescriptor(...args),
  invalidateRestoreDescriptors: () => {},
  getAccountCacheMailboxes: (...args) => mockGetAccountCacheMailboxes(...args),
  listGraphMessages: vi.fn().mockResolvedValue({ headers: [], graphMessageIds: [] }),
  getGraphMessageId: () => null,
  resolveGraphMessageId: async () => null,
  clearGraphIdMap: () => {},
  restoreGraphIdMap: vi.fn().mockResolvedValue(undefined),
}));

const { useMailStore } = await import('../mailStore');
const { serverUids } = await import('../slices/serverUids');
const { _resetArchivedGroupsForTest, setArchivedGroup, getLoadEmailsGeneration } = await import('../slices/messageListSlice');
const { AccountPipeline } = await import('../../services/AccountPipeline');
const { saveEmailLocally, removeLocalEmail } = await import('../../services/workflows/messageMutations');
const { _loadEmailsViaGraph } = await import('../../services/workflows/loadEmails');

const A = { id: 'acct-a', email: 'a@example.com' };
const B = { id: 'acct-b', email: 'b@example.com' };

// A single microtask flush is not always enough for setViewMode's unified
// branch (a nested Promise.all inside a Promise.all().then()); two macrotask
// ticks clears it the same way the existing switchUnifiedFolder spec does.
async function flush() {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetArchivedGroupsForTest();
  mockGetRestoreDescriptor.mockReturnValue(null);
  mockGetEmailHeadersPartial.mockResolvedValue({ emails: [], totalEmails: 0 });
  mockGetCachedMailboxes.mockResolvedValue([]);
  mockGetAccountCacheMailboxes.mockReturnValue(null);
  mockGetSavedEmailIds.mockResolvedValue(new Set());
  mockGetArchivedEmailIds.mockResolvedValue(new Set());
  mockReadLocalEmailIndex.mockResolvedValue(null);
  mockGetLocalEmails.mockResolvedValue([]);

  useMailStore.setState({
    accounts: [A, B],
    emails: [],
    localEmails: [],
    sortedEmails: [],
    savedEmailIds: new Set(),
    archivedEmailIds: new Set(),
    serverUids: serverUids([], { complete: false }),
    deleteTombstones: new Set(),
    viewMode: 'all',
    unifiedInbox: false,
    unifiedFolder: 'INBOX',
    activeAccountId: null,
    activeMailbox: null,
    mailboxScope: null,
    _sortedEmailsFingerprint: '',
  });
});

describe('setViewMode: narrowing out of unified inbox drops groups no longer in view (R3.3)', () => {
  it('a failed re-read of A/INBOX does not leave B\'s archived ids behind', async () => {
    // Unified pass over A and B, both reads succeed: seeds the per-group
    // cache for both.
    mockGetArchivedEmailIds.mockImplementation(async (accountId, mailbox) => {
      if (accountId === A.id && mailbox === 'INBOX') return new Set([1]);
      if (accountId === B.id && mailbox === 'INBOX') return new Set([2]);
      return new Set();
    });
    useMailStore.setState({ unifiedInbox: true, unifiedFolder: 'INBOX' });
    useMailStore.getState().setViewMode('all');
    await flush();

    expect([...useMailStore.getState().archivedEmailIds].sort()).toEqual([1, 2]);

    // Switch to a single-mailbox view on A, whose own re-read now fails.
    mockGetArchivedEmailIds.mockImplementation(async (accountId, mailbox) => (
      accountId === A.id && mailbox === 'INBOX' ? null : new Set([2])
    ));
    useMailStore.setState({ unifiedInbox: false, activeAccountId: A.id, activeMailbox: 'INBOX' });
    useMailStore.getState().setViewMode('all');
    await flush();

    const { archivedEmailIds } = useMailStore.getState();
    // A's own group survives from its last known-good read...
    expect(archivedEmailIds.has(1)).toBe(true);
    // ...but B is no longer in view, so its ids must not still be here.
    expect(archivedEmailIds.has(2)).toBe(false);
  });
});

describe('setViewMode: a per-account read failure inside a unified pass (Phase 2 I-5 regression fence)', () => {
  it('keeps that account\'s previously-known ids and drops nothing from the others', async () => {
    mockGetArchivedEmailIds.mockImplementation(async (accountId, mailbox) => {
      if (accountId === A.id && mailbox === 'INBOX') return new Set([1]);
      if (accountId === B.id && mailbox === 'INBOX') return new Set([2]);
      return new Set();
    });
    useMailStore.setState({ unifiedInbox: true, unifiedFolder: 'INBOX' });
    useMailStore.getState().setViewMode('all');
    await flush();
    expect([...useMailStore.getState().archivedEmailIds].sort()).toEqual([1, 2]);

    // Second unified pass: A's read fails, B's succeeds with a fresh id.
    mockGetArchivedEmailIds.mockImplementation(async (accountId, mailbox) => {
      if (accountId === A.id && mailbox === 'INBOX') return null;
      if (accountId === B.id && mailbox === 'INBOX') return new Set([2, 3]);
      return new Set();
    });
    useMailStore.getState().setViewMode('all');
    await flush();

    const { archivedEmailIds } = useMailStore.getState();
    // A's ids must still be there: nothing dropped by the failed read.
    expect(archivedEmailIds.has(1)).toBe(true);
    // B's fresh read landed too.
    expect([...archivedEmailIds].sort()).toEqual([1, 2, 3]);
  });
});

describe('deriveArchivedUnion: a group never seen by the map is not "nothing archived"', () => {
  it('a failed first read of a group the map has never heard of keeps those ids', async () => {
    // No unified pass ever ran here, so `_archivedIdsByGroup` has never
    // heard of A/INBOX — the same shape as the moment right after app
    // start, before any writer has told the map about this group yet.
    useMailStore.setState({
      unifiedInbox: false,
      activeAccountId: A.id,
      activeMailbox: 'INBOX',
      archivedEmailIds: new Set([1]),
    });
    mockGetArchivedEmailIds.mockResolvedValue(null);

    useMailStore.getState().setViewMode('all');
    await flush();

    // The map has nothing for this group and this round's own read also
    // failed, so there is no group-level evidence to narrow from: the
    // field must not collapse to empty.
    expect([...useMailStore.getState().archivedEmailIds]).toEqual([1]);
  });
});

describe('setViewMode: the Set-identity trap (Step 6)', () => {
  it('N group writes with unchanged contents produce exactly one Set instance and no extra re-sort', async () => {
    // A fresh Set instance every call (as a real db read would return), but
    // the same contents each time.
    mockGetArchivedEmailIds.mockImplementation(async () => new Set([1]));
    useMailStore.setState({ activeAccountId: A.id, activeMailbox: 'INBOX', unifiedInbox: false });

    useMailStore.getState().setViewMode('all');
    await flush();
    const firstIds = useMailStore.getState().archivedEmailIds;
    const firstSorted = useMailStore.getState().sortedEmails;
    expect([...firstIds]).toEqual([1]);

    for (let i = 0; i < 3; i++) {
      useMailStore.getState().setViewMode('all');
      // eslint-disable-next-line no-await-in-loop
      await flush();
    }

    // Same contents every pass -> the derived union must be the SAME Set
    // instance, or messageListSlice's identity-based re-sort guard
    // (`_sortedInputs.archivedEmailIds === archivedEmailIds`) sees a
    // "changed" input on every write and re-sorts for nothing.
    expect(useMailStore.getState().archivedEmailIds).toBe(firstIds);
    expect(useMailStore.getState().sortedEmails).toBe(firstSorted);
  });
});

describe('review fix: a bypassing writer\'s successful read must feed the group map too', () => {
  it('AccountPipeline._finish keeping the map in sync stops a later failed read from shrinking archivedEmailIds', async () => {
    // An earlier pass (e.g. a unified read) went through the map and left a
    // stale, smaller entry for this group.
    setArchivedGroup(A.id, 'INBOX', new Set([1]));

    useMailStore.setState({
      unifiedInbox: false,
      activeAccountId: A.id,
      activeMailbox: 'INBOX',
      archivedEmailIds: new Set([1]),
    });

    // AccountPipeline._finish() is one of the three sites that write
    // `archivedEmailIds` straight to the store on a successful read. Before
    // the fix it never told the map about that fresher value, so the map
    // above stayed on the STALE {1} while the store moved on to {1,2,3}.
    mockGetArchivedEmailIds.mockResolvedValue(new Set([1, 2, 3]));
    mockGetSavedEmailIds.mockResolvedValue(new Set());
    const pipeline = new AccountPipeline(A, { concurrency: 1 });
    await pipeline._finish('INBOX');
    await flush();

    // Sanity check: the write site itself was actually reached.
    expect([...useMailStore.getState().archivedEmailIds].sort()).toEqual([1, 2, 3]);

    // Now a later read for the SAME group fails, the mechanism F2 already
    // uses for this elsewhere (see the "excluded writer" spec above).
    mockGetArchivedEmailIds.mockResolvedValue(null);
    useMailStore.getState().setViewMode('all');
    await flush();

    // The ids _finish just wrote must survive: the map is no longer staler
    // than the store, so the failed read has nothing to narrow down to.
    expect([...useMailStore.getState().archivedEmailIds].sort()).toEqual([1, 2, 3]);
  });
});

describe('review follow-up: 4 more bypassing writers must feed the group map too', () => {
  beforeEach(() => {
    useMailStore.setState({
      unifiedInbox: false,
      activeAccountId: A.id,
      activeMailbox: 'INBOX',
      archivedEmailIds: new Set([1]),
    });
    setArchivedGroup(A.id, 'INBOX', new Set([1]));
    mockGetSavedEmailIds.mockResolvedValue(new Set());
  });

  it('saveEmailLocally keeps the map in sync on a successful read', async () => {
    mockGetArchivedEmailIds.mockResolvedValue(new Set([1, 2, 3]));
    await saveEmailLocally(42);

    expect([...useMailStore.getState().archivedEmailIds].sort()).toEqual([1, 2, 3]);

    mockGetArchivedEmailIds.mockResolvedValue(null);
    useMailStore.getState().setViewMode('all');
    await flush();

    expect([...useMailStore.getState().archivedEmailIds].sort()).toEqual([1, 2, 3]);
  });

  it('removeLocalEmail keeps the map in sync on a successful read', async () => {
    mockGetArchivedEmailIds.mockResolvedValue(new Set([1, 2, 3]));
    await removeLocalEmail(99);

    expect([...useMailStore.getState().archivedEmailIds].sort()).toEqual([1, 2, 3]);

    mockGetArchivedEmailIds.mockResolvedValue(null);
    useMailStore.getState().setViewMode('all');
    await flush();

    expect([...useMailStore.getState().archivedEmailIds].sort()).toEqual([1, 2, 3]);
  });

  it('loadEmails (main list load) keeps the map in sync on a successful read', async () => {
    mockGetArchivedEmailIds.mockResolvedValue(new Set([1, 2, 3]));
    await useMailStore.getState().loadEmails();

    expect([...useMailStore.getState().archivedEmailIds].sort()).toEqual([1, 2, 3]);

    mockGetArchivedEmailIds.mockResolvedValue(null);
    useMailStore.getState().setViewMode('all');
    await flush();

    expect([...useMailStore.getState().archivedEmailIds].sort()).toEqual([1, 2, 3]);
  });

  it('_loadEmailsViaGraph keeps the map in sync on a successful read', async () => {
    mockGetArchivedEmailIds.mockResolvedValue(new Set([1, 2, 3]));
    const generation = getLoadEmailsGeneration();
    await _loadEmailsViaGraph(A, A.id, 'INBOX', generation);

    expect([...useMailStore.getState().archivedEmailIds].sort()).toEqual([1, 2, 3]);

    mockGetArchivedEmailIds.mockResolvedValue(null);
    useMailStore.getState().setViewMode('all');
    await flush();

    expect([...useMailStore.getState().archivedEmailIds].sort()).toEqual([1, 2, 3]);
  });
});
