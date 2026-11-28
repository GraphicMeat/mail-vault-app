/**
 * The journal exists because every server mutation runs in the webview: the row
 * is repainted optimistically and the command is sent afterwards, so a reload,
 * a quit or a dropped link inside that window leaves the user looking at a
 * change the server never heard about.
 *
 * Replay is what closes that gap, and it has to close it for all three ops —
 * a flag and a move are as invisible to the user as a delete, and just as
 * confidently shown as done. These hold the dispatch, what gets cleared, and
 * the one failure that must NOT clear.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

if (!globalThis.window) globalThis.window = {};

const ACCOUNT = { id: 'acct1', email: 'a@example.com' };

const mockReadOps = vi.fn().mockResolvedValue([]);
const mockClearOps = vi.fn().mockResolvedValue(undefined);
const mockGetAccounts = vi.fn().mockResolvedValue([ACCOUNT]);
const mockSaveEmailHeaders = vi.fn().mockResolvedValue(undefined);
const mockDeleteQueueSubmit = vi.fn().mockResolvedValue({ landed: [], queued: [], dropped: [] });
const mockUpdateEmailFlags = vi.fn().mockResolvedValue(undefined);
const mockUpdateEmailFlagsBatch = vi.fn();
const mockSetFlagOnServer = vi.fn().mockResolvedValue(undefined);
const mockMoveEmails = vi.fn().mockResolvedValue(undefined);
const mockMarkServerDeleted = vi.fn().mockResolvedValue(true);
const mockLoadEmails = vi.fn();
const mockNoteOpFailure = vi.fn();
const mockGraphDeleteMessages = vi.fn();
const mockGraphMoveEmails = vi.fn();
const mockResolveGraphMessageId = vi.fn().mockResolvedValue(null);

vi.mock('../../db', () => ({
  readOps: (...a) => mockReadOps(...a),
  clearOps: (...a) => mockClearOps(...a),
  getAccounts: (...a) => mockGetAccounts(...a),
  saveEmailHeaders: (...a) => mockSaveEmailHeaders(...a),
  noteOpFailure: (...a) => mockNoteOpFailure(...a),
  startKeychainLoad: () => {},
  onKeychainReady: (cb) => cb(),
}));

vi.mock('../../api', () => ({
  deleteQueueSubmit: (...a) => mockDeleteQueueSubmit(...a),
  updateEmailFlags: (...a) => mockUpdateEmailFlags(...a),
  updateEmailFlagsBatch: (...a) => mockUpdateEmailFlagsBatch(...a),
  moveEmails: (...a) => mockMoveEmails(...a),
  graphDeleteMessages: (...a) => mockGraphDeleteMessages(...a),
  graphMoveEmails: (...a) => mockGraphMoveEmails(...a),
}));
vi.mock('../../cacheManager', () => ({ resolveGraphMessageId: (...a) => mockResolveGraphMessageId(...a) }));

vi.mock('../../authUtils', () => ({ ensureFreshToken: async (a) => a }));
vi.mock('../../graphConfig', () => ({ isGraphAccount: (a) => a?.oauth2Transport === 'graph' }));

const mockReplayPurge = vi.fn();
const mockQueueLanded = vi.fn().mockResolvedValue(undefined);
const mockQueueChanged = vi.fn().mockResolvedValue(undefined);
const mockQueueStatus = vi.fn().mockResolvedValue(false);
const mockListeners = new Map();
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (name, cb) => { mockListeners.set(name, cb); return () => mockListeners.delete(name); },
}));
const mockHideQueued = vi.fn().mockResolvedValue(undefined);
const mockShowQueued = vi.fn().mockResolvedValue(undefined);
vi.mock('../messageMutations', async (importOriginal) => ({
  ...(await importOriginal()),
  markServerDeleted: (...a) => mockMarkServerDeleted(...a),
  _setFlagOnServer: (...a) => mockSetFlagOnServer(...a),
  replayPurge: (...a) => mockReplayPurge(...a),
  hideQueuedDeletes: (...a) => mockHideQueued(...a),
  showQueuedRows: (...a) => mockShowQueued(...a),
  onDeleteQueueLanded: (...a) => mockQueueLanded(...a),
  onDeleteQueueChanged: (...a) => mockQueueChanged(...a),
  onDeleteQueueStatus: (...a) => mockQueueStatus(...a),
}));
const mockRemind = vi.fn().mockResolvedValue(false);
vi.mock('../pendingActionsReminder', () => ({ remindOfUnfinished: (...a) => mockRemind(...a) }));

const mockClearUndo = vi.fn();
const mailState = { undo: null, activeAccountId: 'acct1', activeMailbox: 'INBOX', loadEmails: (...a) => mockLoadEmails(...a), clearUndo: (...a) => mockClearUndo(...a) };
vi.mock('../../../stores/mailStore', () => ({
  useMailStore: {
    getState: () => mailState,
    setState: (patch) => Object.assign(mailState, patch),
  },
}));

// The connectivity store is the real one — `wireReplayOnReconnect` subscribes
// to it, and a hand-rolled subscribe would test the fake's semantics.
vi.mock('../../daemonClient', () => ({ daemonCall: async () => ({ online: true }) }));

import { replayOps, shouldRetryNow, wireReplayOnReconnect, wireDeleteQueueEvents } from '../replayOps';
import { UNDO_TOAST_MS } from '../../../stores/slices/undoSlice';
import { useConnectivityStore } from '../../../stores/connectivityStore';

const entry = (over) => ({ id: 1, op: 'delete', accountId: 'acct1', mailbox: 'INBOX', uids: [7], arg: {}, at: 1, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  mockReadOps.mockResolvedValue([]);
  mockGetAccounts.mockResolvedValue([ACCOUNT]);
  mockUpdateEmailFlagsBatch.mockImplementation(async (_a, uids) => ({ success: true, written: [], done: uids, skipped: [] }));
  mailState.activeAccountId = 'acct1';
  mailState.activeMailbox = 'INBOX';
  mockResolveGraphMessageId.mockResolvedValue(null);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe('replayOps', () => {
  // The daemon owns deletes end to end (src-daemon/src/delete_queue.rs): its
  // replay worker sends them, with or without a window. The JS replay must not
  // send, clear or hide them, or both would send the same delete.
  it('leaves every delete entry to the daemon and still replays the rest', async () => {
    mockReadOps.mockResolvedValue([entry(), entry({ id: 2, op: 'flag', uids: [3], arg: { flags: ['\\Seen'], action: 'add' } })]);

    const result = await replayOps();

    expect(mockDeleteQueueSubmit).not.toHaveBeenCalled();
    expect(mockMarkServerDeleted).not.toHaveBeenCalled();
    expect(mockClearOps).not.toHaveBeenCalledWith(expect.objectContaining({ op: 'delete' }));
    expect(mockShowQueued).not.toHaveBeenCalled();
    expect(mockHideQueued).toHaveBeenCalledWith([expect.objectContaining({ op: 'flag' })]);
    expect(mockUpdateEmailFlags).toHaveBeenCalledWith(ACCOUNT, 3, ['\\Seen'], 'add', 'INBOX');
    expect(result).toMatchObject({ attempted: 1, done: 1, failed: 0, kept: 0 });
    // The outcome is the only trace this leaves; the work happens before any UI.
    expect(mailState.opReplay).toMatchObject({ attempted: 1, done: 1 });
  });

  it('reads a journal that holds only deletes as an empty one: the undo offer stays, nothing is said', async () => {
    mockReadOps.mockResolvedValue([entry(), entry({ id: 2, accountId: 'vanished' })]);

    const result = await replayOps();

    expect(result).toMatchObject({ attempted: 0, kept: 0 });
    expect(mockClearUndo).not.toHaveBeenCalled();
    expect(mockClearOps).not.toHaveBeenCalled();
    expect(mockRemind).not.toHaveBeenCalled();
  });

  it('replays a flag against the server and clears it', async () => {
    mockReadOps.mockResolvedValue([entry({ op: 'flag', uids: [3], arg: { flags: ['\\Seen'], action: 'add' } })]);

    await replayOps();

    expect(mockUpdateEmailFlags).toHaveBeenCalledWith(ACCOUNT, 3, ['\\Seen'], 'add', 'INBOX');
    expect(mockClearOps).toHaveBeenCalledWith({ id: 1, op: 'flag', accountId: 'acct1', mailbox: 'INBOX', uids: [3], arg: { flags: ['\\Seen'], action: 'add' } });
    // A flag removes no uid, so nothing is pruned — but the row on screen still
    // paints the old state, so the open folder is reloaded.
    expect(mockSaveEmailHeaders).not.toHaveBeenCalled();
    expect(mockLoadEmails).toHaveBeenCalled();
  });

  it('replays a move and prunes the source mailbox, which no longer holds the uid', async () => {
    mockReadOps.mockResolvedValue([entry({ op: 'move', uids: [5], arg: { target: 'Archive' } })]);

    await replayOps();

    expect(mockMoveEmails).toHaveBeenCalledWith(ACCOUNT, [5], 'INBOX', 'Archive');
    expect(mockClearOps).toHaveBeenCalledWith({ id: 1, op: 'move', accountId: 'acct1', mailbox: 'INBOX', uids: [5], arg: { target: 'Archive' } });
    expect(mockSaveEmailHeaders).toHaveBeenCalledWith('acct1', 'INBOX', [], null, { removedUids: [5] });
    // A move is not this app deleting the server copy — the message still exists.
    expect(mockMarkServerDeleted).not.toHaveBeenCalled();
  });

  // A failed op is not a dropped op. The journal is the user's confirmed
  // intent, and the row is already gone from the list — draining the entry on
  // failure left the server holding a message the app had shown as deleted,
  // with nothing anywhere to finish the job. It stays queued; Settings is
  // where a user cancels one that has been failing for too long.
  it('keeps an entry whose op failed, whatever the reason, and records why', async () => {
    mockReadOps.mockResolvedValue([entry({ op: 'move', uids: [7], arg: { target: 'Archive' } })]);
    mockMoveEmails.mockRejectedValueOnce(new Error('Password missing for account'));

    const creds = await replayOps();

    expect(mockClearOps).not.toHaveBeenCalled();
    expect(creds).toMatchObject({ attempted: 1, done: 0, failed: 1, kept: 1 });

    vi.clearAllMocks();
    mockReadOps.mockResolvedValue([entry({ op: 'move', uids: [7], arg: { target: 'Archive' } })]);
    mockMoveEmails.mockRejectedValueOnce(new Error('UID 7 not found'));

    const other = await replayOps();
    // Still owed after a replay: the daily reminder decides whether to say so.
    expect(mockRemind).toHaveBeenCalledWith(1);

    expect(mockClearOps).not.toHaveBeenCalled();
    expect(other).toMatchObject({ failed: 1, kept: 1 });
    expect(mockNoteOpFailure).toHaveBeenCalledWith(
      { op: 'move', accountId: 'acct1', mailbox: 'INBOX', uid: 7 },
      expect.stringContaining('UID 7 not found'),
    );
  });

  // An offline move's undo works by forgetting its journal entry. Once this
  // has read the journal the entry is going to the server whatever the undo
  // does, so the offer has to come down before the first op is sent — or the
  // user is shown an undo that worked and then quietly unworked itself.
  it('withdraws the undo offer before it sends anything', async () => {
    mockReadOps.mockResolvedValue([entry({ op: 'move', uids: [5], arg: { target: 'Archive' } })]);

    await replayOps();

    expect(mockClearUndo).toHaveBeenCalledTimes(1);
    expect(mockClearUndo.mock.invocationCallOrder[0]).toBeLessThan(mockMoveEmails.mock.invocationCallOrder[0]);
  });

  it('leaves the undo slot alone when there is nothing to replay', async () => {
    mockReadOps.mockResolvedValue([]);

    await replayOps();

    expect(mockClearUndo).not.toHaveBeenCalled();
  });

  it('drops an entry whose account is gone rather than carrying it forever', async () => {
    const gone = entry({ op: 'move', accountId: 'vanished', arg: { target: 'Archive' } });
    mockReadOps.mockResolvedValue([gone]);

    await replayOps();

    expect(mockMoveEmails).not.toHaveBeenCalled();
    expect(mockClearOps).toHaveBeenCalledWith({ id: 1, op: 'move', accountId: 'vanished', mailbox: 'INBOX', uids: [7], arg: { target: 'Archive' } });
    expect(mockShowQueued).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'vanished', uids: [7] }));
  });

  it('hides the rows every owed purge names before sending anything', async () => {
    const ops = [entry({ op: 'purge', uids: [7], arg: { hints: [{ uid: 7 }] } })];
    mockReadOps.mockResolvedValue(ops);
    mockReplayPurge.mockResolvedValue({ landed: [7], kept: [], error: null });
    await replayOps();
    expect(mockHideQueued).toHaveBeenCalledWith(ops);
    expect(mockHideQueued.mock.invocationCallOrder[0]).toBeLessThan(mockReplayPurge.mock.invocationCallOrder[0]);
  });

  it('replays a delete everywhere as one run, clears what landed and keeps the rest', async () => {
    const purge = entry({ op: 'purge', uids: [7, 8], arg: { hints: [{ uid: 7 }, { uid: 8 }] } });
    mockReadOps.mockResolvedValue([purge]);
    mockReplayPurge.mockResolvedValue({ landed: [7], kept: [8], error: 'NO try later' });

    const result = await replayOps();

    expect(mockReplayPurge).toHaveBeenCalledWith(purge);
    expect(mockDeleteQueueSubmit).not.toHaveBeenCalled();
    expect(mockClearOps).toHaveBeenCalledWith({ id: 1, op: 'purge', accountId: 'acct1', mailbox: 'INBOX', uids: [7], arg: purge.arg });
    expect(mockNoteOpFailure).toHaveBeenCalledWith({ op: 'purge', accountId: 'acct1', mailbox: 'INBOX', uid: 8 }, 'NO try later');
    expect(result).toMatchObject({ attempted: 2, done: 1, kept: 1 });
    expect(mockRemind).toHaveBeenCalledWith(1);
  });

  it('takes a delete everywhere the daemon refuses for good off the queue and shows its row', async () => {
    const purge = entry({ op: 'purge', uids: [7, 8], arg: { hints: [{ uid: 7 }, { uid: 8 }] } });
    mockReadOps.mockResolvedValue([purge]);
    mockReplayPurge.mockResolvedValue({ landed: [], kept: [8], dropped: [{ uid: 7, error: 'errors.bulkIdentityChanged' }], error: 'NO try later' });

    const result = await replayOps();

    expect(mockClearOps).toHaveBeenCalledWith({ id: 1, op: 'purge', accountId: 'acct1', mailbox: 'INBOX', uids: [7], arg: purge.arg });
    expect(mockNoteOpFailure).toHaveBeenCalledWith({ op: 'purge', accountId: 'acct1', mailbox: 'INBOX', uid: 7 }, 'errors.bulkIdentityChanged');
    expect(mockShowQueued).toHaveBeenCalledWith(purge, [7]);
    expect(result).toMatchObject({ attempted: 2, done: 0, kept: 1 });
  });

  // A uid at or above 0xC000_0000 is a local-only mbox import filed into a
  // server folder after a Graph to IMAP switch. No server holds it, Outlook
  // answers BAD, and the entry used to be kept and retried forever.
  it('answers an import-range uid of a flag without the server and sends the rest', async () => {
    const IMPORT = 0xC0000001;
    const arg = { flags: ['\\Seen'], action: 'add' };
    mockReadOps.mockResolvedValue([entry({ op: 'flag', uids: [IMPORT, 3], arg })]);

    const result = await replayOps();

    expect(mockUpdateEmailFlags).toHaveBeenCalledTimes(1);
    expect(mockUpdateEmailFlags).toHaveBeenCalledWith(ACCOUNT, 3, ['\\Seen'], 'add', 'INBOX');
    expect(mockUpdateEmailFlagsBatch).not.toHaveBeenCalled();
    const cleared = mockClearOps.mock.calls.flatMap(c => c[0].uids);
    expect(cleared).toEqual(expect.arrayContaining([IMPORT, 3]));
    expect(result).toMatchObject({ kept: 0 });
  });

  it('answers an import-range uid of a move without the server and prunes nothing for it', async () => {
    const IMPORT = 0xC0000002;
    mockReadOps.mockResolvedValue([entry({ op: 'move', uids: [IMPORT], arg: { target: 'Archive' } })]);

    const result = await replayOps();

    expect(mockMoveEmails).not.toHaveBeenCalled();
    expect(mockClearOps).toHaveBeenCalledWith({ id: 1, op: 'move', accountId: 'acct1', mailbox: 'INBOX', uids: [IMPORT], arg: { target: 'Archive' } });
    expect(mockSaveEmailHeaders).not.toHaveBeenCalled();
    expect(result).toMatchObject({ kept: 0, failed: 0 });
  });

  it('replays a flag entry of many uids as one batch', async () => {
    const arg = { flags: ['\\Flagged'], action: 'add' };
    mockReadOps.mockResolvedValue([entry({ op: 'flag', uids: [3, 4, 5], arg })]);

    const result = await replayOps();

    expect(mockUpdateEmailFlagsBatch).toHaveBeenCalledTimes(1);
    expect(mockUpdateEmailFlagsBatch).toHaveBeenCalledWith(ACCOUNT, [3, 4, 5], ['\\Flagged'], 'add', 'INBOX');
    expect(mockUpdateEmailFlags).not.toHaveBeenCalled();
    expect(mockClearOps).toHaveBeenCalledWith({ id: 1, op: 'flag', accountId: 'acct1', mailbox: 'INBOX', uids: [3, 4, 5], arg });
    expect(result).toMatchObject({ attempted: 3, done: 3, kept: 0 });
  });

  // The batch answers per uid: `done` landed, `skipped` is import-range and
  // never sent. A uid in neither did not land and stays owed, as on the live
  // path, or the next replay has nothing left to send for it.
  it('clears only the uids a flag batch answered, and keeps the rest owed', async () => {
    const arg = { flags: ['\\Seen'], action: 'add' };
    mockReadOps.mockResolvedValue([entry({ op: 'flag', uids: [3, 4, 5], arg })]);
    mockUpdateEmailFlagsBatch.mockResolvedValueOnce({ success: true, done: [3], skipped: [4] });

    const result = await replayOps();

    expect(mockClearOps).toHaveBeenCalledTimes(1);
    expect(mockClearOps).toHaveBeenCalledWith({ id: 1, op: 'flag', accountId: 'acct1', mailbox: 'INBOX', uids: [3, 4], arg });
    expect(mockNoteOpFailure).toHaveBeenCalledWith({ op: 'flag', accountId: 'acct1', mailbox: 'INBOX', uid: 5 }, expect.any(String));
    expect(result).toMatchObject({ attempted: 3, done: 2, failed: 1, kept: 1 });
  });

  it('clears by the entry\'s id, so another entry with the same arg keeps its uids', async () => {
    const arg = { flags: ['\\Seen'], action: 'add' };
    mockReadOps.mockResolvedValue([entry({ id: 41, op: 'flag', uids: [3, 4], arg })]);

    await replayOps();

    expect(mockClearOps).toHaveBeenCalledWith({ id: 41, op: 'flag', accountId: 'acct1', mailbox: 'INBOX', uids: [3, 4], arg });
  });

  it('keeps every uid of a refused flag batch', async () => {
    const arg = { flags: ['\\Flagged'], action: 'add' };
    mockReadOps.mockResolvedValue([entry({ op: 'flag', uids: [3, 4], arg })]);
    mockUpdateEmailFlagsBatch.mockRejectedValueOnce(new Error('NO busy'));

    const result = await replayOps();

    expect(mockClearOps).not.toHaveBeenCalled();
    expect(mockNoteOpFailure).toHaveBeenCalledWith({ op: 'flag', accountId: 'acct1', mailbox: 'INBOX', uid: 4 }, expect.stringContaining('NO busy'));
    expect(result).toMatchObject({ attempted: 2, failed: 2, kept: 2 });
  });

  describe('a Graph account', () => {
    const GRAPH = { id: 'acct1', email: 'a@example.com', oauth2Transport: 'graph' };
    beforeEach(() => mockGetAccounts.mockResolvedValue([GRAPH]));

    it('replays a Graph flag entry through the Graph write and clears it', async () => {
      const arg = { flags: ['\\Seen'], action: 'add', graph: true };
      mockReadOps.mockResolvedValue([entry({ op: 'flag', uids: [3, 4], arg })]);

      const result = await replayOps();

      expect(mockSetFlagOnServer).toHaveBeenCalledWith(GRAPH, 'acct1', 'INBOX', 3, ['\\Seen'], 'add');
      expect(mockSetFlagOnServer).toHaveBeenCalledWith(GRAPH, 'acct1', 'INBOX', 4, ['\\Seen'], 'add');
      expect(mockUpdateEmailFlags).not.toHaveBeenCalled();
      expect(mockClearOps).toHaveBeenCalledWith({ id: 1, op: 'flag', accountId: 'acct1', mailbox: 'INBOX', uids: [3, 4], arg });
      expect(result).toMatchObject({ done: 2, kept: 0 });
    });

    it('keeps a Graph flag that failed', async () => {
      const arg = { flags: ['\\Seen'], action: 'add', graph: true };
      mockReadOps.mockResolvedValue([entry({ op: 'flag', uids: [3], arg })]);
      mockSetFlagOnServer.mockRejectedValueOnce(new Error('429'));

      const result = await replayOps();

      expect(mockClearOps).not.toHaveBeenCalled();
      expect(result).toMatchObject({ failed: 1, kept: 1 });
    });

    it('replays a Graph delete entry as one call by its journalled ids, clears only what landed by entry id', async () => {
      const arg = { graph: true, ids: { 3: 'g3', 4: 'g4' } };
      const owed = entry({ id: 4, op: 'delete', uids: [3, 4, 5], arg });
      mockReadOps.mockResolvedValue([owed]);
      // Not journalled with an id: resolved now.
      mockResolveGraphMessageId.mockImplementation(async (_a, _m, uid) => (uid === 5 ? 'g5' : null));
      mockGraphDeleteMessages.mockResolvedValue({ done: [3, 5], failed: [{ uid: 4, error: '429' }], binIds: {} });

      const result = await replayOps();

      expect(mockGraphDeleteMessages).toHaveBeenCalledTimes(1);
      expect(mockGraphDeleteMessages).toHaveBeenCalledWith(GRAPH, {
        accountId: 'acct1', mailbox: 'INBOX',
        items: [{ uid: 3, messageId: 'g3' }, { uid: 4, messageId: 'g4' }, { uid: 5, messageId: 'g5' }],
      });
      expect(mockDeleteQueueSubmit).not.toHaveBeenCalled();
      expect(mockClearOps).toHaveBeenCalledTimes(1);
      expect(mockClearOps).toHaveBeenCalledWith({ id: 4, op: 'delete', accountId: 'acct1', mailbox: 'INBOX', uids: [3, 5], arg });
      expect(mockSaveEmailHeaders).toHaveBeenCalledWith('acct1', 'INBOX', [], null, { removedUids: [3, 5] });
      expect(mockNoteOpFailure).toHaveBeenCalledWith({ op: 'delete', accountId: 'acct1', mailbox: 'INBOX', uid: 4 }, '429');
      expect(mockLoadEmails).toHaveBeenCalled();
      expect(result).toMatchObject({ attempted: 3, done: 2, failed: 1, kept: 1 });
    });

    it('answers a Graph delete uid with no id anywhere: dropped, its row shown, never retried', async () => {
      const arg = { graph: true, ids: {} };
      const owed = entry({ id: 6, op: 'delete', uids: [3], arg });
      mockReadOps.mockResolvedValue([owed]);

      const result = await replayOps();

      expect(mockGraphDeleteMessages).not.toHaveBeenCalled();
      expect(mockClearOps).toHaveBeenCalledWith({ id: 6, op: 'delete', accountId: 'acct1', mailbox: 'INBOX', uids: [3], arg });
      expect(mockShowQueued).toHaveBeenCalledWith(owed, [3]);
      expect(result).toMatchObject({ kept: 0 });
    });

    it('keeps a young Graph delete uid whose id lookup came up empty: a relist that failed or cooled down is not proof', async () => {
      const arg = { graph: true, ids: {} };
      mockReadOps.mockResolvedValue([entry({ id: 7, op: 'delete', uids: [3], arg, at: Date.now() - 60_000 })]);

      const result = await replayOps();

      expect(mockGraphDeleteMessages).not.toHaveBeenCalled();
      expect(mockClearOps).not.toHaveBeenCalled();
      expect(mockShowQueued).not.toHaveBeenCalled();
      expect(result).toMatchObject({ kept: 1 });
    });

    it('keeps every uid of a Graph delete whose call failed outright', async () => {
      const arg = { graph: true, ids: { 3: 'g3' } };
      mockReadOps.mockResolvedValue([entry({ op: 'delete', uids: [3], arg })]);
      mockGraphDeleteMessages.mockRejectedValue(new Error('daemon gone'));

      const result = await replayOps();

      expect(mockClearOps).not.toHaveBeenCalled();
      expect(mockNoteOpFailure).toHaveBeenCalledWith({ op: 'delete', accountId: 'acct1', mailbox: 'INBOX', uid: 3 }, 'daemon gone');
      expect(result).toMatchObject({ failed: 1, kept: 1 });
    });

    it('replays a Graph move entry as one call: done and gone are answered and pruned, the failed one kept', async () => {
      const arg = { target: 'Archive', graph: true, ids: { 3: 'g3', 4: 'g4', 5: 'g5' }, targetFolderId: 'gf' };
      mockReadOps.mockResolvedValue([entry({ id: 8, op: 'move', uids: [3, 4, 5], arg })]);
      mockGraphMoveEmails.mockResolvedValue({ success: true, moved: 1, done: ['g3'], gone: ['g4'], failed: [{ messageId: 'g5', error: 'ErrorMoveCopyFailed' }] });

      const result = await replayOps();

      expect(mockGraphMoveEmails).toHaveBeenCalledTimes(1);
      expect(mockGraphMoveEmails).toHaveBeenCalledWith(GRAPH, ['g3', 'g4', 'g5'], 'gf');
      expect(mockMoveEmails).not.toHaveBeenCalled();
      expect(mockClearOps).toHaveBeenCalledTimes(1);
      expect(mockClearOps).toHaveBeenCalledWith({ id: 8, op: 'move', accountId: 'acct1', mailbox: 'INBOX', uids: [3, 4], arg });
      expect(mockSaveEmailHeaders).toHaveBeenCalledWith('acct1', 'INBOX', [], null, { removedUids: [3, 4] });
      expect(mockNoteOpFailure).toHaveBeenCalledWith({ op: 'move', accountId: 'acct1', mailbox: 'INBOX', uid: 5 }, 'ErrorMoveCopyFailed');
      expect(result).toMatchObject({ done: 2, failed: 1, kept: 1 });
    });

    it('answers a Graph move uid with no id anywhere and sends the rest', async () => {
      const arg = { target: 'Archive', graph: true, ids: { 3: 'g3' }, targetFolderId: 'gf' };
      const owed = entry({ id: 9, op: 'move', uids: [3, 4], arg });
      mockReadOps.mockResolvedValue([owed]);
      mockGraphMoveEmails.mockResolvedValue({ success: true, moved: 1, done: ['g3'], gone: [], failed: [] });

      await replayOps();

      expect(mockGraphMoveEmails).toHaveBeenCalledWith(GRAPH, ['g3'], 'gf');
      expect(mockClearOps).toHaveBeenCalledWith({ id: 9, op: 'move', accountId: 'acct1', mailbox: 'INBOX', uids: [4, 3], arg });
      expect(mockShowQueued).toHaveBeenCalledWith(owed, [4]);
    });

    it('still drops a Graph entry it cannot replay (a move)', async () => {
      const gone = entry({ op: 'move', uids: [3], arg: { target: 'Archive' } });
      mockReadOps.mockResolvedValue([gone]);

      await replayOps();

      expect(mockMoveEmails).not.toHaveBeenCalled();
      expect(mockSetFlagOnServer).not.toHaveBeenCalled();
      expect(mockClearOps).toHaveBeenCalledWith({ id: 1, op: 'move', accountId: 'acct1', mailbox: 'INBOX', uids: [3], arg: { target: 'Archive' } });
    });
  });

  it('does not raise the reminder for a replay started from the Settings list', async () => {
    mockReadOps.mockResolvedValue([entry({ op: 'move', arg: { target: 'Archive' } })]);
    mockMoveEmails.mockRejectedValueOnce(new Error('NO'));
    await replayOps({ reason: 'manual' });
    expect(mockRemind).not.toHaveBeenCalled();
  });
});

// The daemon's delete queue reaches the window as events; the handlers live
// in messageMutations (pinned in deleteMessages.test.js).
describe('wireDeleteQueueEvents', () => {
  it('follows the queue events, re-reads the queue at once and after a reconnect or a lag, once per window', async () => {
    await wireDeleteQueueEvents();
    await wireDeleteQueueEvents(); // idempotent
    expect([...mockListeners.keys()].sort()).toEqual([
      'daemon-events-lagged', 'daemon-reconnected', 'delete-queue-changed', 'delete-queue-landed', 'delete-queue-status',
    ]);
    // The launch sync: what the queue owes now, whatever events were missed.
    await vi.waitFor(() => expect(mockQueueChanged).toHaveBeenCalledTimes(1));

    const landed = { accountId: 'acct1', mailbox: 'INBOX', landed: [{ kind: 'gone', uid: 7 }] };
    mockListeners.get('delete-queue-landed')({ payload: landed });
    mockListeners.get('delete-queue-status')({ payload: { kept: 2, online: true } });
    mockListeners.get('delete-queue-changed')({ payload: {} });
    mockListeners.get('daemon-reconnected')({ payload: {} });
    mockListeners.get('daemon-events-lagged')({ payload: {} });
    await vi.waitFor(() => expect(mockQueueChanged).toHaveBeenCalledTimes(4));
    expect(mockQueueLanded).toHaveBeenCalledWith(landed);
    expect(mockQueueStatus).toHaveBeenCalledWith({ kept: 2, online: true });
  });
});

// Last: the subscription is module-level and outlives the test that makes it.
describe('wireReplayOnReconnect', () => {
  it('replays once the link has been back for a moment, and not on a repeated "still online"', async () => {
    vi.useFakeTimers();
    useConnectivityStore.getState().setOnline(false);
    wireReplayOnReconnect();
    wireReplayOnReconnect(); // idempotent — the scheduler calls it on every mount

    useConnectivityStore.getState().setOnline(true);
    // Debounced: a link can flap on the way up (Wi-Fi rejoining, a captive
    // portal settling), and each flap would re-issue ops the last one has sent
    // but not yet cleared.
    await vi.advanceTimersByTimeAsync(1999);
    expect(mockReadOps).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(mockReadOps).toHaveBeenCalledTimes(1);

    useConnectivityStore.getState().setOnline(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(mockReadOps).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  // A stuck entry keeps the journal non-empty for good, and a replay that
  // reads a non-empty journal withdraws the undo offer. Without this guard the
  // five-minute tick would take the user's undo toast down again and again for
  // reasons that have nothing to do with the delete they just made.
  it('holds the retry tick while an undo offer is live, or offline', async () => {
    useConnectivityStore.getState().setOnline(true);
    mailState.undo = null;
    expect(await shouldRetryNow()).toBe(true);

    mailState.undo = { kind: 'delete', at: Date.now() };
    expect(await shouldRetryNow()).toBe(false);

    mailState.undo = null;
    useConnectivityStore.getState().setOnline(false);
    expect(await shouldRetryNow()).toBe(false);
    useConnectivityStore.getState().setOnline(true);
  });

  // The slot outlives its toast: Cmd+Z reaches it until the next action
  // replaces it. Held on the slot, the tick stopped for the rest of the session
  // after the first delete, and an op a flaky link refused sat in the journal
  // for hours: the server kept the message unread and the badge counted it.
  it('runs the retry tick once the undo toast is gone, though the slot still holds', async () => {
    useConnectivityStore.getState().setOnline(true);
    mailState.undo = { kind: 'delete', at: Date.now() - UNDO_TOAST_MS - 1 };
    expect(await shouldRetryNow()).toBe(true);
    mailState.undo = null;
  });
});
