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
const { markAnswered } = await import('../messageMutations');

const ACCOUNT = { id: 'a1', email: 'a1@x' };

const row = (uid, extra = {}) => ({
  uid, messageId: `m${uid}@mock`, subject: `m${uid}`, flags: [],
  from: { address: 'them@x' }, date: '2026-09-01T10:00:00Z', ...extra,
});

function primeStore({ emails, selected = [], activeMailbox = 'INBOX' } = {}) {
  useMailStore.setState({
    accounts: [ACCOUNT],
    activeAccountId: ACCOUNT.id,
    activeMailbox,
    unifiedInbox: false,
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
      op: 'move', accountId: 'a1', mailbox: 'INBOX', uids: [7],
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

    await useMailStore.getState().runUndo();

    expect(mockMoveEmails).toHaveBeenCalledWith(ACCOUNT, [5], 'Trash', 'INBOX');
    // The vault copy was stamped "we deleted the server copy" a moment ago.
    expect(mockAppendLocalIndex).toHaveBeenLastCalledWith('a1', 'INBOX',
      [expect.objectContaining({ serverDeleted: false })]);
    expect(useMailStore.getState().deleteTombstones.has('a1|INBOX|7')).toBe(false);
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

  it('a bulk delete that emptied Trash offers no undo button', async () => {
    mockDeleteEmail.mockResolvedValue({ trash: null, trashUid: null });
    primeStore({ emails: [row(7), row(8)], selected: [7, 8] });

    await useMailStore.getState().deleteSelectedFromServer();

    expect(useMailStore.getState().undo).toMatchObject({
      labelKey: 'undo.deletedPermanently', labelParams: { count: 2 }, canUndo: false,
    });
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

  it('does not offer to undo the \\Answered stamp a reply writes', async () => {
    primeStore({ emails: [row(7)] });

    await markAnswered(row(7, { _accountId: 'a1', _mailbox: 'INBOX' }));

    // The user asked to send, not to set a flag.
    expect(mockUpdateEmailFlags).toHaveBeenCalledWith(ACCOUNT, 7, ['\\Answered'], 'add', 'INBOX');
    expect(useMailStore.getState().undo).toBeNull();
  });
});
