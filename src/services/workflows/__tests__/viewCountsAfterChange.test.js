// The badge beside each saved view, after a change made in this app.
//
// A view's count comes from the daemon's index, and a read, a star, a delete
// or a move changes what a view holds. The sidebar only counted again when a
// view was opened, so the badges sat on the old numbers. Every flag, delete
// and move path now marks the counts stale (viewStore's
// scheduleViewCountsRefresh, which coalesces them into one count), undo
// included because it runs through the same paths.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { serverUids } from '../../../stores/slices/serverUids';

if (!globalThis.window) {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
} else {
  globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
}

const mockUpdateEmailFlags = vi.fn().mockResolvedValue({ success: true, written: [] });
const mockVaultApplyFlags = vi.fn().mockResolvedValue({ renamed: 1 });
const mockQueueOp = vi.fn().mockResolvedValue(1);
const mockClearOps = vi.fn().mockResolvedValue(undefined);
const mockDaemonCall = vi.fn().mockResolvedValue({});
const mockScheduleViewCounts = vi.fn();

vi.mock('../../daemonClient', () => ({
  daemonCall: (...a) => mockDaemonCall(...a),
  isDaemonAvailable: async () => true,
  getDaemonStatus: async () => ({}),
  DaemonError: class DaemonError extends Error {},
}));

vi.mock('../../db', () => ({
  getLocalEmailLight: vi.fn().mockResolvedValue(null),
  getEmailHeadersMeta: vi.fn().mockResolvedValue(null),
  getEmailHeadersPartial: vi.fn().mockResolvedValue({ emails: [], totalEmails: 0 }),
  getVaultUidSets: vi.fn().mockResolvedValue({ saved: new Set(), archived: new Set() }),
  getCachedMailboxEntry: vi.fn().mockResolvedValue(null),
  getCachedMailboxes: vi.fn().mockResolvedValue(null),
  getLocalEmails: vi.fn().mockResolvedValue([]),
  readLocalEmailIndex: vi.fn().mockResolvedValue(null),
  getArchivedEmails: vi.fn().mockResolvedValue([]),
  deleteLocalEmail: vi.fn().mockResolvedValue(undefined),
  isEmailSaved: vi.fn().mockResolvedValue(true),
  archiveEmail: vi.fn().mockResolvedValue(undefined),
  saveEmailHeaders: vi.fn().mockResolvedValue(undefined),
  exportEmail: vi.fn().mockResolvedValue(null),
  queueOp: (...a) => mockQueueOp(...a),
  clearOps: (...a) => mockClearOps(...a),
  initDB: vi.fn().mockResolvedValue(undefined),
  getAccounts: vi.fn().mockResolvedValue([]),
  ensureAccountsInFile: vi.fn().mockResolvedValue(undefined),
  saveMailboxes: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../api', () => ({
  vaultApplyFlags: (...a) => mockVaultApplyFlags(...a),
  fetchEmailLight: vi.fn().mockResolvedValue(null),
  updateEmailFlags: (...a) => mockUpdateEmailFlags(...a),
  graphSetRead: vi.fn().mockResolvedValue(undefined),
  graphSetFlagged: vi.fn().mockResolvedValue(undefined),
  graphGetMessage: vi.fn().mockResolvedValue(null),
  graphListFolders: vi.fn().mockResolvedValue([]),
  graphListMessages: vi.fn().mockResolvedValue({ headers: [], graphMessageIds: [] }),
  graphCacheMime: vi.fn().mockResolvedValue(undefined),
  deleteEmail: vi.fn().mockResolvedValue(undefined),
  moveEmails: vi.fn().mockResolvedValue(undefined),
  removeFromLocalIndex: vi.fn().mockResolvedValue(undefined),
  appendLocalIndex: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../authUtils', () => ({
  hasValidCredentials: () => true,
  ensureFreshToken: (a) => Promise.resolve(a),
  resolveServerAccount: (id, account) => Promise.resolve({ ok: true, account }),
}));

vi.mock('../../attachmentUtils', () => ({
  hasRealAttachments: () => false,
  hydrateInlineImages: (email) => Promise.resolve(email),
  getRealAttachments: () => [],
  replaceCidUrls: (html) => html,
  getCleanBase64: (b64) => b64,
}));

vi.mock('../../graphConfig', () => ({
  isGraphAccount: (a) => a?.oauth2Transport === 'graph',
  graphMessageToEmail: (m) => m,
}));

vi.mock('../../cacheManager', () => ({
  getRestoreDescriptor: vi.fn().mockReturnValue(null),
  saveRestoreDescriptor: vi.fn(),
  invalidateRestoreDescriptors: () => {},
  getAccountCacheMailboxes: () => null,
  listGraphMessages: vi.fn().mockResolvedValue({ headers: [], graphMessageIds: [] }),
  getGraphMessageId: () => null,
  resolveGraphMessageId: async () => null,
  clearGraphIdMap: () => {},
}));

vi.mock('../../../stores/connectivityStore', () => ({
  useConnectivityStore: { getState: () => ({ online: true }) },
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
      markAsReadMode: 'manual',
      markAsReadDelay: 3,
      setUnreadForAccount: () => {},
    }),
  },
}));

vi.mock('../../safeStorage', () => ({
  safeStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}));

// The debounce itself is viewStore's and has its own tests; here only whether
// a change asks for it.
vi.mock('../../../stores/viewStore', async (importOriginal) => ({
  ...(await importOriginal()),
  scheduleViewCountsRefresh: (...a) => mockScheduleViewCounts(...a),
}));

const { useMailStore } = await import('../../../stores/mailStore');
const { useSearchStore } = await import('../../../stores/searchStore');
const { invalidateChatAndThreadCaches } = await import('../../../stores/slices/messageListSlice');
const { toggleFlagged, deleteEmailFromServer, setDeleteUndo, reloadListInView, saveEmailLocally } = await import('../messageMutations');

const ACCOUNT = { id: 'a1', email: 'a1@x' };
const ROW = { uid: 7, messageId: '<m7@x>', subject: 'Invoice', flags: ['\\Seen'], from: { address: 'b@x' }, date: '2026-08-01T10:00:00Z' };

function primeStore(emails = []) {
  useMailStore.setState({
    accounts: [ACCOUNT],
    activeAccountId: ACCOUNT.id,
    activeMailbox: 'INBOX',
    mailboxScope: null,
    mailboxes: [],
    viewMode: 'all',
    emails,
    sentEmails: [],
    localEmails: [],
    savedEmailIds: new Set(),
    archivedEmailIds: new Set(),
    serverUids: serverUids(emails.map(e => e.uid), { complete: false }),
    deleteTombstones: new Set(),
    totalEmails: emails.length,
    selectedEmailIds: new Set(),
    selectedEmail: null,
    selectedEmailId: null,
    emailCache: new Map(),
    loadEmails: vi.fn(),
    undo: null,
    _sortedEmailsFingerprint: '',
  });
  invalidateChatAndThreadCaches();
  useMailStore.getState().updateSortedEmails();
}

// The request goes out through a dynamic import; let it land.
const settle = () => new Promise(resolve => setTimeout(resolve, 10));

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdateEmailFlags.mockResolvedValue({ success: true, written: [] });
  mockVaultApplyFlags.mockResolvedValue({ renamed: 1 });
  mockDaemonCall.mockResolvedValue({});
  useSearchStore.setState({ searchResults: [] });
});

describe('saved-view counts after a change made here', () => {
  it('a star counts the views again, and again once the vault copy the index reads is written', async () => {
    primeStore([{ ...ROW }]);
    let written;
    mockVaultApplyFlags.mockReturnValue(new Promise(resolve => { written = resolve; }));

    await toggleFlagged(7);
    await vi.waitFor(() => expect(mockScheduleViewCounts).toHaveBeenCalledTimes(1));
    await settle();
    expect(mockScheduleViewCounts).toHaveBeenCalledTimes(1);

    written({ renamed: 1 });
    await vi.waitFor(() => expect(mockScheduleViewCounts).toHaveBeenCalledTimes(2));
  });

  it('the undo of a star counts them again', async () => {
    primeStore([{ ...ROW }]);
    await toggleFlagged(7);
    await settle();
    mockScheduleViewCounts.mockClear();

    await expect(useMailStore.getState().runUndo()).resolves.toBe(true);

    await vi.waitFor(() => expect(mockScheduleViewCounts).toHaveBeenCalled());
  });

  it('a delete counts them again as soon as the row leaves the list', async () => {
    primeStore([{ ...ROW }]);
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await deleteEmailFromServer(7).catch(() => {});

    await vi.waitFor(() => expect(mockScheduleViewCounts).toHaveBeenCalled());
    quiet.mockRestore();
    log.mockRestore();
  });

  it('the undo of a delete counts them again', async () => {
    primeStore();
    mockDaemonCall.mockImplementation(async method => (method === 'deleted.recover'
      ? { recovered: [{ accountId: 'a1', mailbox: 'INBOX', uid: 7 }] } : {}));
    await setDeleteUndo([{ accountId: 'a1', mailbox: 'INBOX', uid: 7, binId: 'bin-1' }]);
    mockScheduleViewCounts.mockClear();

    await expect(useMailStore.getState().runUndo()).resolves.toBe(true);

    await vi.waitFor(() => expect(mockScheduleViewCounts).toHaveBeenCalled());
  });

  it('an archive into the vault counts them again', async () => {
    primeStore([{ ...ROW }]);
    await saveEmailLocally(7).catch(() => {});
    await vi.waitFor(() => expect(mockScheduleViewCounts).toHaveBeenCalled());
  });

  // The repaint after a move, its undo, a restore and a snooze wake.
  it('the reload after a move counts them again', async () => {
    primeStore();
    await reloadListInView();
    await vi.waitFor(() => expect(mockScheduleViewCounts).toHaveBeenCalled());
  });
});
