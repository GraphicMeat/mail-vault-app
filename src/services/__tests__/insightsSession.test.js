import { describe, expect, it } from 'vitest';
import { BUILD_PROGRESS_EVENT, createInsightsSession } from '../insightsSession';

/**
 * The session only follows a daemon build (insights.build and its
 * insights-build-progress frames) and asks the built model. The walk, the
 * stale retries and the aggregation are the daemon's
 * (src-daemon/src/handlers/insights_aggregate.rs) and tested there.
 */
function harness(overrides = {}) {
  const calls = [], listeners = new Map();
  const emit = (event, payload) => { for (const fn of listeners.get(event) || []) fn({ payload }); };
  const listen = async (event, fn) => {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => listeners.get(event).delete(fn);
  };
  const api = {
    buildInsights: async (buildId, scope) => {
      calls.push(['build', buildId, scope]);
      if (overrides.onBuild) overrides.onBuild(buildId, emit);
      else queueMicrotask(() => {
        emit(BUILD_PROGRESS_EVENT, { buildId, loaded: 0, total: 2, coverage: { status: 'reading' } });
        emit(BUILD_PROGRESS_EVENT, { buildId, loaded: 2, total: 2, coverage: { status: 'partial' } });
        emit(BUILD_PROGRESS_EVENT, { buildId, finished: true, ok: true, loaded: 2, coverage: { status: 'partial' } });
      });
      return { ok: true, buildId };
    },
    insightsStatus: async buildId => { calls.push(['status', buildId]); return overrides.status || { ok: true, state: 'ready', loaded: 2, coverage: { status: 'ready' } }; },
    aggregateInsights: async (buildId, query) => { calls.push(['aggregate', buildId, query]); return overrides.aggregate ? overrides.aggregate(buildId, calls) : { totals: { received: 2 } }; },
    insightsMessages: async (buildId, query, selection) => { calls.push(['messages', buildId, query, selection]); return [{ key: 'one' }]; },
    releaseInsights: async buildId => { calls.push(['release', buildId]); },
  };
  return { session: createInsightsSession({ api, listen }), calls, emit, listeners };
}
const scope = { accountIds: ['a'], accounts: [{ id: 'a' }], ownAddressesByAccount: { a: ['me@test'] } };
const builds = calls => calls.filter(c => c[0] === 'build').map(c => c[1]);
const listening = listeners => [...listeners.values()].reduce((n, set) => n + set.size, 0);

describe('Insights session over the daemon model', () => {
  it('follows the build frames and answers queries from the built model', async () => {
    const { session, calls, listeners } = harness();
    const progress = [];
    expect(await session.load({ ...scope, onProgress: p => progress.push(p) })).toEqual({ coverage: { status: 'partial' }, loaded: 2 });
    expect(progress).toEqual([
      { loaded: 0, total: 2, coverage: { status: 'reading' } },
      { loaded: 2, total: 2, coverage: { status: 'partial' } },
    ]);
    expect(calls[0][2]).toEqual(scope);
    const [id] = builds(calls);
    expect(await session.query({ direction: 'both' })).toEqual({ totals: { received: 2 } });
    expect(await session.messages({ direction: 'both' }, { messageKey: 'one' })).toEqual([{ key: 'one' }]);
    expect(calls).toContainEqual(['aggregate', id, { direction: 'both' }]);
    expect(calls).toContainEqual(['messages', id, { direction: 'both' }, { messageKey: 'one' }]);
    expect(listening(listeners)).toBe(0);
    session.dispose();
    expect(calls.at(-1)).toEqual(['release', id]);
  });

  it('ignores frames of another build', async () => {
    const { session } = harness({ onBuild: (buildId, emit) => queueMicrotask(() => {
      emit(BUILD_PROGRESS_EVENT, { buildId: 'someone-else', finished: true, ok: false, error: { code: 'vaultUnavailable' } });
      emit(BUILD_PROGRESS_EVENT, { buildId, finished: true, ok: true, loaded: 1, coverage: { status: 'ready' } });
    }) });
    expect(await session.load(scope)).toMatchObject({ loaded: 1 });
    session.dispose();
  });

  it('rejects with the daemon code and coverage, and releases the failed build', async () => {
    const { session, calls } = harness({ onBuild: (buildId, emit) => queueMicrotask(() =>
      emit(BUILD_PROGRESS_EVENT, { buildId, finished: true, ok: false, error: { code: 'snapshotStale', message: 'insights.failed', coverage: { status: 'stale' } } })) });
    const error = await session.load(scope).catch(e => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ code: 'snapshotStale', coverage: { status: 'stale' } });
    expect(error.message).toMatch(/refresh/i);
    expect(calls.at(-1)).toEqual(['release', builds(calls)[0]]);
    await expect(session.query({})).rejects.toMatchObject({ code: 'modelNotReady' });
    session.dispose();
  });

  it('cancels the running build when a new scope loads, and never adopts it', async () => {
    let hold;
    const { session, calls, emit } = harness({ onBuild: (buildId, send) => { if (!hold) hold = buildId; else queueMicrotask(() => send(BUILD_PROGRESS_EVENT, { buildId, finished: true, ok: true, loaded: 1, coverage: {} })); } });
    const old = session.load(scope).catch(e => e.name);
    await new Promise(r => setTimeout(r, 0));
    const fresh = await session.load({ ...scope, accountIds: ['b'] });
    expect(await old).toBe('AbortError');
    expect(fresh).toMatchObject({ loaded: 1 });
    // The cancelled build's last frame arrives late and changes nothing.
    emit(BUILD_PROGRESS_EVENT, { buildId: hold, finished: true, ok: true, loaded: 9, coverage: {} });
    const [first, second] = builds(calls);
    expect(calls).toContainEqual(['release', first]);
    await session.query({});
    expect(calls.at(-1)[1]).toBe(second);
    session.dispose();
  });

  it('stops following a build when disposed and releases it', async () => {
    const { session, calls, listeners } = harness({ onBuild: () => {} });
    const pending = session.load(scope).catch(e => e.name);
    await new Promise(r => setTimeout(r, 0));
    session.dispose();
    expect(await pending).toBe('AbortError');
    expect(calls).toContainEqual(['release', builds(calls)[0]]);
    expect(listening(listeners)).toBe(0);
    await expect(session.load(scope)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('asks where the build is when the event stream lagged', async () => {
    const { session, calls, emit } = harness({ onBuild: () => queueMicrotask(() => emit('daemon-events-lagged', {})) });
    expect(await session.load(scope)).toEqual({ coverage: { status: 'ready' }, loaded: 2 });
    expect(calls.some(c => c[0] === 'status')).toBe(true);
    session.dispose();
  });

  it('fails a build the restarted daemon lost', async () => {
    const { session, emit } = harness({ onBuild: () => queueMicrotask(() => emit('daemon-reconnected', {})) });
    await expect(session.load(scope)).rejects.toMatchObject({ code: 'daemonRestarted' });
    session.dispose();
  });

  it('builds again once when the daemon dropped an idle model', async () => {
    let first = true;
    const { session, calls } = harness({ aggregate: () => {
      if (first) { first = false; throw Object.assign(new Error('x'), { code: 'modelExpired' }); }
      return { totals: { received: 5 } };
    } });
    await session.load(scope);
    expect(await session.query({})).toEqual({ totals: { received: 5 } });
    const [one, two] = builds(calls);
    expect(two).toBeTruthy();
    expect(calls).toContainEqual(['release', one]);
    session.dispose();
  });
});
