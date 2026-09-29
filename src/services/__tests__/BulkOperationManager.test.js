// purgeEverywhere's onProgress reports 'delete' with the whole batch's
// total/completed, then 'vault'/'backup' with a per-(account,mailbox)-group
// count instead — which can be smaller than what 'delete' already reached.
// BulkOperationManager must relay the phase label for every phase but only
// let 'delete' rewrite total/completed, or the progress bar would jump
// backward moving into vault/backup. This app has a standing rule that
// progress must be monotone.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockSavePendingOperation = vi.fn().mockResolvedValue(undefined);
const mockClearPendingOperation = vi.fn().mockResolvedValue(undefined);
const mockVerifyArchivedEmails = vi.fn();
const mockBulkDeleteEmails = vi.fn().mockResolvedValue({});
const mockBackupCopyUids = vi.fn();
vi.mock('../api', () => ({
  backupCopyUids: (...a) => mockBackupCopyUids(...a),
  savePendingOperation: (...a) => mockSavePendingOperation(...a),
  clearPendingOperation: (...a) => mockClearPendingOperation(...a),
  verifyArchivedEmails: (...a) => mockVerifyArchivedEmails(...a),
  bulkDeleteEmails: (...a) => mockBulkDeleteEmails(...a),
}));

vi.mock('../authUtils', () => ({
  ensureFreshToken: (account) => Promise.resolve(account),
}));

// No real Tauri IPC bridge in jsdom — BulkOperationManager already wraps
// this import in try/catch, but stubbing it keeps the test from depending
// on that fallback behaving a particular way.
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

const mockSend = vi.fn().mockResolvedValue({});
vi.mock('../transport.js', () => ({
  send: (...a) => mockSend(...a),
}));

let mockPurgeEverywhere;
vi.mock('../workflows/messageMutations', () => ({
  purgeEverywhere: (...args) => mockPurgeEverywhere(...args),
}));

describe('BulkOperationManager delete_everywhere progress relay', () => {
  beforeEach(() => {
    mockSavePendingOperation.mockClear();
    mockClearPendingOperation.mockClear();
  });

  it('does not let vault/backup phases shrink total/completed below what delete already reached', async () => {
    mockPurgeEverywhere = vi.fn(async (uids, { onProgress }) => {
      // 'delete' covers the whole 10-uid batch.
      onProgress({ phase: 'delete', total: 10, completed: 4 });
      onProgress({ phase: 'delete', total: 10, completed: 10 });
      // 'vault'/'backup' report a single (account, mailbox) group's own
      // count — smaller than the batch total, and completed resets to 0
      // for the group. Must not read as progress going backward.
      onProgress({ phase: 'vault', total: 3, completed: 0 });
      onProgress({ phase: 'vault', total: 3, completed: 3 });
      onProgress({ phase: 'backup', total: 3, completed: 0 });
      onProgress({ phase: 'backup', total: 3, completed: 3 });
      return { deleted: 10, failed: 0, queuedBackup: 0, needsResync: 0 };
    });

    const { bulkOperationManager } = await import('../BulkOperationManager.js');
    const seen = [];
    await bulkOperationManager.start({
      type: 'delete_everywhere',
      accountId: 'acc1',
      account: { id: 'acc1', email: 'me@test.com' },
      mailbox: 'INBOX',
      uids: Array.from({ length: 10 }, (_, i) => i + 1),
      onProgress: (op) => seen.push({ phase: op.currentPhase, total: op.total, completed: op.completed }),
    });

    // Monotone: neither total nor completed may drop from one snapshot to
    // the next, across the whole run (including the initial 0/10 snapshot
    // emitted before any phase reports in).
    let prevTotal = -Infinity;
    let prevCompleted = -Infinity;
    for (const snap of seen) {
      expect(snap.total).toBeGreaterThanOrEqual(prevTotal);
      expect(snap.completed).toBeGreaterThanOrEqual(prevCompleted);
      prevTotal = snap.total;
      prevCompleted = snap.completed;
    }

    // The phase label still switches — only total/completed are frozen.
    const vaultSnaps = seen.filter(s => s.phase === 'vault');
    const backupSnaps = seen.filter(s => s.phase === 'backup');
    expect(vaultSnaps.length).toBeGreaterThan(0);
    expect(backupSnaps.length).toBeGreaterThan(0);
    for (const snap of [...vaultSnaps, ...backupSnaps]) {
      expect(snap.total).toBe(10);
      expect(snap.completed).toBe(10);
    }
  });
});

describe('BulkOperationManager archive-progress account/mailbox filter', () => {
  beforeEach(() => {
    mockSavePendingOperation.mockClear();
    mockClearPendingOperation.mockClear();
  });

  it('ignores archive-progress events for the right operation but the wrong accountId or mailbox', async () => {
    const { listen } = await import('@tauri-apps/api/event');
    let archiveProgressHandler;
    listen.mockImplementation((eventName, handler) => {
      if (eventName === 'archive-progress') archiveProgressHandler = handler;
      return Promise.resolve(() => {});
    });

    const { bulkOperationManager } = await import('../BulkOperationManager.js');
    await bulkOperationManager.start({
      type: 'archive',
      accountId: 'acc1',
      account: { id: 'acc1', email: 'me@test.com' },
      mailbox: 'INBOX',
      uids: [1, 2, 3],
      onProgress: () => {},
    });

    expect(typeof archiveProgressHandler).toBe('function');
    expect(bulkOperationManager.operation.completed).toBe(0);
    expect(bulkOperationManager.operation.errors).toBe(0);

    // Right operation, wrong accountId: e.g. a scheduled backup or a
    // cleanup-rule archive for a different account running concurrently.
    archiveProgressHandler({
      payload: { operation: 'archive', accountId: 'other-acc', mailbox: 'INBOX', completed: 5, errors: 2 },
    });
    expect(bulkOperationManager.operation.completed).toBe(0);
    expect(bulkOperationManager.operation.errors).toBe(0);

    // Right operation, right accountId, wrong mailbox.
    archiveProgressHandler({
      payload: { operation: 'archive', accountId: 'acc1', mailbox: 'Archive', completed: 7, errors: 3 },
    });
    expect(bulkOperationManager.operation.completed).toBe(0);
    expect(bulkOperationManager.operation.errors).toBe(0);

    // Sanity: a matching accountId and mailbox does update state.
    archiveProgressHandler({
      payload: { operation: 'archive', accountId: 'acc1', mailbox: 'INBOX', completed: 2, errors: 1 },
    });
    expect(bulkOperationManager.operation.completed).toBe(2);
    expect(bulkOperationManager.operation.errors).toBe(1);
  });
});

// A bulk archive fetches on the daemon's background lane: on the priority
// lane its five workers held every session a click needs, so the message
// the user opened meanwhile waited behind whole body fetches.
describe('BulkOperationManager archive lane', () => {
  it('asks the daemon to archive in the background', async () => {
    // Node test environment: no window unless this test makes one.
    globalThis.window = { __TAURI__: { core: { invoke: () => {} } } };
    try {
      mockSend.mockClear();
      const { bulkOperationManager } = await import('../BulkOperationManager.js');
      await bulkOperationManager.start({
        type: 'archive',
        accountId: 'acc1',
        account: { id: 'acc1', email: 'me@test.com' },
        mailbox: 'INBOX',
        uids: [1, 2, 3],
        onProgress: () => {},
      });
      expect(mockSend).toHaveBeenCalledWith('archive_emails', expect.objectContaining({ background: true }));
    } finally {
      delete globalThis.window;
    }
  });
});

// Archive-then-delete trusts only what the vault verified. The daemon
// verifies archived (`A`) copies only (`maildir::verify_copies`): a uid whose
// only local file is a working-cache copy comes back `missing`, because the
// eviction worker may delete that copy once the server has the message.
describe('BulkOperationManager archive-then-delete', () => {
  it('deletes from the server only the uids the vault verified as archived', async () => {
    globalThis.window = { __TAURI__: { core: { invoke: () => {} } } };
    try {
      mockBulkDeleteEmails.mockClear();
      mockVerifyArchivedEmails.mockResolvedValue({ verified: [2], missing: [1], mismatched: [] });
      const { bulkOperationManager } = await import('../BulkOperationManager.js');
      await bulkOperationManager.start({
        type: 'archive_and_delete',
        accountId: 'acc1',
        account: { id: 'acc1', email: 'me@test.com' },
        mailbox: 'INBOX',
        uids: [1, 2],
        onProgress: () => {},
      });
      expect(mockVerifyArchivedEmails).toHaveBeenCalledWith('acc1', 'INBOX', [1, 2]);
      expect(mockBulkDeleteEmails).toHaveBeenCalledTimes(1);
      expect(mockBulkDeleteEmails.mock.calls[0][3]).toEqual([2]);
    } finally {
      delete globalThis.window;
    }
  });
});

// Archive, Back up & Delete: the server delete follows a check in BOTH places.
// A message the vault verified but the backup drive did not prove stays on the
// server, and the run says why.
describe('BulkOperationManager archive-back-up-then-delete', () => {
  const account = { id: 'acc1', email: 'me@test.com' };
  const outcome = (o = {}) => ({ copied: [], verified: [], missing: [], mismatched: [], failed: [], ...o });
  const run = async (uids, onProgress = () => {}) => {
    const { bulkOperationManager } = await import('../BulkOperationManager.js');
    await bulkOperationManager.start({
      type: 'archive_backup_delete', accountId: 'acc1', account, mailbox: 'INBOX', uids, onProgress,
    });
    return bulkOperationManager;
  };

  beforeEach(() => {
    globalThis.window = { __TAURI__: { core: { invoke: () => {} } } };
    mockBulkDeleteEmails.mockReset();
    mockBulkDeleteEmails.mockResolvedValue({});
    mockBackupCopyUids.mockReset();
    mockVerifyArchivedEmails.mockReset();
    mockSend.mockReset();
    mockSend.mockResolvedValue({});
  });
  afterEach(() => { delete globalThis.window; });

  it('runs archive, verify, back up, then delete, one step after the other', async () => {
    const order = [];
    mockSend.mockImplementation(async (cmd) => { order.push(cmd); return {}; });
    mockVerifyArchivedEmails.mockImplementation(async () => { order.push('verify'); return { verified: [1, 2], missing: [], mismatched: [] }; });
    mockBackupCopyUids.mockImplementation(async () => { order.push('copy'); return outcome({ verified: [1, 2] }); });
    mockBulkDeleteEmails.mockImplementation(async () => { order.push('delete'); return {}; });

    const phases = [];
    await run([1, 2], (op) => phases.push(op.currentPhase));

    expect(order).toEqual(['archive_emails', 'verify', 'copy', 'delete']);
    expect([...new Set(phases)]).toEqual(['archive', 'verify', 'copy', 'delete']);
  });

  it('deletes only the uids verified in BOTH the vault and the backup drive, with no bin copy', async () => {
    mockVerifyArchivedEmails.mockResolvedValue({ verified: [1, 2, 3], missing: [4], mismatched: [] });
    mockBackupCopyUids.mockResolvedValue(outcome({ verified: [1, 2], mismatched: [3] }));

    const mgr = await run([1, 2, 3, 4]);

    expect(mockBackupCopyUids).toHaveBeenCalledTimes(1);
    expect(mockBackupCopyUids).toHaveBeenCalledWith('acc1', 'me@test.com', 'INBOX', [1, 2, 3]);
    expect(mockBulkDeleteEmails).toHaveBeenCalledTimes(1);
    expect(mockBulkDeleteEmails.mock.calls[0][3]).toEqual([1, 2]);
    expect(mockBulkDeleteEmails.mock.calls[0][4]).toEqual({ bin: false });
    expect(mgr.operation.status).toBe('complete');
    expect(mgr.operation.result).toEqual({ removed: 2, keptNotArchived: 1, keptBackupUnreachable: 0, keptCopyMismatch: 1, keptDeleteFailed: 0 });
  });

  it('never deletes a uid the drive answered that the vault did not verify', async () => {
    mockVerifyArchivedEmails.mockResolvedValue({ verified: [1], missing: [2], mismatched: [] });
    // A drive that claims a uid nobody asked about must not widen the delete.
    mockBackupCopyUids.mockResolvedValue(outcome({ verified: [1, 2] }));

    await run([1, 2]);

    expect(mockBulkDeleteEmails.mock.calls[0][3]).toEqual([1]);
  });

  it('deletes nothing when the backup drive cannot be reached, and says how many stayed', async () => {
    mockVerifyArchivedEmails.mockResolvedValue({ verified: [1, 2, 3], missing: [], mismatched: [] });
    mockBackupCopyUids.mockRejectedValue(new Error('Backup folder unavailable'));

    const mgr = await run([1, 2, 3]);

    expect(mockBulkDeleteEmails).not.toHaveBeenCalled();
    expect(mgr.operation.status).toBe('complete');
    expect(mgr.operation.result).toEqual({ removed: 0, keptNotArchived: 0, keptBackupUnreachable: 3, keptCopyMismatch: 0, keptDeleteFailed: 0 });
  });

  it('keeps a uid whose copy could not be written on the server as unreachable, not mismatched', async () => {
    mockVerifyArchivedEmails.mockResolvedValue({ verified: [1, 2], missing: [], mismatched: [] });
    mockBackupCopyUids.mockResolvedValue(outcome({ verified: [1], failed: [2] }));

    const mgr = await run([1, 2]);

    expect(mockBulkDeleteEmails.mock.calls[0][3]).toEqual([1]);
    expect(mgr.operation.result).toMatchObject({ removed: 1, keptBackupUnreachable: 1, keptCopyMismatch: 0 });
  });

  it('counts what the server really removed, not what was sent', async () => {
    mockVerifyArchivedEmails.mockResolvedValue({ verified: [1, 2, 3], missing: [], mismatched: [] });
    mockBackupCopyUids.mockResolvedValue(outcome({ verified: [1, 2, 3] }));
    // The daemon's reply for a bulk delete: two went, one failed on the server.
    mockBulkDeleteEmails.mockResolvedValue({ total: 3, completed: 2, errors: 1, operation: 'bulk_delete' });

    const mgr = await run([1, 2, 3]);

    expect(mgr.operation.result).toMatchObject({ removed: 2, keptDeleteFailed: 1 });
  });

  it('a uid the drive reports missing from the vault is kept and counted as not archived', async () => {
    mockVerifyArchivedEmails.mockResolvedValue({ verified: [1, 2], missing: [], mismatched: [] });
    mockBackupCopyUids.mockResolvedValue(outcome({ verified: [1], missing: [2] }));

    const mgr = await run([1, 2]);

    expect(mockBulkDeleteEmails.mock.calls[0][3]).toEqual([1]);
    expect(mgr.operation.result).toMatchObject({ removed: 1, keptNotArchived: 1 });
  });

  it('does not touch the drive or the server when the vault verified nothing', async () => {
    mockVerifyArchivedEmails.mockResolvedValue({ verified: [], missing: [1, 2], mismatched: [] });

    const mgr = await run([1, 2]);

    expect(mockBackupCopyUids).not.toHaveBeenCalled();
    expect(mockBulkDeleteEmails).not.toHaveBeenCalled();
    expect(mgr.operation.result).toMatchObject({ removed: 0, keptNotArchived: 2 });
  });

  it('copies in batches and, when the drive drops mid-run, deletes only what an earlier batch proved', async () => {
    const uids = Array.from({ length: 250 }, (_, i) => i + 1);
    mockVerifyArchivedEmails.mockResolvedValue({ verified: uids, missing: [], mismatched: [] });
    mockBackupCopyUids
      .mockImplementationOnce(async (_a, _e, _m, batch) => outcome({ verified: batch }))
      .mockRejectedValueOnce(new Error('drive gone'));

    const mgr = await run(uids);

    expect(mockBackupCopyUids).toHaveBeenCalledTimes(2);
    expect(mockBackupCopyUids.mock.calls[0][3]).toHaveLength(100);
    expect(mockBulkDeleteEmails.mock.calls[0][3]).toEqual(uids.slice(0, 100));
    expect(mgr.operation.result).toMatchObject({ removed: 100, keptBackupUnreachable: 150 });
  });

  it('a cancel while backing up deletes nothing', async () => {
    const uids = Array.from({ length: 250 }, (_, i) => i + 1);
    mockVerifyArchivedEmails.mockResolvedValue({ verified: uids, missing: [], mismatched: [] });
    const { bulkOperationManager } = await import('../BulkOperationManager.js');
    mockBackupCopyUids.mockImplementation(async (_a, _e, _m, batch) => {
      await bulkOperationManager.cancel();
      return outcome({ verified: batch });
    });

    await run(uids);

    expect(mockBackupCopyUids).toHaveBeenCalledTimes(1);
    expect(mockBulkDeleteEmails).not.toHaveBeenCalled();
    expect(bulkOperationManager.operation.status).toBe('cancelled');
  });

  it('counts the backup step as a running state', async () => {
    const { bulkOperationManager } = await import('../BulkOperationManager.js');
    mockVerifyArchivedEmails.mockResolvedValue({ verified: [1], missing: [], mismatched: [] });
    let runningDuringCopy;
    mockBackupCopyUids.mockImplementation(async () => {
      runningDuringCopy = bulkOperationManager.isRunning;
      return outcome({ verified: [1] });
    });

    await run([1]);

    expect(runningDuringCopy).toBe(true);
  });
});
