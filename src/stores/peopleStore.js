import { create } from 'zustand';
import { daemonCall } from '../services/daemonClient';
import { useSettingsStore, selectOwnAddresses } from './settingsStore';
import { useMailStore } from './mailStore';

const PAGE = 50;

// Every address that is the user, across all accounts: login, default From, aliases.
function myAddresses() {
  const { accounts = [] } = useMailStore.getState();
  const settings = useSettingsStore.getState();
  const out = new Set();
  for (const account of accounts) {
    for (const a of selectOwnAddresses(settings, account)) out.add(a);
  }
  return [...out];
}

let listSeq = 0;
let mailSeq = 0;

const initial = {
  items: [], total: 0, indexReady: true, indexing: false,
  query: '', sort: 'name', vipOnly: false,
  selectedId: null, card: null, stats: {},
  mail: [], mailNext: null, mailFilters: {}, mailLoading: false,
  review: [], journal: [], proposals: [],
  status: 'idle', error: null,
};

export const usePeopleStore = create((set, get) => {
  const run = async (fn) => {
    try { set({ error: null }); return await fn(); }
    catch (e) { set({ error: e?.message || String(e), status: 'idle' }); return null; }
  };
  const refresh = async () => { await get().load(); if (get().selectedId) await get().select(get().selectedId); };

  return {
    ...initial,

    load: async () => {
      const seq = ++listSeq;
      set({ status: 'loading' });
      const { query, sort, vipOnly } = get();
      const r = await run(() => daemonCall('people.list', { query, sort, vipOnly, limit: PAGE, offset: 0 }));
      if (!r || seq !== listSeq) return;
      set({ items: r.items, total: r.total, indexReady: r.indexReady, status: 'idle' });
    },
    loadMore: async () => {
      const { items, total, query, sort, vipOnly } = get();
      if (items.length >= total) return;
      const seq = listSeq;
      const r = await run(() => daemonCall('people.list', { query, sort, vipOnly, limit: PAGE, offset: items.length }));
      if (!r || seq !== listSeq) return;
      set({ items: [...get().items, ...r.items], total: r.total });
    },
    setQuery: (query) => { set({ query }); return get().load(); },
    setSort: (sort) => { set({ sort }); return get().load(); },
    setVipOnly: (vipOnly) => { set({ vipOnly }); return get().load(); },

    select: async (id) => {
      set({ selectedId: id, card: null, mail: [], mailNext: null });
      if (!id || id === 'new') return; // 'new' is the unsaved draft: nothing to fetch
      const card = await run(() => daemonCall('people.get', { id }));
      if (get().selectedId !== id) return;
      set({ card });
      get().refreshStats([id]);
    },
    refreshStats: async (ids) => {
      if (!ids.length) return;
      const r = await run(() => daemonCall('people.stats', { ids, ownAddresses: myAddresses() }));
      if (r) set({ stats: { ...get().stats, ...r } });
    },

    loadMail: async (filters = {}) => {
      const id = get().selectedId;
      if (!id) return;
      const seq = ++mailSeq;
      set({ mailFilters: filters, mailLoading: true });
      const r = await run(() => daemonCall('people.messages', { id, ownAddresses: myAddresses(), limit: PAGE, ...filters }));
      if (seq !== mailSeq) return;
      set({ mail: r?.items || [], mailNext: r?.next || null, mailLoading: false });
    },
    loadMoreMail: async () => {
      const { selectedId: id, mailNext, mailFilters, mail } = get();
      if (!id || !mailNext) return;
      const seq = mailSeq;
      const r = await run(() => daemonCall('people.messages', { id, ownAddresses: myAddresses(), limit: PAGE, ...mailFilters, after: mailNext }));
      if (!r || seq !== mailSeq) return;
      set({ mail: [...mail, ...r.items], mailNext: r.next });
    },

    create: async (fields) => {
      const card = await run(() => daemonCall('people.create', fields));
      if (card) { await get().load(); await get().select(card.id); }
      return card;
    },
    update: async (id, patch) => {
      const card = await run(() => daemonCall('people.update', { id, patch }));
      if (card) { set({ card }); await get().load(); }
      return card;
    },
    remove: async (id) => {
      const ok = await run(() => daemonCall('people.delete', { id }));
      if (ok) { set({ selectedId: null, card: null }); await get().load(); }
      return ok;
    },

    previewMerge: (ids, keepId) => run(() => daemonCall('people.merge_preview', { ids, keepId })),
    merge: async (ids, keepId) => {
      const card = await run(() => daemonCall('people.merge', { ids, keepId }));
      if (card) { await get().load(); await get().select(card.id); await get().loadProposals(); }
      return card;
    },
    split: async (id, recordIds) => {
      const r = await run(() => daemonCall('people.split', { id, recordIds }));
      if (r) await refresh();
      return r;
    },
    undo: async () => {
      const r = await run(() => daemonCall('people.undo', {}));
      await refresh();
      await get().loadJournal();
      return r;
    },

    loadReview: async () => {
      const r = await run(() => daemonCall('people.review.list', { ownAddresses: myAddresses(), limit: 100 }));
      if (r) set({ review: r });
    },
    acceptReview: async (items) => {
      const r = await run(() => daemonCall('people.review.accept', { items }));
      await get().loadReview();
      await get().load();
      return r;
    },
    dismissReview: async (addresses) => {
      await run(() => daemonCall('people.review.dismiss', { addresses }));
      await get().loadReview();
    },
    loadJournal: async () => { const r = await run(() => daemonCall('people.journal', { limit: 30 })); if (r) set({ journal: r }); },
    loadProposals: async () => { const r = await run(() => daemonCall('people.proposals', {})); if (r) set({ proposals: r }); },
    importVcf: async (text) => {
      const r = await run(() => daemonCall('people.import_vcf', { text }));
      await get().load();
      return r;
    },

    applyIndexEvent: ({ done }) => set({ indexReady: !!done, indexing: !done }),
    reset: () => set({ ...initial }),
    initPeople: () => initPeople(),
  };
});

let initialized = false;
export async function initPeople() {
  if (initialized) return;
  initialized = true;
  try {
    const { listen } = await import('@tauri-apps/api/event');
    await listen('people-index-progress', e => usePeopleStore.getState().applyIndexEvent(e.payload || {}));
  } catch { /* no event bridge in tests or web preview */ }
}
