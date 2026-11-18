// The phone's saved views (desktop's views, kept and run by the engine: `mobile.views.*`, engine
// `views.rs`): the list in desktop's order and each view's count, for the folder drawer and
// Settings > Views. The list loads once at launch, again after an import and after every change
// made on the Views page; the counts each time the drawer opens and after a change.
import { create } from 'zustand';
import { daemonCall } from './transport.js';
import { viewLimitReached } from '../utils/viewLimit.js';

const listOf = (reply) => (Array.isArray(reply?.views) ? reply.views : null);

export const useViewStore = create((set, get) => ({
  views: [],
  /** view id -> how many messages it finds (none while the phone has no search index). */
  counts: {},

  loadViews: async () => {
    const reply = await daemonCall('mobile.views.list', {});
    set({ views: Array.isArray(reply?.views) ? reply.views : [] });
  },

  /** Makes the view or edits the one of its id; rejects with the engine's refusal (`PREMIUM_REQUIRED`, `INVALID`). */
  saveView: async (view) => {
    const reply = await daemonCall('mobile.views.save', { view });
    await get().loadViews().catch(() => {});
    void get().loadCounts();
    return reply?.view ?? view;
  },

  deleteView: async (id) => {
    const reply = await daemonCall('mobile.views.delete', { id });
    const views = listOf(reply);
    if (views) set({ views });
    void get().loadCounts();
  },

  reorderViews: async (ids) => {
    // Shown at once; the engine's order comes back (or the old one, when it refused).
    const before = get().views;
    set({ views: ids.map((id) => before.find((v) => v.id === id)).filter(Boolean) });
    try {
      const views = listOf(await daemonCall('mobile.views.reorder', { ids }));
      if (views) set({ views });
    } catch (cause) {
      set({ views: before });
      throw cause;
    }
  },

  /**
   * Make a view, or say why not (desktop's createView): `{ ok: true, view }`, or `{ ok: false,
   * reason: 'limit' }` when the free plan is full here or the engine refuses with
   * PREMIUM_REQUIRED. Asked against the stored list, not the one on screen.
   */
  createView: async (view, premium) => {
    const views = await get().loadViews().then(() => get().views, () => get().views);
    if (viewLimitReached(views, premium)) return { ok: false, reason: 'limit' };
    try {
      return { ok: true, view: await get().saveView(view) };
    } catch (cause) {
      if (cause?.code === 'PREMIUM_REQUIRED') return { ok: false, reason: 'limit' };
      throw cause;
    }
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
