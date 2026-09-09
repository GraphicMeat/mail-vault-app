import {t} from '../i18n';

const aborted = () => new DOMException('Insights request cancelled', 'AbortError');
const waitForRetry = (milliseconds, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(aborted()); return; }
  const cancel = () => { clearTimeout(timer); reject(aborted()); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, milliseconds);
  signal.addEventListener('abort', cancel, { once: true });
});

/** Owns native snapshot and worker lifetimes without reading or mutating mail UI state. */
export function createInsightsSession({ api, workerFactory }) {
  const worker = workerFactory();
  const pending = new Map();
  let disposed = false, ready = false, nextId = 0, generation = 0, current = null;
  const rejectPending = error => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
  };
  const receive = ({ data }) => {
    const entry = pending.get(data?.requestId);
    if (!entry) return;
    clearTimeout(entry.timer); pending.delete(data.requestId);
    if (data.type === 'error') entry.reject(Object.assign(new Error(data.payload?.message || 'Insights query failed'), data.payload));
    else entry.resolve(data.payload);
  };
  const workerError = event => rejectPending(new Error(event.message || 'Insights worker stopped'));
  worker.addEventListener('message', receive);
  worker.addEventListener('error', workerError);
  const request = (type, payload) => new Promise((resolve, reject) => {
    if (disposed) { reject(aborted()); return; }
    const requestId = ++nextId;
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('Insights query timed out')); }, 60000);
    pending.set(requestId, { resolve, reject, timer });
    try { worker.postMessage({ type, requestId, ...payload }); }
    catch (error) { clearTimeout(timer); pending.delete(requestId); reject(error); }
  });
  const release = async run => {
    if (!run?.snapshotId) return;
    const id = run.snapshotId; run.snapshotId = null;
    try { await api.releaseInsightsSnapshot(id); } catch { /* Native inactivity expiry remains the fallback. */ }
  };
  const cancel = () => {
    if (current) { current.controller.abort(); void release(current); }
    rejectPending(aborted());
  };
  return {
    async load({ accountIds, accounts, ownAddressesByAccount, onProgress = () => {} }) {
      if (disposed) throw aborted();
      cancel();
      const run = { generation: ++generation, controller: new AbortController(), snapshotId: null };
      current = run;
      const assertCurrent = () => { if (disposed || run.generation !== generation || run.controller.signal.aborted) throw aborted(); };
      const backoff = [250, 500, 1000];
      for (let attempt = 0; attempt <= backoff.length; attempt++) {
        try {
          assertCurrent();
          const start = await api.beginInsightsSnapshot(accountIds, { signal: run.controller.signal });
          run.snapshotId = start.snapshotId;
          assertCurrent();
          // Each attempt owns fresh rows/cursors. A stale partial inventory
          // must never be joined to the following generation or reach a worker.
          const copies = [], visited = new Set();
          let cursor = null, coverage = start.coverage;
          onProgress({ loaded: 0, total: start.inventoryCount ?? null, coverage });
          do {
            const page = await api.readInsightsPage(run.snapshotId, cursor, { signal: run.controller.signal });
            assertCurrent();
            coverage = page.coverage || coverage;
            if (coverage?.status === 'stale') throw Object.assign(new Error(t('insights.failed')), { code: 'stale', coverage });
            if (!Array.isArray(page.rows)) throw Object.assign(new Error(t('insights.failed')), {code:'invalid-page'});
            copies.push(...page.rows);
            cursor = page.nextCursor ?? null;
            if (cursor !== null && visited.has(cursor)) throw Object.assign(new Error(t('insights.failed')), {code:'repeated-cursor'});
            visited.add(cursor);
            onProgress({ loaded: copies.length, total: start.inventoryCount ?? copies.length, coverage });
          } while (cursor !== null);
          const build = await request('build-start', { accounts, ownAddressesByAccount });
          assertCurrent();
          const buildId = build?.buildId;
          if (!buildId) throw new Error(t('insights.failed'));
          for (let offset = 0; offset < copies.length; offset += 1000) {
            assertCurrent();
            await request('build-append', { buildId, copies: copies.slice(offset, offset + 1000) });
            assertCurrent();
            if (offset + 1000 < copies.length) await waitForRetry(0, run.controller.signal);
          }
          assertCurrent();
          await request('build-commit', { buildId });
          assertCurrent(); ready = true;
          return { coverage, loaded: copies.length };
        } catch (error) {
          assertCurrent();
          if (!['snapshotStale', 'stale'].includes(error?.code)) throw error;
          if (attempt === backoff.length) {
            throw Object.assign(new Error(t('insights.failed')), { code: error.code, coverage: error.coverage });
          }
        } finally { await release(run); }
        await waitForRetry(backoff[attempt], run.controller.signal);
      }
    },
    query(query) { return !ready ? Promise.reject(new Error('Insights model is not ready')) : request('query', { query }); },
    messages(query, selection) { return !ready ? Promise.reject(new Error('Insights model is not ready')) : request('messages', { query, selection }); },
    dispose() {
      if (disposed) return;
      disposed = true; ++generation; cancel();
      worker.removeEventListener('message', receive); worker.removeEventListener('error', workerError);
      worker.terminate();
    },
  };
}
