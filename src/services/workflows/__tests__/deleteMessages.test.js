// deleteMessages: the one app delete workflow both entry points run.
//
// deleteEmailFromServer (one message) and deleteSelectedFromServer (the
// selection) used to be two near-copies of the same loop: journal first, hide
// the rows, send, retry, reconcile. These cases pin the seam they now share,
// called directly with a list of keys, plus the three failure modes the plan's
// Review Focus assigns to it: a Graph message whose id cannot be resolved (6),
// a delete issued while an undo is still moving the message back (4), and an
// offline delete (5).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { serverUids } from '../../../stores/slices/serverUids';

if (!globalThis.window) {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
} else {
  globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
}

const mockMoveEmails = vi.fn();
const mockDeleteEmail = vi.fn();
const mockGraphDeleteMessage = vi.fn().mockResolvedValue(undefined);
const mockQueueOp = vi.fn().mockResolvedValue(1);
const mockClearOps = vi.fn().mockResolvedValue(undefined);
const mockNoteOpFailure = vi.fn();
const mockSaveEmailHeaders = vi.fn().mockResolvedValue(undefined);
const mockResolveGraphMessageId = vi.fn();
const mockDaemonCall = vi.fn().mockResolvedValue({});

let netOnline = true;

vi.mock('../../db', () => ({
  getLocalEmailLight: vi.fn().mockResolvedValue(null),
  getEmailHeadersMeta: vi.fn().mockResolvedValue(null),
  getEmailHeadersPartial: vi.fn().mockResolvedValue({ emails: [], totalEmails: 0 }),
  getVaultUidSets: vi.fn().mockResolvedValue({ saved: new Set(), archived: new Set() }),
  getCachedMailboxEntry: vi.fn().mockResolvedValue(null),
  getLocalEmails: vi.fn().mockResolvedValue([]),
  readLocalEmailIndex: vi.fn().mockResolvedValue(null),
  getLocalIndexEntry: vi.fn().mockResolvedValue(null),
  getArchivedEmails: vi.fn().mockResolvedValue([]),
  deleteLocalEmail: vi.fn().mockResolvedValue(undefined),
  saveEmailHeaders: (...a) => mockSaveEmailHeaders(...a),
  queueOp: (...a) => mockQueueOp(...a),
  clearOps: (...a) => mockClearOps(...a),
  noteOpFailure: (...a) => mockNoteOpFailure(...a),
  initDB: vi.fn().mockResolvedValue(undefined),
  getAccounts: vi.fn().mockResolvedValue([]),
  ensureAccountsInFile: vi.fn().mockResolvedValue(undefined),
  saveMailboxes: vi.fn().mockResolvedValue(undefined),
  appendLocalIndex: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../api', () => ({
  vaultApplyFlags: vi.fn().mockResolvedValue({}),
  fetchEmailLight: vi.fn().mockResolvedValue(null),
  updateEmailFlags: vi.fn().mockResolvedValue({ success: true, written: [] }),
  graphSetRead: vi.fn().mockResolvedValue(undefined),
  deleteEmail: (...a) => mockDeleteEmail(...a),
  graphDeleteMessage: (...a) => mockGraphDeleteMessage(...a),
  moveEmails: (...a) => mockMoveEmails(...a),
  findMessageId: vi.fn().mockResolvedValue({ found: [], searched: 1, failed: 0, complete: true }),
  appendLocalIndex: vi.fn().mockResolvedValue(undefined),
  removeFromLocalIndex: vi.fn().mockResolvedValue(undefined),
  vaultRebindUids: vi.fn().mockResolvedValue({ rebound: [] }),
}));

vi.mock('../../daemonClient', async (importOriginal) => ({
  ...(await importOriginal()),
  daemonCall: (method, params) => mockDaemonCall(method, params),
}));

vi.mock('../refreshAccounts', () => ({
  refreshCurrentView: vi.fn().mockResolvedValue(undefined),
  refreshAllAccounts: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../authUtils', () => ({
  hasValidCredentials: () => true,
  ensureFreshToken: (a) => Promise.resolve(a),
  resolveServerAccount: (id, account) => Promise.resolve({ ok: true, account }),
}));

vi.mock('../../attachmentUtils', () => ({ hasRealAttachments: () => false, hydrateInlineImages: async (e) => e }));

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
  resolveGraphMessageId: (...a) => mockResolveGraphMessageId(...a),
  clearGraphIdMap: () => {},
}));

vi.mock('../../../stores/connectivityStore', () => ({
  useConnectivityStore: { getState: () => ({ online: netOnline }) },
}));

vi.mock('../../safeStorage', () => ({
  safeStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}));

const { useMailStore } = await import('../../../stores/mailStore');
const { invalidateChatAndThreadCaches } = await import('../../../stores/slices/messageListSlice');
const { deleteMessages } = await import('../messageMutations');

const A = { id: 'a1', email: 'a1@mock.test' };
const B = { id: 'b1', email: 'b1@mock.test' };
const G = { id: 'g1', email: 'g1@mock.test', oauth2Transport: 'graph' };

const row = (uid, extra = {}) => ({
  uid, messageId: `m${uid}@mock`, subject: `m${uid}`, flags: [],
  from: { address: 'them@mock.test' }, date: '2026-09-01T10:00:00Z', ...extra,
});

function prime({ emails, accounts = [A], activeAccountId = accounts[0].id, activeMailbox = 'INBOX', selected = [] }) {
  useMailStore.setState({
    accounts,
    activeAccountId,
    activeMailbox,
    unifiedInbox: activeMailbox === 'UNIFIED',
    unifiedFolder: null,
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
    selectedEmailIds: new Set(selected),
    selectedEmail: null,
    selectedEmailId: null,
    emailCache: new Map(),
    loadEmails: vi.fn(),
    undo: null,
    error: null,
    _sortedEmailsFingerprint: '',
  });
  invalidateChatAndThreadCaches();
  useMailStore.getState().updateSortedEmails();
}

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

beforeEach(() => {
  vi.clearAllMocks();
  netOnline = true;
  mockDeleteEmail.mockImplementation(async (_a, uid) => ({ trash: 'Trash', trashUid: 100 + Number(uid) }));
  mockMoveEmails.mockResolvedValue({ success: true, moved: 1, newUids: [41] });
  mockResolveGraphMessageId.mockResolvedValue('graph-id');
  mockDaemonCall.mockResolvedValue({});
});

describe('deleteMessages, one call over many keys', () => {
  it('journals once per (account, folder), hides every row, sends one delete per message and files one undo', async () => {
    prime({
      accounts: [A, B],
      activeMailbox: 'UNIFIED',
      emails: [
        row(7, { _accountId: 'a1', _mailbox: 'INBOX' }),
        row(8, { _accountId: 'a1', _mailbox: 'INBOX' }),
        row(3, { _accountId: 'b1', _mailbox: 'INBOX' }),
        row(9, { _accountId: 'b1', _mailbox: 'INBOX' }),
      ],
    });

    const { outcomes } = await deleteMessages([{ key: 'a1:INBOX:7' }, { key: 'a1:INBOX:8' }, { key: 'b1:INBOX:3' }]);

    // One entry per group, written before anything left the list.
    expect(mockQueueOp).toHaveBeenCalledTimes(2);
    const entries = mockQueueOp.mock.calls.map(([e]) => e);
    expect(entries.find(e => e.accountId === 'a1')).toMatchObject({ op: 'delete', mailbox: 'INBOX', uids: [7, 8] });
    expect(entries.find(e => e.accountId === 'b1')).toMatchObject({ op: 'delete', mailbox: 'INBOX', uids: [3] });

    expect(useMailStore.getState().emails.map(e => e.uid)).toEqual([9]);
    expect(mockDeleteEmail).toHaveBeenCalledTimes(3);
    expect(mockDeleteEmail).toHaveBeenCalledWith(A, 7, 'INBOX');
    expect(mockDeleteEmail).toHaveBeenCalledWith(A, 8, 'INBOX');
    expect(mockDeleteEmail).toHaveBeenCalledWith(B, 3, 'INBOX');

    // One record per message, addressed by where it went.
    expect(outcomes).toHaveLength(3);
    expect(outcomes.find(o => o.uid === 7)).toMatchObject({ accountId: 'a1', mailbox: 'INBOX', trash: 'Trash', trashUid: 107, messageId: 'm7@mock' });
    expect(outcomes.find(o => o.uid === 3)).toMatchObject({ accountId: 'b1', mailbox: 'INBOX', trash: 'Trash', trashUid: 103 });
    expect(outcomes.find(o => o.uid === 8).row).toMatchObject({ uid: 8 });

    // Every landed delete forgets its own entry.
    expect(mockClearOps).toHaveBeenCalledWith(expect.objectContaining({ op: 'delete', accountId: 'a1', mailbox: 'INBOX', uids: [7, 8] }));
    expect(mockClearOps).toHaveBeenCalledWith(expect.objectContaining({ op: 'delete', accountId: 'b1', mailbox: 'INBOX', uids: [3] }));

    // One undo slot for the whole call.
    expect(useMailStore.getState().undo).toMatchObject({ labelKey: 'undo.deleted', labelParams: { count: 3 } });
  });

  it('a message the server refuses stays journalled and hidden; the rest land', async () => {
    prime({ emails: [row(7), row(8), row(9)] });
    mockDeleteEmail.mockImplementation(async (_a, uid) => {
      if (uid === 8) throw new Error('socket closed');
      return { trash: 'Trash', trashUid: 100 + uid };
    });

    const { outcomes } = await deleteMessages([{ key: 7 }, { key: 8 }]);

    expect(outcomes.map(o => o.uid)).toEqual([7]);
    expect(mockNoteOpFailure).toHaveBeenCalledWith(
      { op: 'delete', accountId: 'a1', mailbox: 'INBOX', uid: 8 }, expect.stringContaining('socket closed'),
    );
    expect(mockClearOps).toHaveBeenCalledWith(expect.objectContaining({ op: 'delete', accountId: 'a1', mailbox: 'INBOX', uids: [7] }));
    expect(mockClearOps).not.toHaveBeenCalledWith(expect.objectContaining({ uids: expect.arrayContaining([8]) }));
    expect(useMailStore.getState().emails.map(e => e.uid)).toEqual([9]);
    expect(useMailStore.getState().deleteTombstones.has('a1|INBOX|8')).toBe(true);
    expect(useMailStore.getState().error).toBeNull();
  });
});

describe('deleteMessages, Review Focus 6: a Graph message whose id cannot be resolved', () => {
  it('puts the row back, says so, and journals nothing', async () => {
    prime({ accounts: [G], emails: [row(7), row(8)] });
    mockResolveGraphMessageId.mockResolvedValue(null);

    const { outcomes } = await deleteMessages([{ key: 7 }]);

    expect(outcomes).toEqual([]);
    expect(mockQueueOp).not.toHaveBeenCalled();
    expect(mockGraphDeleteMessage).not.toHaveBeenCalled();
    expect(useMailStore.getState().deleteTombstones.has('g1|INBOX|7')).toBe(false);
    expect(useMailStore.getState().emails.map(e => e.uid).sort()).toEqual([7, 8]);
    expect(useMailStore.getState().error).toBeTruthy();
  });
});

describe('deleteMessages, Review Focus 4: a delete while an undo is moving the message back', () => {
  it('waits for the undo, then deletes the uid the message has now, not the one the undo retired', async () => {
    prime({ emails: [row(7), row(8)] });
    await deleteMessages([{ key: 7 }]);
    expect(mockDeleteEmail).toHaveBeenLastCalledWith(A, 7, 'INBOX');
    const move = deferred();
    mockMoveEmails.mockReturnValueOnce(move.promise);

    const undone = useMailStore.getState().runUndo();
    await vi.waitFor(() => expect(mockMoveEmails).toHaveBeenCalled());
    const again = deleteMessages([{ key: 7 }]);
    // Nothing is journalled or sent while the move is on the wire.
    await new Promise((r) => setTimeout(r, 20));
    expect(mockQueueOp).toHaveBeenCalledTimes(1);
    expect(mockDeleteEmail).toHaveBeenCalledTimes(1);
    move.resolve({ success: true, moved: 1, newUids: [41] });
    await undone;
    await again;

    expect(mockDeleteEmail).toHaveBeenCalledTimes(2);
    expect(mockDeleteEmail).toHaveBeenLastCalledWith(A, 41, 'INBOX');
    expect(mockQueueOp).toHaveBeenLastCalledWith(expect.objectContaining({ uids: [41] }));
    expect(useMailStore.getState().emails.map(e => e.uid)).toEqual([8]);
  });
});

describe('deleteMessages, Review Focus 5: offline', () => {
  it('journals the group once, hides the rows, and sends nothing', async () => {
    netOnline = false;
    prime({ emails: [row(7), row(8), row(9)] });

    const { outcomes } = await deleteMessages([{ key: 7 }, { key: 8 }]);

    expect(outcomes).toEqual([]);
    expect(mockQueueOp).toHaveBeenCalledTimes(1);
    expect(mockQueueOp).toHaveBeenCalledWith(expect.objectContaining({ op: 'delete', accountId: 'a1', mailbox: 'INBOX', uids: [7, 8] }));
    expect(mockDeleteEmail).not.toHaveBeenCalled();
    expect(mockClearOps).not.toHaveBeenCalled();
    expect(mockNoteOpFailure).not.toHaveBeenCalled();
    expect(useMailStore.getState().emails.map(e => e.uid)).toEqual([9]);
    expect(useMailStore.getState().deleteTombstones.has('a1|INBOX|7')).toBe(true);
    expect(useMailStore.getState().deleteTombstones.has('a1|INBOX|8')).toBe(true);
  });
});
