// The app's side of "is the server copy gone?". The daemon reads the custody
// entry, sweeps every folder and stamps the answer (`custody.probe_server_copy`,
// tested in src-daemon/src/handlers/custody_probe.rs). What is left here: which
// message is meant, what this app's own row knows about it, and repainting the
// rows in memory from the answer without touching a row that merely shares
// the uid.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockProbe = vi.fn();
const mockApplyServerRemoval = vi.fn().mockResolvedValue(undefined);
const mockUpdateSortedEmails = vi.fn();

vi.mock('../../api', () => ({
  probeServerCopy: (...a) => mockProbe(...a),
}));

vi.mock('../../authUtils', () => ({
  hasValidCredentials: (a) => !!a?.password,
  ensureFreshToken: (a) => Promise.resolve(a),
}));

vi.mock('../messageMutations', () => ({
  applyServerRemoval: (...a) => mockApplyServerRemoval(...a),
  indexEntryFor: (row) => ({ uid: row.uid, subject: row.subject, message_id: row.messageId || null, source: 'local' }),
}));

let storeState;
vi.mock('../../../stores/mailStore', () => ({
  useMailStore: {
    getState: () => storeState,
    setState: (patch) => { storeState = { ...storeState, ...patch }; },
  },
}));

const { probeServerCopy } = await import('../probeServerCopy');

const ACCOUNT = { id: 'acc1', email: 'luke@mock.test', password: 'x' };
const VAULT_ROW = { uid: 7, _accountId: 'acc1', _mailbox: 'INBOX', isArchived: true, subject: 'Aruodas', messageId: '<kept@example.com>' };
const ABSENT = { state: 'absent', checkedAt: '2026-10-19T10:00:00.000Z', searched: ['INBOX', 'Archive'] };

beforeEach(() => {
  vi.clearAllMocks();
  mockApplyServerRemoval.mockResolvedValue(undefined);
  mockProbe.mockResolvedValue(ABSENT);
  storeState = {
    activeAccountId: 'acc1',
    activeMailbox: 'INBOX',
    accounts: [ACCOUNT],
    localEmails: [VAULT_ROW],
    emails: [],
    sortedEmails: [],
    archivedEmailIds: new Set(['acc1:INBOX:7']),
    updateSortedEmails: mockUpdateSortedEmails,
  };
});

describe('the question it hands the daemon', () => {
  it('names the account, folder, uid and what its own row knows', async () => {
    await probeServerCopy(7);
    expect(mockProbe).toHaveBeenCalledWith(ACCOUNT, {
      accountId: 'acc1', mailbox: 'INBOX', uid: 7,
      messageId: '<kept@example.com>',
      fallbackEntry: { uid: 7, subject: 'Aruodas', message_id: '<kept@example.com>', source: 'local' },
    });
  });

  it('offers no row to stamp for a message the vault does not hold', async () => {
    storeState.archivedEmailIds = new Set();
    await probeServerCopy(7);
    expect(mockProbe.mock.calls[0][1].fallbackEntry).toBeNull();
  });

  it('offers no row to stamp when the row has no header to write', async () => {
    storeState.localEmails = [{ ...VAULT_ROW, subject: '' }];
    await probeServerCopy(7);
    expect(mockProbe.mock.calls[0][1].fallbackEntry).toBeNull();
  });

  it('resolves the UNIFIED view to a real folder before asking', async () => {
    // 'UNIFIED' is a view, not a mailbox: there is no custody entry under it.
    storeState.activeMailbox = 'UNIFIED';
    await probeServerCopy(7, { accountId: 'acc1', mailbox: 'UNIFIED' });
    expect(mockProbe.mock.calls[0][1].mailbox).toBe('INBOX');
  });
});

describe('the Message-ID of the message asked about', () => {
  // The daemon prefers the custody entry's; the row's is for a message with
  // none, and it has to be THIS message's row. A sweep for another message's
  // Message-ID that finds nothing stamps the wrong one "deleted by someone
  // else", the loudest claim in the product.
  const OTHER = { id: 'acc2', email: 'leia@mock.test', password: 'x' };

  beforeEach(() => {
    storeState.accounts = [ACCOUNT, OTHER];
    storeState.localEmails = [];
  });

  it("never takes another account's row with the same uid", async () => {
    storeState.localEmails = [{ uid: 7, _accountId: 'acc2', _mailbox: 'INBOX', messageId: '<theirs@example.com>', isArchived: true }];
    await probeServerCopy(7, { accountId: 'acc1', mailbox: 'INBOX' });
    expect(mockProbe.mock.calls[0][1].messageId).toBeNull();
  });

  it("never takes the folder on screen's unstamped row for another folder's message", async () => {
    storeState.activeMailbox = 'Archive';
    storeState.emails = [{ uid: 7, messageId: '<archive-7@example.com>' }];
    await probeServerCopy(7, { accountId: 'acc1', mailbox: 'INBOX' });
    expect(mockProbe.mock.calls[0][1].messageId).toBeNull();
  });

  it('reads it off its own row', async () => {
    storeState.localEmails = [
      { uid: 7, _accountId: 'acc2', _mailbox: 'INBOX', messageId: '<theirs@example.com>', isArchived: true },
      { uid: 7, _accountId: 'acc1', _mailbox: 'INBOX', messageId: '<mine@example.com>', isArchived: true },
    ];
    await probeServerCopy(7, { accountId: 'acc1', mailbox: 'INBOX' });
    expect(mockProbe.mock.calls[0][1].messageId).toBe('<mine@example.com>');
  });

  it('passes the daemon\'s "no Message-ID" answer through', async () => {
    mockProbe.mockResolvedValue({ state: 'unknown', reason: 'no-message-id' });
    expect(await probeServerCopy(7)).toEqual({ state: 'unknown', reason: 'no-message-id' });
  });
});

describe('an absent answer', () => {
  it('is returned as the daemon gave it', async () => {
    expect(await probeServerCopy(7)).toEqual(ABSENT);
  });

  it('repaints the rows already in memory rather than waiting for a disk read', async () => {
    await probeServerCopy(7);
    expect(storeState.localEmails[0].serverAbsent).toBe(true);
    expect(storeState.localEmails[0].serverAbsentAt).toBe(ABSENT.checkedAt);
    expect(mockUpdateSortedEmails).toHaveBeenCalled();
  });

  it('takes down a stale server row, which would otherwise shadow the vault row', async () => {
    storeState.emails = [{ uid: 7, _accountId: 'acc1', _mailbox: 'INBOX' }];
    await probeServerCopy(7);
    expect(mockApplyServerRemoval).toHaveBeenCalledWith(7, expect.objectContaining({
      accountId: 'acc1', mailbox: 'INBOX', clearSelection: false,
    }));
    // NOT a delete: this app did not remove anything.
    expect(mockApplyServerRemoval.mock.calls[0][1].deletedByUs).toBeUndefined();
  });

  it('leaves the list alone when no server row is shadowing anything', async () => {
    await probeServerCopy(7);
    expect(mockApplyServerRemoval).not.toHaveBeenCalled();
  });

  it('stamps and removes only the message it asked about, never the open folder\'s uid 7', async () => {
    // The sweep is a round trip: the screen may show ANOTHER folder by now,
    // whose rows carry no folder of their own and whose uid 7 is another message.
    const archiveRow = { uid: 7, subject: 'Something else' };
    const archiveVaultRow = { uid: 7, isArchived: true, subject: 'Something else' };
    storeState.activeMailbox = 'Archive';
    storeState.emails = [archiveRow];
    storeState.localEmails = [VAULT_ROW, archiveVaultRow];

    expect((await probeServerCopy(7, { accountId: 'acc1', mailbox: 'INBOX' })).state).toBe('absent');
    expect(storeState.localEmails[0].serverAbsent).toBe(true);
    expect(storeState.localEmails[1].serverAbsent).toBeUndefined();
    expect(mockApplyServerRemoval).not.toHaveBeenCalled();
  });

  it('does not restamp a row that merely shares the uid', async () => {
    const otherFolder = { uid: 7, _accountId: 'acc1', _mailbox: 'Sent', isArchived: true };
    const otherAccount = { uid: 7, _accountId: 'acc2', _mailbox: 'INBOX', isArchived: true };
    storeState.localEmails = [VAULT_ROW, otherFolder, otherAccount];
    await probeServerCopy(7);
    expect(storeState.localEmails.map(e => e.serverAbsent)).toEqual([true, undefined, undefined]);
  });
});

describe('answers that paint nothing', () => {
  it.each([
    [{ state: 'unknown', reason: 'not-in-vault' }],
    [{ state: 'unknown', reason: 'incomplete', failed: ['[Gmail]/Spam'] }],
    [{ state: 'unknown', reason: 'error' }],
  ])('%j is returned as given and leaves every row alone', async (answer) => {
    mockProbe.mockResolvedValue(answer);
    expect(await probeServerCopy(7)).toEqual(answer);
    expect(storeState.localEmails[0].serverAbsent).toBeUndefined();
    expect(mockUpdateSortedEmails).not.toHaveBeenCalled();
  });
});

describe('a present answer', () => {
  it('reports where, and repaints nothing when no stamp was torn up', async () => {
    mockProbe.mockResolvedValue({ state: 'present', locations: [{ mailbox: 'Archive', uid: 42 }], cleared: false });
    expect(await probeServerCopy(7)).toEqual({ state: 'present', locations: [{ mailbox: 'Archive', uid: 42 }] });
    expect(mockUpdateSortedEmails).not.toHaveBeenCalled();
  });

  it('repaints the rows when the daemon tore up an earlier absence stamp', async () => {
    storeState.localEmails = [{ ...VAULT_ROW, serverAbsent: true }];
    mockProbe.mockResolvedValue({ state: 'present', locations: [{ mailbox: 'INBOX', uid: 7 }], cleared: true });
    expect((await probeServerCopy(7)).state).toBe('present');
    expect(storeState.localEmails[0].serverAbsent).toBe(false);
  });
});

describe('questions the probe cannot ask', () => {
  it('never reaches the daemon for an account it has no credentials for', async () => {
    storeState.accounts = [{ id: 'acc1', email: 'luke@mock.test' }];
    expect(await probeServerCopy(7)).toEqual({ state: 'unknown', reason: 'offline' });
    expect(mockProbe).not.toHaveBeenCalled();
  });

  it('skips Graph accounts as not-applicable rather than answering absent', async () => {
    // A fail-closed guard that inherits the failure branch is how Delete
    // Everywhere became a permanent no-op for every Microsoft account.
    storeState.accounts = [{ ...ACCOUNT, oauth2Transport: 'graph' }];
    expect(await probeServerCopy(7)).toEqual({ state: 'unknown', reason: 'graph' });
    expect(mockProbe).not.toHaveBeenCalled();
  });

  it('says nothing about the server when the call itself failed', async () => {
    mockProbe.mockRejectedValue(new Error('daemon unavailable'));
    expect(await probeServerCopy(7)).toEqual({ state: 'unknown', reason: 'error' });
    expect(storeState.localEmails[0].serverAbsent).toBeUndefined();
  });
});
