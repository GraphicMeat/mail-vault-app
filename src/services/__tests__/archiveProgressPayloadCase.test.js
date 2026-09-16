/**
 * Task 3.3 (R3.2): `archive-progress` moves to a fully camelCase payload,
 * keyed by `operation` (+ `accountId`/`mailbox`). These RED tests prove
 * BulkOperationManager mis-reads the payload it will actually receive once
 * the Rust struct changes - written BEFORE the rename, per the plan: every
 * read here is `if`-guarded, so a naive rename breaks it silently, with
 * nothing failing loudly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const handlers = {};
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name, cb) => { handlers[name] = cb; return () => {}; }),
}));
vi.mock('../api', () => ({
  savePendingOperation: vi.fn().mockResolvedValue(undefined),
  clearPendingOperation: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../authUtils', () => ({ ensureFreshToken: (a) => Promise.resolve(a) }));

const { bulkOperationManager } = await import('../BulkOperationManager.js');

beforeEach(async () => {
  for (const k of Object.keys(handlers)) delete handlers[k];
  // Bypass start() - it gates on window.__TAURI__, which does not exist in
  // this (node-environment) test file, and none of that machinery is what
  // is under test here. Drive the listener directly, as production code
  // does once a run is under way.
  bulkOperationManager._operation = { completed: 0, errors: 0, status: 'archiving' };
  await bulkOperationManager._setupEventListener();
});

describe('BulkOperationManager reads a camelCase archive-progress payload', () => {
  it('surfaces lastError when bandwidthLimited is true (:225)', () => {
    handlers['archive-progress']({
      payload: {
        total: 10, completed: 3, errors: 1, active: false,
        bandwidthLimited: true, lastError: 'Daily download limit reached for this provider.',
        operation: 'archive', accountId: 'acc1', mailbox: 'INBOX',
      },
    });

    expect(bulkOperationManager._operation.lastError).toBe('Daily download limit reached for this provider.');
  });
});

describe('BulkOperationManager archive-progress is keyed by operation (R3.2 / N3)', () => {
  it('does not let a concurrent scheduled backup overwrite this bulk operation\'s counts', () => {
    bulkOperationManager._operation.completed = 4;
    bulkOperationManager._operation.errors = 0;

    // A scheduled backup running alongside a manual bulk archive, on a
    // different account entirely - today's listener has no operation guard
    // at all, so this stomps the in-flight bulk operation's own counts.
    handlers['archive-progress']({
      payload: {
        total: 999, completed: 999, errors: 999, active: true,
        operation: 'backup', accountId: 'someone-elses-account', mailbox: 'INBOX',
      },
    });

    expect(bulkOperationManager._operation.completed).toBe(4);
    expect(bulkOperationManager._operation.errors).toBe(0);
  });
});
