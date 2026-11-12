import { create } from 'zustand';
import { daemonCall } from '../services/daemonClient';
import { myAddresses } from './myAddresses';

const PAGE = 50;

let listSeq = 0;
let mailSeq = 0;
// Fast scrolling fires loadMore again before the first page lands; both calls
// would ask for the same offset and append the same page twice.
let loadingMore = false;
// Same for the mail pager; holds the mailSeq it started under, so a page still
// in flight for the previous contact does not block the next one.
let loadingMoreMail = null;

const initial = {
  items: [], total: 0, indexReady: true, indexing: false,
  query: '', sort: 'name', vipOnly: false,
  selectedId: null, card: null, sender: null, stats: {},
  mail: [], mailNext: null, mailFilters: {}, mailLoading: false,
  review: [], journal: [], proposals: [],
  changed: 0, // writes that can change who owns an address or whether it is a favorite
  status: 'idle', error: null,
};

// What the mail pager reads: a saved contact by id, else an unsaved sender by address.
function mailTarget({ selectedId, sender }) {
  if (selectedId && selectedId !== 'new') return { id: selectedId };
  return sender ? { address: sender.address } : null;
}

export const usePeopleStore = create((set, get) => {
  const fail = (e) => { set({ error: e?.message || String(e), status: 'idle' }); return null; };
  const run = async (fn) => {
    try { set({ error: null }); return await fn(); }
    catch (e) { return fail(e); }
  };
  // A contact write: tell other lists (senders, email people) to re-resolve, then reload this one.
  const reloadAfterWrite = async () => { set((s) => ({ changed: s.changed + 1 })); await get().load(); };
  const refresh = async () => { await reloadAfterWrite(); if (get().selectedId) await get().select(get().selectedId); };

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
      if (loadingMore || items.length >= total) return;
      loadingMore = true;
      try {
        const seq = listSeq;
        const r = await run(() => daemonCall('people.list', { query, sort, vipOnly, limit: PAGE, offset: items.length }));
        if (!r || seq !== listSeq) return;
        set({ items: [...get().items, ...r.items], total: r.total });
      } finally {
        loadingMore = false;
      }
    },
    // Lookups for the merge dialog: they touch no list state.
    searchPeople: async (query) => {
      const r = await run(() => daemonCall('people.list', { query, sort: 'name', vipOnly: false, limit: 20, offset: 0 }));
      return r?.items || [];
    },
    // A proposal row can name a contact that is gone: that renders nothing, not a banner.
    fetchCard: async (id) => { try { return await daemonCall('people.get', { id }); } catch { return null; } },
    setQuery: (query) => { set({ query }); return get().load(); },
    setSort: (sort) => { set({ sort }); return get().load(); },
    setVipOnly: (vipOnly) => { set({ vipOnly }); return get().load(); },

    select: async (id) => {
      const same = !!id && id !== 'new' && get().selectedId === id;
      // The mail list only refetches when the target changes, so re-picking the open contact must not blank it.
      if (!same) ++mailSeq; // a mail page still in flight for the previous contact is stale now
      set({ selectedId: id, card: null, sender: null, ...(same ? {} : { mail: [], mailNext: null, mailLoading: false }) });
      if (!id || id === 'new') return; // 'new' is the unsaved draft: nothing to fetch
      let card;
      try { set({ error: null }); card = await daemonCall('people.get', { id }); }
      catch (e) {
        if (get().selectedId !== id) return;
        // Deleted or undone while selected: nothing to show, not an error.
        if (/E_NOT_FOUND/.test(e?.message || '')) set({ selectedId: null, card: null });
        else fail(e);
        return;
      }
      if (get().selectedId !== id) return;
      set({ card });
      if (same) get().loadMail(get().mailFilters);
      get().refreshStats([id]);
    },
    // An unsaved sender is selected by address: it has no card, and its stats are keyed by address.
    selectSender: async ({ address, name = '' }) => {
      const same = !get().selectedId && get().sender?.address === address;
      if (!same) ++mailSeq;
      set({ selectedId: null, card: null, sender: { address, name }, ...(same ? {} : { mail: [], mailNext: null, mailLoading: false }) });
      if (same) get().loadMail(get().mailFilters);
      await get().refreshStats([], [address]);
    },
    refreshStats: async (ids, addresses = []) => {
      if (!ids.length && !addresses.length) return;
      const r = await run(() => daemonCall('people.stats', { ids, addresses, ownAddresses: myAddresses() }));
      if (r) set({ stats: { ...get().stats, ...r } });
    },

    loadMail: async (filters = {}) => {
      const target = mailTarget(get());
      if (!target) return;
      const seq = ++mailSeq;
      set({ mailFilters: filters, mailLoading: true });
      const r = await run(() => daemonCall('people.messages', { ...target, ownAddresses: myAddresses(), limit: PAGE, ...filters }));
      if (seq !== mailSeq) return;
      set({ mail: r?.items || [], mailNext: r?.next || null, mailLoading: false });
    },
    loadMoreMail: async () => {
      const { mailNext, mailFilters, mail } = get();
      const target = mailTarget(get());
      const seq = mailSeq;
      if (!target || !mailNext || loadingMoreMail === seq) return;
      loadingMoreMail = seq;
      try {
        const r = await run(() => daemonCall('people.messages', { ...target, ownAddresses: myAddresses(), limit: PAGE, ...mailFilters, after: mailNext }));
        if (!r || seq !== mailSeq) return;
        set({ mail: [...mail, ...r.items], mailNext: r.next });
      } finally {
        if (loadingMoreMail === seq) loadingMoreMail = null;
      }
    },

    // Lookups for the contacts view: address -> { personId, favorite }; they touch no list state.
    owners: async (addresses) => (await run(() => daemonCall('people.owners', { addresses }))) || {},
    // A saved sender becomes a contact and is selected as one.
    saveSender: async ({ address, name = '' }) => {
      const r = await run(() => daemonCall('people.review.accept', { items: [{ address, name }] }));
      const id = r?.ids?.[0];
      if (!id) return null;
      await get().select(id);
      await reloadAfterWrite();
      return id;
    },
    // A favorite is always a contact: save first, then star.
    favoriteSender: async (row) => {
      const id = await get().saveSender(row);
      if (id) await get().update(id, { vip: true });
      return id;
    },

    create: async (fields) => {
      const card = await run(() => daemonCall('people.create', fields));
      if (card) { await reloadAfterWrite(); await get().select(card.id); await get().loadProposals(); }
      return card;
    },
    update: async (id, patch) => {
      const card = await run(() => daemonCall('people.update', { id, patch }));
      if (card) { if (get().selectedId === id) set({ card }); await reloadAfterWrite(); }
      return card;
    },
    remove: async (id) => {
      const ok = await run(() => daemonCall('people.delete', { id }));
      if (ok) { set({ selectedId: null, card: null }); await reloadAfterWrite(); await get().loadProposals(); }
      return ok;
    },

    previewMerge: (ids, keepId) => run(() => daemonCall('people.merge_preview', { ids, keepId })),
    merge: async (ids, keepId) => {
      const card = await run(() => daemonCall('people.merge', { ids, keepId }));
      if (card) { await reloadAfterWrite(); await get().select(card.id); await get().loadProposals(); }
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
      await get().loadProposals();
      return r;
    },

    loadReview: async () => {
      const r = await run(() => daemonCall('people.review.list', { ownAddresses: myAddresses(), limit: 100 }));
      if (r) set({ review: r });
    },
    acceptReview: async (items) => {
      const r = await run(() => daemonCall('people.review.accept', { items }));
      await get().loadReview();
      await reloadAfterWrite();
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
      await reloadAfterWrite();
      await get().loadProposals();
      return r;
    },

    applyIndexEvent: ({ done }) => {
      const finished = !!done && !get().indexReady;
      set({ indexReady: !!done, indexing: !done });
      if (!finished) return;
      // The counts and the list were built on a partial index.
      reloadAfterWrite();
      const id = get().selectedId;
      if (id && id !== 'new') get().refreshStats([id]);
      else if (get().sender) get().refreshStats([], [get().sender.address]);
    },
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
