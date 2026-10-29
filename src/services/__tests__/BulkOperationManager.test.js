// Native transport replacement for migrated JS phase decisions.
import { it, expect, vi, beforeEach, afterEach } from 'vitest';
const m = vi.hoisted(() => ({ send: vi.fn(), events: {}, unlisten: vi.fn() }));
vi.mock('../transport.js', () => ({ send: (...a) => m.send(...a) }));
vi.mock('../api', () => ({
  savePendingOperation: vi.fn(),
  clearPendingOperation: vi.fn(),
  bulkDeleteEmails: vi.fn(),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (name, fn) => {
    m.events[name] = fn;
    return m.unlisten;
  },
}));
import { bulkOperationManager as manager } from '../BulkOperationManager.js';
const scope = {
  accountId: 'a',
  mailbox: 'INBOX',
  spans: false,
  keys: [7],
  targetHints: [
    {
      accountId: 'a',
      mailbox: 'INBOX',
      uid: 7,
      nativeIdentity: {
        accountId: 'a',
        mailbox: 'INBOX',
        uidValidity: 4,
        originHash: 'original',
      },
      messageIdPresent: true,
      messageId: 'original@test',
      graphId: null,
      jmapId: null,
      localIdentity: { source: null, staged: false },
    },
  ],
};
const tick = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
beforeEach(() => {
  manager._cleanup();
  manager._operation = null;
  m.send.mockReset();
  m.events = {};
  m.unlisten.mockClear();
});
afterEach(() => {
  manager._cleanup();
  vi.useRealTimers();
});
it('starts exactly one native operation using the frozen original hints', async () => {
  m.send.mockImplementation(async (cmd, p) =>
    cmd === 'bulk.start'
      ? {
          id: p.operationId,
          attemptId: p.attemptId,
          type: p.type,
          status: 'complete',
          total: 1,
          completed: 1,
        }
      : { active: null, pending: null }
  );
  await manager.start({
    type: 'delete',
    accountId: 'a',
    mailbox: 'INBOX',
    uids: [7],
    scope,
  });
  expect(
    m.send.mock.calls.filter(([cmd]) => cmd === 'bulk.start')
  ).toHaveLength(1);
  expect(
    m.send.mock.calls.find(([cmd]) => cmd === 'bulk.start')[1]
  ).toMatchObject({ type: 'delete', scope });
  expect(manager.operation.status).toBe('complete');
});
it('waits for drain and ignores old attempts after native adoption', async () => {
  let accepted;
  m.send.mockImplementation(async (cmd, p) => {
    if (cmd === 'bulk.start') {
      accepted = {
        id: p.operationId,
        attemptId: 'adopted',
        type: p.type,
        status: 'deleting',
        total: 1,
        completed: 0,
      };
      return accepted;
    }
    return { active: accepted, pending: null };
  });
  const run = manager.start({ type: 'delete', scope });
  await tick();
  expect(manager.isRunning).toBeTruthy();
  m.events['bulk-progress']({
    payload: {
      operationId: accepted.id,
      attemptId: 'old',
      finished: true,
      operation: { ...accepted, status: 'complete' },
    },
  });
  expect(manager.operation.status).toBe('deleting');
  m.events['bulk-progress']({
    payload: {
      operationId: accepted.id,
      attemptId: 'adopted',
      finished: true,
      operation: { ...accepted, status: 'cancelled' },
    },
  });
  await run;
  expect(manager.operation.status).toBe('cancelled');
});
it('queries status after an ambiguous timeout without restarting work', async () => {
  m.send.mockImplementation(async (cmd, p) => {
    if (cmd === 'bulk.start') throw new Error('timed out');
    if (cmd === 'bulk.status')
      return {
        active: null,
        pending: {
          id: p.operationId,
          attemptId: p.attemptId,
          type: 'delete',
          status: 'awaitingResume',
          total: 1,
          remaining: 1,
        },
        admission: {
          operationId: p.operationId,
          attemptId: p.attemptId,
          state: 'done',
        },
      };
  });
  await manager.start({ type: 'delete', scope });
  expect(m.send.mock.calls.map(([cmd]) => cmd)).toEqual([
    'bulk.start',
    'bulk.status',
  ]);
  expect(manager.operation.status).toBe('awaitingResume');
});
it('explicit Resume and Discard use exact ids without JS replay', async () => {
  m.send.mockImplementation(async (cmd, p) =>
    cmd === 'bulk.resume'
      ? {
          id: p.operationId,
          attemptId: p.attemptId,
          type: 'delete',
          status: 'complete',
        }
      : null
  );
  await manager.resume({
    id: 'pending',
    type: 'delete',
    total: 3,
    remaining: 2,
  });
  await manager.discard('pending');
  expect(m.send.mock.calls.map(([cmd]) => cmd)).toEqual([
    'bulk.resume',
    'bulk.discard',
  ]);
  expect(m.send.mock.calls[0][1].operationId).toBe('pending');
});
it('no-active cancellation refuses without inventing terminal state', async () => {
  await expect(manager.cancel()).rejects.toThrow();
  expect(m.send).not.toHaveBeenCalled();
});
it('attaches to an already running native attempt without starting another job', async () => {
  const active = {
    id: 'existing',
    attemptId: 'A',
    type: 'archive',
    status: 'archiving',
  };
  m.send.mockResolvedValue({ active, pending: null });
  const run = manager.attach(active);
  await tick();
  m.events['bulk-progress']({
    payload: {
      operationId: 'existing',
      attemptId: 'A',
      finished: true,
      operation: { ...active, status: 'complete' },
    },
  });
  await run;
  expect(
    m.send.mock.calls.filter(([cmd]) => cmd === 'bulk.start')
  ).toHaveLength(0);
});
it('cancellation retains ownership until the matching worker actually drains', async () => {
  let active;
  m.send.mockImplementation(async (cmd, p) => {
    if (cmd === 'bulk.start') {
      active = {
        id: p.operationId,
        attemptId: p.attemptId,
        type: p.type,
        status: 'deleting',
      };
      return active;
    }
    if (cmd === 'bulk.status') return { active, pending: null };
    return { id: active.id, status: 'cancelling' };
  });
  const run = manager.start({ type: 'delete', scope });
  await tick();
  await manager.cancel();
  expect(manager.isRunning).toBe(true);
  expect(manager.operation.status).toBe('cancelling');
  m.events['bulk-progress']({
    payload: {
      operationId: active.id,
      attemptId: active.attemptId,
      finished: true,
      operation: { ...active, status: 'cancelled' },
    },
  });
  await run;
  expect(manager.isRunning).toBe(false);
});
it.each([
  'archive',
  'delete',
  'archive_and_delete',
  'archive_backup_delete',
  'delete_everywhere',
])('delegates %s once without frontend phase decisions', async (type) => {
  m.send.mockImplementation(async (cmd, p) =>
    cmd === 'bulk.start'
      ? { id: p.operationId, attemptId: p.attemptId, type, status: 'complete' }
      : null
  );
  await manager.start({ type, scope });
  expect(
    m.send.mock.calls.filter(([cmd]) => cmd === 'bulk.start')
  ).toHaveLength(1);
  expect(
    m.send.mock.calls.find(([cmd]) => cmd === 'bulk.start')[1].scope
  ).toEqual(scope);
});
it('fences an unstarted ambiguous admission before allowing another run', async () => {
  let reads = 0;
  m.send.mockImplementation(async (cmd, p) => {
    if (cmd === 'bulk.start') throw new Error('timed out');
    if (cmd === 'bulk.status') {
      reads++;
      return {
        active: null,
        pending: null,
        admission:
          reads === 1
            ? null
            : {
                operationId: p.operationId,
                attemptId: p.attemptId,
                state: 'fenced',
              },
      };
    }
  });
  await manager.start({ type: 'delete', scope });
  expect(m.send.mock.calls.map(([cmd]) => cmd)).toEqual([
    'bulk.start',
    'bulk.status',
    'bulk.status',
  ]);
  expect(m.send.mock.calls[2][1].fenceUnstarted).toBe(true);
  expect(manager.isRunning).toBe(false);
  expect(manager.operation.status).toBe('error');
});
it('recovers a lost terminal event from the exact retained native row', async () => {
  vi.useFakeTimers();
  let accepted;
  m.send.mockImplementation(async (cmd, p) => {
    if (cmd === 'bulk.start') {
      accepted = {
        id: p.operationId,
        attemptId: p.attemptId,
        type: p.type,
        status: 'deleting',
      };
      return accepted;
    }
    if (cmd === 'bulk.status')
      return {
        active: null,
        pending: null,
        admission: {
          operationId: accepted.id,
          attemptId: accepted.attemptId,
          state: 'done',
          ownerAttemptId: accepted.attemptId,
        },
      };
    if (cmd === 'read_pending_operation')
      return {
        ...accepted,
        schemaVersion: 1,
        status: 'complete',
        result: { removed: 1 },
      };
  });
  const run = manager.start({ type: 'delete', scope });
  await tick();
  await vi.advanceTimersByTimeAsync(501);
  await run;
  expect(manager.operation.status).toBe('complete');
  expect(manager.operation.result).toEqual({ removed: 1 });
});
it('does not mistake an Active complete label for an actual drain', async () => {
  const active = {
    id: 'existing',
    attemptId: 'A',
    type: 'archive',
    status: 'complete',
  };
  const run = manager.attach(active);
  await tick();
  expect(manager.isRunning).toBe(true);
  m.events['bulk-progress']({
    payload: {
      operationId: 'existing',
      attemptId: 'A',
      finished: true,
      operation: active,
    },
  });
  await run;
  expect(manager.isRunning).toBe(false);
});

it.each(['start', 'resume'])(
  'retains %s ownership after kickoff and first status both fail',
  async (mode) => {
    vi.useFakeTimers();
    let requested;
    let statusReads = 0;
    let rejected;
    m.send.mockImplementation(async (command, params) => {
      if (command === 'bulk.start' || command === 'bulk.resume') {
        requested = params;
        throw new Error('reply timed out');
      }
      if (command === 'bulk.status') {
        if (++statusReads === 1) throw new Error('status unavailable');
        return {
          active: {
            id: requested.operationId,
            attemptId: requested.attemptId,
            type: 'delete',
            status: 'deleting',
          },
          pending: null,
        };
      }
      return { id: requested.operationId, status: 'cancelling' };
    });
    const run = (
      mode === 'start'
        ? manager.start({ type: 'delete', scope })
        : manager.resume({ id: 'resume-id', type: 'delete' })
    ).catch((error) => {
      rejected = error;
    });
    await tick();
    expect(manager.isRunning).toBe(true);
    expect(m.unlisten).not.toHaveBeenCalled();
    await expect(manager.start({ type: 'delete', scope })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(501);
    await manager.cancel();
    m.events['bulk-progress']({
      payload: {
        operationId: requested.operationId,
        attemptId: requested.attemptId,
        finished: true,
        operation: {
          id: requested.operationId,
          attemptId: requested.attemptId,
          type: 'delete',
          status: 'cancelled',
        },
      },
    });
    await run;
    expect(rejected).toBeUndefined();
    expect(
      m.send.mock.calls.filter(([command]) =>
        ['bulk.start', 'bulk.resume'].includes(command)
      )
    ).toHaveLength(1);
    expect(manager.isRunning).toBe(false);
  }
);

it('retains an ambiguous owner when its first unstarted fence is unavailable', async () => {
  vi.useFakeTimers();
  let requested;
  let reads = 0;
  let rejected;
  m.send.mockImplementation(async (command, params) => {
    if (command === 'bulk.start') {
      requested = params;
      throw new Error('reply timed out');
    }
    if (command === 'bulk.status') {
      reads++;
      if (reads === 1) return { active: null, pending: null, admission: null };
      if (reads === 2) throw new Error('fence unavailable');
      return {
        active: null,
        pending: null,
        admission: {
          operationId: requested.operationId,
          attemptId: requested.attemptId,
          state: 'fenced',
        },
      };
    }
  });
  const run = manager.start({ type: 'delete', scope }).catch((error) => {
    rejected = error;
  });
  await tick();
  expect(manager.isRunning).toBe(true);
  await vi.advanceTimersByTimeAsync(501);
  await run;
  expect(rejected).toBeUndefined();
  expect(manager.isRunning).toBe(false);
  expect(
    m.send.mock.calls.filter(([command]) => command === 'bulk.start')
  ).toHaveLength(1);
});

// The list's corner panel belongs to the bulk selection. A run started with no
// panel (a delete from the list or reader) tells subscribers so; one recovered
// after a relaunch has no caller of its own and gets the panel.
it('tells subscribers whether a run belongs to the corner panel', async () => {
  const seen = [];
  const stop = manager.subscribe((_op, lifecycle) => seen.push(lifecycle?.panel));
  seen.length = 0;
  m.send.mockImplementation(async (cmd, p) =>
    cmd === 'bulk.start'
      ? { id: p.operationId, attemptId: p.attemptId, type: p.type, status: 'complete', total: 1, completed: 1 }
      : { active: null, pending: null }
  );
  await manager.start({ type: 'delete_everywhere', scope });
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every((panel) => panel === false)).toBe(true);
  await manager.start({ type: 'archive', scope, panel: true });
  expect(seen.at(-1)).toBe(true);
  // A delete never gets the panel, whoever asks: its rows are already gone.
  await manager.start({ type: 'delete', scope, panel: true });
  expect(seen.at(-1)).toBe(false);

  seen.length = 0;
  const active = { id: 'existing', attemptId: 'A', type: 'archive', status: 'archiving' };
  m.send.mockResolvedValue({ active, pending: null });
  const run = manager.attach(active);
  await tick();
  m.events['bulk-progress']({
    payload: { operationId: 'existing', attemptId: 'A', finished: true, operation: { ...active, status: 'complete' } },
  });
  await run;
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every((panel) => panel === true)).toBe(true);

  seen.length = 0;
  const purge = { id: 'purge', attemptId: 'B', type: 'delete_everywhere', status: 'deleting' };
  m.send.mockResolvedValue({ active: purge, pending: null });
  const reattached = manager.attach(purge);
  await tick();
  m.events['bulk-progress']({
    payload: { operationId: 'purge', attemptId: 'B', finished: true, operation: { ...purge, status: 'complete' } },
  });
  await reattached;
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every((panel) => panel === false)).toBe(true);
  stop();
});
// A plain server delete hands back what its own durable row says it removed,
// group by group, so the queue takes off only those. A row that is not this
// exact run says nothing, never "all deleted".
it('reports which uids a delete removed from its exact native row', async () => {
  const finished = (rowFor) => {
    m.send.mockImplementation(async (cmd, p) => {
      if (cmd === 'bulk.start') {
        m.accepted = { id: p.operationId, attemptId: p.attemptId, type: p.type, status: 'complete', errors: 1, total: 2, completed: 2 };
        return m.accepted;
      }
      if (cmd === 'read_pending_operation') return rowFor(m.accepted);
      return { active: null, pending: null };
    });
    return manager.start({ type: 'delete', scope: { ...scope, keys: [7, 8] } });
  };
  const row = (run, over = {}) => ({
    id: run.id,
    attemptId: run.attemptId,
    schemaVersion: 1,
    type: 'delete',
    status: 'complete',
    worker: { groups: [{ group: { accountId: 'a', mailbox: 'INBOX', uids: [7, 8] }, deleted: [8] }] },
    ...over,
  });

  const run = await finished((r) => row(r));
  expect(run.deleted).toEqual([{ accountId: 'a', mailbox: 'INBOX', uids: [8] }]);

  const other = await finished((r) => row(r, { attemptId: 'another-run' }));
  expect(other.deleted).toBeUndefined();

  const unreadable = await finished(() => { throw new Error('locked'); });
  expect(unreadable.deleted).toBeUndefined();
});
