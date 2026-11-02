// The undo slot as the mutation workflows fill it.
//
// One slot, and the workflows are the only things that write it: a move, a
// delete that landed in Trash, a star, a read-state change. What each slot's
// `run` actually does is the whole point — a label with no working reverse is
// worse than no offer at all — so every case below runs it and asserts the
// server call it made.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeDeleteQueueSubmit } from './fakeDeleteQueue.js';
import { serverUids } from '../../../stores/slices/serverUids';
import { remember as memoRemember, peek as memoPeek, forget as memoForget } from '../../headerMemo';

if (!globalThis.window) {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
} else {
  globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
}

const mockMoveEmails = vi.fn();
const mockDeleteEmail = vi.fn();
// The daemon's delete queue, answering through the per-message mock above.
const mockDeleteQueueSubmit = vi.fn((...a) => fakeDeleteQueueSubmit((...b) => mockDeleteEmail(...b), ...a));
const mockUpdateEmailFlags = vi.fn().mockResolvedValue({ success: true, written: [] });
const mockFindMessageId = vi.fn();
const mockGetLocalIndexEntry = vi.fn();
const mockAppendLocalIndex = vi.fn().mockResolvedValue(undefined);
const mockQueueOp = vi.fn().mockResolvedValue(1);
const mockClearOps = vi.fn().mockResolvedValue(undefined);
const mockSaveEmailHeaders = vi.fn().mockResolvedValue(undefined);
const mockRefreshCurrentView = vi.fn().mockResolvedValue(undefined);
const mockVaultRebindUids = vi.fn().mockResolvedValue({ rebound: [] });
// The daemon's undo of a delete (`messages.restore`). It finds the Trash copy,
// moves it back, re-keys the header cache and the vault, and drops the bin
// copy; the app only learns which old uid became which.
const mockRestoreMessages = vi.fn();
// Every item back on the server, under the uid `newUids` names (null: the
// server did not say), in the reply shape the daemon answers.
const backAs = (newUids = {}) => async (items) => ({
  restored: items.map(i => ({ accountId: i.accountId, mailbox: i.mailbox, uid: i.uid, newUid: newUids[`${i.accountId}|${i.uid}`] ?? newUids[i.uid] ?? null })),
  failed: [],
});
// What the app must no longer send itself for a delete undo.
const expectNoAppSideRestore = () => {
  expect(mockFindMessageId).not.toHaveBeenCalled();
  expect(mockMoveEmails).not.toHaveBeenCalled();
  expect(mockVaultRebindUids).not.toHaveBeenCalled();
  expect(mockSaveEmailHeaders).not.toHaveBeenCalled();
  expect(mockAppendLocalIndex).not.toHaveBeenCalled();
  expect(mockDaemonCall).not.toHaveBeenCalledWith('deleted.discard', expect.anything());
};
// Clears what the delete itself called, so the undo's calls stand alone.
const clearForUndo = () => {
  for (const m of [mockFindMessageId, mockMoveEmails, mockVaultRebindUids, mockSaveEmailHeaders, mockAppendLocalIndex, mockGetLocalIndexEntry, mockDaemonCall, mockRestoreMessages]) m.mockClear();
};
const item = (uid, extra = {}) => expect.objectContaining({ accountId: 'a1', mailbox: 'INBOX', uid, trash: 'Trash', ...extra });
// The server holds the restored message under its new uid only: the retired
// one answers "gone", as uid_still_present proves it in the app.
const gone = () => Object.assign(new Error('gone'), { messageGone: true });
const mockFetchEmailLight = vi.fn();
// The sidebar badge, as the settings store keeps it: absolute per account.
const unreadPerAccount = {};
const mockSetUnreadForAccount = vi.fn((id, n) => { unreadPerAccount[id] = n; });

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

vi.mock('../../api', () => ({
  vaultApplyFlags: vi.fn().mockResolvedValue({ renamed: 0, mirrored: 0, index_patched: 0, sidecars_patched: 0 }),
  fetchEmailLight: (...a) => mockFetchEmailLight(...a),
  updateEmailFlags: (...a) => mockUpdateEmailFlags(...a),
  graphSetRead: vi.fn().mockResolvedValue(undefined),
  graphSetFlagged: vi.fn().mockResolvedValue(undefined),
  graphMoveEmails: vi.fn().mockResolvedValue(undefined),
  graphDeleteMessage: vi.fn().mockResolvedValue(undefined),
  deleteEmail: (...a) => mockDeleteEmail(...a),
  deleteQueueSubmit: (...a) => mockDeleteQueueSubmit(...a),
  deleteQueueList: async () => [],
  moveEmails: (...a) => mockMoveEmails(...a),
  findMessageId: (...a) => mockFindMessageId(...a),
  appendLocalIndex: (...a) => mockAppendLocalIndex(...a),
  removeFromLocalIndex: vi.fn().mockResolvedValue(undefined),
  vaultRebindUids: (...a) => mockVaultRebindUids(...a),
  restoreMessages: (...a) => mockRestoreMessages(...a),
}));

// The daemon's deleted-mail bin.
const mockDaemonCall = vi.fn();
const nativeUnreadAnswer = async params => {
  const counts = { ...params.baseline };
  let wrote = false;
  if (params.op === 'shift') {
    for (const entry of params.entries) {
      if (entry.mailbox !== 'INBOX' || params.mode === 'unreadOnly'
        && entry.row.flags?.includes('\\Seen')) continue;
      counts[entry.accountId] = Math.max(0, (counts[entry.accountId] || 0) + params.sign);
      wrote = true;
    }
  }
  return { counts, rows: [], total: 0, wrote };
};
vi.mock('../../daemonClient', async (importOriginal) => ({
  ...(await importOriginal()),
  daemonCall: (method, params) => method === 'counts.unread'
    ? nativeUnreadAnswer(params) : mockDaemonCall(method, params),
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
      unreadPerAccount,
      setUnreadPerAccount: counts => {
        for (const id of Object.keys(unreadPerAccount)) delete unreadPerAccount[id];
        Object.assign(unreadPerAccount, counts);
      },
      setUnreadForAccount: (...a) => mockSetUnreadForAccount(...a),
    }),
  },
}));

vi.mock('../../safeStorage', () => ({
  safeStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}));

const { useMailStore } = await import('../../../stores/mailStore');
const { invalidateChatAndThreadCaches } = await import('../../../stores/slices/messageListSlice');
const { markAnswered, setDeleteUndo, undoLastAction, recoverFromBin } = await import('../messageMutations');
const { whenUnreadIdle } = await import('../../unreadCountsClient');
const { t, tErr } = await import('../../../i18n/index.js');

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
  mockVaultRebindUids.mockResolvedValue({ rebound: [] });
  mockRestoreMessages.mockImplementation(backAs());
  mockDaemonCall.mockImplementation(async (method, { ids } = {}) => (method === 'deleted.recover'
    ? { recovered: ids.map(id => ({ id })), failed: [] } : {}));
  mockFetchEmailLight.mockImplementation(async (_a, uid) => (uid === 7 ? Promise.reject(gone())
    : { uid, subject: `m${uid}`, html: '<p>body</p>', text: 'body', flags: [] }));
  for (const id of Object.keys(unreadPerAccount)) delete unreadPerAccount[id];
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
    clearForUndo();

    await expect(useMailStore.getState().runUndo()).resolves.toBe(true);

    // One daemon call does the whole undo: find the copy, move it back,
    // re-key the header cache and the vault, lift the custody stamp (the
    // vault copy was stamped "we deleted the server copy" a moment ago) and
    // drop the bin copy. The app sends none of those itself any more.
    expect(mockRestoreMessages).toHaveBeenCalledTimes(1);
    expect(mockRestoreMessages).toHaveBeenCalledWith([item(7, { trashUid: 5, messageId: 'm7@mock' })]);
    expectNoAppSideRestore();
    // The restored message has a NEW uid; 7 is retired and names nothing, so
    // its tombstone stays. Lifting it let anything still holding 7 (a header
    // cache a sync wrote back, a vault copy filed under it) paint a ghost of
    // the message next to the real one.
    expect(useMailStore.getState().deleteTombstones.has('a1|INBOX|7')).toBe(true);
    // No COPYUID for the move back here (the daemon answers `newUid: null`),
    // so the row's new uid is unknown and the folder is reloaded. One folder in view, so that is loadEmails, and the unified
    // refresh must not fire for it.
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

    expect(mockRestoreMessages).toHaveBeenCalledWith([item(7, { trashUid: 5 })]);
    expect(mockRefreshCurrentView).toHaveBeenCalled();
    expect(useMailStore.getState().loadEmails).not.toHaveBeenCalled();
  });

  it('offers the undo when the server reported no COPYUID, addressing the copy by Message-ID', async () => {
    // A server without UIDPLUS names no destination uid. The message is in
    // Trash and perfectly restorable, but the slot used to say "Deleted 1
    // message permanently" and offer nothing — the one word that must never be
    // wrong about mail, over a message sitting in the bin.
    mockDeleteEmail.mockResolvedValue({ trash: 'Trash', trashUid: null });
    primeStore({ emails: [row(7)] });

    await useMailStore.getState().deleteEmailFromServer(7);

    expect(useMailStore.getState().undo).toMatchObject({
      labelKey: 'undo.deleted', labelParams: { count: 1 }, canUndo: true,
    });
    clearForUndo();

    await expect(useMailStore.getState().runUndo()).resolves.toBe(true);

    // The daemon finds the copy by its Message-ID, in Trash only (the same id
    // also sits in INBOX's own copy, and moving that one back would be moving
    // somebody else's message): handlers/deleted.rs pins the search.
    expect(mockRestoreMessages).toHaveBeenCalledWith([item(7, { trashUid: null, messageId: 'm7@mock' })]);
    expectNoAppSideRestore();
  });

  it('refuses to guess when no COPYUID and no copy in Trash can be found', async () => {
    mockDeleteEmail.mockResolvedValue({ trash: 'Trash', trashUid: null });
    // Nothing in Trash and no bin copy: the daemon says so in catalog words.
    mockRestoreMessages.mockResolvedValueOnce({ restored: [], failed: [{ accountId: 'a1', mailbox: 'INBOX', uid: 7, error: 'deletedBin.goneFromTrash' }] });
    primeStore({ emails: [row(7)] });

    await useMailStore.getState().deleteEmailFromServer(7);
    clearForUndo();

    await expect(useMailStore.getState().runUndo()).resolves.toBe(false);
    expectNoAppSideRestore();
    expect(useMailStore.getState().error).toBe(t('undo.failed', { err: tErr('deletedBin.goneFromTrash') }));
    // Hidden again: it is not back.
    expect(useMailStore.getState().sortedEmails.map(e => e.uid)).toEqual([]);
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

  it('undoes a permanent delete from the copy the deleted-mail bin kept', async () => {
    mockDeleteEmail.mockResolvedValue({ trash: null, trashUid: null, binId: 'b7' });
    primeStore({ emails: [row(7)] });

    await useMailStore.getState().deleteEmailFromServer(7);
    expect(useMailStore.getState().undo).toMatchObject({ labelKey: 'undo.deletedKept', labelParams: { count: 1 }, canUndo: true });
    useMailStore.getState().loadEmails.mockClear();

    await expect(useMailStore.getState().runUndo()).resolves.toBe(true);
    expect(mockDaemonCall).toHaveBeenCalledWith('deleted.recover', { ids: ['b7'], target: 'server' });
    expect(useMailStore.getState().loadEmails).toHaveBeenCalledTimes(1);
    // Spent: Cmd+Z has nothing more to bring back.
    mockDaemonCall.mockClear();
    await expect(undoLastAction()).resolves.toBe(false);
    expect(mockDaemonCall).not.toHaveBeenCalled();
  });

  it('recovering locally shows the message again under the uid the delete hid', async () => {
    mockDeleteEmail.mockResolvedValue({ trash: null, trashUid: null, binId: 'b7' });
    primeStore({ emails: [row(7)] });
    await useMailStore.getState().deleteEmailFromServer(7);
    expect(useMailStore.getState().deleteTombstones.has('a1|INBOX|7')).toBe(true);
    mockDaemonCall.mockResolvedValueOnce({ recovered: [{ id: 'b7', accountId: 'a1', mailbox: 'INBOX', uid: 7 }], failed: [] });

    await recoverFromBin(['b7'], 'local');

    expect(mockDaemonCall).toHaveBeenCalledWith('deleted.recover', { ids: ['b7'], target: 'local' });
    expect(useMailStore.getState().deleteTombstones.has('a1|INBOX|7')).toBe(false);
  });

  // A JMAP server recover answers the uid the delete tombstoned when the
  // email still existed (a label put back keeps its ledger uid), so the
  // tombstone must lift for a server recover too.
  it('a server recover that answers the tombstoned uid shows the message again', async () => {
    mockDeleteEmail.mockResolvedValue({ trash: null, trashUid: null, binId: 'b7' });
    primeStore({ emails: [row(7)] });
    await useMailStore.getState().deleteEmailFromServer(7);
    expect(useMailStore.getState().deleteTombstones.has('a1|INBOX|7')).toBe(true);
    mockDaemonCall.mockResolvedValueOnce({ recovered: [{ id: 'b7', accountId: 'a1', mailbox: 'INBOX', uid: 7 }], failed: [] });

    await recoverFromBin(['b7'], 'server');

    expect(mockDaemonCall).toHaveBeenCalledWith('deleted.recover', { ids: ['b7'], target: 'server' });
    expect(useMailStore.getState().deleteTombstones.has('a1|INBOX|7')).toBe(false);
  });

  it('Cmd+Z after the slot is gone brings the last delete back from the bin, once', async () => {
    mockDeleteEmail.mockResolvedValue({ trash: 'Trash', trashUid: 5, binId: 'b7' });
    primeStore({ emails: [row(7)] });
    await useMailStore.getState().deleteEmailFromServer(7);
    // A later action took the slot, and was undone itself.
    useMailStore.getState().clearUndo();

    await expect(undoLastAction()).resolves.toBe(true);
    expect(mockDaemonCall).toHaveBeenCalledWith('deleted.recover', { ids: ['b7'], target: 'server' });
    expect(mockMoveEmails).not.toHaveBeenCalled();
    expect(mockRestoreMessages).not.toHaveBeenCalled();
    mockDaemonCall.mockClear();
    await expect(undoLastAction()).resolves.toBe(false);
    expect(mockDaemonCall).not.toHaveBeenCalled();
  });

  it('Cmd+Z that fails on a JMAP error says it in catalog words, not the raw code', async () => {
    mockDeleteEmail.mockResolvedValue({ trash: 'Trash', trashUid: 5, binId: 'b7' });
    primeStore({ emails: [row(7)] });
    await useMailStore.getState().deleteEmailFromServer(7);
    useMailStore.getState().clearUndo();
    mockDaemonCall.mockRejectedValueOnce(new Error('E_JMAP_NO_TRASH: no trash mailbox'));

    await expect(undoLastAction()).resolves.toBe(false);

    const { error } = useMailStore.getState();
    expect(error).toBe(t('undo.failed', { err: tErr('E_JMAP_NO_TRASH: no trash mailbox') }));
    expect(error).not.toContain('E_JMAP');
  });

  // A second Cmd+Z while the slot's restore is on the wire: the slot is spent
  // the moment the first one runs, so the second reaches for the bin. It must
  // wait for the restore, or `deleted.recover` APPENDs the bin copy beside the
  // one the MOVE just put back.
  it('a second Cmd+Z during the restore waits for it and never recovers the same bin copy', async () => {
    mockDeleteEmail.mockResolvedValue({ trash: 'Trash', trashUid: 5, binId: 'b7' });
    primeStore({ emails: [row(7)] });
    await useMailStore.getState().deleteEmailFromServer(7);
    clearForUndo();
    let release;
    mockRestoreMessages.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));

    const first = undoLastAction();
    await vi.waitFor(() => expect(mockRestoreMessages).toHaveBeenCalled());
    const second = undoLastAction();
    await new Promise((r) => setTimeout(r, 20));
    const recoveredMeanwhile = mockDaemonCall.mock.calls.some(([m]) => m === 'deleted.recover');
    // Released whatever happened, so no later case waits on this restore.
    release({ restored: [{ accountId: 'a1', mailbox: 'INBOX', uid: 7, newUid: 41 }], failed: [] });
    expect(recoveredMeanwhile).toBe(false);

    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(false);
    expect(mockDaemonCall).not.toHaveBeenCalledWith('deleted.recover', expect.anything());
  });

  // What the restore could not put back stays in the bin, and the next Cmd+Z
  // reaches it there once the restore is over.
  it('a Cmd+Z after a failed restore recovers the bin copy the restore left', async () => {
    mockDeleteEmail.mockResolvedValue({ trash: 'Trash', trashUid: 5, binId: 'b7' });
    mockRestoreMessages.mockResolvedValueOnce({ restored: [], failed: [{ accountId: 'a1', mailbox: 'INBOX', uid: 7, error: 'deletedBin.recoverFailed' }] });
    primeStore({ emails: [row(7)] });
    await useMailStore.getState().deleteEmailFromServer(7);

    await expect(undoLastAction()).resolves.toBe(false);
    await expect(undoLastAction()).resolves.toBe(true);
    expect(mockDaemonCall).toHaveBeenCalledWith('deleted.recover', { ids: ['b7'], target: 'server' });
  });

  it('Cmd+Z runs the slot while it holds the delete, and the restored message leaves the bin', async () => {
    mockDeleteEmail.mockResolvedValue({ trash: 'Trash', trashUid: 5, binId: 'b7' });
    mockRestoreMessages.mockImplementation(backAs({ 7: 41 }));
    primeStore({ emails: [row(7)] });
    await useMailStore.getState().deleteEmailFromServer(7);
    clearForUndo();

    await expect(undoLastAction()).resolves.toBe(true);
    // The bin id travels with the item: back on the server from Trash, the
    // daemon drops its bin copy, which would put a second one there.
    expect(mockRestoreMessages).toHaveBeenCalledWith([item(7, { trashUid: 5, binId: 'b7' })]);
    expectNoAppSideRestore();
    expect(mockDaemonCall).not.toHaveBeenCalledWith('deleted.recover', expect.anything());
    // Spent: Cmd+Z has nothing more to bring back from the bin either.
    await expect(undoLastAction()).resolves.toBe(false);
    expect(mockDaemonCall).not.toHaveBeenCalledWith('deleted.recover', expect.anything());
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

    clearForUndo();
    await useMailStore.getState().runUndo();

    // One daemon call for the whole undo; the daemon sends one MOVE per
    // (account, Trash, folder) group (handlers/deleted.rs pins that).
    expect(mockRestoreMessages).toHaveBeenCalledTimes(1);
    expect(mockRestoreMessages).toHaveBeenCalledWith([item(7, { trashUid: 5 }), item(8, { trashUid: 6 })]);
    expectNoAppSideRestore();
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

    clearForUndo();
    await useMailStore.getState().runUndo();

    expect(mockRestoreMessages).toHaveBeenCalledTimes(1);
    expect(mockRestoreMessages).toHaveBeenCalledWith([item(7, { trashUid: 51 }), item(8, { trashUid: 52 }), item(9, { trashUid: 53 })]);
    expectNoAppSideRestore();
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

    clearForUndo();
    await useMailStore.getState().runUndo();

    // Only what reached Trash is asked back; 8 was deleted for good.
    expect(mockRestoreMessages).toHaveBeenCalledTimes(1);
    expect(mockRestoreMessages).toHaveBeenCalledWith([item(7, { trashUid: 5 }), item(9, { trashUid: 6 })]);
    expectNoAppSideRestore();
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

    clearForUndo();
    await useMailStore.getState().runUndo();

    // Each item names its own account: the daemon groups by (account, Trash,
    // folder), so a2's message is never addressed against a1's server.
    expect(mockRestoreMessages).toHaveBeenCalledTimes(1);
    expect(mockRestoreMessages).toHaveBeenCalledWith([
      item(7, { accountId: 'a1', trashUid: 5 }),
      item(8, { accountId: 'a2', trashUid: 6 }),
    ]);
    expectNoAppSideRestore();
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

    expect(mockRestoreMessages).toHaveBeenCalledWith([item(7, { trashUid: 5 })]);
    expect(useMailStore.getState().loadEmails).toHaveBeenCalledTimes(1);
    expect(mockRefreshCurrentView).not.toHaveBeenCalled();
  });
});

// Rokas' reports: the undo waited for the server before the row came back,
// and delete -> undo -> delete left the message in All Inboxes as well as in
// Trash. The row now comes back first; the move follows and re-keys it.
describe('undo puts the row back first, then the server follows', () => {
  const deferred = () => {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
  };
  const uids = () => useMailStore.getState().sortedEmails.map(e => e.uid).sort((a, b) => a - b);

  it('the row is back before the move answers, and then carries its new uid', async () => {
    primeStore({ emails: [row(7, { _nativeIdentity: { accountId: 'a1', mailbox: 'INBOX', uidValidity: 1, originHash: 'original' } }), row(8)] });
    await useMailStore.getState().deleteEmailFromServer(7);
    expect(useMailStore.getState().totalEmails).toBe(1);
    useMailStore.getState().loadEmails.mockClear();
    clearForUndo();
    const move = deferred();
    mockRestoreMessages.mockReturnValueOnce(move.promise);

    const undone = useMailStore.getState().runUndo();
    await vi.waitFor(() => expect(mockRestoreMessages).toHaveBeenCalled());

    expect(uids()).toEqual([7, 8]);
    expect(useMailStore.getState().totalEmails).toBe(2);

    useMailStore.getState().setEmailsSelected([useMailStore.getState().emails.find(e => e.uid === 7)], true);
    expect(useMailStore.getState().selectedEmailSnapshots.get(7).nativeIdentity.uidValidity).toBe(1);
    move.resolve({ restored: [{ accountId: 'a1', mailbox: 'INBOX', uid: 7, newUid: 41 }], failed: [] });
    await expect(undone).resolves.toBe(true);

    expect(uids()).toEqual([8, 41]);
    expect(useMailStore.getState().emails.find(e => e.uid === 41)._nativeIdentity).toBeUndefined();
    expect(useMailStore.getState().selectedEmailSnapshots.has(7)).toBe(false);
    expect(useMailStore.getState().selectedEmailSnapshots.get(41)).toBeNull();
    // Filed under the new uid, the retired one pruned, by the daemon
    // (handlers/deleted.rs: the header cache carries the new uid): the app
    // writes no header cache of its own.
    expectNoAppSideRestore();
    expect(useMailStore.getState().deleteTombstones.has('a1|INBOX|7')).toBe(true);
    // Nothing left to reload: the row on screen is already the right one.
    expect(useMailStore.getState().loadEmails).not.toHaveBeenCalled();
    expect(mockRefreshCurrentView).not.toHaveBeenCalled();
  });

  // The memo of a mailbox you left is stamped by counts (total, cached, modseq).
  // Undo swaps a uid for another and keeps every count, so a memo taken before
  // the delete matched the cache after the undo and painted the retired uid,
  // which its own tombstone then hid: the message was on the server and in the
  // cache and never on the list (Windows e2e, connected-delete-undo).
  it('drops the in-memory header memo of the mailbox whose uid it re-keyed', async () => {
    primeStore({ emails: [row(7), row(8)] });
    memoRemember('a1', 'INBOX', [row(7), row(8)], { totalEmails: 2, totalCached: 2, highestModseq: 5, uidValidity: 1 });
    memoRemember('a1', 'Archive', [row(1)], { totalEmails: 1, totalCached: 1, highestModseq: 5, uidValidity: 1 });
    await useMailStore.getState().deleteEmailFromServer(7);
    mockRestoreMessages.mockImplementationOnce(backAs({ 7: 41 }));

    await expect(useMailStore.getState().runUndo()).resolves.toBe(true);

    expect(memoPeek('a1', 'INBOX')).toBeNull();
    expect(memoPeek('a1', 'Archive')).not.toBeNull();
    memoForget('a1');
  });

  // EmailList memoises its rows on a fingerprint of size, end uids and
  // `_flagSeq`. A uid changing mid-list moves none of those, so the list kept
  // the old row, which the retired uid's tombstone then hid: the message was
  // back in the store and missing from the screen (caught by the e2e spec).
  it('tells the list to redraw when the restored row takes its new uid', async () => {
    primeStore({ emails: [
      row(6, { date: '2026-09-03T10:00:00Z' }),
      row(7, { date: '2026-09-02T10:00:00Z' }),
      row(8, { date: '2026-09-01T10:00:00Z' }),
    ] });
    await useMailStore.getState().deleteEmailFromServer(7);
    const move = deferred();
    mockRestoreMessages.mockReturnValueOnce(move.promise);

    const undone = useMailStore.getState().runUndo();
    await vi.waitFor(() => expect(mockRestoreMessages).toHaveBeenCalled());
    const seq = useMailStore.getState()._flagSeq;

    move.resolve(await backAs({ 7: 41 })([{ accountId: 'a1', mailbox: 'INBOX', uid: 7 }]));
    await undone;

    expect(useMailStore.getState()._flagSeq).toBeGreaterThan(seq);
    expect(useMailStore.getState().getChatEmails().map(e => e.uid)).toEqual([6, 41, 8]);
  });

  // The natural next action after Undo is to click the row that came back.
  // Its MOVE is still on the wire, so the row still carries the retired uid:
  // fetched as it stands, the server says "gone" and the row is pruned.
  it('a row opened while the move is on the wire opens under its new uid, and stays', async () => {
    primeStore({ emails: [row(7), row(8)] });
    await useMailStore.getState().deleteEmailFromServer(7);
    const move = deferred();
    mockRestoreMessages.mockReturnValueOnce(move.promise);

    const undone = useMailStore.getState().runUndo();
    await vi.waitFor(() => expect(mockRestoreMessages).toHaveBeenCalled());
    const opening = useMailStore.getState().selectEmail(7);
    move.resolve(await backAs({ 7: 41 })([{ accountId: 'a1', mailbox: 'INBOX', uid: 7 }]));
    await undone;
    await opening;

    expect(mockFetchEmailLight).not.toHaveBeenCalledWith(ACCOUNT, 7, 'INBOX', 'a1');
    expect(mockFetchEmailLight).toHaveBeenCalledWith(ACCOUNT, 41, 'INBOX', 'a1');
    expect(useMailStore.getState().selectedEmailId).toBe(41);
    expect(useMailStore.getState().selectedEmail?.uid).toBe(41);
    expect(uids()).toEqual([8, 41]);
    expect(useMailStore.getState().totalEmails).toBe(2);
  });

  it('a mark-read and a move issued while the move is on the wire reach the new uid', async () => {
    primeStore({ emails: [row(7), row(8)] });
    await useMailStore.getState().deleteEmailFromServer(7);
    const move = deferred();
    mockRestoreMessages.mockReturnValueOnce(move.promise);

    const undone = useMailStore.getState().runUndo();
    await vi.waitFor(() => expect(mockRestoreMessages).toHaveBeenCalled());
    const marked = useMailStore.getState().markEmailReadStatus(7, true);
    move.resolve(await backAs({ 7: 41 })([{ accountId: 'a1', mailbox: 'INBOX', uid: 7 }]));
    await undone;
    await marked;

    expect(mockUpdateEmailFlags).toHaveBeenLastCalledWith(ACCOUNT, 41, ['\\Seen'], 'add', 'INBOX');
    expect(useMailStore.getState().emails.find(e => e.uid === 41)?.flags).toContain('\\Seen');

    await useMailStore.getState().moveEmails([7], 'Archive');
    expect(mockMoveEmails).toHaveBeenLastCalledWith(ACCOUNT, [41], 'INBOX', 'Archive');
  });

  // Without COPYUID the copies are found by Message-ID, and a message the
  // search cannot find stayed in Trash: it must not be left on screen as
  // though it were back (the daemon stamps custody only for what it moved).
  it('keeps on screen only the messages the daemon put back', async () => {
    mockDeleteEmail.mockResolvedValue({ trash: 'Trash', trashUid: null });
    mockRestoreMessages.mockResolvedValueOnce({
      restored: [{ accountId: 'a1', mailbox: 'INBOX', uid: 7, newUid: null }],
      failed: [{ accountId: 'a1', mailbox: 'INBOX', uid: 8, error: 'deletedBin.goneFromTrash' }],
    });
    primeStore({ emails: [row(7), row(8), row(9)], selected: [7, 8] });
    await useMailStore.getState().deleteSelectedFromServer();
    useMailStore.getState().loadEmails.mockClear();
    clearForUndo();

    // Some of it came back: the undo did not fail.
    await expect(useMailStore.getState().runUndo()).resolves.toBe(true);

    expect(mockRestoreMessages).toHaveBeenCalledWith([item(7, { trashUid: null, messageId: 'm7@mock' }), item(8, { trashUid: null, messageId: 'm8@mock' })]);
    expectNoAppSideRestore();
    // 7 is back under a uid only the reload learns (its old one stays
    // retired); 8 stayed in Trash and stays off the list.
    expect(useMailStore.getState().loadEmails).toHaveBeenCalledTimes(1);
    expect(useMailStore.getState().sortedEmails.map(e => e.uid)).not.toContain(8);
    expect(useMailStore.getState().deleteTombstones.has('a1|INBOX|8')).toBe(true);
  });

  it('takes the row back out when the server refuses the move, in catalog words', async () => {
    primeStore({ emails: [row(7), row(8)] });
    await useMailStore.getState().deleteEmailFromServer(7);
    mockRestoreMessages.mockResolvedValueOnce({ restored: [], failed: [{ accountId: 'a1', mailbox: 'INBOX', uid: 7, error: 'deletedBin.recoverFailed' }] });

    await expect(useMailStore.getState().runUndo()).resolves.toBe(false);

    expect(uids()).toEqual([8]);
    expect(useMailStore.getState().totalEmails).toBe(1);
    expect(useMailStore.getState().error).toBe(t('undo.failed', { err: tErr('deletedBin.recoverFailed') }));
  });

  // The call itself failed (the daemon went away, or the app stopped
  // waiting): the server may or may not have the messages back, so the rows
  // go out again and the folder reloads to show what is true.
  it('takes the row back out and reloads when the restore call itself fails', async () => {
    primeStore({ emails: [row(7), row(8)] });
    await useMailStore.getState().deleteEmailFromServer(7);
    useMailStore.getState().loadEmails.mockClear();
    mockRestoreMessages.mockRejectedValueOnce(new Error('no route'));

    await expect(useMailStore.getState().runUndo()).resolves.toBe(false);

    expect(uids()).toEqual([8]);
    expect(useMailStore.getState().totalEmails).toBe(1);
    expect(useMailStore.getState().error).toMatch(/no route/);
    expect(useMailStore.getState().loadEmails).toHaveBeenCalledTimes(1);
  });

  it('delete, undo, delete again: no row left, and the retired uid stays tombstoned', async () => {
    mockDeleteEmail
      .mockResolvedValueOnce({ trash: 'Trash', trashUid: 5 })
      .mockResolvedValueOnce({ trash: 'Trash', trashUid: 6 });
    mockRestoreMessages.mockImplementationOnce(backAs({ 7: 41 }));
    primeStore({ emails: [row(7), row(8)] });

    await useMailStore.getState().deleteEmailFromServer(7);
    await useMailStore.getState().runUndo();
    await useMailStore.getState().deleteEmailFromServer(41);

    expect(mockDeleteEmail).toHaveBeenLastCalledWith(ACCOUNT, 41, 'INBOX');
    expect(uids()).toEqual([8]);
    const { deleteTombstones } = useMailStore.getState();
    expect(deleteTombstones.has('a1|INBOX|7')).toBe(true);
    expect(deleteTombstones.has('a1|INBOX|41')).toBe(true);
  });

  it('in All Inboxes: the same loop leaves nothing, and prunes both uids from the header cache', async () => {
    mockDeleteEmail
      .mockResolvedValueOnce({ trash: 'Trash', trashUid: 5 })
      .mockResolvedValueOnce({ trash: 'Trash', trashUid: 6 });
    mockRestoreMessages.mockImplementationOnce(backAs({ 7: 41 }));
    primeStore({
      emails: [row(7, { _accountId: 'a1', _mailbox: 'INBOX' }), row(8, { _accountId: 'a1', _mailbox: 'INBOX' })],
      activeMailbox: 'UNIFIED',
      selected: ['a1:INBOX:7'],
    });

    await useMailStore.getState().deleteSelectedFromServer();
    // The unified list is a merge of header caches: an unpruned row came
    // straight back from it, hidden only by a session tombstone.
    expect(mockSaveEmailHeaders).toHaveBeenCalledWith('a1', 'INBOX', [], null, { removedUids: [7] });

    await useMailStore.getState().runUndo();
    expect(uids()).toEqual([8, 41]);

    useMailStore.setState({ selectedEmailIds: new Set(['a1:INBOX:41']) });
    await useMailStore.getState().deleteSelectedFromServer();

    expect(mockDeleteEmail).toHaveBeenLastCalledWith(ACCOUNT, 41, 'INBOX');
    expect(uids()).toEqual([8]);
    expect(mockSaveEmailHeaders).toHaveBeenCalledWith('a1', 'INBOX', [], null, { removedUids: [41] });
    expect(mockRefreshCurrentView).not.toHaveBeenCalled();
  });

  // The row is back on screen with its old uid while the move is on the wire;
  // a delete aimed at it then must reach the message the server holds now.
  it('a delete aimed at the restored row while its move is on the wire deletes the new uid', async () => {
    mockDeleteEmail
      .mockResolvedValueOnce({ trash: 'Trash', trashUid: 5 })
      .mockResolvedValueOnce({ trash: 'Trash', trashUid: 6 });
    primeStore({ emails: [row(7), row(8)] });
    await useMailStore.getState().deleteEmailFromServer(7);
    const move = deferred();
    mockRestoreMessages.mockReturnValueOnce(move.promise);

    const undone = useMailStore.getState().runUndo();
    await vi.waitFor(() => expect(mockRestoreMessages).toHaveBeenCalled());
    const again = useMailStore.getState().deleteEmailFromServer(7);
    move.resolve(await backAs({ 7: 41 })([{ accountId: 'a1', mailbox: 'INBOX', uid: 7 }]));
    await undone;
    await again;

    expect(mockDeleteEmail).toHaveBeenLastCalledWith(ACCOUNT, 41, 'INBOX');
    expect(uids()).toEqual([8]);
  });

  it('the count and the unread badge follow the row out and back in All Inboxes', async () => {
    unreadPerAccount.a1 = 3;
    const release = deferred();
    mockDeleteEmail.mockReturnValueOnce(release.promise);
    mockRestoreMessages.mockImplementationOnce(backAs({ 7: 41 }));
    primeStore({
      emails: [
        row(7, { _accountId: 'a1', _mailbox: 'INBOX' }),
        row(8, { _accountId: 'a1', _mailbox: 'INBOX', flags: ['\\Seen'] }),
      ],
      activeMailbox: 'UNIFIED',
    });

    const pending = useMailStore.getState().deleteEmailFromServer('a1:INBOX:7');
    await vi.waitFor(() => expect(mockDeleteEmail).toHaveBeenCalled());
    // The row paints immediately; its count follows the ordered native lane.
    expect(useMailStore.getState().totalEmails).toBe(1);
    await whenUnreadIdle();
    expect(unreadPerAccount.a1).toBe(2);

    release.resolve({ trash: 'Trash', trashUid: 5 });
    await pending;
    expect(useMailStore.getState().totalEmails).toBe(1);

    await useMailStore.getState().runUndo();
    expect(useMailStore.getState().totalEmails).toBe(2);
    await whenUnreadIdle();
    expect(unreadPerAccount.a1).toBe(3);
  });

  it('re-files an archived copy under the new uid, so it shadows the restored row instead of doubling it', async () => {
    mockRestoreMessages.mockImplementationOnce(backAs({ 7: 41 }));
    primeStore({ emails: [row(7), row(8)] });
    useMailStore.setState({
      localEmails: [row(7, { source: 'local', _nativeIdentity: { accountId: 'a1', mailbox: 'INBOX', uidValidity: 1, originHash: 'old' } })],
      archivedEmailIds: new Set(['a1:INBOX:7']),
      _sortedEmailsFingerprint: '',
    });

    await useMailStore.getState().deleteEmailFromServer(7);
    clearForUndo();
    await useMailStore.getState().runUndo();

    // The daemon re-filed the vault copy and took the "we deleted the server
    // copy" stamp off it (handlers/deleted.rs pins both); the app follows
    // with its own sets and rows.
    expectNoAppSideRestore();
    expect([...useMailStore.getState().archivedEmailIds]).toEqual(['a1:INBOX:41']);
    expect(useMailStore.getState().sortedEmails.filter(e => e.subject === 'm7')).toHaveLength(1);
    expect(useMailStore.getState().localEmails.find(e => e.uid === 41)._nativeIdentity).toBeUndefined();
  });
});

describe('a flag change that fails on a JMAP error', () => {
  it('words the error in the catalog, not the raw code', async () => {
    primeStore({ emails: [row(7)] });
    mockQueueOp.mockRejectedValueOnce(new Error('E_JMAP_NO_TRASH: no trash mailbox'));

    await useMailStore.getState().markEmailReadStatus(7, true);

    const { error } = useMailStore.getState();
    expect(error).toBe(t('svc.messageMutations.couldChangeReadStatusServer', { error: tErr('E_JMAP_NO_TRASH: no trash mailbox') }));
    expect(error).not.toContain('E_JMAP');
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

  it('offers the star back after an UNstar, and taking it re-adds the flag', async () => {
    primeStore({ emails: [row(7, { flags: ['\\Flagged'] })] });

    await useMailStore.getState().toggleFlagged(7);
    expect(useMailStore.getState().undo).toMatchObject({
      labelKey: 'undo.unstarred', labelParams: { count: 1 }, canUndo: true,
    });
    expect(useMailStore.getState().sortedEmails.find(e => e.uid === 7).flags).not.toContain('\\Flagged');

    await useMailStore.getState().runUndo();

    expect(mockUpdateEmailFlags).toHaveBeenLastCalledWith(ACCOUNT, 7, ['\\Flagged'], 'add', 'INBOX');
    expect(useMailStore.getState().sortedEmails.find(e => e.uid === 7).flags).toContain('\\Flagged');
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

// A JMAP account answers the move back from Trash with the target ledger's
// uids in the order of the uids sent, and a label put back gets its old uid
// back: the ledger never drops a row. So the pairing is positional, and a
// uid that came back unchanged is neither re-keyed nor tombstoned.
describe('undo after a delete on a JMAP account', () => {
  const JMAP = { id: 'a1', email: 'a1@x', jmapSessionUrl: 'https://jmap.x/jmap/session', jmapAuth: 'bearer' };
  const uids = () => useMailStore.getState().sortedEmails.map(e => [e.subject, e.uid]).sort((a, b) => a[1] - b[1]);

  beforeEach(() => {
    mockDeleteEmail
      .mockResolvedValueOnce({ trash: 'Trash', trashUid: 10 })
      .mockResolvedValueOnce({ trash: 'Trash', trashUid: 9 });
  });

  it('keeps both rows on screen when the labels come back under their old uids', async () => {
    primeStore({ emails: [row(7), row(8)], selected: [7, 8], accounts: [JMAP] });
    useMailStore.setState({
      localEmails: [row(7, { source: 'local' }), row(8, { source: 'local' })],
      archivedEmailIds: new Set(['a1:INBOX:7', 'a1:INBOX:8']),
    });
    await useMailStore.getState().deleteSelectedFromServer();
    // The delete stamped the vault rows "we deleted the server copy".
    expect(useMailStore.getState().localEmails.map(e => e.serverDeleted)).toEqual([true, true]);
    clearForUndo();
    mockRestoreMessages.mockImplementationOnce(backAs({ 7: 7, 8: 8 }));

    await useMailStore.getState().runUndo();

    expect(mockRestoreMessages).toHaveBeenCalledWith([item(7, { trashUid: 10 }), item(8, { trashUid: 9 })]);
    expect(uids()).toEqual([['m7', 7], ['m8', 8]]);
    const { deleteTombstones } = useMailStore.getState();
    expect(deleteTombstones.has('a1|INBOX|7')).toBe(false);
    expect(deleteTombstones.has('a1|INBOX|8')).toBe(false);
    // Put back under the same uids, nothing pruned: the daemon writes the
    // rows back (handlers/deleted.rs, the JMAP restore test), the app none.
    expectNoAppSideRestore();
    // The server copy is back under the same uids: the viewer must stop saying it is gone.
    expect(useMailStore.getState().localEmails.map(e => e.serverDeleted)).toEqual([false, false]);
  });

  // The daemon pairs by position for JMAP (handlers/deleted.rs); the app
  // takes each new uid from the reply by the old uid it names, never by the
  // order of the reply.
  it('re-keys each row by the old uid the reply names, not by its order', async () => {
    primeStore({ emails: [row(7), row(8)], selected: [7, 8], accounts: [JMAP] });
    await useMailStore.getState().deleteSelectedFromServer();
    // m7 went to Trash as 10 and m8 as 9.
    mockRestoreMessages.mockResolvedValueOnce({ restored: [
      { accountId: 'a1', mailbox: 'INBOX', uid: 8, newUid: 31 },
      { accountId: 'a1', mailbox: 'INBOX', uid: 7, newUid: 30 },
    ], failed: [] });

    await useMailStore.getState().runUndo();

    expect(uids()).toEqual([['m7', 30], ['m8', 31]]);
  });
});
