// A delete made inside a folder-branch view (activeMailbox = the branch root,
// mailboxScope set, each row stamped with its own folder) writes the tombstone
// the display derivation matches: the row's own folder. A stale repaint of the
// deleted row then stays hidden, and the same uid in the root folder stays shown.
// loadUnifiedInbox never clears activeAccountId, so the fallback had a target.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { serverUids } from '../../../stores/slices/serverUids';
import { _selKey } from '../../../stores/slices/unifiedHelpers';

if (!globalThis.window) {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
} else {
  globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
}

const mockUpdateEmailFlags = vi.fn().mockResolvedValue(undefined);
const mockGraphSetRead = vi.fn().mockResolvedValue(undefined);
const mockDeleteEmail = vi.fn().mockResolvedValue(undefined);
const mockMoveEmails = vi.fn().mockResolvedValue(undefined);
const mockSaveEmailHeaders = vi.fn().mockResolvedValue(undefined);
const mockQueueOp = vi.fn().mockResolvedValue(undefined);
const mockClearOps = vi.fn().mockResolvedValue(undefined);
const mockSetUnreadForAccount = vi.fn();
const mockGetGraphMessageId = vi.fn().mockReturnValue(null);
const mockIsGraphAccount = vi.fn().mockReturnValue(false);
const mockGraphDeleteMessage = vi.fn().mockResolvedValue(undefined);
const mockGetLocalIndexEntry = vi.fn().mockResolvedValue(null);
const mockAppendLocalIndex = vi.fn().mockResolvedValue(undefined);
// maildir_delete/local_index_remove now route through transport.js (Task
// 2.1); each test below still supplies its own mockSend implementation.
const mockSend = vi.fn().mockResolvedValue(undefined);
vi.mock('../../transport', () => ({ send: (...a) => mockSend(...a) }));

// The connectivity verdict the workflow reads. Offline is not a failure — the
// journal entry stays and replayOps sends it when the link is back.
let netOnline = true;

vi.mock('../../db', () => ({
  getLocalEmailLight: vi.fn().mockResolvedValue(null),
  getEmailHeadersMeta: vi.fn().mockResolvedValue(null),
  getEmailHeadersPartial: vi.fn().mockResolvedValue({ emails: [], totalEmails: 0 }),
  getVaultUidSets: vi.fn().mockResolvedValue({ saved: new Set(), archived: new Set() }),
  getCachedMailboxEntry: vi.fn().mockResolvedValue(null),
  getLocalEmails: vi.fn().mockResolvedValue([]),
  readLocalEmailIndex: vi.fn().mockResolvedValue(null),
  getLocalIndexEntry: (...a) => mockGetLocalIndexEntry(...a),
  getArchivedEmails: vi.fn().mockResolvedValue([]),
  deleteLocalEmail: vi.fn().mockResolvedValue(undefined),
  saveEmailHeaders: (...a) => mockSaveEmailHeaders(...a),
  queueOp: (...a) => mockQueueOp(...a),
  clearOps: (...a) => mockClearOps(...a),
  initDB: vi.fn().mockResolvedValue(undefined),
  getAccounts: vi.fn().mockResolvedValue([]),
  ensureAccountsInFile: vi.fn().mockResolvedValue(undefined),
  saveMailboxes: vi.fn().mockResolvedValue(undefined),
}));

const mockVaultApplyFlags = vi.fn().mockResolvedValue({ renamed: 0, mirrored: 0, index_patched: 0, sidecars_patched: 0 });
vi.mock('../../api', () => ({
  vaultApplyFlags: (...a) => mockVaultApplyFlags(...a),
  fetchEmailLight: vi.fn().mockResolvedValue(null),
  updateEmailFlags: (...a) => mockUpdateEmailFlags(...a),
  graphSetRead: (...a) => mockGraphSetRead(...a),
  deleteEmail: (...a) => mockDeleteEmail(...a),
  graphDeleteMessage: (...a) => mockGraphDeleteMessage(...a),
  moveEmails: (...a) => mockMoveEmails(...a),
  removeFromLocalIndex: vi.fn().mockResolvedValue(undefined),
  appendLocalIndex: (...a) => mockAppendLocalIndex(...a),
}));
vi.mock('../../authUtils', () => ({
  hasValidCredentials: () => true,
  ensureFreshToken: (a) => Promise.resolve(a),
  resolveServerAccount: (id, account) => Promise.resolve({ ok: true, account }),
}));
vi.mock('../../attachmentUtils', () => ({ hasRealAttachments: () => false }));
vi.mock('../../graphConfig', () => ({
  isGraphAccount: (...a) => mockIsGraphAccount(...a),
  graphMessageToEmail: (m) => m,
}));
vi.mock('../../cacheManager', () => ({
  getRestoreDescriptor: vi.fn().mockReturnValue(null),
  saveRestoreDescriptor: vi.fn(),
  invalidateRestoreDescriptors: () => {},
  getAccountCacheMailboxes: () => null,
  listGraphMessages: vi.fn().mockResolvedValue({ headers: [], graphMessageIds: [] }),
  getGraphMessageId: (...a) => mockGetGraphMessageId(...a),
  resolveGraphMessageId: async (acct, mb, uid, opts) => opts?.row?._graphId || mockGetGraphMessageId(acct, mb, uid),
  clearGraphIdMap: () => {},
}));
vi.mock('../../../stores/connectivityStore', () => ({
  useConnectivityStore: { getState: () => ({ online: netOnline }) },
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
      unreadPerAccount: { 'acct-b': 2 },
      setUnreadForAccount: (...a) => mockSetUnreadForAccount(...a),
    }),
  },
}));
// `reloadListInView` reaches for the whole-account refresh when the view is
// UNIFIED, and nothing here awaits it: it walks every account, dies on a
// settings store this file only stubs the parts it needs of, and vitest fails
// the RUN on the unhandled rejection while every test still passes. The
// refresh is not what these cases are about; the module has these two exports
// and no more.
vi.mock('../refreshAccounts', () => ({
  refreshCurrentView: vi.fn().mockResolvedValue(undefined),
  refreshAllAccounts: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../safeStorage', () => ({
  safeStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}));

const { useMailStore } = await import('../../../stores/mailStore');
const { invalidateChatAndThreadCaches } = await import('../../../stores/slices/messageListSlice');

const ACCT_A = { id: 'acct-a', email: 'a@mock.test' };
const ACCT_B = { id: 'acct-b', email: 'b@mock.test' };

const row = (uid, mailbox) => ({
  uid, subject: `m${uid}`, flags: [], from: { address: 'x@mock.test' }, date: '2026-09-01T10:00:00Z',
  _accountId: ACCT_A.id, _accountEmail: ACCT_A.email, _mailbox: mailbox,
});

const PATHS = ['Projects', 'Projects/Alpha'];

function primeBranch(emails) {
  useMailStore.setState({
    accounts: [ACCT_A],
    activeAccountId: ACCT_A.id,
    activeMailbox: 'Projects',
    unifiedInbox: false,
    unifiedFolder: null,
    mailboxScope: { root: 'Projects', paths: PATHS },
    mailboxes: PATHS.map(path => ({ path, name: path })),
    viewMode: 'all',
    emails,
    sentEmails: [],
    localEmails: [],
    savedEmailIds: new Set(),
    archivedEmailIds: new Set(),
    serverUids: serverUids([], { complete: false }),
    deleteTombstones: new Set(),
    totalEmails: emails.length,
    selectedEmailIds: new Set(),
    selectedEmail: null,
    selectedEmailId: null,
    loadEmails: vi.fn(),
  });
  invalidateChatAndThreadCaches();
  useMailStore.getState().updateSortedEmails();
}

const shown = () => useMailStore.getState().sortedEmails.map(e => `${e._mailbox}|${e.uid}`);

describe('deleting inside a folder-branch view', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    netOnline = true;
    mockGetLocalIndexEntry.mockResolvedValue(null);
  });

  it('tombstones the child folder\'s row, so a stale repaint of it stays hidden', async () => {
    const root = row(34, 'Projects');
    const child = row(34, 'Projects/Alpha');
    primeBranch([root, child]);
    // The server never answers: what is checked is the optimistic window, where
    // a header cache that still holds the row repaints it.
    mockDeleteEmail.mockReturnValue(new Promise(() => {}));
    useMailStore.getState().deleteEmailFromServer(_selKey(child));
    await vi.waitFor(() => expect(mockDeleteEmail).toHaveBeenCalled());
    expect(mockDeleteEmail).toHaveBeenCalledWith(ACCT_A, 34, 'Projects/Alpha');
    expect(shown()).toEqual(['Projects|34']);

    // The stale repaint: the cache hands the deleted row back.
    useMailStore.setState({ emails: [root, { ...child }] });
    useMailStore.getState().updateSortedEmails();
    expect(shown()).toEqual(['Projects|34']);
  });

  it('deleting the root\'s row leaves the child folder\'s same uid on screen', async () => {
    const root = row(34, 'Projects');
    const child = row(34, 'Projects/Alpha');
    primeBranch([root, child]);
    mockDeleteEmail.mockReturnValue(new Promise(() => {}));
    useMailStore.getState().deleteEmailFromServer(_selKey(root));
    await vi.waitFor(() => expect(mockDeleteEmail).toHaveBeenCalled());
    useMailStore.setState({ emails: [{ ...root }, child] });
    useMailStore.getState().updateSortedEmails();
    expect(shown()).toEqual(['Projects/Alpha|34']);
  });
});
