import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInsightsSession } from '../insightsSession';

const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };
function harness(options = {}) {
  const operations = [], listeners = new Map();
  const worker = {
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: type => listeners.delete(type),
    postMessage(message) {
      operations.push(message);
      options.onPost?.(message, operations);
      queueMicrotask(() => listeners.get('message')?.({ data: {
        type: message.type === 'build-start' ? 'build-started' : message.type === 'build-append' ? 'build-appended' : message.type === 'build-commit' || message.type === 'build' ? 'built' : message.type === 'query' ? 'result' : 'messages',
        requestId: message.requestId, payload: message.type === 'build-start' ? { buildId: message.requestId } : message.type === 'query' ? { totals: { received: 2 } } : [],
      } }));
    },
    terminate: () => operations.push('terminated'),
  };
  const api = {
    beginInsightsSnapshot: async ids => { operations.push(['begin', ids]); return { snapshotId: 'snap', inventoryCount: 2, coverage: { status: 'reading' } }; },
    readInsightsPage: async (id, cursor) => {
      operations.push(['page', id, cursor]);
      return cursor == null
        ? { rows: [{ uid: 1 }], nextCursor: 'next', coverage: { status: 'reading' } }
        : { rows: [{ uid: 2 }], nextCursor: null, coverage: { status: 'partial', folders: [{ missingHeaders: 8 }] } };
    },
    releaseInsightsSnapshot: async id => operations.push(['release', id]),
    ...options,
  };
  return { session: createInsightsSession({ api, workerFactory: () => worker }), operations, listeners };
}
const scope = { accountIds: ['a'], accounts: [{ id: 'a' }], ownAddressesByAccount: { a: ['me@test'] } };

describe('Insights session lifecycle', () => {
  it('streams inventory to the worker in chunks no larger than 1000 and preserves every row', async () => {
    const rows = Array.from({ length: 2001 }, (_, uid) => ({ uid }));
    const { session, operations } = harness({
      beginInsightsSnapshot: async () => ({ snapshotId: 'large', inventoryCount: rows.length, coverage: { status: 'reading' } }),
      readInsightsPage: async () => ({ rows, nextCursor: null, coverage: { status: 'ready' } }),
    });
    await session.load(scope);
    const chunks = operations.filter(op => Array.isArray(op?.copies));
    expect(chunks.length).toBeGreaterThan(1);
    expect(Math.max(...chunks.map(chunk => chunk.copies.length))).toBeLessThanOrEqual(1000);
    expect(chunks.filter(chunk => chunk.type === 'build-append').flatMap(chunk => chunk.copies)).toEqual(rows);
    session.dispose();
  });

  it('does not commit old rows after a scope switch between worker chunks', async () => {
    const oldRows = Array.from({ length: 2001 }, (_, uid) => ({ uid }));
    const newRows = [{ uid: 8000 }];
    let session, newLoad;
    const target = harness({
      onPost: message => {
        if (message.type === 'build-append' && !newLoad) {
          newLoad = session.load({ ...scope, accountIds: ['new'] });
        }
      },
      beginInsightsSnapshot: async ids => ({ snapshotId: ids[0] === 'new' ? 'new' : 'old', coverage: {} }),
      readInsightsPage: async id => ({ rows: id === 'old' ? oldRows : newRows, nextCursor: null }),
    });
    session = target.session;
    const { operations } = target;
    try {
      const old = session.load(scope).catch(error => error.name);
      expect(await old).toBe('AbortError');
      await newLoad;
      const starts = operations.filter(op => op?.type === 'build-start');
      expect(starts).toHaveLength(2);
      const commits = operations.filter(op => op?.type === 'build-commit');
      expect(commits).toHaveLength(1);
      expect(commits[0].buildId).toBe(starts[1].requestId);
      expect(operations.filter(op => op?.type === 'build-append' && op.buildId === starts[1].requestId)
        .flatMap(op => op.copies)).toEqual(newRows);
      expect(operations.filter(op => op?.type === 'build-append' && op.buildId === starts[0].requestId)).toHaveLength(1);
      expect(operations).toContainEqual(['release', 'old']);
      expect(operations).toContainEqual(['release', 'new']);
    } finally { session.dispose(); }
  });

  it('does not transfer more chunks or commit after disposal during an append', async () => {
    let session;
    const target = harness({
      onPost: message => { if (message.type === 'build-append') session.dispose(); },
      readInsightsPage: async () => ({ rows: Array.from({ length: 2001 }, (_, uid) => ({ uid })), nextCursor: null }),
    });
    session = target.session;
    try {
      await expect(session.load(scope)).rejects.toMatchObject({ name: 'AbortError' });
      expect(target.operations.filter(op => op?.type === 'build-append')).toHaveLength(1);
      expect(target.operations.some(op => op?.type === 'build-commit')).toBe(false);
      expect(target.operations).toContain('terminated');
      expect(target.operations).toContainEqual(['release', 'snap']);
    } finally { session.dispose(); }
  });

  it('yields a macrotask between staged append chunks', async () => {
    let marker = false, sawMarkerOnSecondAppend = false, appends = 0;
    const { session } = harness({
      onPost: message => {
        if (message.type !== 'build-append') return;
        if (++appends === 1) setTimeout(() => { marker = true; }, 0);
        else if (appends === 2) sawMarkerOnSecondAppend = marker;
      },
      readInsightsPage: async () => ({ rows: Array.from({ length: 2001 }, (_, uid) => ({ uid })), nextCursor: null }),
    });
    await session.load(scope);
    expect(sawMarkerOnSecondAppend).toBe(true);
    session.dispose();
  });

  it('drains all pages before building and reports partial coverage honestly', async () => {
    const { session, operations } = harness();
    const progress = [];
    await session.load({ ...scope, onProgress: value => progress.push(value) });
    expect(operations.filter(op => op?.type === 'build-commit')).toHaveLength(1);
    expect(operations.filter(op => op?.type === 'build-append').flatMap(op => op.copies)).toEqual([{ uid: 1 }, { uid: 2 }]);
    expect(progress.at(-1)).toMatchObject({ loaded: 2, coverage: { status: 'partial' } });
    expect(operations).toContainEqual(['release', 'snap']);
    expect(await session.query({ direction: 'received' })).toEqual({ totals: { received: 2 } });
    session.dispose();
  });
  it('cancels an old snapshot and never builds its rows after a scope switch', async () => {
    const first = deferred(); let n=0;
    const { session, operations } = harness({ beginInsightsSnapshot: () => ++n===1 ? first.promise : Promise.resolve({ snapshotId:'new', coverage:{} }) });
    const old = session.load(scope).catch(error => error.name);
    await session.load({ ...scope, accountIds: ['b'] });
    first.resolve({ snapshotId: 'old', coverage: {} });
    expect(await old).toBe('AbortError');
    expect(operations).toContainEqual(['release', 'old']);
    expect(operations.filter(op=>op?.type==='build-commit')).toHaveLength(1);
    session.dispose();
  });
  it('keeps a read failure as an error instead of building a false empty model', async () => {
    const { session, operations } = harness({ readInsightsPage: async () => { throw new Error('Vault disconnected'); } });
    await expect(session.load(scope)).rejects.toThrow('Vault disconnected');
    expect(operations.some(op=>op?.type?.startsWith('build'))).toBe(false);
    expect(operations).toContainEqual(['release','snap']);
    session.dispose();
  });
  it('refuses stale snapshots rather than joining mixed generations', async () => {
    const { session, operations } = harness({ readInsightsPage: async () => ({ rows: [{ uid: 4 }], nextCursor: null, coverage: { status: 'stale' } }) });
    await expect(session.load(scope)).rejects.toMatchObject({ code: 'stale' });
    expect(operations.some(op=>op?.type?.startsWith('build'))).toBe(false);
    session.dispose();
  });
  it('rejects pending worker work when disposed and releases the native snapshot', async () => {
    const pending = deferred();
    const { session, operations } = harness({ readInsightsPage: () => pending.promise });
    const load = session.load(scope).catch(error=>error.name);
    await Promise.resolve(); session.dispose();
    pending.resolve({ rows: [], nextCursor:null, coverage:{} });
    expect(await load).toBe('AbortError');
    expect(operations).toContain('terminated');
    expect(operations).toContainEqual(['release', 'snap']);
  });
  it('rejects queries before a model exists', async () => {
    const { session } = harness();
    await expect(session.query({})).rejects.toThrow(/ready/i);
    session.dispose();
  });
});

describe('Insights session snapshot retries', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
  const stale = () => ({ code: 'snapshotStale', coverage: { status: 'stale' } });

  it('retries a changing initial inventory after backoff and builds only the completed scan', async () => {
    let begins = 0;
    const { session, operations } = harness({ beginInsightsSnapshot: async () => {
      if (++begins < 3) throw stale();
      return { snapshotId: 'stable', inventoryCount: 2, coverage: { status: 'reading' } };
    } });
    const load = session.load(scope).catch(error => error);
    await vi.advanceTimersByTimeAsync(249); expect(begins).toBe(1);
    await vi.advanceTimersByTimeAsync(1); expect(begins).toBe(2);
    await vi.advanceTimersByTimeAsync(499); expect(begins).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(await load).toMatchObject({ loaded: 2, coverage: { status: 'partial' } });
    expect(begins).toBe(3);
    expect(operations.filter(op => op?.type === 'build-commit')).toHaveLength(1);
    expect(operations).toContainEqual(['release', 'stable']);
    session.dispose();
  });

  it('releases an invalidated paged snapshot and discards its rows before a fresh attempt', async () => {
    let begins = 0;
    const { session, operations } = harness({
      beginInsightsSnapshot: async () => ({ snapshotId: ++begins === 1 ? 'old' : 'new', coverage: { status: 'reading' } }),
      readInsightsPage: async (id, cursor) => {
        if (id === 'old' && cursor == null) return { rows: [{ uid: 900 }], nextCursor: 'old-next' };
        if (id === 'old') throw stale();
        return { rows: [{ uid: 2 }], nextCursor: null, coverage: { status: 'ready' } };
      },
    });
    const progress = [], load = session.load({ ...scope, onProgress: value => progress.push(value.loaded) }).catch(error => error);
    await vi.advanceTimersByTimeAsync(250);
    expect(await load).toMatchObject({ loaded: 1 });
    expect(operations.filter(op => op?.type === 'build-append').flatMap(op => op.copies)).toEqual([{ uid: 2 }]);
    expect(operations.filter(op => op?.type === 'build-commit')).toHaveLength(1);
    expect(operations.filter(op => op?.[0] === 'release')).toEqual([['release', 'old'], ['release', 'new']]);
    expect(progress).toEqual([0, 1, 0, 1]);
    session.dispose();
  });

  it('retries a stale coverage response without building any of its records', async () => {
    let begins = 0;
    const { session, operations } = harness({
      beginInsightsSnapshot: async () => ({ snapshotId: `attempt-${++begins}`, coverage: {} }),
      readInsightsPage: async () => begins === 1
        ? { rows: [{ uid: 900 }], nextCursor: null, coverage: { status: 'stale' } }
        : { rows: [{ uid: 2 }], nextCursor: null, coverage: { status: 'ready' } },
    });
    const load = session.load(scope).catch(error => error);
    await vi.advanceTimersByTimeAsync(250);
    expect(await load).toMatchObject({ loaded: 1 });
    expect(operations.filter(op => op?.type === 'build-append').flatMap(op => op.copies)).toEqual([{ uid: 2 }]);
    expect(operations.filter(op => op?.type === 'build-commit')).toHaveLength(1);
    session.dispose();
  });

  it('stops after four attempts and preserves the stale code with a readable error', async () => {
    let begins = 0;
    const { session, operations } = harness({ beginInsightsSnapshot: async () => { ++begins; throw stale(); } });
    const load = session.load(scope).catch(error => error);
    await vi.advanceTimersByTimeAsync(1749); expect(begins).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    const error = await load;
    expect(begins).toBe(4);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ code: 'snapshotStale', coverage: { status: 'stale' } });
    expect(error.message).toMatch(/refresh/i);
    expect(operations.some(op => op?.type?.startsWith('build'))).toBe(false);
    await vi.advanceTimersByTimeAsync(10000); expect(begins).toBe(4);
    session.dispose();
  });

  it('does not retry a non-stale failure', async () => {
    let begins = 0;
    const failure = new Error('Vault disconnected');
    const { session } = harness({ beginInsightsSnapshot: async () => { ++begins; throw failure; } });
    expect(await session.load(scope).catch(error => error)).toBe(failure);
    await vi.advanceTimersByTimeAsync(10000); expect(begins).toBe(1);
    session.dispose();
  });

  it('cancels a backoff immediately and never starts another native attempt', async () => {
    let begins = 0;
    const { session, operations } = harness({ beginInsightsSnapshot: async () => { ++begins; throw stale(); } });
    const load = session.load(scope).catch(error => error);
    await vi.advanceTimersByTimeAsync(100);
    session.dispose();
    expect(await load).toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(10000); expect(begins).toBe(1);
    expect(operations.some(op => op?.type?.startsWith('build'))).toBe(false);
  });
});
