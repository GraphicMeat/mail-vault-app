// _prewarmAccountCaches's F3 fix (ruling R3.4, plan Task 3.8): a failed
// db.getArchivedEmailIds() read is documented as `null` ("could not read",
// src/services/db/emails.js:542-560), not "zero archived messages". Before
// this fix the prewarm path substituted `new Set()` for the transient
// localEmails decision (fine, in-memory only) but ALSO persisted
// `firstWindowArchivedUids: []` into the restore descriptor — a durable lie
// that activateAccount.js's restore path (~:471, `new Set(restored.
// firstWindowArchivedUids || [])`) adopts unconditionally on the next switch
// back to this account, with no way to tell "really empty" from "we never
// found out".
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockGetEmailHeadersPartial = vi.fn();
const mockGetArchivedEmailIds = vi.fn();
const mockGetSavedEmailIds = vi.fn();
const mockGetCachedMailboxEntry = vi.fn();
const mockReadLocalEmailIndex = vi.fn();
const mockGetArchivedEmails = vi.fn();

vi.mock('../../db', () => ({
  getEmailHeadersPartial: (...a) => mockGetEmailHeadersPartial(...a),
  getArchivedEmailIds: (...a) => mockGetArchivedEmailIds(...a),
  getSavedEmailIds: (...a) => mockGetSavedEmailIds(...a),
  getCachedMailboxEntry: (...a) => mockGetCachedMailboxEntry(...a),
  readLocalEmailIndex: (...a) => mockReadLocalEmailIndex(...a),
  getArchivedEmails: (...a) => mockGetArchivedEmails(...a),
  // _prefetchAllMailboxes's own dep, unused by the prewarm tests below —
  // stubbed only so the module's static `import * as db` resolves.
  saveMailboxes: vi.fn(),
}));

const mockSaveRestore = vi.fn();
const mockGetRestore = vi.fn();
vi.mock('../../cacheManager', () => ({
  saveRestoreDescriptor: (...a) => mockSaveRestore(...a),
  getRestoreDescriptor: (...a) => mockGetRestore(...a),
}));

const mockSetUnreadForAccount = vi.fn();
vi.mock('../../../stores/settingsStore', () => ({
  useSettingsStore: {
    getState: () => ({
      hiddenAccounts: {},
      setUnreadForAccount: (...a) => mockSetUnreadForAccount(...a),
    }),
  },
}));

// Leaf deps of the sibling _prefetchAllMailboxes export — unused by the
// prewarm path this file exercises, stubbed only so prefetch.js's static
// import from './activateAccount' resolves.
vi.mock('../activateAccount', () => ({
  fetchAccountMailboxes: vi.fn(),
  shouldUseFreshMailboxCache: vi.fn(),
  isSuspiciousEmptyMailboxResult: vi.fn(),
  MAILBOX_PREFETCH_LIMIT: 3,
}));

const BACKGROUND_ACCOUNT = { id: 'acct-bg', email: 'bg@mock.test' };
vi.mock('../../../stores/mailStore', () => ({
  useMailStore: {
    getState: () => ({
      accounts: [{ id: 'acct-active', email: 'active@mock.test' }, BACKGROUND_ACCOUNT],
      activeAccountId: 'acct-active',
    }),
  },
}));

const { _prewarmAccountCaches } = await import('../prefetch');

const mkHeader = (uid) => ({ uid, subject: `Msg ${uid}`, date: '2026-08-01T00:00:00Z', flags: [] });

beforeEach(() => {
  vi.clearAllMocks();
  mockGetRestore.mockReturnValue(null);
  mockGetCachedMailboxEntry.mockResolvedValue(null);
  mockGetSavedEmailIds.mockResolvedValue(new Set());
  mockGetEmailHeadersPartial.mockResolvedValue({ emails: [mkHeader(1), mkHeader(2)], totalEmails: 2 });
  mockReadLocalEmailIndex.mockResolvedValue(null);
  mockGetArchivedEmails.mockResolvedValue([]);
});

describe('_prewarmAccountCaches: a failed archived-ids read must not persist a lying restore descriptor', () => {
  it('RED: getArchivedEmailIds() returning null skips the restore save entirely', async () => {
    mockGetArchivedEmailIds.mockResolvedValue(null); // documented "could not read"

    await _prewarmAccountCaches();

    expect(mockSaveRestore).not.toHaveBeenCalled();
  });

  it('control: a successful read still persists the descriptor with the real archived uids', async () => {
    mockGetArchivedEmailIds.mockResolvedValue(new Set([2]));

    await _prewarmAccountCaches();

    expect(mockSaveRestore).toHaveBeenCalledTimes(1);
    const descriptor = mockSaveRestore.mock.calls[0][0];
    expect(descriptor.accountId).toBe(BACKGROUND_ACCOUNT.id);
    expect(descriptor.firstWindowArchivedUids).toEqual([2]);
  });

  it('control: an empty-but-real read (Set with size 0) still persists as a genuine empty', async () => {
    mockGetArchivedEmailIds.mockResolvedValue(new Set());

    await _prewarmAccountCaches();

    expect(mockSaveRestore).toHaveBeenCalledTimes(1);
    expect(mockSaveRestore.mock.calls[0][0].firstWindowArchivedUids).toEqual([]);
  });
});
