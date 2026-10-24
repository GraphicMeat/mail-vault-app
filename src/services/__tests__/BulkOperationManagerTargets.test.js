// A bulk run's selection is keyed the way the list keys it: a bare uid for the
// open folder's own row, `account:mailbox:uid` for a row from anywhere else (a
// hand-ticked row in All Inboxes or a folder subtree, a Sent copy merged into
// INBOX, a search hit). The daemon's archive/delete/verify routes parse `uids`
// as u32, so a full key sent under the session's one (account, mailbox) failed
// the whole RPC, bare uids included; in All Inboxes the session's mailbox is
// literally `UNIFIED`. Each key must run in its own folder, with its own
// account's credentials, and a key that names no one folder must be refused
// and counted, never guessed.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockSavePendingOperation = vi.fn().mockResolvedValue(undefined);
const mockClearPendingOperation = vi.fn().mockResolvedValue(undefined);
const mockVerifyArchivedEmails = vi.fn();
const mockBulkDeleteEmails = vi.fn();
const mockBackupCopyUids = vi.fn();
vi.mock('../api', () => ({
  backupCopyUids: (...a) => mockBackupCopyUids(...a),
  savePendingOperation: (...a) => mockSavePendingOperation(...a),
  clearPendingOperation: (...a) => mockClearPendingOperation(...a),
  verifyArchivedEmails: (...a) => mockVerifyArchivedEmails(...a),
  bulkDeleteEmails: (...a) => mockBulkDeleteEmails(...a),
}));

const mockEnsureFreshToken = vi.fn((account) => Promise.resolve(account));
vi.mock('../authUtils', () => ({
  ensureFreshToken: (account) => mockEnsureFreshToken(account),
}));

const listeners = {};
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((name, handler) => { listeners[name] = handler; return Promise.resolve(() => {}); }),
}));

const mockSend = vi.fn();
vi.mock('../transport.js', () => ({
  send: (...a) => mockSend(...a),
}));

vi.mock('../workflows/messageMutations', () => ({
  purgeEverywhere: vi.fn(),
}));

import { bulkOperationManager, groupBulkTargets } from '../BulkOperationManager.js';

const acc1 = { id: 'acc1', email: 'one@test.com' };
const acc2 = { id: 'acc2', email: 'two@test.com' };
const accounts = [acc1, acc2];

const archiveCalls = () => mockSend.mock.calls
  .filter(([cmd]) => cmd === 'archive_emails')
  .map(([, p]) => ({ accountId: p.accountId, mailbox: p.mailbox, uids: p.uids, jsonId: JSON.parse(p.accountJson).id }));
const deleteCalls = () => mockBulkDeleteEmails.mock.calls
  .map(([account, accountId, mailbox, uids]) => ({ accountId, mailbox, uids, jsonId: account.id }));

describe('groupBulkTargets', () => {
  const session = { accountId: 'acc1', mailbox: 'INBOX', spans: false };

  it('puts a bare uid in the session folder and a full key in its own', () => {
    expect(groupBulkTargets([1, 'acc1:Sent:5', 2, 'acc2:INBOX:7'], session)).toEqual({
      groups: [
        { accountId: 'acc1', mailbox: 'INBOX', uids: [1, 2] },
        { accountId: 'acc1', mailbox: 'Sent', uids: [5] },
        { accountId: 'acc2', mailbox: 'INBOX', uids: [7] },
      ],
      refused: [],
    });
  });

  it('folds a full key for the session folder into the bare uids, once', () => {
    expect(groupBulkTargets([3, 'acc1:INBOX:3', 'acc1:INBOX:4'], session).groups)
      .toEqual([{ accountId: 'acc1', mailbox: 'INBOX', uids: [3, 4] }]);
  });

  it('keeps a mailbox that contains a colon whole', () => {
    expect(groupBulkTargets(['acc1:Work:Clients:9'], session).groups)
      .toEqual([{ accountId: 'acc1', mailbox: 'Work:Clients', uids: [9] }]);
  });

  it('refuses a bare uid in a view spanning folders: it names no one message there', () => {
    expect(groupBulkTargets([3, 'acc1:INBOX:4'], { accountId: 'acc1', mailbox: 'Work', spans: true })).toEqual({
      groups: [{ accountId: 'acc1', mailbox: 'INBOX', uids: [4] }],
      refused: [3],
    });
    expect(groupBulkTargets([3], { accountId: 'acc1', mailbox: 'UNIFIED', spans: false }).refused).toEqual([3]);
  });

  it('refuses a key with no folder, the UNIFIED placeholder, or a uid that is not a number', () => {
    const keys = ['acc1:5', 'acc1:UNIFIED:6', 'acc1:INBOX:x'];
    expect(groupBulkTargets(keys, session)).toEqual({ groups: [], refused: keys });
  });
});
