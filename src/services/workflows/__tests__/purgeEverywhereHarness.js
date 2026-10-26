// Shared dependency boundary for the real purge workflow tests and oracle.
import { beforeEach, vi } from 'vitest';
import { serverUids } from '../../../stores/slices/serverUids';

if (!globalThis.window) globalThis.window = {};
globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
globalThis.window.removeEventListener = globalThis.window.removeEventListener || (() => {});

const mockDeleteEmail = vi.fn().mockResolvedValue(undefined);
const mockMaildirDeleteMany = vi.fn().mockResolvedValue({ removed: 0 });
const mockBackupPurgeUids = vi.fn().mockResolvedValue({ removed: 0, queued: 0 });
// Matching non-null values by default so every test that doesn't care about
// the UIDVALIDITY guard sees a "trusted" mailbox and behaves as before it
// existed. Tests that DO care override one side to force a mismatch.
const mockCheckMailboxStatus = vi.fn().mockResolvedValue({ uidValidity: 1 });
const mockMoveEmails = vi.fn().mockResolvedValue({ newUids: [171] });
const mockVaultRebindUids = vi.fn().mockResolvedValue({ rebound: [] });
const mockGetVaultUidSets = vi.fn().mockResolvedValue({ saved: new Set(), archived: new Set() });
const mockGetLocalEmails = vi.fn().mockResolvedValue([]);
const mockSearch = { searchActive: true, searchResults: [], performSearch: vi.fn() };
const mockGraphDeleteMessage = vi.fn().mockResolvedValue(undefined);
// A purge refused for missing identity resyncs its mailbox and re-reads the rows.
const mockSyncNow = vi.fn().mockResolvedValue({ ticket: 7 });
const mockWaitForSync = vi.fn().mockResolvedValue({ success: true });
const mockGetEmailHeadersByUids = vi.fn().mockResolvedValue([]);

vi.mock('../../syncService', () => ({
  syncNow: (...a) => mockSyncNow(...a),
  waitForSync: (...a) => mockWaitForSync(...a),
  toSyncAccount: (account) => ({ id: account.id, email: account.email }),
}));

vi.mock('../../api', () => ({
  deleteEmail: (...a) => mockDeleteEmail(...a),
  maildirDeleteMany: (...a) => mockMaildirDeleteMany(...a),
  backupPurgeUids: (...a) => mockBackupPurgeUids(...a),
  checkMailboxStatus: (...a) => mockCheckMailboxStatus(...a),
  appendLocalIndex: (...a) => mockAppendLocalIndex(...a),
  removeFromLocalIndex: vi.fn().mockResolvedValue(undefined),
  fetchEmailLight: vi.fn(),
  updateEmailFlags: vi.fn().mockResolvedValue(undefined),
  moveEmails: (...a) => mockMoveEmails(...a),
  vaultRebindUids: (...a) => mockVaultRebindUids(...a),
  graphDeleteMessage: (...a) => mockGraphDeleteMessage(...a),
  graphSetRead: vi.fn().mockResolvedValue(undefined),
}));

// The vault index read/write pair `stampVaultEntry` uses. Mocked here so a
// stamp on this path would be a visible call rather than a TypeError the
// helper's own catch swallows.
const mockGetLocalIndexEntry = vi.fn().mockResolvedValue({ uid: 1, flags: ['archived'], source: 'local' });
const mockAppendLocalIndex = vi.fn().mockResolvedValue(undefined);

const mockGetLocalIndexProvenance = vi.fn().mockResolvedValue(new Map());
const mockGetEmailHeadersMeta = vi.fn().mockResolvedValue({ uidValidity: 1 });
const mockSaveEmailHeaders = vi.fn().mockResolvedValue(undefined);

vi.mock('../../db', () => ({
  initDB: vi.fn().mockResolvedValue(undefined),
  getVaultUidSets: (...a) => mockGetVaultUidSets(...a),
  getLocalEmails: (...a) => mockGetLocalEmails(...a),
  readLocalEmailIndex: vi.fn().mockResolvedValue(null),
  getLocalIndexProvenance: (...a) => mockGetLocalIndexProvenance(...a),
  getLocalIndexEntry: (...a) => mockGetLocalIndexEntry(...a),
  deleteLocalEmail: vi.fn().mockResolvedValue(undefined),
  getEmailHeadersPartial: vi.fn().mockResolvedValue({ emails: [], totalEmails: 0 }),
  getEmailHeadersByUids: (...a) => mockGetEmailHeadersByUids(...a),
  getEmailHeadersMeta: (...a) => mockGetEmailHeadersMeta(...a),
  getCachedMailboxEntry: vi.fn().mockResolvedValue(null),
  saveEmailHeaders: (...a) => mockSaveEmailHeaders(...a),
  getAccounts: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../authUtils', () => ({
  ensureFreshToken: (a) => Promise.resolve(a),
  hasValidCredentials: () => true,
  resolveServerAccount: (id, account) => Promise.resolve({ ok: true, account }),
}));

const mockIsGraphAccount = vi.fn().mockReturnValue(false);
const mockGetGraphMessageId = vi.fn().mockReturnValue(null);

vi.mock('../../graphConfig', () => ({
  isGraphAccount: (...a) => mockIsGraphAccount(...a),
  graphMessageToEmail: (m) => m,
}));

// getGraphMessageId is imported from cacheManager, not graphConfig.
vi.mock('../../cacheManager', () => ({
  getGraphMessageId: (...a) => mockGetGraphMessageId(...a),
  resolveGraphMessageId: async (acct, mb, uid, opts) => opts?.row?._graphId || mockGetGraphMessageId(acct, mb, uid),
}));

vi.mock('../../safeStorage', () => ({
  safeStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}));

vi.mock('../../../stores/settingsStore', () => ({
  useSettingsStore: {
    getState: () => ({
      cacheLimitMB: 128,
      hiddenAccounts: {},
      getLastMailbox: () => 'INBOX',
      emailListStyle: 'default',
      linkAlerts: {},
      linkSafetyEnabled: false,
      setUnreadForAccount: () => {},
    }),
  },
}));

// The open search results; a purge has to reach them too.
const mockRemoveSearchResults = vi.fn();
vi.mock('../../../stores/searchStore', () => ({
  useSearchStore: {
    getState: () => ({ ...mockSearch, removeSearchResults: (...a) => mockRemoveSearchResults(...a) }),
    setState: patch => Object.assign(mockSearch, typeof patch === 'function' ? patch(mockSearch) : patch),
  },
}));

const { useMailStore } = await import('../../../stores/mailStore');
const { purgeEverywhere, purgeEverywhereReporting, setDeleteUndo } = await import('../messageMutations');

// 36-char UUID: db/emails.js parses `accountId-mailbox-uid` with a fixed-width
// prefix and silently no-ops on anything shorter.
const ACCOUNT = { id: '11111111-1111-4111-8111-111111111111', email: 'me@mock.test' };

function prime({ emails, archived = [], localOnly = [], serverUidList, sent = [], provenance }) {
  useMailStore.setState({
    accounts: [ACCOUNT],
    activeAccountId: ACCOUNT.id,
    activeMailbox: 'INBOX.Spam',
    viewMode: 'all',
    emails,
    sentEmails: sent,
    // Rows still on the server live in `emails`. A row purged from the server
    // but still archived locally lives only in `localEmails`; the real
    // production placement for the "local-only" case, and where
    // updateSortedEmails() derives `source: 'local-only'` for it.
    localEmails: localOnly,
    savedEmailIds: new Set(),
    archivedEmailIds: new Set(archived),
    serverUids: serverUids(serverUidList !== undefined ? serverUidList : emails.filter(e => e.source !== 'local-only').map(e => e.uid), { complete: false }),
    deleteTombstones: new Set(),
    totalEmails: emails.length,
    selectedEmailIds: new Set(),
    selectedEmail: null,
    selectedEmailId: null,
    loadEmails: vi.fn(),
    _sortedEmailsFingerprint: '',
  });
  mockGetLocalIndexProvenance.mockResolvedValue(provenance || new Map());
  useMailStore.getState().updateSortedEmails();
}

const serverMsg = (uid) => ({
  uid, messageId: `m${uid}@mock`, subject: `Spam ${uid}`, flags: [],
  from: { address: 'them@mock.test' }, date: '2026-08-01T10:00:00Z',
});

function resetPurgeMocks() {
  mockDeleteEmail.mockReset().mockResolvedValue(undefined);
  mockMaildirDeleteMany.mockReset().mockResolvedValue({ removed: 0 });
  mockBackupPurgeUids.mockReset().mockResolvedValue({ removed: 0, queued: 0 });
  mockGetLocalIndexProvenance.mockReset().mockResolvedValue(new Map());
  mockGetLocalIndexEntry.mockReset().mockResolvedValue({ uid: 1, flags: ['archived'], source: 'local' });
  mockAppendLocalIndex.mockReset().mockResolvedValue(undefined);
  // Without this, prune assertions match a previous test's call and pass (or
  // fail) for the wrong reason.
  mockSaveEmailHeaders.mockReset().mockResolvedValue(undefined);
  mockCheckMailboxStatus.mockReset().mockResolvedValue({ uidValidity: 1 });
  mockGetEmailHeadersMeta.mockReset().mockResolvedValue({ uidValidity: 1 });
  mockGraphDeleteMessage.mockReset().mockResolvedValue(undefined);
  mockSyncNow.mockReset().mockResolvedValue({ ticket: 7 });
  mockWaitForSync.mockReset().mockResolvedValue({ success: true });
  mockGetEmailHeadersByUids.mockReset().mockResolvedValue([]);
  mockIsGraphAccount.mockReset().mockReturnValue(false);
  mockGetGraphMessageId.mockReset().mockReturnValue(null);
  mockRemoveSearchResults.mockReset();
  mockMoveEmails.mockReset().mockResolvedValue({ newUids: [171] });
  mockVaultRebindUids.mockReset().mockResolvedValue({ rebound: [] });
  mockGetVaultUidSets.mockReset().mockResolvedValue({ saved: new Set(), archived: new Set() });
  mockGetLocalEmails.mockReset().mockResolvedValue([]);
  mockSearch.searchResults = [];
  mockSearch.indexedSearchRows = {};
  mockSearch.searchRowsOutsideIndex = [];
  mockSearch.excludedSearchCopies = new Set();
  mockSearch.searchGeneration = 0;
  mockSearch.performSearch.mockReset();
}
beforeEach(resetPurgeMocks);

export {
  ACCOUNT, prime, serverMsg, useMailStore, purgeEverywhere, purgeEverywhereReporting,
  setDeleteUndo, resetPurgeMocks, mockDeleteEmail, mockMaildirDeleteMany,
  mockBackupPurgeUids, mockCheckMailboxStatus, mockGraphDeleteMessage,
  mockGetLocalIndexEntry, mockAppendLocalIndex, mockGetLocalIndexProvenance,
  mockGetEmailHeadersMeta, mockSaveEmailHeaders, mockIsGraphAccount,
  mockGetGraphMessageId, mockRemoveSearchResults, mockMoveEmails,
  mockVaultRebindUids, mockGetVaultUidSets, mockGetLocalEmails, mockSearch,
  mockSyncNow, mockWaitForSync, mockGetEmailHeadersByUids,
};
