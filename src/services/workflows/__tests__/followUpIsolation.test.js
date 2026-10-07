// A due follow-up reminder is the user's SENT message brought back to their
// attention. It must never become a row of the inbox list: every list action
// (the bulk modal's ranges, select-all, keyboard delete, j/k) works off the
// list's rows and their (account, folder, uid), and a reminder row there IS
// the Sent copy's identity, so any of them can reach the real Sent message.
// Reminders are shown pinned above the list instead (FollowUpPinnedRows).
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
const mockBulkDeleteEmails = vi.fn().mockResolvedValue({ completed: 0 });
// maildir_delete/local_index_remove now route through transport.js (Task
// 2.1); each test below still supplies its own mockSend implementation.
const mockSend = vi.fn().mockResolvedValue(undefined);
const mockDaemonCall = vi.fn().mockResolvedValue({});
vi.mock('../../daemonClient', () => ({
  daemonCall: (...a) => mockDaemonCall(...a),
  DaemonError: class DaemonError extends Error {},
}));
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
  bulkDeleteEmails: (...a) => mockBulkDeleteEmails(...a),
  savePendingOperation: vi.fn().mockResolvedValue(undefined),
  clearPendingOperation: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
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
const { useFollowUpStore } = await import('../../../stores/followUpStore');
const { selectionKey } = await import('../../../stores/slices/unifiedHelpers');
const { resolvePool } = await import('../../../stores/messageRows');
const { bulkOperationManager } = await import('../../BulkOperationManager');

const ACCT_A = { id: 'acct-a', email: 'a@mock.test' };

const row = (uid, extra = {}) => ({
  uid, subject: `m${uid}`, flags: [], from: { address: 'x@mock.test' }, date: '2026-09-01T10:00:00Z', ...extra,
});

const REMINDER = {
  id: 'f1', accountId: ACCT_A.id, messageId: '<asked@me>', subject: 'Quote?', recipients: 'ana@x.co',
  sentAt: Date.UTC(2026, 7, 1), remindAt: Date.UTC(2026, 8, 2), state: 'due',
  sentMailbox: 'Sent', sentUid: 77, seen: false, announced: true,
};

function prime({ activeMailbox = 'INBOX', emails = [row(1), row(2)], sentEmails = [] } = {}) {
  useFollowUpStore.setState({ rows: [REMINDER] });
  useMailStore.setState({
    accounts: [ACCT_A],
    activeAccountId: ACCT_A.id,
    activeMailbox,
    unifiedInbox: false,
    unifiedFolder: null,
    mailboxScope: null,
    mailboxes: [],
    localFolders: [],
    viewMode: 'all',
    emails,
    sentEmails,
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

const atSent77 = (e) => (e._mailbox === 'Sent' || e._fromSentFolder) && e.uid === 77;

describe('a due follow-up reminder and the inbox list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    netOnline = true;
    mockDeleteEmail.mockResolvedValue(undefined);
    globalThis.window.__TAURI__ = { core: { invoke: () => {} } };
  });

  it('is never a row of the list, nor of the pool a key or a range resolves against', () => {
    prime();
    const state = useMailStore.getState();
    expect(state.sortedEmails.filter(atSent77)).toEqual([]);
    expect(state.sortedEmails.some(e => e._followUpId)).toBe(false);
    expect(resolvePool(state).filter(atSent77)).toEqual([]);
  });

  // The bulk modal's "All" range ticks every row of its pool (the folder's
  // cached rows plus the list rows the cache lacks, BulkOperationsModal
  // emailPool), and Delete hands those keys to the bulk manager.
  it('a bulk delete of "All" in the inbox never reaches the Sent copy', async () => {
    prime();
    const state = useMailStore.getState();
    const keys = state.sortedEmails.map(e => selectionKey(e, state));
    await bulkOperationManager.start({
      type: 'delete', accountId: ACCT_A.id, account: ACCT_A, accounts: [ACCT_A],
      localFolders: {}, mailbox: 'INBOX', spans: false, uids: keys,
    });

    const calls = mockBulkDeleteEmails.mock.calls.map(([, accountId, mailbox, uids]) => ({ accountId, mailbox, uids }));
    expect(calls.filter(c => c.mailbox === 'Sent')).toEqual([]);
    expect(calls).toEqual([{ accountId: ACCT_A.id, mailbox: 'INBOX', uids: [1, 2] }]);
  });

  // App.jsx's `#`: deleteEmailFromServer(selectedEmailId). A Sent message
  // opened from the inbox (a pinned reminder, or a merged Sent copy) has the
  // full key as its id; read as a bare uid it journalled a delete in INBOX.
  it('keyboard delete of the Sent message opened from the inbox acts on it in Sent, never on INBOX', async () => {
    prime({ sentEmails: [row(77, { _accountId: ACCT_A.id, _mailbox: 'Sent', messageId: '<asked@me>', flags: ['\\Seen'] })] });
    const key = selectionKey({ _accountId: ACCT_A.id, _mailbox: 'Sent', uid: 77 }, useMailStore.getState());
    expect(key).toBe(`${ACCT_A.id}:Sent:77`);
    useMailStore.setState({ selectedEmailId: key, selectedEmail: row(77, { _accountId: ACCT_A.id, _mailbox: 'Sent' }) });

    await useMailStore.getState().deleteEmailFromServer(useMailStore.getState().selectedEmailId);

    expect(mockQueueOp.mock.calls.filter(([op]) => op.mailbox === 'INBOX')).toEqual([]);
    expect(mockDeleteEmail.mock.calls.filter(([, , mailbox]) => mailbox === 'INBOX')).toEqual([]);
    expect(mockDeleteEmail).toHaveBeenCalledWith(ACCT_A, 77, 'Sent');
  });

  // ── a Sent copy deleted or moved from where it is shown ──
  //
  // The pin names the Sent message by its uid. Once that message is deleted
  // or moved (from the reader the pin opened, the Sent folder, a bulk run),
  // the reminder points at nothing: it ends AFTER the server said yes, and
  // never instead of the action.

  const dismissed = () => mockDaemonCall.mock.calls.filter(([m]) => m === 'follow_up.dismiss').map(([, p]) => p.id);
  const sentRow = () => row(77, { _accountId: ACCT_A.id, _mailbox: 'Sent', messageId: '<asked@me>', flags: ['\\Seen'] });

  it('ends the reminder once a reader delete of its Sent copy succeeds', async () => {
    mockDaemonCall.mockClear();
    prime({ sentEmails: [sentRow()] });
    useMailStore.setState({ selectedEmailId: `${ACCT_A.id}:Sent:77`, selectedEmail: sentRow() });
    await useMailStore.getState().deleteEmailFromServer(useMailStore.getState().selectedEmailId);
    expect(mockDeleteEmail).toHaveBeenCalledWith(ACCT_A, 77, 'Sent');
    expect(dismissed()).toEqual(['f1']);
  });

  it('keeps the reminder when the delete fails', async () => {
    mockDaemonCall.mockClear();
    prime({ sentEmails: [sentRow()] });
    // Every try refused: the delete retries a refusal once (retryOnce).
    mockDeleteEmail.mockRejectedValue(new Error('NO server says no'));
    await useMailStore.getState().deleteEmailFromServer(`${ACCT_A.id}:Sent:77`).catch(() => {});
    expect(mockDeleteEmail).toHaveBeenCalled();
    expect(dismissed()).toEqual([]);
  });

  it('ends the reminder once a move of its Sent copy succeeds', async () => {
    mockDaemonCall.mockClear();
    prime({ activeMailbox: 'Sent', emails: [row(77, { messageId: '<asked@me>' })] });
    mockMoveEmails.mockResolvedValueOnce({ moved: 1, newUids: [9] });
    await useMailStore.getState().moveEmails([77], 'Archive');
    expect(mockMoveEmails).toHaveBeenCalled();
    expect(dismissed()).toEqual(['f1']);
  });

  it('ends the reminder once a bulk delete of the selection in Sent succeeds', async () => {
    mockDaemonCall.mockClear();
    prime({ activeMailbox: 'Sent', emails: [row(77, { messageId: '<asked@me>' }), row(78)] });
    useMailStore.setState({ selectedEmailIds: new Set([77]) });
    await useMailStore.getState().deleteSelectedFromServer();
    expect(mockDeleteEmail).toHaveBeenCalledWith(ACCT_A, 77, 'Sent');
    expect(dismissed()).toEqual(['f1']);
  });

  // Opening the pin answers "gone": the message was deleted from another client.
  it('ends the reminder whose Sent copy the server proves gone', async () => {
    mockDaemonCall.mockClear();
    prime();
    const { applyServerRemoval } = await import('../messageMutations');
    await applyServerRemoval(77, { accountId: ACCT_A.id, mailbox: 'Sent', skipRefresh: true, clearSelection: false });
    expect(dismissed()).toEqual(['f1']);
  });
});

