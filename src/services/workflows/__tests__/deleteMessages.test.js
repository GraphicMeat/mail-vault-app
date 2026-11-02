// deleteMessages: the one app delete workflow both entry points run.
//
// deleteEmailFromServer (one message) and deleteSelectedFromServer (the
// selection) used to be two near-copies of the same loop: journal first, hide
// the rows, send, retry, reconcile. These cases pin the seam they now share,
// called directly with a list of keys, plus the three failure modes the plan's
// Review Focus assigns to it: a Graph message whose id cannot be resolved (6),
// a delete issued while an undo is still moving the message back (4), and an
// offline delete (5).
//
// The daemon owns the journal and the retries (`delete_queue.submit`): one
// submit per (account, folder), answered `landed` / `queued` / `dropped`. The
// queue's events (`delete-queue-landed`, `-changed`, `-status`) settle what a
// submit left queued; their handlers are pinned at the end (Review Focus 9).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { serverUids } from '../../../stores/slices/serverUids';

if (!globalThis.window) {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
} else {
  globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
}

const mockMoveEmails = vi.fn();
// The daemon's undo of a delete (`messages.restore`).
const mockRestoreMessages = vi.fn();
const mockDeleteEmail = vi.fn();
const mockGraphDeleteMessage = vi.fn().mockResolvedValue(undefined);
const mockQueueOp = vi.fn().mockResolvedValue(1);
const mockClearOps = vi.fn().mockResolvedValue(undefined);
const mockNoteOpFailure = vi.fn();
const mockSaveEmailHeaders = vi.fn().mockResolvedValue(undefined);
const mockResolveGraphMessageId = vi.fn();
const mockDaemonCall = vi.fn().mockResolvedValue({});
const mockSubmit = vi.fn();
const mockQueueList = vi.fn().mockResolvedValue([]);
const mockReadOps = vi.fn().mockResolvedValue([]);

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
  readOps: (...a) => mockReadOps(...a),
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
  restoreMessages: (...a) => mockRestoreMessages(...a),
  findMessageId: vi.fn().mockResolvedValue({ found: [], searched: 1, failed: 0, complete: true }),
  appendLocalIndex: vi.fn().mockResolvedValue(undefined),
  removeFromLocalIndex: vi.fn().mockResolvedValue(undefined),
  vaultRebindUids: vi.fn().mockResolvedValue({ rebound: [] }),
  deleteQueueSubmit: (...a) => mockSubmit(...a),
  deleteQueueList: (...a) => mockQueueList(...a),
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
const { deleteMessages, onDeleteQueueLanded, onDeleteQueueChanged, onDeleteQueueStatus, hideQueuedDeletes, __resetDeleteQueueForTests } = await import('../messageMutations');
const { useSettingsStore } = await import('../../../stores/settingsStore');

// What the daemon answers for a group that landed whole.
const landedAll = async ({ uids }) => ({
  landed: uids.map(uid => ({ kind: 'deleted', uid, trash: 'Trash', trashUid: 100 + Number(uid), binId: null })),
  queued: [],
  dropped: [],
});

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
  mockSubmit.mockImplementation(landedAll);
  mockQueueList.mockResolvedValue([]);
  mockGraphDeleteMessage.mockReset().mockResolvedValue(undefined);
  // What the app remembers about the queue lives in the module: each case starts clean.
  __resetDeleteQueueForTests();
  mockReadOps.mockResolvedValue([]);
});

describe('deleteMessages, one call over many keys', () => {
  it('submits once per (account, folder) before any row leaves, hides every row and files one undo', async () => {
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
    const onScreenAtSubmit = [];
    mockSubmit.mockImplementation(async (group) => {
      onScreenAtSubmit.push(useMailStore.getState().emails.length);
      return landedAll(group);
    });

    const { outcomes } = await deleteMessages([{ key: 'a1:INBOX:7' }, { key: 'a1:INBOX:8' }, { key: 'b1:INBOX:3' }]);

    // One submit per group; the daemon journals it before it sends a thing,
    // and the request is on its way before the rows go.
    expect(mockSubmit).toHaveBeenCalledTimes(2);
    expect(onScreenAtSubmit).toEqual([4, 4]);
    expect(mockSubmit).toHaveBeenCalledWith(
      { accountId: 'a1', mailbox: 'INBOX', uids: [7, 8] },
      { mode: 'auto', bin: true, arg: expect.objectContaining({ total: 2, messages: [expect.objectContaining({ uid: 7, subject: 'm7' }), expect.objectContaining({ uid: 8 })] }) },
    );
    expect(mockSubmit).toHaveBeenCalledWith({ accountId: 'b1', mailbox: 'INBOX', uids: [3] }, { mode: 'auto', bin: true, arg: {} });
    // The app keeps no journal and sends nothing itself.
    expect(mockQueueOp).not.toHaveBeenCalled();
    expect(mockClearOps).not.toHaveBeenCalled();
    expect(mockDeleteEmail).not.toHaveBeenCalled();

    expect(useMailStore.getState().emails.map(e => e.uid)).toEqual([9]);

    // One record per message, addressed by where it went.
    expect(outcomes).toHaveLength(3);
    expect(outcomes.find(o => o.uid === 7)).toMatchObject({ account: A, accountId: 'a1', mailbox: 'INBOX', trash: 'Trash', trashUid: 107, messageId: 'm7@mock' });
    expect(outcomes.find(o => o.uid === 3)).toMatchObject({ accountId: 'b1', mailbox: 'INBOX', trash: 'Trash', trashUid: 103 });
    expect(outcomes.find(o => o.uid === 8).row).toMatchObject({ uid: 8 });

    // One undo slot for the whole call.
    expect(useMailStore.getState().undo).toMatchObject({ labelKey: 'undo.deleted', labelParams: { count: 3 } });
  });

  it('a message the daemon still owes stays hidden with its tombstone; the rest land', async () => {
    prime({ emails: [row(7), row(8), row(9)] });
    mockSubmit.mockResolvedValue({ landed: [{ kind: 'deleted', uid: 7, trash: 'Trash', trashUid: 107, binId: null }], queued: [8], dropped: [] });

    const { outcomes } = await deleteMessages([{ key: 7 }, { key: 8 }]);

    expect(outcomes.map(o => o.uid)).toEqual([7]);
    expect(mockNoteOpFailure).not.toHaveBeenCalled();
    expect(useMailStore.getState().emails.map(e => e.uid)).toEqual([9]);
    expect(useMailStore.getState().deleteTombstones.has('a1|INBOX|8')).toBe(true);
    expect(useMailStore.getState().error).toBeNull();
    expect(useMailStore.getState().undo).toMatchObject({ labelParams: { count: 1 } });
  });

  it('a message already gone counts done and offers no undo for it', async () => {
    prime({ emails: [row(7), row(9)] });
    mockSubmit.mockResolvedValue({ landed: [{ kind: 'gone', uid: 7 }], queued: [], dropped: [] });

    const { outcomes } = await deleteMessages([{ key: 7 }]);

    expect(outcomes).toEqual([]);
    expect(useMailStore.getState().emails.map(e => e.uid)).toEqual([9]);
    expect(useMailStore.getState().undo).toBeNull();
  });

  it('a message refused for good comes back and says why; a cancelled one comes back quietly', async () => {
    prime({ emails: [row(7), row(8), row(9)] });
    mockSubmit.mockResolvedValue({ landed: [], queued: [], dropped: [{ uid: 7, reason: 'errors.bulkIdentityChanged' }] });

    await deleteMessages([{ key: 7 }]);

    expect(useMailStore.getState().emails.map(e => e.uid).sort()).toEqual([7, 8, 9]);
    expect(useMailStore.getState().deleteTombstones.has('a1|INBOX|7')).toBe(false);
    expect(useMailStore.getState().error).toBeTruthy();
    expect(useMailStore.getState().error).not.toMatch(/errors\./);

    useMailStore.setState({ error: null });
    mockSubmit.mockResolvedValue({ landed: [], queued: [], dropped: [{ uid: 8, reason: 'cancelled' }] });
    await deleteMessages([{ key: 8 }]);
    expect(useMailStore.getState().emails.map(e => e.uid).sort()).toEqual([7, 8, 9]);
    expect(useMailStore.getState().deleteTombstones.has('a1|INBOX|8')).toBe(false);
    expect(useMailStore.getState().error).toBeNull();
  });

  it('a submit the daemon never answers puts the rows back and says so', async () => {
    prime({ emails: [row(7), row(8)] });
    mockSubmit.mockRejectedValue(new Error('daemon unreachable'));

    await deleteMessages([{ key: 7 }]);

    expect(useMailStore.getState().emails.map(e => e.uid).sort()).toEqual([7, 8]);
    expect(useMailStore.getState().deleteTombstones.has('a1|INBOX|7')).toBe(false);
    expect(useMailStore.getState().error).toMatch(/daemon unreachable/);
  });

  it('a Graph message is deleted by the app itself, never through the queue, and a transient refusal is retried', async () => {
    prime({ accounts: [G], emails: [row(7), row(8)] });
    mockGraphDeleteMessage.mockRejectedValueOnce(new Error('graph busy'));

    await deleteMessages([{ key: 7 }]);

    expect(mockSubmit).not.toHaveBeenCalled();
    expect(mockGraphDeleteMessage).toHaveBeenCalledTimes(2);
    expect(useMailStore.getState().emails.map(e => e.uid)).toEqual([8]);
    expect(useMailStore.getState().deleteTombstones.has('g1|INBOX|7')).toBe(true);
    expect(useMailStore.getState().error).toBeNull();
  });

  it('a Graph delete refused on every try comes back and says so', async () => {
    prime({ accounts: [G], emails: [row(7), row(8)] });
    mockGraphDeleteMessage.mockRejectedValue(new Error('graph down'));

    await deleteMessages([{ key: 7 }]);

    // The first try and five retries (the same schedule as Delete everywhere's).
    expect(mockGraphDeleteMessage).toHaveBeenCalledTimes(6);
    expect(useMailStore.getState().emails.map(e => e.uid).sort()).toEqual([7, 8]);
    expect(useMailStore.getState().deleteTombstones.has('g1|INBOX|7')).toBe(false);
    expect(useMailStore.getState().error).toBe('Delete failed: graph down');
  });

  it('a reply that answers queued for a uid that landed while it waited counts it done, with no undo', async () => {
    prime({ emails: [row(7), row(8)] });
    const reply = deferred();
    mockSubmit.mockReturnValueOnce(reply.promise);
    const running = deleteMessages([{ key: 7 }]);
    await vi.waitFor(() => expect(mockSubmit).toHaveBeenCalled());
    // Another submit (or the replay worker) lands it first.
    await onDeleteQueueLanded({ accountId: 'a1', mailbox: 'INBOX', landed: [{ kind: 'deleted', uid: 7, trash: 'Trash', trashUid: 107, binId: null }] });
    reply.resolve({ landed: [], queued: [7], dropped: [] });
    const { outcomes } = await running;

    expect(outcomes).toEqual([]);
    expect(useMailStore.getState().undo).toBeNull();
    expect(useMailStore.getState().emails.map(e => e.uid)).toEqual([8]);
    // It is not owed: a later re-list has nothing of it to show again.
    const { loadEmails } = useMailStore.getState();
    loadEmails.mockClear();
    await onDeleteQueueChanged();
    expect(loadEmails).not.toHaveBeenCalled();
  });
});

describe('deleteMessages, Review Focus 6: a Graph message whose id cannot be resolved', () => {
  it('puts the row back, says so, and journals nothing', async () => {
    prime({ accounts: [G], emails: [row(7), row(8)] });
    mockResolveGraphMessageId.mockResolvedValue(null);

    const { outcomes } = await deleteMessages([{ key: 7 }]);

    expect(outcomes).toEqual([]);
    expect(mockSubmit).not.toHaveBeenCalled();
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
    expect(mockSubmit).toHaveBeenLastCalledWith(expect.objectContaining({ uids: [7] }), expect.anything());
    const move = deferred();
    mockRestoreMessages.mockReturnValueOnce(move.promise);

    const undone = useMailStore.getState().runUndo();
    await vi.waitFor(() => expect(mockRestoreMessages).toHaveBeenCalled());
    const again = deleteMessages([{ key: 7 }]);
    // Nothing is submitted while the move is on the wire.
    await new Promise((r) => setTimeout(r, 20));
    expect(mockSubmit).toHaveBeenCalledTimes(1);
    move.resolve({ restored: [{ accountId: 'a1', mailbox: 'INBOX', uid: 7, newUid: 41 }], failed: [] });
    await undone;
    await again;

    expect(mockSubmit).toHaveBeenCalledTimes(2);
    expect(mockSubmit).toHaveBeenLastCalledWith({ accountId: 'a1', mailbox: 'INBOX', uids: [41] }, expect.anything());
    expect(useMailStore.getState().emails.map(e => e.uid)).toEqual([8]);
  });
});

describe('deleteMessages, Review Focus 5: offline', () => {
  it('submits the group once (the daemon journals it and its gate holds the send), hides the rows', async () => {
    netOnline = false;
    prime({ emails: [row(7), row(8), row(9)] });
    mockSubmit.mockImplementation(async ({ uids }) => ({ landed: [], queued: uids, dropped: [] }));

    const { outcomes } = await deleteMessages([{ key: 7 }, { key: 8 }]);

    expect(outcomes).toEqual([]);
    expect(mockSubmit).toHaveBeenCalledTimes(1);
    expect(mockSubmit).toHaveBeenCalledWith({ accountId: 'a1', mailbox: 'INBOX', uids: [7, 8] }, expect.objectContaining({ mode: 'auto', bin: true }));
    expect(mockQueueOp).not.toHaveBeenCalled();
    expect(mockDeleteEmail).not.toHaveBeenCalled();
    expect(mockNoteOpFailure).not.toHaveBeenCalled();
    expect(useMailStore.getState().emails.map(e => e.uid)).toEqual([9]);
    expect(useMailStore.getState().deleteTombstones.has('a1|INBOX|7')).toBe(true);
    expect(useMailStore.getState().deleteTombstones.has('a1|INBOX|8')).toBe(true);
  });
});

// ── the delete queue's events (Review Focus 9) ──

describe('delete-queue-landed', () => {
  it('a queued delete that lands later lifts its tombstone, offers its undo and reloads the open folder', async () => {
    prime({ emails: [row(7), row(8)] });
    mockSubmit.mockResolvedValue({ landed: [], queued: [8], dropped: [] });
    await deleteMessages([{ key: 8 }]);
    expect(useMailStore.getState().undo).toBeNull();
    const { loadEmails } = useMailStore.getState();
    loadEmails.mockClear();

    await onDeleteQueueLanded({ accountId: 'a1', mailbox: 'INBOX', landed: [{ kind: 'deleted', uid: 8, trash: 'Trash', trashUid: 108, binId: 'bin-8' }] });

    expect(useMailStore.getState().deleteTombstones.has('a1|INBOX|8')).toBe(false);
    expect(useMailStore.getState().emails.map(e => e.uid)).toEqual([7]);
    expect(useMailStore.getState().undo).toMatchObject({ labelKey: 'undo.deleted', labelParams: { count: 1 } });
    expect(loadEmails).toHaveBeenCalledTimes(1);
    // No journal is re-derived: the daemon has already cleared the entry.
    expect(mockQueueOp).not.toHaveBeenCalled();
    expect(mockClearOps).not.toHaveBeenCalled();
  });

  it('a landing in Trash with no handle to find it by never claims a permanent delete', async () => {
    prime({ emails: [row(7)] });
    useMailStore.setState({ deleteTombstones: new Set(['a1|INBOX|44']) });

    // Queued by an earlier session: no row, no Message-ID; the server sent no COPYUID.
    await onDeleteQueueLanded({ accountId: 'a1', mailbox: 'INBOX', landed: [{ kind: 'deleted', uid: 44, trash: 'Trash', trashUid: null, binId: null }] });

    expect(useMailStore.getState().deleteTombstones.has('a1|INBOX|44')).toBe(false);
    expect(useMailStore.getState().undo).toBeNull();
  });

  // The undo slot is the user's last action. Only a delete this window
  // submitted, and still remembers, may take it, and never over a newer action.
  const MOVED = { labelKey: 'undo.moved', labelParams: { count: 1 }, run: async () => {} };
  const landed8 = { accountId: 'a1', mailbox: 'INBOX', landed: [{ kind: 'deleted', uid: 8, trash: 'Trash', trashUid: 108, binId: null }] };

  it('a landing for an entry this window never submitted lifts its tombstone but leaves the undo slot alone', async () => {
    prime({ emails: [row(7)] });
    // An earlier session's entry, or what the bulk tool's delete left owed.
    mockQueueList.mockResolvedValue([{ id: 3, op: 'delete', accountId: 'a1', mailbox: 'INBOX', uids: [8], arg: {}, attempts: 2, failures: {} }]);
    await hideQueuedDeletes();
    useMailStore.getState().setUndo(MOVED);
    const slot = useMailStore.getState().undo;

    await onDeleteQueueLanded(landed8);

    expect(useMailStore.getState().deleteTombstones.has('a1|INBOX|8')).toBe(false);
    expect(useMailStore.getState().undo).toBe(slot);
  });

  it('a second landed event for the same delete leaves the undo slot alone', async () => {
    prime({ emails: [row(7), row(8)] });
    mockSubmit.mockResolvedValue({ landed: [], queued: [8], dropped: [] });
    await deleteMessages([{ key: 8 }]);
    await onDeleteQueueLanded(landed8);
    expect(useMailStore.getState().undo).toMatchObject({ labelKey: 'undo.deleted' });
    useMailStore.getState().setUndo(MOVED);
    const slot = useMailStore.getState().undo;

    await onDeleteQueueLanded(landed8);

    expect(useMailStore.getState().undo).toBe(slot);
  });

  it('a late landing does not replace a newer action the user took meanwhile', async () => {
    prime({ emails: [row(7), row(8)] });
    mockSubmit.mockResolvedValue({ landed: [], queued: [8], dropped: [] });
    await deleteMessages([{ key: 8 }]);
    // Same millisecond or later: the move is newer than the submit.
    useMailStore.getState().setUndo(MOVED);
    const slot = useMailStore.getState().undo;

    await onDeleteQueueLanded(landed8);

    expect(useMailStore.getState().deleteTombstones.has('a1|INBOX|8')).toBe(false);
    expect(useMailStore.getState().undo).toBe(slot);
  });

  it('a landing in a folder that is not open leaves the list alone', async () => {
    prime({ emails: [row(7)] });
    useMailStore.setState({ deleteTombstones: new Set(['a1|Work|3']) });
    const { loadEmails } = useMailStore.getState();

    await onDeleteQueueLanded({ accountId: 'a1', mailbox: 'Work', landed: [{ kind: 'gone', uid: 3 }] });

    expect(useMailStore.getState().deleteTombstones.has('a1|Work|3')).toBe(false);
    expect(loadEmails).not.toHaveBeenCalled();
    expect(useMailStore.getState().undo).toBeNull();
  });

  it('a landing for a submit still being awaited is left to that submit: one undo, from its reply', async () => {
    prime({ emails: [row(7), row(8)] });
    const reply = deferred();
    mockSubmit.mockReturnValueOnce(reply.promise);
    const running = deleteMessages([{ key: 7 }]);
    await vi.waitFor(() => expect(mockSubmit).toHaveBeenCalled());

    await onDeleteQueueLanded({ accountId: 'a1', mailbox: 'INBOX', landed: [{ kind: 'deleted', uid: 7, trash: 'Trash', trashUid: 107, binId: null }] });
    expect(useMailStore.getState().undo).toBeNull();
    expect(useMailStore.getState().deleteTombstones.has('a1|INBOX|7')).toBe(true);

    reply.resolve({ landed: [{ kind: 'deleted', uid: 7, trash: 'Trash', trashUid: 107, binId: null }], queued: [], dropped: [] });
    await running;
    expect(useMailStore.getState().undo).toMatchObject({ labelParams: { count: 1 } });
  });
});

describe('delete-queue-landed after its own reply', () => {
  it('is not settled twice: the reply\'s undo for the whole batch stays', async () => {
    prime({ emails: [row(7), row(8), row(9)] });
    await deleteMessages([{ key: 7 }, { key: 8 }]);
    expect(useMailStore.getState().undo).toMatchObject({ labelParams: { count: 2 } });
    const { loadEmails } = useMailStore.getState();
    loadEmails.mockClear();

    // The event stream is not the reply's socket: its landing can come after.
    await onDeleteQueueLanded({ accountId: 'a1', mailbox: 'INBOX', landed: [{ kind: 'deleted', uid: 7, trash: 'Trash', trashUid: 107, binId: null }] });

    expect(useMailStore.getState().undo).toMatchObject({ labelParams: { count: 2 } });
    expect(loadEmails).not.toHaveBeenCalled();
  });
});

describe('delete-queue-changed', () => {
  it('re-lists the queue and shows again a row the daemon dropped without landing it', async () => {
    prime({ emails: [row(7), row(8)] });
    mockSubmit.mockResolvedValue({ landed: [], queued: [8], dropped: [] });
    await deleteMessages([{ key: 8 }]);
    // A tombstone the queue never listed (an offline Graph delete, say) is not this queue's.
    useMailStore.setState({ deleteTombstones: new Set([...useMailStore.getState().deleteTombstones, 'g1|INBOX|5']) });
    const { loadEmails } = useMailStore.getState();
    loadEmails.mockClear();

    mockQueueList.mockResolvedValue([{ id: 4, op: 'delete', accountId: 'a1', mailbox: 'INBOX', uids: [8], arg: {}, attempts: 1, failures: {} }]);
    await onDeleteQueueChanged();
    expect(useMailStore.getState().deleteTombstones.has('a1|INBOX|8')).toBe(true);
    expect(loadEmails).not.toHaveBeenCalled();

    // The worker dropped it (the account went, say): neither owed nor landed.
    mockQueueList.mockResolvedValue([]);
    await onDeleteQueueChanged();
    expect(useMailStore.getState().deleteTombstones.has('a1|INBOX|8')).toBe(false);
    expect(useMailStore.getState().deleteTombstones.has('g1|INBOX|5')).toBe(true);
    expect(loadEmails).toHaveBeenCalledTimes(1);
  });

  it('hides a row another window queued', async () => {
    prime({ emails: [row(7), row(8)] });
    mockQueueList.mockResolvedValue([{ id: 5, op: 'delete', accountId: 'a1', mailbox: 'INBOX', uids: [7], arg: {}, attempts: 0, failures: {} }]);
    await onDeleteQueueChanged();
    expect(useMailStore.getState().deleteTombstones.has('a1|INBOX|7')).toBe(true);
    expect(useMailStore.getState().sortedEmails.map(e => e.uid)).toEqual([8]);
  });
});

describe('delete-queue-changed, one read at a time', () => {
  it('a change during a re-read reads again after it, never two at once', async () => {
    prime({ emails: [row(7), row(8)] });
    const first = deferred();
    mockQueueList.mockReturnValueOnce(first.promise).mockResolvedValue([]);
    const a = onDeleteQueueChanged();
    const b = onDeleteQueueChanged();
    await new Promise((r) => setTimeout(r, 10));
    expect(mockQueueList).toHaveBeenCalledTimes(1);
    first.resolve([{ id: 1, op: 'delete', accountId: 'a1', mailbox: 'INBOX', uids: [8], arg: {}, attempts: 0, failures: {} }]);
    await Promise.all([a, b]);
    expect(mockQueueList).toHaveBeenCalledTimes(2);
  });
});

describe('delete-queue-status', () => {
  it('raises the daily reminder only when something is still owed', async () => {
    useSettingsStore.setState({ pendingActionsRemindedAt: 0 });
    useMailStore.setState({ pendingActionsReminder: null });

    expect(await onDeleteQueueStatus({ kept: 0, online: true })).toBe(false);
    expect(useMailStore.getState().pendingActionsReminder).toBeNull();

    expect(await onDeleteQueueStatus({ kept: 2, online: true })).toBe(true);
    expect(useMailStore.getState().pendingActionsReminder).toEqual({ count: 2 });

    // The 24 h guard holds for the next five-minute pass.
    useMailStore.setState({ pendingActionsReminder: null });
    expect(await onDeleteQueueStatus({ kept: 2, online: true })).toBe(false);
    expect(useMailStore.getState().pendingActionsReminder).toBeNull();
  });
});

describe('at launch', () => {
  it('hides the rows the daemon queue owes, and purges from the journal, not its delete entries', async () => {
    prime({ emails: [row(7), row(8), row(9)] });
    mockQueueList.mockResolvedValue([{ id: 1, op: 'delete', accountId: 'a1', mailbox: 'INBOX', uids: [7], arg: {}, attempts: 2, failures: {} }]);
    mockReadOps.mockResolvedValue([
      { id: 1, op: 'delete', accountId: 'a1', mailbox: 'INBOX', uids: [9], arg: {} },
      { id: 2, op: 'purge', accountId: 'a1', mailbox: 'INBOX', uids: [8], arg: { hints: [] } },
    ]);

    await hideQueuedDeletes();

    expect([...useMailStore.getState().deleteTombstones].sort()).toEqual(['a1|INBOX|7', 'a1|INBOX|8']);
    expect(mockQueueList).toHaveBeenCalledTimes(1);
  });

  it('still hides what the queue owes when the journal will not read', async () => {
    prime({ emails: [row(7), row(8)] });
    mockQueueList.mockResolvedValue([{ id: 1, op: 'delete', accountId: 'a1', mailbox: 'INBOX', uids: [7], arg: {}, attempts: 0, failures: {} }]);
    mockReadOps.mockRejectedValue(new Error('journal unreadable'));

    await hideQueuedDeletes();

    expect([...useMailStore.getState().deleteTombstones]).toEqual(['a1|INBOX|7']);
  });
});
