// The sweep that decides whether "your only copy" is sayable.
//
// Everything the app knew before this was scoped to ONE mailbox, and a uid
// missing from one mailbox is the everyday result of an archive, a filter, or
// a delete-to-Bin. So the loudest claim in the product — someone else deleted
// your mail and the vault is what is left — was unmakeable. This asks the
// server about every folder instead, and these tests pin the boundary between
// the two answers it may write down and the four it may not.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockFindMessageId = vi.fn();
const mockGetLocalIndexEntry = vi.fn();
const mockStampVaultEntry = vi.fn().mockResolvedValue(true);
const mockApplyServerRemoval = vi.fn().mockResolvedValue(undefined);
const mockUpdateSortedEmails = vi.fn();

vi.mock('../../api', () => ({
  findMessageId: (...a) => mockFindMessageId(...a),
}));

vi.mock('../../db', () => ({
  getLocalIndexEntry: (...a) => mockGetLocalIndexEntry(...a),
}));

vi.mock('../../authUtils', () => ({
  hasValidCredentials: (a) => !!a?.password,
  ensureFreshToken: (a) => Promise.resolve(a),
}));

vi.mock('../messageMutations', () => ({
  stampVaultEntry: (...a) => mockStampVaultEntry(...a),
  applyServerRemoval: (...a) => mockApplyServerRemoval(...a),
}));

let storeState;
const setState = vi.fn((patch) => { storeState = { ...storeState, ...patch }; });
vi.mock('../../../stores/mailStore', () => ({
  useMailStore: {
    getState: () => storeState,
    setState: (...a) => setState(...a),
  },
}));

const { probeServerCopy } = await import('../probeServerCopy');

const ACCOUNT = { id: 'acc1', email: 'luke@mock.test', password: 'x' };
const VAULT_ROW = { uid: 7, _accountId: 'acc1', _mailbox: 'INBOX', isArchived: true, subject: 'Aruodas' };

beforeEach(() => {
  vi.clearAllMocks();
  mockStampVaultEntry.mockResolvedValue(true);
  mockApplyServerRemoval.mockResolvedValue(undefined);
  mockGetLocalIndexEntry.mockResolvedValue({ uid: 7, message_id: '<kept@example.com>' });
  storeState = {
    activeAccountId: 'acc1',
    activeMailbox: 'INBOX',
    accounts: [ACCOUNT],
    localEmails: [VAULT_ROW],
    emails: [],
    sortedEmails: [],
    updateSortedEmails: mockUpdateSortedEmails,
  };
});

describe('a completed sweep that finds nothing', () => {
  it('writes the absence to the vault entry so it survives a reload', async () => {
    mockFindMessageId.mockResolvedValue({ found: [], searched: ['INBOX', 'Archive'], failed: [], complete: true });

    const result = await probeServerCopy(7);

    expect(result.state).toBe('absent');
    expect(mockStampVaultEntry).toHaveBeenCalledWith('acc1', 'INBOX', 7, expect.objectContaining({
      serverAbsent: true,
    }));
    // A stamp that only lives in the store dies with the session, and the row
    // goes quiet again on the next launch — the same silence the bug produced.
    expect(mockStampVaultEntry.mock.calls[0][3].serverAbsentAt).toEqual(expect.any(String));
  });

  it('repaints the rows already in memory rather than waiting for a disk read', async () => {
    mockFindMessageId.mockResolvedValue({ found: [], searched: ['INBOX'], failed: [], complete: true });

    await probeServerCopy(7);

    expect(storeState.localEmails[0].serverAbsent).toBe(true);
    expect(mockUpdateSortedEmails).toHaveBeenCalled();
  });

  it('takes down a stale server row, which would otherwise shadow the vault row', async () => {
    // A server row from an older enumeration duplicates the vault row and wins
    // the derivation, so the stamp would be written and the row would stay
    // quiet. The server has just answered a stronger version of the question a
    // failed body fetch asks — route it through the same path.
    storeState.emails = [{ uid: 7, _accountId: 'acc1', _mailbox: 'INBOX' }];
    mockFindMessageId.mockResolvedValue({ found: [], searched: ['INBOX'], failed: [], complete: true });

    await probeServerCopy(7);

    expect(mockApplyServerRemoval).toHaveBeenCalledWith(7, expect.objectContaining({
      accountId: 'acc1', mailbox: 'INBOX', clearSelection: false,
    }));
    // NOT a delete: this app did not remove anything, and stamping that it did
    // would put the wrong sentence under the gold row.
    expect(mockApplyServerRemoval.mock.calls[0][1].deletedByUs).toBeUndefined();
  });

  it('leaves the list alone when no server row is shadowing anything', async () => {
    mockFindMessageId.mockResolvedValue({ found: [], searched: ['INBOX'], failed: [], complete: true });

    await probeServerCopy(7);

    expect(mockApplyServerRemoval).not.toHaveBeenCalled();
  });

  it('refuses to claim anything about a message the vault does not hold', async () => {
    // Gold says "the vault is what you have left". Nothing is left if there is
    // no vault copy, so there is no claim to make — stampVaultEntry declines
    // to invent an entry, and the verdict has to follow it.
    mockStampVaultEntry.mockResolvedValue(false);
    mockFindMessageId.mockResolvedValue({ found: [], searched: ['INBOX'], failed: [], complete: true });

    expect((await probeServerCopy(7)).state).toBe('unknown');
    expect(storeState.localEmails[0].serverAbsent).toBeUndefined();
  });
});

describe('an incomplete sweep', () => {
  it('is unknown, not absent — the folder that would not open could be holding it', async () => {
    mockFindMessageId.mockResolvedValue({
      found: [], searched: ['INBOX', 'Archive'], failed: ['[Gmail]/Spam'], complete: false,
    });

    const result = await probeServerCopy(7);

    expect(result.state).toBe('unknown');
    expect(result.failed).toEqual(['[Gmail]/Spam']);
    expect(mockStampVaultEntry).not.toHaveBeenCalled();
  });
});

describe('a sweep that finds the message', () => {
  it('reports where, and writes nothing', async () => {
    mockFindMessageId.mockResolvedValue({
      found: [{ mailbox: 'Archive', uid: 42 }], searched: ['INBOX', 'Archive'], failed: [], complete: false,
    });

    const result = await probeServerCopy(7);

    expect(result.state).toBe('present');
    expect(result.locations).toEqual([{ mailbox: 'Archive', uid: 42 }]);
    expect(mockStampVaultEntry).not.toHaveBeenCalled();
  });

  it('tears up an earlier absence stamp instead of leaving a lie on disk', async () => {
    // A message can come back: restored from the Bin, re-delivered, moved back
    // by whoever moved it out. The stamp outlives the sweep that wrote it, so
    // the sweep that disproves it has to clear it.
    mockGetLocalIndexEntry.mockResolvedValue({ uid: 7, message_id: '<kept@example.com>', serverAbsent: true });
    mockFindMessageId.mockResolvedValue({
      found: [{ mailbox: 'INBOX', uid: 7 }], searched: ['INBOX'], failed: [], complete: false,
    });

    expect((await probeServerCopy(7)).state).toBe('present');
    expect(mockStampVaultEntry).toHaveBeenCalledWith('acc1', 'INBOX', 7, {
      serverAbsent: false, serverAbsentAt: null,
    });
    expect(storeState.localEmails[0].serverAbsent).toBe(false);
  });
});

describe('questions the probe cannot ask', () => {
  it('never reaches the server for an account it has no credentials for', async () => {
    storeState.accounts = [{ id: 'acc1', email: 'luke@mock.test' }];

    expect(await probeServerCopy(7)).toEqual({ state: 'unknown', reason: 'offline' });
    expect(mockFindMessageId).not.toHaveBeenCalled();
  });

  it('skips Graph accounts as not-applicable rather than answering absent', async () => {
    // A fail-closed guard that inherits the failure branch is how Delete
    // Everywhere became a permanent no-op for every Microsoft account.
    storeState.accounts = [{ ...ACCOUNT, oauth2Transport: 'graph' }];

    expect(await probeServerCopy(7)).toEqual({ state: 'unknown', reason: 'graph' });
    expect(mockFindMessageId).not.toHaveBeenCalled();
  });

  it('cannot look up a message with no Message-ID', async () => {
    mockGetLocalIndexEntry.mockResolvedValue({ uid: 7, message_id: null });

    expect(await probeServerCopy(7)).toEqual({ state: 'unknown', reason: 'no-message-id' });
    expect(mockFindMessageId).not.toHaveBeenCalled();
  });

  it('reads the Message-ID off the vault entry, which outlives the row', async () => {
    // The vanished-message path calls this straight after pruning the row, so
    // the in-memory copy is already gone by then.
    storeState.localEmails = [];
    storeState.sortedEmails = [];
    mockFindMessageId.mockResolvedValue({ found: [], searched: ['INBOX'], failed: [], complete: true });

    expect((await probeServerCopy(7)).state).toBe('absent');
    expect(mockFindMessageId).toHaveBeenCalledWith(ACCOUNT, '<kept@example.com>', { stopOnFirst: true });
  });

  it('says nothing about the server when the sweep itself errored', async () => {
    mockFindMessageId.mockRejectedValue(new Error('connection reset'));

    expect(await probeServerCopy(7)).toEqual({ state: 'unknown', reason: 'error' });
    expect(mockStampVaultEntry).not.toHaveBeenCalled();
  });
});

describe('scope', () => {
  it('does not restamp a row that merely shares the uid', async () => {
    // A uid names a message only inside one (account, mailbox): Sent uid 7 is
    // not INBOX uid 7, and account B's uid 7 is neither.
    const otherFolder = { uid: 7, _accountId: 'acc1', _mailbox: 'Sent', isArchived: true };
    const otherAccount = { uid: 7, _accountId: 'acc2', _mailbox: 'INBOX', isArchived: true };
    storeState.localEmails = [VAULT_ROW, otherFolder, otherAccount];
    mockFindMessageId.mockResolvedValue({ found: [], searched: ['INBOX'], failed: [], complete: true });

    await probeServerCopy(7);

    expect(storeState.localEmails.map(e => e.serverAbsent)).toEqual([true, undefined, undefined]);
  });

  it('resolves the UNIFIED view to a real folder before touching the vault', async () => {
    // 'UNIFIED' is a view, not a mailbox — there is no local-index.json under
    // that name to read a Message-ID out of.
    storeState.activeMailbox = 'UNIFIED';
    mockFindMessageId.mockResolvedValue({ found: [], searched: ['INBOX'], failed: [], complete: true });

    await probeServerCopy(7, { accountId: 'acc1', mailbox: 'UNIFIED' });

    expect(mockGetLocalIndexEntry).toHaveBeenCalledWith('acc1', 'INBOX', 7);
  });
});
