// The undo slot as the mutation workflows fill it.
//
// One slot, and the workflows are the only things that write it: a move, a
// delete that landed in Trash, a star, a read-state change. What each slot's
// `run` actually does is the whole point — a label with no working reverse is
// worse than no offer at all — so every case below runs it and asserts the
// server call it made.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { serverUids } from '../../../stores/slices/serverUids';

if (!globalThis.window) {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
} else {
  globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
}

const mockMoveEmails = vi.fn();
const mockDeleteEmail = vi.fn();
const mockUpdateEmailFlags = vi.fn().mockResolvedValue({ success: true, written: [] });
const mockFindMessageId = vi.fn();
const mockGetLocalIndexEntry = vi.fn();
const mockAppendLocalIndex = vi.fn().mockResolvedValue(undefined);
const mockQueueOp = vi.fn().mockResolvedValue(1);
const mockClearOps = vi.fn().mockResolvedValue(undefined);
const mockSaveEmailHeaders = vi.fn().mockResolvedValue(undefined);
const mockRefreshCurrentView = vi.fn().mockResolvedValue(undefined);

let netOnline = true;

vi.mock('../../db', () => ({
  getLocalEmailLight: vi.fn().mockResolvedValue(null),
  getSavedEmailIds: vi.fn().mockResolvedValue(new Set()),
  getEmailHeadersMeta: vi.fn().mockResolvedValue(null),
  getEmailHeadersPartial: vi.fn().mockResolvedValue({ emails: [], totalEmails: 0 }),
  getArchivedEmailIds: vi.fn().mockResolvedValue(new Set()),
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

vi.mock('../../api', () => ({
  vaultApplyFlags: vi.fn().mockResolvedValue({ renamed: 0, mirrored: 0, index_patched: 0, sidecars_patched: 0 }),
  fetchEmailLight: vi.fn().mockResolvedValue(null),
  updateEmailFlags: (...a) => mockUpdateEmailFlags(...a),
  graphSetRead: vi.fn().mockResolvedValue(undefined),
  graphSetFlagged: vi.fn().mockResolvedValue(undefined),
  graphMoveEmails: vi.fn().mockResolvedValue(undefined),
  graphDeleteMessage: vi.fn().mockResolvedValue(undefined),
  deleteEmail: (...a) => mockDeleteEmail(...a),
  moveEmails: (...a) => mockMoveEmails(...a),
  findMessageId: (...a) => mockFindMessageId(...a),
  appendLocalIndex: (...a) => mockAppendLocalIndex(...a),
  removeFromLocalIndex: vi.fn().mockResolvedValue(undefined),
}));

// The unified view's reload verb. Real, it refetches every account — here it
// only has to prove which reload the undo chose.
vi.mock('../refreshAccounts', () => ({
  refreshCurrentView: (...a) => mockRefreshCurrentView(...a),
  refreshAllAccounts: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../authUtils', () => ({
  hasValidCredentials: () => true,
  ensureFreshToken: (a) => Promise.resolve(a),
  resolveServerAccount: (id, account) => Promise.resolve({ ok: true, account }),
}));

vi.mock('../../attachmentUtils', () => ({ hasRealAttachments: () => false }));

vi.mock('../../graphConfig', () => ({
  isGraphAccount: (a) => a?.oauth2Transport === 'graph',
  graphMessageToEmail: (m) => m,
  normalizeGraphFolderName: (n) => n,
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
      setUnreadForAccount: vi.fn(),
    }),
  },
}));

vi.mock('../../safeStorage', () => ({
  safeStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}));

const { useMailStore } = await import('../../../stores/mailStore');
const { invalidateChatAndThreadCaches } = await import('../../../stores/slices/messageListSlice');
const { markAnswered, setDeleteUndo } = await import('../messageMutations');

const ACCOUNT = { id: 'a1', email: 'a1@x' };

const row = (uid, extra = {}) => ({
  uid, messageId: `m${uid}@mock`, subject: `m${uid}`, flags: [],
  from: { address: 'them@x' }, date: '2026-09-01T10:00:00Z', ...extra,
});

function primeStore({ emails, selected = [], activeMailbox = 'INBOX', accounts = [ACCOUNT], mailboxScope = null } = {}) {
  useMailStore.setState({
    accounts,
    activeAccountId: ACCOUNT.id,
    activeMailbox,
    unifiedInbox: false,
    unifiedFolder: null,
    mailboxScope,
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

beforeEach(() => {
  vi.clearAllMocks();
  netOnline = true;
  mockMoveEmails.mockResolvedValue({ success: true, moved: 2, newUids: [41, 42] });
  mockDeleteEmail.mockResolvedValue({ trash: 'Trash', trashUid: 5 });
  mockFindMessageId.mockResolvedValue({ found: [], searched: 1, failed: 0, complete: true });
  mockGetLocalIndexEntry.mockResolvedValue({ uid: 7, subject: 'm7' });
  mockUpdateEmailFlags.mockResolvedValue({ success: true, written: [] });
});

describe('undo after a move', () => {
  it('offers the move back, addressed by the COPYUID the server reported', async () => {
    primeStore({ emails: [row(7), row(8)] });

    await useMailStore.getState().moveEmails([7, 8], 'Archive');

    const { undo } = useMailStore.getState();
    expect(undo).toMatchObject({
      labelKey: 'undo.moved',
      labelParams: { count: 2, folder: 'Archive' },
      canUndo: true,
    });

    mockMoveEmails.mockClear();
    await useMailStore.getState().runUndo();

    // Back the way it came: the destination uids, out of the destination.
    expect(mockMoveEmails).toHaveBeenCalledWith(ACCOUNT, [41, 42], 'Archive', 'INBOX');
    expect(useMailStore.getState().loadEmails).toHaveBeenCalled();
  });

  it('finds the moved copies by Message-ID when the server reported no COPYUID', async () => {
    mockMoveEmails.mockResolvedValue({ success: true, moved: 1, newUids: null });
    // The sweep answers with every folder holding this Message-ID; only the
    // destination's copy is the one this move made.
    mockFindMessageId.mockResolvedValue({
      found: [{ mailbox: 'Archive', uid: 9 }, { mailbox: 'INBOX', uid: 1 }],
      searched: 2, failed: 0, complete: true,
    });
    primeStore({ emails: [row(7)] });

    await useMailStore.getState().moveEmails([7], 'Archive');
    expect(useMailStore.getState().undo.labelParams).toEqual({ count: 1, folder: 'Archive' });

    mockMoveEmails.mockClear();
    await useMailStore.getState().runUndo();

    expect(mockFindMessageId).toHaveBeenCalledWith(ACCOUNT, 'm7@mock', { stopOnFirst: false });
    expect(mockMoveEmails).toHaveBeenCalledWith(ACCOUNT, [9], 'Archive', 'INBOX');
  });

  it('reports a failure when nothing in the destination can be addressed', async () => {
    mockMoveEmails.mockResolvedValue({ success: true, moved: 1, newUids: null });
    primeStore({ emails: [row(7)] });

    await useMailStore.getState().moveEmails([7], 'Archive');
    mockMoveEmails.mockClear();

    await expect(useMailStore.getState().runUndo()).resolves.toBe(false);
    // Never a guessed uid — a wrong one moves somebody else's message.
    expect(mockMoveEmails).not.toHaveBeenCalled();
    expect(useMailStore.getState().error).toBeTruthy();
  });

  it('undoing a move that never left the journal just forgets it', async () => {
    netOnline = false;
    primeStore({ emails: [row(7)] });

    await useMailStore.getState().moveEmails([7], 'Archive');
    expect(useMailStore.getState().undo.labelKey).toBe('undo.moved');

    await useMailStore.getState().runUndo();

    // Offline the journal entry IS the move; dropping it is the whole undo.
    expect(mockClearOps).toHaveBeenCalledWith({
      op: 'move', accountId: 'a1', mailbox: 'INBOX', uids: [7], arg: { target: 'Archive' },
    });
    expect(mockMoveEmails).not.toHaveBeenCalled();
  });

  it('names the leaf folder, not its full path', async () => {
    primeStore({ emails: [row(7)] });
    await useMailStore.getState().moveEmails([7], 'INBOX.Archive.2026');
    expect(useMailStore.getState().undo.labelParams.folder).toBe('2026');
  });
});

describe('undo after a delete', () => {
  it('offers a delete-to-Trash back, and restoring lifts the custody stamp', async () => {
    primeStore({ emails: [row(7)] });

    await useMailStore.getState().deleteEmailFromServer(7);

    expect(useMailStore.getState().undo).toMatchObject({
      labelKey: 'undo.deleted', labelParams: { count: 1 }, canUndo: true,
    });
    expect(useMailStore.getState().deleteTombstones.has('a1|INBOX|7')).toBe(true);

    // The DELETE reloads too (applyServerRemoval), so a bare toHaveBeenCalled
    // below would be satisfied by that one and pin nothing about the undo.
    useMailStore.getState().loadEmails.mockClear();

    await useMailStore.getState().runUndo();

    expect(mockMoveEmails).toHaveBeenCalledWith(ACCOUNT, [5], 'Trash', 'INBOX');
    // The vault copy was stamped "we deleted the server copy" a moment ago.
    expect(mockAppendLocalIndex).toHaveBeenLastCalledWith('a1', 'INBOX',
      [expect.objectContaining({ serverDeleted: false })]);
    expect(useMailStore.getState().deleteTombstones.has('a1|INBOX|7')).toBe(false);
    // Lifting the tombstone only stops the row being HIDDEN — the optimistic
    // update took it out of `emails` entirely, so nothing is back on screen
    // until the folder is reloaded. One folder in view, so that is loadEmails,
    // and the unified refresh must not fire for it.
    expect(useMailStore.getState().loadEmails).toHaveBeenCalledTimes(1);
    expect(mockRefreshCurrentView).not.toHaveBeenCalled();
  });

  it('repaints the list that is on screen when the view spans mailboxes', async () => {
    // All Inboxes: `activeMailbox` is the literal 'UNIFIED', which no account
    // can SELECT. Reloading through loadEmails() put the message back on the
    // server and then reloaded a folder that does not exist — the row never
    // came back, so the undo read as a no-op.
    primeStore({
      emails: [row(7, { _accountId: 'a1', _mailbox: 'INBOX' })],
      activeMailbox: 'UNIFIED',
    });

    await useMailStore.getState().deleteEmailFromServer('a1:INBOX:7');
    expect(useMailStore.getState().undo).toMatchObject({
      labelKey: 'undo.deleted', canUndo: true,
    });

    await useMailStore.getState().runUndo();

    expect(mockMoveEmails).toHaveBeenCalledWith(ACCOUNT, [5], 'Trash', 'INBOX');
    expect(mockRefreshCurrentView).toHaveBeenCalled();
    expect(useMailStore.getState().loadEmails).not.toHaveBeenCalled();
  });

  it('offers the undo when the server reported no COPYUID, addressing the copy by Message-ID', async () => {
    // A server without UIDPLUS names no destination uid. The message is in
    // Trash and perfectly restorable, but the slot used to say "Deleted 1
    // message permanently" and offer nothing — the one word that must never be
    // wrong about mail, over a message sitting in the bin.
    mockDeleteEmail.mockResolvedValue({ trash: 'Trash', trashUid: null });
    mockFindMessageId.mockResolvedValue({
      found: [{ mailbox: 'Trash', uid: 88 }, { mailbox: 'INBOX', uid: 7 }],
      searched: 2, failed: 0, complete: true,
    });
    primeStore({ emails: [row(7)] });

    await useMailStore.getState().deleteEmailFromServer(7);

    expect(useMailStore.getState().undo).toMatchObject({
      labelKey: 'undo.deleted', labelParams: { count: 1 }, canUndo: true,
    });

    await useMailStore.getState().runUndo();

    expect(mockFindMessageId).toHaveBeenCalledWith(ACCOUNT, 'm7@mock', { stopOnFirst: false });
    // Only the hit in Trash — the same id also sits in INBOX's own copy, and
    // moving that one back would be moving somebody else's message.
    expect(mockMoveEmails).toHaveBeenCalledWith(ACCOUNT, [88], 'Trash', 'INBOX');
  });

  it('refuses to guess when no COPYUID and no copy in Trash can be found', async () => {
    mockDeleteEmail.mockResolvedValue({ trash: 'Trash', trashUid: null });
    mockFindMessageId.mockResolvedValue({ found: [], searched: 1, failed: 0, complete: true });
    primeStore({ emails: [row(7)] });

    await useMailStore.getState().deleteEmailFromServer(7);
    mockMoveEmails.mockClear();

    await expect(useMailStore.getState().runUndo()).resolves.toBe(false);
    expect(mockMoveEmails).not.toHaveBeenCalled();
    expect(useMailStore.getState().error).toBeTruthy();
  });

  it('says a permanent delete cannot be undone rather than offering a button', async () => {
    mockDeleteEmail.mockResolvedValue({ trash: null, trashUid: null });
    primeStore({ emails: [row(7)] });

    await useMailStore.getState().deleteEmailFromServer(7);

    const { undo } = useMailStore.getState();
    expect(undo).toMatchObject({ labelKey: 'undo.deletedPermanently', canUndo: false });
    expect(undo.run).toBeUndefined();
    await expect(useMailStore.getState().runUndo()).resolves.toBe(false);
  });

  it('a bulk delete restores every message that reached Trash, one move per folder', async () => {
    mockDeleteEmail
      .mockResolvedValueOnce({ trash: 'Trash', trashUid: 5 })
      .mockResolvedValueOnce({ trash: 'Trash', trashUid: 6 });
    primeStore({ emails: [row(7), row(8)], selected: [7, 8] });

    await useMailStore.getState().deleteSelectedFromServer();
    expect(useMailStore.getState().undo).toMatchObject({
      labelKey: 'undo.deleted', labelParams: { count: 2 },
    });

    await useMailStore.getState().runUndo();

    expect(mockMoveEmails).toHaveBeenCalledTimes(1);
    expect(mockMoveEmails).toHaveBeenCalledWith(ACCOUNT, [5, 6], 'Trash', 'INBOX');
  });

  it('a thread-row delete fills one slot for the whole row, not one per copy', async () => {
    mockDeleteEmail
      .mockResolvedValueOnce({ trash: 'Trash', trashUid: 51 })
      .mockResolvedValueOnce({ trash: 'Trash', trashUid: 52 })
      .mockResolvedValueOnce({ trash: 'Trash', trashUid: 53 });
    primeStore({ emails: [row(7), row(8), row(9)] });

    // Exactly what RowActionMenuItems' delete loop does: one call per
    // server-backed copy of the row, each skipping its own refresh.
    const outcomes = [];
    for (const uid of [7, 8, 9]) {
      outcomes.push(await useMailStore.getState()
        .deleteEmailFromServer(uid, { skipRefresh: true, mailboxOverride: 'INBOX' }));
    }
    // A slot per message would describe one and strand four.
    expect(useMailStore.getState().undo).toBeNull();

    await setDeleteUndo(outcomes.filter(Boolean));

    expect(useMailStore.getState().undo).toMatchObject({
      labelKey: 'undo.deleted', labelParams: { count: 3 }, canUndo: true,
    });

    mockMoveEmails.mockClear();
    await useMailStore.getState().runUndo();

    expect(mockMoveEmails).toHaveBeenCalledTimes(1);
    expect(mockMoveEmails).toHaveBeenCalledWith(ACCOUNT, [51, 52, 53], 'Trash', 'INBOX');
  });

  it('a mixed bulk delete offers back exactly what reached Trash', async () => {
    mockDeleteEmail
      .mockResolvedValueOnce({ trash: 'Trash', trashUid: 5 })
      .mockResolvedValueOnce({ trash: null, trashUid: null })
      .mockResolvedValueOnce({ trash: 'Trash', trashUid: 6 });
    primeStore({ emails: [row(7), row(8), row(9)], selected: [7, 8, 9] });

    await useMailStore.getState().deleteSelectedFromServer();

    expect(useMailStore.getState().undo).toMatchObject({
      labelKey: 'undo.deleted', labelParams: { count: 2 }, canUndo: true,
    });

    mockMoveEmails.mockClear();
    await useMailStore.getState().runUndo();

    expect(mockMoveEmails).toHaveBeenCalledTimes(1);
    expect(mockMoveEmails).toHaveBeenCalledWith(ACCOUNT, [5, 6], 'Trash', 'INBOX');
  });

  it('a bulk delete that emptied Trash offers no undo button', async () => {
    mockDeleteEmail.mockResolvedValue({ trash: null, trashUid: null });
    primeStore({ emails: [row(7), row(8)], selected: [7, 8] });

    await useMailStore.getState().deleteSelectedFromServer();

    expect(useMailStore.getState().undo).toMatchObject({
      labelKey: 'undo.deletedPermanently', labelParams: { count: 2 }, canUndo: false,
    });
  });

  it('restores across accounts with one move per (account, folder) pair', async () => {
    // All Inboxes spans accounts, so one undo can owe two servers a move back.
    const A2 = { id: 'a2', email: 'a2@x' };
    mockDeleteEmail
      .mockResolvedValueOnce({ trash: 'Trash', trashUid: 5 })
      .mockResolvedValueOnce({ trash: 'Trash', trashUid: 6 });
    primeStore({
      accounts: [ACCOUNT, A2],
      activeMailbox: 'UNIFIED',
      emails: [
        row(7, { _accountId: 'a1', _mailbox: 'INBOX' }),
        row(8, { _accountId: 'a2', _mailbox: 'INBOX' }),
      ],
      selected: ['a1:INBOX:7', 'a2:INBOX:8'],
    });

    await useMailStore.getState().deleteSelectedFromServer();
    expect(useMailStore.getState().undo).toMatchObject({
      labelKey: 'undo.deleted', labelParams: { count: 2 },
    });

    mockMoveEmails.mockClear();
    await useMailStore.getState().runUndo();

    // Two accounts, so two moves — never one call carrying both accounts' uids,
    // which would address a2's message against a1's server.
    expect(mockMoveEmails).toHaveBeenCalledTimes(2);
    expect(mockMoveEmails).toHaveBeenCalledWith(ACCOUNT, [5], 'Trash', 'INBOX');
    expect(mockMoveEmails).toHaveBeenCalledWith(A2, [6], 'Trash', 'INBOX');
  });

  it('repaints a branch listing through loadEmails, not the unified refresh', async () => {
    // The third view shape: `spansMailboxes` is true for a branch listing too,
    // but its `activeMailbox` is a REAL folder (the branch root), and
    // loadEmails knows how to reload it (loadSubtree). Only the literal
    // 'UNIFIED' needs the other verb.
    primeStore({
      emails: [row(7, { _accountId: 'a1', _mailbox: 'INBOX' })],
      mailboxScope: { root: 'INBOX' },
    });

    await useMailStore.getState().deleteEmailFromServer('a1:INBOX:7');
    useMailStore.getState().loadEmails.mockClear();

    await useMailStore.getState().runUndo();

    expect(mockMoveEmails).toHaveBeenCalledWith(ACCOUNT, [5], 'Trash', 'INBOX');
    expect(useMailStore.getState().loadEmails).toHaveBeenCalledTimes(1);
    expect(mockRefreshCurrentView).not.toHaveBeenCalled();
  });
});

describe('undo after a flag change', () => {
  it('offers the star back, and taking it sets no new slot', async () => {
    primeStore({ emails: [row(7)] });

    await useMailStore.getState().toggleFlagged(7);
    expect(useMailStore.getState().undo).toMatchObject({
      labelKey: 'undo.starred', labelParams: { count: 1 }, canUndo: true,
    });

    await useMailStore.getState().runUndo();

    expect(mockUpdateEmailFlags).toHaveBeenLastCalledWith(ACCOUNT, 7, ['\\Flagged'], 'remove', 'INBOX');
    // The reverse is not itself an action to undo — otherwise Cmd+Z ping-pongs.
    expect(useMailStore.getState().undo).toBeNull();
  });

  it('offers a read-state change back', async () => {
    primeStore({ emails: [row(7)] });

    await useMailStore.getState().markEmailReadStatus(7, true);
    expect(useMailStore.getState().undo).toMatchObject({
      labelKey: 'undo.markedRead', labelParams: { count: 1 },
    });

    await useMailStore.getState().runUndo();

    expect(mockUpdateEmailFlags).toHaveBeenLastCalledWith(ACCOUNT, 7, ['\\Seen'], 'remove', 'INBOX');
  });

  it('offers back only the messages the change actually touched', async () => {
    // Row 8 is already read: marking both read changes one message, so the
    // offer must be for one — undoing all of them would mark 8 unread, which
    // this action never did.
    primeStore({ emails: [row(7), row(8, { flags: ['\\Seen'] })], selected: [7, 8] });

    await useMailStore.getState().markSelectedAsRead();

    expect(useMailStore.getState().undo).toMatchObject({
      labelKey: 'undo.markedRead', labelParams: { count: 1 },
    });

    mockUpdateEmailFlags.mockClear();
    await useMailStore.getState().runUndo();

    expect(mockUpdateEmailFlags.mock.calls.map(c => c[1])).toEqual([7]);
    expect(mockUpdateEmailFlags).toHaveBeenCalledWith(ACCOUNT, 7, ['\\Seen'], 'remove', 'INBOX');
  });

  it('offers nothing when the change was a no-op on every row', async () => {
    primeStore({ emails: [row(7, { flags: ['\\Seen'] })], selected: [7] });

    await useMailStore.getState().markSelectedAsRead();

    expect(useMailStore.getState().undo).toBeNull();
  });

  it('does not offer to undo the \\Answered stamp a reply writes', async () => {
    primeStore({ emails: [row(7)] });

    await markAnswered(row(7, { _accountId: 'a1', _mailbox: 'INBOX' }));

    // The user asked to send, not to set a flag.
    expect(mockUpdateEmailFlags).toHaveBeenCalledWith(ACCOUNT, 7, ['\\Answered'], 'add', 'INBOX');
    expect(useMailStore.getState().undo).toBeNull();
  });
});
