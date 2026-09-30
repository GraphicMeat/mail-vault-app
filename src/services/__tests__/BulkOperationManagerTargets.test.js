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

describe('BulkOperationManager runs each key in its own folder', () => {
  beforeEach(() => {
    globalThis.window = { __TAURI__: { core: { invoke: () => {} } } };
    for (const k of Object.keys(listeners)) delete listeners[k];
    mockSend.mockReset();
    mockSend.mockResolvedValue({});
    mockBulkDeleteEmails.mockReset();
    mockBulkDeleteEmails.mockResolvedValue({});
    mockVerifyArchivedEmails.mockReset();
    mockBackupCopyUids.mockReset();
    mockSavePendingOperation.mockClear();
    mockEnsureFreshToken.mockClear();
  });
  afterEach(() => { delete globalThis.window; });

  it('archives a Sent copy and another account\'s row in their own folders, with their own credentials', async () => {
    await bulkOperationManager.start({
      type: 'archive', accountId: 'acc1', account: acc1, accounts, mailbox: 'INBOX',
      uids: [1, 'acc1:Sent:5', 'acc2:INBOX:7'], onProgress: () => {},
    });

    expect(archiveCalls()).toEqual([
      { accountId: 'acc1', mailbox: 'INBOX', uids: [1], jsonId: 'acc1' },
      { accountId: 'acc1', mailbox: 'Sent', uids: [5], jsonId: 'acc1' },
      { accountId: 'acc2', mailbox: 'INBOX', uids: [7], jsonId: 'acc2' },
    ]);
    expect(bulkOperationManager.operation.status).toBe('complete');
  });

  it('never sends the UNIFIED placeholder as a mailbox', async () => {
    await bulkOperationManager.start({
      type: 'delete', accountId: 'acc1', account: acc1, accounts, mailbox: 'UNIFIED', spans: true,
      uids: ['acc1:INBOX:5', 'acc2:INBOX:5', 'acc2:Sent:6'], onProgress: () => {},
    });

    expect(deleteCalls()).toEqual([
      { accountId: 'acc1', mailbox: 'INBOX', uids: [5], jsonId: 'acc1' },
      { accountId: 'acc2', mailbox: 'INBOX', uids: [5], jsonId: 'acc2' },
      { accountId: 'acc2', mailbox: 'Sent', uids: [6], jsonId: 'acc2' },
    ]);
  });

  it('refuses what names no one folder, runs the rest, and says how many it skipped', async () => {
    await bulkOperationManager.start({
      type: 'delete', accountId: 'acc1', account: acc1, accounts, mailbox: 'Work', spans: true,
      uids: [3, 'acc1:Work/Sub:4', 'gone:INBOX:8'], onProgress: () => {},
    });

    expect(deleteCalls()).toEqual([{ accountId: 'acc1', mailbox: 'Work/Sub', uids: [4], jsonId: 'acc1' }]);
    expect(bulkOperationManager.operation).toMatchObject({ status: 'complete', total: 1, skipped: 2 });
  });

  it('sends nothing at all when no key resolves', async () => {
    await bulkOperationManager.start({
      type: 'archive_and_delete', accountId: 'acc1', account: acc1, accounts, mailbox: 'UNIFIED', spans: true,
      uids: [3, 4], onProgress: () => {},
    });

    expect(mockSend).not.toHaveBeenCalled();
    expect(mockVerifyArchivedEmails).not.toHaveBeenCalled();
    expect(mockBulkDeleteEmails).not.toHaveBeenCalled();
    expect(bulkOperationManager.operation).toMatchObject({ status: 'complete', total: 0, skipped: 2 });
  });

  it('archive then delete verifies and deletes each folder on its own', async () => {
    mockVerifyArchivedEmails.mockImplementation(async (accountId, mailbox, uids) =>
      ({ verified: uids.filter(u => u !== 2), missing: uids.filter(u => u === 2), mismatched: [] }));

    await bulkOperationManager.start({
      type: 'archive_and_delete', accountId: 'acc1', account: acc1, accounts, mailbox: 'INBOX',
      uids: [1, 2, 'acc2:INBOX:7'], onProgress: () => {},
    });

    expect(mockVerifyArchivedEmails.mock.calls).toEqual([['acc1', 'INBOX', [1, 2]], ['acc2', 'INBOX', [7]]]);
    expect(deleteCalls()).toEqual([
      { accountId: 'acc1', mailbox: 'INBOX', uids: [1], jsonId: 'acc1' },
      { accountId: 'acc2', mailbox: 'INBOX', uids: [7], jsonId: 'acc2' },
    ]);
  });

  it('archive, back up and delete copies each folder under its own account and adds up the result', async () => {
    mockVerifyArchivedEmails.mockImplementation(async (_a, _m, uids) => ({ verified: uids, missing: [], mismatched: [] }));
    mockBackupCopyUids.mockImplementation(async (accountId, _email, _m, batch) =>
      ({ copied: batch, verified: accountId === 'acc1' ? batch : [], missing: [], mismatched: accountId === 'acc2' ? batch : [], failed: [] }));

    await bulkOperationManager.start({
      type: 'archive_backup_delete', accountId: 'acc1', account: acc1, accounts, mailbox: 'INBOX',
      uids: [1, 2, 'acc2:INBOX:7'], onProgress: () => {},
    });

    expect(mockBackupCopyUids.mock.calls).toEqual([
      ['acc1', 'one@test.com', 'INBOX', [1, 2]],
      ['acc2', 'two@test.com', 'INBOX', [7]],
    ]);
    expect(deleteCalls()).toEqual([{ accountId: 'acc1', mailbox: 'INBOX', uids: [1, 2], jsonId: 'acc1' }]);
    expect(bulkOperationManager.operation.result)
      .toEqual({ removed: 2, keptNotArchived: 0, keptBackupUnreachable: 0, keptCopyMismatch: 1, keptDeleteFailed: 0 });
  });

  it('counts archive progress from every folder in turn, never backwards', async () => {
    const seen = [];
    mockSend.mockImplementation(async (cmd, p) => {
      if (cmd !== 'archive_emails') return {};
      listeners['archive-progress']({ payload: { operation: 'archive', accountId: p.accountId, mailbox: p.mailbox, completed: p.uids.length, errors: 0 } });
      return {};
    });

    await bulkOperationManager.start({
      type: 'archive', accountId: 'acc1', account: acc1, accounts, mailbox: 'UNIFIED', spans: true,
      uids: ['acc1:INBOX:1', 'acc1:INBOX:2', 'acc2:INBOX:7'], onProgress: (op) => seen.push(op.completed),
    });

    expect(seen).toContain(2);
    expect(seen).toContain(3);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
  });

  it('persists self-describing keys, so a resume runs each folder where it was', async () => {
    await bulkOperationManager.start({
      type: 'delete', accountId: 'acc1', account: acc1, accounts, mailbox: 'INBOX',
      uids: [1, 'acc2:Sent:7'], onProgress: () => {},
    });
    const persisted = mockSavePendingOperation.mock.calls[0][0];
    expect(persisted.totalUids).toEqual(['acc1:INBOX:1', 'acc2:Sent:7']);

    mockBulkDeleteEmails.mockClear();
    await bulkOperationManager.resume(persisted, acc1, () => {}, { accounts });

    expect(deleteCalls()).toEqual([
      { accountId: 'acc1', mailbox: 'INBOX', uids: [1], jsonId: 'acc1' },
      { accountId: 'acc2', mailbox: 'Sent', uids: [7], jsonId: 'acc2' },
    ]);
  });
});
