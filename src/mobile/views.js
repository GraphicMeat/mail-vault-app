// The phone's saved views (desktop's views, kept and run by the engine: `mobile.views.*`, engine
// `views.rs`): the list in desktop's order and each view's count, for the folder drawer. The
// list loads once at launch and again after an import; the counts each time the drawer opens.
import { create } from 'zustand';
import { daemonCall } from './transport.js';

export const useViewStore = create((set) => ({
  views: [],
  /** view id -> how many messages it finds (none while the phone has no search index). */
  counts: {},

  loadViews: async () => {
    const reply = await daemonCall('mobile.views.list', {});
    set({ views: Array.isArray(reply?.views) ? reply.views : [] });
  },

  loadCounts: async () => {
    try {
      const reply = await daemonCall('mobile.views.counts', {});
      set({ counts: reply?.counts && typeof reply.counts === 'object' ? reply.counts : {} });
    } catch {
      // A count that would not come is not worth an error in the drawer.
    }
  },
}));

let loading = null;

/** Loads the view list once; a failed load is asked again by the next call. */
export function ensureViews() {
  if (!loading) {
    loading = useViewStore.getState().loadViews().catch(() => { loading = null; });
  }
  return loading;
}

/** After an import brought views: the list again. */
export function refreshViews() {
  loading = useViewStore.getState().loadViews().catch(() => { loading = null; });
  return loading;
}

/** Tests: back to a phone that has asked for nothing. */
export function resetViewsForTests() {
  loading = null;
  useViewStore.setState({ views: [], counts: {} });
}
