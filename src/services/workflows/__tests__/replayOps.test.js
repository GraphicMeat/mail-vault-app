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
const mockDeleteEmail = vi.fn().mockResolvedValue(undefined);
const mockUpdateEmailFlags = vi.fn().mockResolvedValue(undefined);
const mockMoveEmails = vi.fn().mockResolvedValue(undefined);
const mockMarkServerDeleted = vi.fn().mockResolvedValue(true);
const mockLoadEmails = vi.fn();
const mockNoteOpFailure = vi.fn();

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
  deleteEmail: (...a) => mockDeleteEmail(...a),
  updateEmailFlags: (...a) => mockUpdateEmailFlags(...a),
  moveEmails: (...a) => mockMoveEmails(...a),
}));

vi.mock('../../authUtils', () => ({ ensureFreshToken: async (a) => a }));
vi.mock('../../graphConfig', () => ({ isGraphAccount: () => false }));

vi.mock('../messageMutations', async (importOriginal) => ({
  ...(await importOriginal()),
  markServerDeleted: (...a) => mockMarkServerDeleted(...a),
}));

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

import { replayOps, shouldRetryNow, wireReplayOnReconnect } from '../replayOps';
import { useConnectivityStore } from '../../../stores/connectivityStore';

const entry = (over) => ({ id: 1, op: 'delete', accountId: 'acct1', mailbox: 'INBOX', uids: [7], arg: {}, at: 1, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  mockReadOps.mockResolvedValue([]);
  mockGetAccounts.mockResolvedValue([ACCOUNT]);
  mailState.activeAccountId = 'acct1';
  mailState.activeMailbox = 'INBOX';
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe('replayOps', () => {
  it('finishes a delete, stamps the vault copy and prunes the sidecar', async () => {
    mockReadOps.mockResolvedValue([entry()]);

    const result = await replayOps();

    expect(mockDeleteEmail).toHaveBeenCalledWith(ACCOUNT, 7, 'INBOX');
    expect(mockMarkServerDeleted).toHaveBeenCalledWith('acct1', 'INBOX', 7);
    expect(mockSaveEmailHeaders).toHaveBeenCalledWith('acct1', 'INBOX', [], null, { removedUids: [7] });
    expect(mockClearOps).toHaveBeenCalledWith({ op: 'delete', accountId: 'acct1', mailbox: 'INBOX', uids: [7], arg: {} });
    expect(result).toMatchObject({ attempted: 1, done: 1, failed: 0, kept: 0 });
    // The outcome is the only trace this leaves; the work happens before any UI.
    expect(mailState.opReplay).toMatchObject({ attempted: 1, done: 1 });
  });

  it('replays a flag against the server and clears it', async () => {
    mockReadOps.mockResolvedValue([entry({ op: 'flag', uids: [3], arg: { flags: ['\\Seen'], action: 'add' } })]);

    await replayOps();

    expect(mockUpdateEmailFlags).toHaveBeenCalledWith(ACCOUNT, 3, ['\\Seen'], 'add', 'INBOX');
    expect(mockClearOps).toHaveBeenCalledWith({ op: 'flag', accountId: 'acct1', mailbox: 'INBOX', uids: [3], arg: { flags: ['\\Seen'], action: 'add' } });
    // A flag removes no uid, so nothing is pruned — but the row on screen still
    // paints the old state, so the open folder is reloaded.
    expect(mockSaveEmailHeaders).not.toHaveBeenCalled();
    expect(mockLoadEmails).toHaveBeenCalled();
  });

  it('replays a move and prunes the source mailbox, which no longer holds the uid', async () => {
    mockReadOps.mockResolvedValue([entry({ op: 'move', uids: [5], arg: { target: 'Archive' } })]);

    await replayOps();

    expect(mockMoveEmails).toHaveBeenCalledWith(ACCOUNT, [5], 'INBOX', 'Archive');
    expect(mockClearOps).toHaveBeenCalledWith({ op: 'move', accountId: 'acct1', mailbox: 'INBOX', uids: [5], arg: { target: 'Archive' } });
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
    mockReadOps.mockResolvedValue([entry({ uids: [7] })]);
    mockDeleteEmail.mockRejectedValueOnce(new Error('Password missing for account'));

    const creds = await replayOps();

    expect(mockClearOps).not.toHaveBeenCalled();
    expect(creds).toMatchObject({ attempted: 1, done: 0, failed: 1, kept: 1 });

    vi.clearAllMocks();
    mockReadOps.mockResolvedValue([entry({ uids: [7] })]);
    mockDeleteEmail.mockRejectedValueOnce(new Error('UID 7 not found'));

    const other = await replayOps();

    expect(mockClearOps).not.toHaveBeenCalled();
    expect(other).toMatchObject({ failed: 1, kept: 1 });
    expect(mockNoteOpFailure).toHaveBeenCalledWith(
      { op: 'delete', accountId: 'acct1', mailbox: 'INBOX', uid: 7 },
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
    mockReadOps.mockResolvedValue([entry({ accountId: 'vanished' })]);

    await replayOps();

    expect(mockDeleteEmail).not.toHaveBeenCalled();
    expect(mockClearOps).toHaveBeenCalledWith({ op: 'delete', accountId: 'vanished', mailbox: 'INBOX', uids: [7], arg: {} });
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

    mailState.undo = { kind: 'delete' };
    expect(await shouldRetryNow()).toBe(false);

    mailState.undo = null;
    useConnectivityStore.getState().setOnline(false);
    expect(await shouldRetryNow()).toBe(false);
    useConnectivityStore.getState().setOnline(true);
  });
});
