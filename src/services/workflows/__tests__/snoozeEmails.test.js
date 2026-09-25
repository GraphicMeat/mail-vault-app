// Snooze = the app's own move into the Snoozed folder (journal, undo, list
// rules), then one daemon row per moved message so the worker can move it
// back. A message in Snoozed with no row would never come back, so every
// failure between the two steps has to put it back where it was.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { selectionKey } from '../../../stores/slices/unifiedHelpers';

const mockMove = vi.fn();
const mockReload = vi.fn().mockResolvedValue(undefined);
const mockApiMove = vi.fn().mockResolvedValue({ success: true });
const mockDaemon = vi.fn();
const mockRefetch = vi.fn();
const setUndo = vi.fn();
let online = true;
let state;

vi.mock('../messageMutations', () => ({
  moveEmails: (...a) => mockMove(...a),
  reloadListInView: (...a) => mockReload(...a),
}));
const mockFind = vi.fn();
vi.mock('../../api', () => ({
  moveEmails: (...a) => mockApiMove(...a),
  findMessageId: (...a) => mockFind(...a),
}));
vi.mock('../../daemonClient', () => ({ daemonCall: (...a) => mockDaemon(...a) }));
vi.mock('../../authUtils', () => ({ ensureFreshToken: (a) => Promise.resolve(a) }));
vi.mock('../../graphConfig', () => ({ isGraphAccount: (a) => a?.oauth2Transport === 'graph' }));
vi.mock('../helpers/mailboxRefetch', () => ({ forceMailboxRefetch: (...a) => mockRefetch(...a) }));
vi.mock('../../../stores/connectivityStore', () => ({
  useConnectivityStore: { getState: () => ({ online }) },
}));
vi.mock('../../../stores/mailStore', () => ({
  useMailStore: { getState: () => state, setState: vi.fn() },
}));

const { snoozeEmails, unsnooze } = await import('../snooze');

const WAKE = Date.UTC(2026, 9, 1, 8);
const account = { id: 'a1', email: 'u@example.com' };
const graph = { id: 'g1', email: 'g@example.com', oauth2Transport: 'graph' };

beforeEach(() => {
  vi.clearAllMocks();
  online = true;
  state = {
    activeAccountId: 'a1',
    activeMailbox: 'INBOX',
    accounts: [account, graph],
    mailboxes: [{ path: 'INBOX' }],
    emails: [
      { uid: 1, messageId: '<1@x>', flags: [] },
      { uid: 2, messageId: null, flags: [] },
      { uid: 3, messageId: '<3@x>', flags: [], _accountId: 'g1', _mailbox: 'INBOX' },
    ],
    sentEmails: [],
    localEmails: [],
    setUndo,
  };
  mockDaemon.mockImplementation(async (method, params) => {
    if (method === 'snooze.ensure_folder') return 'Snoozed';
    if (method === 'snooze.create') return { id: `row-${params.uid}`, ...params, state: 'snoozed' };
    if (method === 'snooze.cancel') return { id: params.id, state: 'woken' };
    throw new Error(`unexpected ${method}`);
  });
  mockMove.mockResolvedValue({
    moved: [{ account, accountId: 'a1', from: 'INBOX', to: 'Snoozed', srcUids: [1], dstUids: [41], messageIds: ['<1@x>'] }],
  });
});

const key = (email) => selectionKey(email, state);

describe('snoozeEmails', () => {
  it('refuses offline without moving anything', async () => {
    online = false;
    await expect(snoozeEmails([key(state.emails[0])], WAKE)).rejects.toThrow();
    expect(mockMove).not.toHaveBeenCalled();
  });

  it('moves into the folder the daemon resolved, then records each moved message', async () => {
    await snoozeEmails([key(state.emails[0])], WAKE);
    expect(mockDaemon).toHaveBeenCalledWith('snooze.ensure_folder', { account });
    expect(mockMove).toHaveBeenCalledWith([key(state.emails[0])], 'Snoozed');
    expect(mockDaemon).toHaveBeenCalledWith('snooze.create', {
      accountId: 'a1', mailbox: 'INBOX', snoozedMailbox: 'Snoozed', uid: 41, messageId: '<1@x>', wakeAt: WAKE,
    });
    // A folder the sidebar has not listed yet must show up on the next load.
    expect(mockRefetch).toHaveBeenCalledWith('a1');
  });

  it('leaves out a message with no Message-ID and one on a Graph account', async () => {
    const keys = state.emails.map(key);
    const result = await snoozeEmails(keys, WAKE);
    expect(mockMove).toHaveBeenCalledTimes(1);
    expect(mockMove.mock.calls[0][0]).toEqual([key(state.emails[0])]);
    expect(result).toEqual({ snoozed: 1, skipped: 2 });
  });

  it('records a server without UIDPLUS with no uid', async () => {
    mockMove.mockResolvedValue({
      moved: [{ account, accountId: 'a1', from: 'INBOX', to: 'Snoozed', srcUids: [1], dstUids: null, messageIds: ['<1@x>'] }],
    });
    await snoozeEmails([key(state.emails[0])], WAKE);
    expect(mockDaemon).toHaveBeenCalledWith('snooze.create', expect.objectContaining({ uid: null, messageId: '<1@x>' }));
  });

  it('moves the message back when its row could not be written', async () => {
    mockDaemon.mockImplementation(async (method) => {
      if (method === 'snooze.ensure_folder') return 'Snoozed';
      throw new Error('disk full');
    });
    await expect(snoozeEmails([key(state.emails[0])], WAKE)).rejects.toThrow('disk full');
    expect(mockApiMove).toHaveBeenCalledWith(account, [41], 'Snoozed', 'INBOX');
  });

  // One failed row must not strand the messages after it: each gets its row
  // or goes back, and the error is reported once at the end.
  it('keeps going after one row fails, and puts back only the one that failed', async () => {
    mockMove.mockResolvedValue({
      moved: [{ account, accountId: 'a1', from: 'INBOX', to: 'Snoozed', srcUids: [1, 4], dstUids: [41, 44], messageIds: ['<1@x>', '<4@x>'] }],
    });
    mockDaemon.mockImplementation(async (method, params) => {
      if (method === 'snooze.ensure_folder') return 'Snoozed';
      if (params.uid === 41) throw new Error('disk full');
      return { id: `row-${params.uid}`, ...params, state: 'snoozed' };
    });
    await expect(snoozeEmails([key(state.emails[0])], WAKE)).rejects.toThrow('disk full');
    expect(mockApiMove).toHaveBeenCalledTimes(1);
    expect(mockApiMove).toHaveBeenCalledWith(account, [41], 'Snoozed', 'INBOX');
    expect(mockDaemon).toHaveBeenCalledWith('snooze.create', expect.objectContaining({ uid: 44 }));
    // The row that was written can still be undone.
    expect(setUndo.mock.calls[0][0].labelParams).toEqual({ count: 1 });
  });

  it('finds a message with no COPYUID by Message-ID to put it back', async () => {
    mockMove.mockResolvedValue({
      moved: [{ account, accountId: 'a1', from: 'INBOX', to: 'Snoozed', srcUids: [1], dstUids: null, messageIds: ['<1@x>'] }],
    });
    mockFind.mockResolvedValue({ found: [{ mailbox: 'INBOX', uid: 1 }, { mailbox: 'Snoozed', uid: 77 }] });
    mockDaemon.mockImplementation(async (method) => {
      if (method === 'snooze.ensure_folder') return 'Snoozed';
      throw new Error('disk full');
    });
    await expect(snoozeEmails([key(state.emails[0])], WAKE)).rejects.toThrow('disk full');
    expect(mockApiMove).toHaveBeenCalledWith(account, [77], 'Snoozed', 'INBOX');
  });

  it('offers an undo that unsnoozes through the daemon', async () => {
    await snoozeEmails([key(state.emails[0])], WAKE);
    expect(setUndo).toHaveBeenCalledTimes(1);
    const entry = setUndo.mock.calls[0][0];
    expect(entry.labelKey).toBe('undo.snoozed');
    await entry.run();
    expect(mockDaemon).toHaveBeenCalledWith('snooze.cancel', { id: 'row-41' });
    expect(mockReload).toHaveBeenCalled();
  });
});

describe('unsnooze', () => {
  it('cancels every row and repaints the list even when one fails', async () => {
    mockDaemon.mockImplementation(async (method, params) => {
      if (params.id === 'bad') throw new Error('offline');
      return { id: params.id, state: 'woken' };
    });
    await expect(unsnooze(['bad'])).rejects.toThrow('offline');
    expect(mockReload).toHaveBeenCalled();
  });
});
