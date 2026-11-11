import { create } from 'zustand';
import { daemonCall } from '../services/daemonClient';
import { myAddresses } from './myAddresses';

const PAGE = 50;

let listSeq = 0;
// Fast scrolling fires loadMore again before the first page lands; both calls
// would ask for the same offset and append the same page twice.
let loadingMore = false;

const initial = { items: [], total: 0, query: '', sort: 'last', status: 'idle', error: null };

const fetchPage = ({ query, sort }, offset) =>
  daemonCall('people.senders', { query, sort, ownAddresses: myAddresses(), limit: PAGE, offset });

/** The paged All senders list: everyone who has emailed the user, saved or not. */
export const useSendersStore = create((set, get) => ({
  ...initial,

  load: async () => {
    const seq = ++listSeq;
    set({ status: 'loading', error: null });
    try {
      const r = await fetchPage(get(), 0);
      if (seq !== listSeq) return;
      set({ items: r.items, total: r.total, status: 'idle' });
    } catch (e) {
      if (seq === listSeq) set({ error: e?.message || String(e), status: 'idle' });
    }
  },
  loadMore: async () => {
    const { items, total } = get();
    if (loadingMore || items.length >= total) return;
    loadingMore = true;
    const seq = listSeq;
    try {
      const r = await fetchPage(get(), items.length);
      if (seq !== listSeq) return;
      set({ items: [...get().items, ...r.items], total: r.total });
    } catch (e) {
      if (seq === listSeq) set({ error: e?.message || String(e) });
    } finally {
      loadingMore = false;
    }
  },
  setQuery: (query) => { set({ query }); return get().load(); },
  setSort: (sort) => { set({ sort }); return get().load(); },
  reset: () => { ++listSeq; set({ ...initial }); },
}));
