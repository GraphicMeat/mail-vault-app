import { it, expect, vi, beforeEach, afterEach } from 'vitest';
const m = vi.hoisted(() => ({ send: vi.fn(), events: {} }));
vi.mock('../transport.js', () => ({ send: (...a) => m.send(...a) }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (name, fn) => {
    m.events[name] = fn;
    return () => {};
  },
}));
import { BulkOperationManager } from '../BulkOperationManager.js';
const hint = {
  accountId: 'a',
  mailbox: 'INBOX',
  uid: 7,
  nativeIdentity: {
    accountId: 'a',
    mailbox: 'INBOX',
    uidValidity: 4,
    originHash: 'A',
  },
  messageIdPresent: true,
  messageId: 'A',
  graphId: null,
  jmapId: null,
  localIdentity: { source: null, staged: false },
};
const scope = {
  accountId: 'a',
  mailbox: 'INBOX',
  spans: false,
  keys: [7],
  targetHints: [hint],
};
const target = {
  accountId: 'a',
  mailbox: 'INBOX',
  uid: 7,
  proof: {
    kind: 'server',
    email: 'a@test',
    origin: 'A',
    identity: { transport: 'imap', validity: 4, message_ids: { 7: 'A' } },
    stored: null,
  },
  server: 'complete',
  local: 'complete',
  mirror: 'unconfigured',
  mirrorRemoved: 0,
  mirrorIssue: null,
  refused: false,
  skipped: false,
  needsResync: false,
  lastError: null,
};
const intent = {
  operation: 'delete_everywhere',
  scope,
  groups: [],
  refused: [],
  skippedLocal: 0,
};
const rawFor = (p) => ({
  schemaVersion: 1,
  id: p.operationId,
  attemptId: p.attemptId,
  type: p.type,
  intent,
  worker: {
    groups: [],
    intent,
    purgeTargets: [target],
    purgeResult: { deleted: 1, failed: 0, queuedBackup: 0, needsResync: 0 },
    phase: 'backup',
    status: 'complete',
    result: {},
    lastError: null,
    errors: 0,
  },
});
let manager;
beforeEach(() => {
  manager = new BulkOperationManager();
  m.send.mockReset();
  m.events = {};
});
afterEach(() => manager._cleanup());
async function run(rawChange = (raw) => raw, events = []) {
  let raw;
  m.send.mockImplementation(async (cmd, p) => {
    if (cmd === 'bulk.start') {
      raw = rawChange(rawFor(p));
      for (const event of events)
        m.events['bulk-progress']({
          payload: {
            operationId: p.operationId,
            attemptId: p.attemptId,
            operation: {
              id: p.operationId,
              attemptId: p.attemptId,
              type: p.type,
              status: 'deleting',
            },
            target: event,
          },
        });
      return {
        id: p.operationId,
        attemptId: p.attemptId,
        type: p.type,
        status: 'complete',
        result: { deleted: 1, failed: 0, queuedBackup: 0, needsResync: 0 },
      };
    }
    if (cmd === 'read_pending_operation') return raw;
  });
  return manager.start({ type: 'delete_everywhere', scope });
}
it('binds durable outcomes to operation, accepted attempt and full original Scope', async () => {
  expect((await run()).outcomes).toEqual([{ hint, target }]);
});
it.each([
  'operation',
  'attempt',
  'scope',
  'version',
  'action',
  'shape',
  'null',
])('refuses unavailable or foreign full outcomes: %s', async (mismatch) => {
  const operation = await run((raw) => {
    if (mismatch === 'operation') raw.id = 'B';
    if (mismatch === 'attempt') raw.attemptId = 'old';
    if (mismatch === 'scope')
      raw.intent = {
        ...raw.intent,
        scope: { ...scope, targetHints: [{ ...hint, messageId: 'B' }] },
      };
    if (mismatch === 'version') raw.schemaVersion = 99;
    if (mismatch === 'action') raw.type = 'delete';
    if (mismatch === 'shape') raw.worker.groups = [{}];
    if (mismatch === 'null') return null;
    return raw;
  });
  expect(operation.outcomes).toEqual([]);
});
it('counters never fill missing targets; exact events survive a replaced getter', async () => {
  expect((await run(() => null, [target])).outcomes).toEqual([
    { hint, target },
  ]);
});
it('does not borrow a same-UID event from another account or folder', async () => {
  expect(
    (
      await run(
        () => null,
        [
          { ...target, mailbox: 'Sent' },
          { ...target, accountId: 'b' },
        ]
      )
    ).outcomes
  ).toEqual([]);
});
it('ignores a late getter after subscription ownership advances', async () => {
  let release;
  let params;
  m.send.mockImplementation(async (cmd, p) => {
    if (cmd === 'bulk.start') {
      params = p;
      return {
        id: p.operationId,
        attemptId: p.attemptId,
        type: p.type,
        status: 'complete',
      };
    }
    if (cmd === 'read_pending_operation')
      return new Promise((resolve) => {
        release = resolve;
      });
  });
  void manager.start({ type: 'delete_everywhere', scope });
  for (let i = 0; i < 30; i++) await Promise.resolve();
  manager._cleanup();
  manager._operation = { id: 'B', status: 'deleting' };
  release(rawFor(params));
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(manager.operation).toEqual({ id: 'B', status: 'deleting' });
});
it('getter errors preserve uncertainty rather than individual success', async () => {
  m.send.mockImplementation(async (cmd, p) => {
    if (cmd === 'bulk.start')
      return {
        id: p.operationId,
        attemptId: p.attemptId,
        type: p.type,
        status: 'complete',
        result: { deleted: 1 },
      };
    throw new Error('getter failed');
  });
  expect(
    (await manager.start({ type: 'delete_everywhere', scope })).outcomes
  ).toEqual([]);
});

it('consumes actual native checkpoint/pending shapes including omitted request defaults', async () => {
  const { readFileSync } = await import('node:fs');
  const wire = JSON.parse(
    readFileSync(
      'src/services/__tests__/fixtures/native-purge-wire.json',
      'utf8'
    )
  );
  vi.stubGlobal('crypto', {
    randomUUID: vi
      .fn()
      .mockReturnValueOnce(wire.accepted.id)
      .mockReturnValueOnce(wire.accepted.attemptId),
  });
  m.send.mockImplementation(async (command) =>
    command === 'bulk.start' ? wire.accepted : wire.pending
  );
  const run = manager.start({
    type: wire.request.type,
    scope: wire.request.scope,
  });
  for (let i = 0; i < 30; i++) await Promise.resolve();
  for (const payload of wire.events) m.events['bulk-progress']({ payload });
  const operation = await run;
  expect(operation.status).toBe('complete');
  expect(operation.result).toEqual({
    deleted: 1,
    failed: 0,
    queuedBackup: 0,
    needsResync: 0,
  });
  expect(operation.outcomes).toEqual([
    {
      hint: wire.pending.intent.scope.targetHints[0],
      target: wire.pending.worker.purgeTargets[0],
    },
  ]);
  vi.unstubAllGlobals();
});
