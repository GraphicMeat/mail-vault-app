import { send } from './transport.js';

// The offline search index lives in the app process (Tauri), never the daemon.
export const configure = (config) => send('search_index_configure', { config }).catch((e) => console.warn('[searchIndex] configure failed:', e));
export const status = () => send('search_index_status', {}).catch(() => ({ available: false }));
export const rebuild = () => send('search_index_rebuild', {});
export async function onProgress(cb) {
  try {
    const { listen } = await import('@tauri-apps/api/event');
    return await listen('search-index-progress', (e) => cb(e.payload));
  } catch {
    return () => {};
  }
}
