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

vi.mock('../../services/db', () => ({
  getLocalEmailLight: (...args) => mockGetLocalEmailLight(...args),
  getEmailHeadersMeta: (...args) => mockGetEmailHeadersMeta(...args),
  getEmailHeadersPartial: (...args) => mockGetEmailHeadersPartial(...args),
  getArchivedEmailIds: (...args) => mockGetArchivedEmailIds(...args),
  getSavedEmailIds: (...args) => mockGetSavedEmailIds(...args),
  getCachedMailboxEntry: (...args) => mockGetCachedMailboxEntry(...args),
  initDB: (...args) => mockInitDB(...args),
  getAccounts: (...args) => mockGetAccounts(...args),
  ensureAccountsInFile: (...args) => mockEnsureAccountsInFile(...args),
  saveMailboxes: (...args) => mockSaveMailboxes(...args),
  readLocalEmailIndex: (...args) => mockReadLocalEmailIndex(...args),
  getArchivedEmails: (...args) => mockGetArchivedEmails(...args),
  getCachedMailboxes: (...args) => mockGetCachedMailboxes(...args),
  getLocalEmails: (...args) => mockGetLocalEmails(...args),
}));
const mockFetchEmailLight = vi.fn().mockResolvedValue(null);
const mockBackupScanUids = vi.fn().mockResolvedValue(null);
const mockBackupGetExternalLocation = vi.fn().mockResolvedValue({ status: 'ready' });
vi.mock('../../services/api', () => ({
  fetchEmailLight: (...args) => mockFetchEmailLight(...args),
  backupScanUids: (...args) => mockBackupScanUids(...args),
  backupGetExternalLocation: (...args) => mockBackupGetExternalLocation(...args),
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
}));

const { useMailStore } = await import('../mailStore');
const { serverUids } = await import('../slices/serverUids');
const { _resetArchivedGroupsForTest } = await import('../slices/messageListSlice');

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
  it('a failed first read of a group an excluded writer (e.g. activateAccount.js) already populated keeps those ids', async () => {
    // No unified pass ever ran here, so `_archivedIdsByGroup` has never
    // heard of A/INBOX, exactly the shape left behind by a writer this
    // task does not touch (activateAccount.js, loadEmails.js), which sets
    // archivedEmailIds directly and never goes through the group map.
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
