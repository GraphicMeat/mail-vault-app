import { send } from './transport.js';

// The offline search index lives in the daemon (spec 2026-09-14 §5). These go through DAEMON_OWNED.
export const configure = (config) => send('search_index_configure', { config }).catch((e) => console.warn('[searchIndex] configure failed:', e));
export const status = () => send('search_index_status', {}).catch(() => ({ available: false, state: 'unavailable' }));
export const rebuild = () => send('search_index_rebuild', {});
/** Resolves `{ok:true}` or `{ok:false, error:<catalog key>}`; rejects only when the daemon is unreachable. */
export const destroy = () => send('search_index_destroy', {});

async function listenTo(event, cb) {
  try {
    const { listen } = await import('@tauri-apps/api/event');
    return await listen(event, (e) => cb(e.payload));
  } catch {
    return () => {};
  }
}

export const onProgress = (cb) => listenTo('search-index-progress', cb);
/** A (re)started daemon holds no config and no status the UI has seen. */
export const onDaemonReconnected = (cb) => listenTo('daemon-reconnected', cb);
