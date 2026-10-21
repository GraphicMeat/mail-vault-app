import { insightsFailure } from './insightsApi.js';

export const BUILD_PROGRESS_EVENT = 'insights-build-progress';

const aborted = () => new DOMException('Insights request cancelled', 'AbortError');
const newBuildId = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const tauriListen = (event, handler) => import('@tauri-apps/api/event').then(module => module.listen(event, handler));

/**
 * One Insights workspace visit's model, held by the daemon. `load` asks the
 * daemon to build it (the snapshot walk, the stale retries and the
 * aggregation all run there) and follows its progress frames; `query` and
 * `messages` ask that model. The session reads and changes no mail state.
 */
export function createInsightsSession({ api, listen = tauriListen }) {
  let disposed = false, run = null, buildId = null, lastScope = null;
  const release = id => { if (id) api.releaseInsights(id).catch(() => { /* Daemon idle expiry is the fallback. */ }); };
  const cancelRun = () => { run?.cancel(); run = null; };

  async function build(scope, onProgress) {
    const id = newBuildId();
    let settle;
    const finished = new Promise((resolve, reject) => { settle = { resolve, reject }; });
    finished.catch(() => {});
    const mine = { cancelled: false, cancel() { this.cancelled = true; settle.reject(aborted()); release(id); } };
    run = mine;
    const unlisten = [];
    try {
      // The listener is up before the build starts, so a build that ends
      // before its reply lands is still heard.
      unlisten.push(await listen(BUILD_PROGRESS_EVENT, ({ payload }) => {
        if (payload?.buildId !== id) return;
        if (!payload.finished) onProgress({ loaded: payload.loaded, total: payload.total ?? null, coverage: payload.coverage });
        else if (payload.ok) settle.resolve(payload);
        else settle.reject(insightsFailure(payload.error));
      }));
      // A restarted daemon lost the build; a lagging stream may have dropped
      // the last frame, so ask where it is.
      unlisten.push(await listen('daemon-reconnected', () => settle.reject(insightsFailure({ code: 'daemonRestarted' }))));
      unlisten.push(await listen('daemon-events-lagged', () => {
        api.insightsStatus(id).then(status => { if (status.state === 'ready') settle.resolve(status); }, error => settle.reject(error));
      }));
      if (mine.cancelled) throw aborted();
      await api.buildInsights(id, scope);
      const done = await finished;
      if (mine.cancelled || disposed) throw aborted();
      return { id, coverage: done.coverage, loaded: done.loaded };
    } catch (error) {
      // Again after a cancel: that release may have reached the daemon
      // before the build did. This one follows the build's reply.
      release(id);
      throw mine.cancelled || disposed ? aborted() : error;
    } finally {
      if (run === mine) run = null;
      for (const stop of unlisten) { try { stop(); } catch { /* the other listeners still go */ } }
    }
  }

  async function load({ accountIds, accounts, ownAddressesByAccount, onProgress = () => {} }) {
    if (disposed) throw aborted();
    cancelRun();
    const scope = { accountIds, accounts, ownAddressesByAccount };
    const built = await build(scope, onProgress);
    const previous = buildId;
    buildId = built.id; lastScope = scope;
    if (previous !== built.id) release(previous);
    return { coverage: built.coverage, loaded: built.loaded };
  }

  /** Asks the model; a model the daemon dropped while idle is built again once. */
  async function ask(fn) {
    if (disposed) throw aborted();
    if (!buildId) throw insightsFailure({ code: 'modelNotReady' });
    try { return await fn(buildId); }
    catch (error) {
      if (error?.code !== 'modelExpired' || !lastScope) throw error;
      await load(lastScope);
      return fn(buildId);
    }
  }

  return {
    load,
    query: query => ask(id => api.aggregateInsights(id, query)),
    messages: (query, selection) => ask(id => api.insightsMessages(id, query, selection)),
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelRun();
      release(buildId); buildId = null;
    },
  };
}
