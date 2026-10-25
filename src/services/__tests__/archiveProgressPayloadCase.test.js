// Native bulk snapshots own manual archive diagnostics and drain. Global
// archive-progress belongs to other archive jobs and is not a facade input.
import { it, expect, vi, beforeEach, afterEach } from 'vitest';
const io = vi.hoisted(() => ({ send: vi.fn(), events: {}, unlisten: vi.fn() }));
vi.mock('../transport.js', () => ({ send: (...args) => io.send(...args) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async (name, callback) => {
  io.events[name] = callback;
  return () => { io.unlisten(); delete io.events[name]; };
} }));
import { BulkOperationManager } from '../BulkOperationManager.js';
const key = 'errors.bulkDownloadLimited';
const scope = { accountId: 'acc1', mailbox: 'INBOX', spans: false, keys: [7], targetHints: [] };
let manager;
beforeEach(() => {
  manager = new BulkOperationManager();
  io.send.mockReset(); io.unlisten.mockClear(); io.events = {};
});
afterEach(() => manager._cleanup());
it('preserves the exact native download-limit key through owned drain and ignores foreign frames', async () => {
  let admission;
  io.send.mockImplementation(async (method, request) => {
    if (method !== 'bulk.start') throw new Error(`Unexpected RPC: ${method}`);
    admission = { id: request.operationId, attemptId: request.attemptId, type: request.type, status: 'archiving', total: 1, completed: 0, errors: 0, lastError: null };
    return admission;
  });
  const observed = [];
  const off = manager.subscribe((operation, meta) => observed.push({ operation, ...meta }));
  const run = manager.start({ type: 'archive', scope });
  await vi.waitFor(() => expect(manager.operation.status).toBe('archiving'));
  expect(Object.keys(io.events)).toEqual(['bulk-progress']);
  const emit = (operationId, attemptId, operation) => io.events['bulk-progress']({ payload: { operationId, attemptId, operation, finished: true } });
  emit('foreign', admission.attemptId, { ...admission, id: 'foreign', completed: 999, errors: 999, lastError: 'errors.bulkOperationFailed', status: 'error' });
  emit(admission.id, 'old-attempt', { ...admission, attemptId: 'old-attempt', completed: 999, errors: 999, lastError: 'errors.bulkOperationFailed', status: 'error' });
  expect(manager.operation).toEqual(admission);
  expect(manager.isRunning).toBe(true);
  const terminal = { ...admission, status: 'cancelled', errors: 1, lastError: key };
  emit(admission.id, admission.attemptId, terminal);
  expect(await run).toMatchObject({ ...terminal, lastError: key });
  expect(observed.at(-1)).toMatchObject({ operation: { lastError: key, completed: 0, errors: 1 }, settled: true });
  expect(manager.operation.lastError).toBe(key);
  expect(manager.isRunning).toBe(false);
  expect(io.unlisten).toHaveBeenCalledTimes(1);
  expect(Object.keys(io.events)).toEqual([]);
  off();
});
it('recovers the exact download-limit key from durable native state after a lost admission reply', async () => {
  let admitted;
  io.send.mockImplementation(async (method, request) => {
    if (method === 'bulk.start') {
      admitted = { id: request.operationId, attemptId: request.attemptId, type: request.type, schemaVersion: 1, status: 'cancelled', errors: 1, lastError: key };
      throw new Error('lost admission reply');
    }
    if (method === 'bulk.status') return { active: null, pending: null, admission: { operationId: admitted.id, attemptId: admitted.attemptId, state: 'done' } };
    if (method === 'read_pending_operation') return JSON.parse(JSON.stringify(admitted));
    throw new Error(`Unexpected RPC: ${method}`);
  });
  const observed = [];
  const off = manager.subscribe((operation, meta) => observed.push({ operation, ...meta }));
  const result = await manager.start({ type: 'archive', scope });
  expect(result.lastError).toBe(key);
  expect(manager.operation.lastError).toBe(key);
  expect(observed.at(-1)).toMatchObject({ operation: { lastError: key, errors: 1 }, settled: true });
  expect(io.send.mock.calls.map(([method]) => method)).toEqual(['bulk.start', 'bulk.status', 'read_pending_operation']);
  expect(io.unlisten).toHaveBeenCalledTimes(1);
  expect(manager.isRunning).toBe(false);
  off();
});
