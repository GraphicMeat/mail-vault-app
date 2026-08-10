// purgeEverywhere's onProgress reports 'delete' with the whole batch's
// total/completed, then 'vault'/'backup' with a per-(account,mailbox)-group
// count instead — which can be smaller than what 'delete' already reached.
// BulkOperationManager must relay the phase label for every phase but only
// let 'delete' rewrite total/completed, or the progress bar would jump
// backward moving into vault/backup. This app has a standing rule that
// progress must be monotone.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSavePendingOperation = vi.fn().mockResolvedValue(undefined);
const mockClearPendingOperation = vi.fn().mockResolvedValue(undefined);
vi.mock('../api', () => ({
  savePendingOperation: (...a) => mockSavePendingOperation(...a),
  clearPendingOperation: (...a) => mockClearPendingOperation(...a),
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
