// A custody write names ONE message by (account, folder, uid), and the header it
// puts in the vault index has to be that message's. stampVaultEntry used to find
// a row by bare uid with a wildcard for a row with no folder, so a bulk-archived
// message of one account (no index entry yet) was given the header of ANOTHER
// account's row that shared its number. The custody write of saveEmailLocally
// looked its row up the same way, and in a spanning view it was handed the
// whole selection key as the uid, so the lookup and every call below it (the
// vault archive, the existence check) addressed a uid that is no number.
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
  isEmailSaved: vi.fn().mockResolvedValue(true),
  archiveEmail: vi.fn().mockResolvedValue(undefined),
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

const { stampVaultEntry, saveEmailLocally } = await import('../messageMutations');
const db = await import('../../db');
import { _selKey } from '../../../stores/slices/unifiedHelpers';

const row = (uid, subject, extra = {}) => ({
  uid, subject, flags: [], from: { address: 'x@mock.test' }, date: '2026-09-01T10:00:00Z', ...extra,
});

function prime({ active = ACCT_A.id, mailbox = 'INBOX', emails = [], localEmails = [], archived = [] }) {
  useMailStore.setState({
    accounts: [ACCT_A, ACCT_B],
    activeAccountId: active,
    activeMailbox: mailbox,
    unifiedInbox: mailbox === 'UNIFIED',
    unifiedFolder: 'INBOX',
    mailboxScope: null,
    mailboxes: [],
    viewMode: 'all',
    emails,
    sentEmails: [],
    localEmails,
    savedEmailIds: new Set(),
    archivedEmailIds: new Set(archived),
    serverUids: serverUids([], { complete: false }),
    deleteTombstones: new Set(),
    selectedEmailIds: new Set(),
    selectedEmail: null,
    selectedEmailId: null,
    loadEmails: vi.fn(),
  });
  invalidateChatAndThreadCaches();
  useMailStore.getState().updateSortedEmails();
}

describe('stampVaultEntry without a durable index entry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetLocalIndexEntry.mockResolvedValue(null);
  });

  it("does not write another account's header under this account's uid", async () => {
    // B archived its uid 5 through the bulk path (no entry yet); the only row
    // in memory with that number is A's.
    prime({
      emails: [],
      localEmails: [row(5, "A's private subject", { _accountId: ACCT_A.id, _mailbox: 'INBOX' })],
      archived: [`${ACCT_B.id}:INBOX:5`],
      mailbox: 'UNIFIED',
    });

    const stamped = await stampVaultEntry(ACCT_B.id, 'INBOX', 5, { serverDeleted: true });

    expect(stamped).toBe(false);
    expect(mockAppendLocalIndex).not.toHaveBeenCalled();
  });

  it("does not take the active view's unstamped row for another account's message", async () => {
    // A single-folder view of A: its rows carry no account or folder stamp.
    prime({
      active: ACCT_A.id,
      localEmails: [row(5, "A's private subject")],
      archived: [`${ACCT_B.id}:INBOX:5`],
    });

    const stamped = await stampVaultEntry(ACCT_B.id, 'INBOX', 5, { serverDeleted: true });

    expect(stamped).toBe(false);
    expect(mockAppendLocalIndex).not.toHaveBeenCalled();
  });

  it("does not take another folder's row of the same account", async () => {
    prime({
      localEmails: [row(5, 'Sent copy', { _accountId: ACCT_A.id, _mailbox: 'Sent' })],
      archived: [`${ACCT_A.id}:INBOX:5`],
      mailbox: 'UNIFIED',
    });

    expect(await stampVaultEntry(ACCT_A.id, 'INBOX', 5, { serverDeleted: true })).toBe(false);
    expect(mockAppendLocalIndex).not.toHaveBeenCalled();
  });

  it('still writes the message\'s own header when its row is in memory', async () => {
    prime({
      localEmails: [
        row(5, "A's private subject", { _accountId: ACCT_A.id, _mailbox: 'INBOX' }),
        row(5, "B's own subject", { _accountId: ACCT_B.id, _mailbox: 'INBOX' }),
      ],
      archived: [`${ACCT_B.id}:INBOX:5`],
      mailbox: 'UNIFIED',
    });

    expect(await stampVaultEntry(ACCT_B.id, 'INBOX', 5, { serverDeleted: true })).toBe(true);
    expect(mockAppendLocalIndex).toHaveBeenCalledWith(ACCT_B.id, 'INBOX', [
      expect.objectContaining({ uid: 5, subject: "B's own subject", serverDeleted: true }),
    ]);
  });

  it('still finds the unstamped row of the single folder on screen', async () => {
    prime({
      localEmails: [row(5, "A's own subject")],
      archived: [`${ACCT_A.id}:INBOX:5`],
    });

    expect(await stampVaultEntry(ACCT_A.id, 'INBOX', 5, { serverDeleted: true })).toBe(true);
    expect(mockAppendLocalIndex).toHaveBeenCalledWith(ACCT_A.id, 'INBOX', [
      expect.objectContaining({ uid: 5, subject: "A's own subject" }),
    ]);
  });

  it('with a durable entry, stamps that entry and reads no row at all', async () => {
    mockGetLocalIndexEntry.mockResolvedValue({ uid: 5, subject: 'the durable one' });
    prime({ localEmails: [row(5, "A's private subject", { _accountId: ACCT_A.id, _mailbox: 'INBOX' })], mailbox: 'UNIFIED' });

    expect(await stampVaultEntry(ACCT_B.id, 'INBOX', 5, { serverDeleted: true })).toBe(true);
    expect(mockAppendLocalIndex).toHaveBeenCalledWith(ACCT_B.id, 'INBOX', [
      expect.objectContaining({ subject: 'the durable one', serverDeleted: true }),
    ]);
  });
});

describe('saveEmailLocally in a view that spans accounts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetLocalIndexEntry.mockResolvedValue(null);
  });

  it("archives the message by its uid and writes that message's own header to the custody entry", async () => {
    const a = row(5, "A's private subject", { _accountId: ACCT_A.id, _mailbox: 'INBOX' });
    const b = row(5, "B's own subject", { _accountId: ACCT_B.id, _mailbox: 'INBOX' });
    prime({ emails: [a, b], mailbox: 'UNIFIED' });

    await saveEmailLocally(_selKey(b));

    expect(db.archiveEmail).toHaveBeenCalledWith(ACCT_B.id, 'INBOX', 5);
    expect(mockAppendLocalIndex).toHaveBeenCalledTimes(1);
    expect(mockAppendLocalIndex).toHaveBeenCalledWith(ACCT_B.id, 'INBOX', [
      expect.objectContaining({ uid: 5, subject: "B's own subject" }),
    ]);
  });
});
