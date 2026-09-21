import { create } from 'zustand';
import { daemonCall } from '../services/daemonClient';
import { useMailStore } from './mailStore';
import { useSearchStore } from './searchStore.js';
import { getAccountCacheMailboxes } from '../services/cacheManager';
import { flattenMailboxes } from './slices/unifiedHelpers.js';
import { parseSearchQuery } from '../utils/searchQuery';

/// What a view is called. A starter carries no name in the database — storing
/// "Needs reply" there would pin one language into the store — so it is
/// translated by its builtin id, unless the person renamed it.
export function viewLabel(view, t) {
  if (view?.name) return view.name;
  if (view?.builtin) return t(`views.builtin.${view.builtin}`);
  return '';
}

/// The folders of one account, and which of them are its bin, junk and
/// archive. A folder's name is a per-mailbox word, so "not the bin" is only
/// answerable here, never in the daemon.
function accountPayload(account, mail) {
  const tree = getAccountCacheMailboxes(account.id)
    || (account.id === mail.activeAccountId ? mail.mailboxes : [])
    || [];
  const boxes = flattenMailboxes(tree);
  const specialUse = {};
  for (const box of boxes) {
    const use = box.specialUse || box.special_use;
    if (use && !specialUse[use]) specialUse[use] = box.path;
  }
  return {
    accountId: account.id,
    address: account.email || '',
    knownMailboxes: boxes.map(box => box.path).filter(Boolean),
    specialUse,
  };
}

function accountsPayload() {
  const mail = useMailStore.getState();
  return (mail.accounts || []).map(account => accountPayload(account, mail));
}

export const useViewStore = create((set, get) => ({
  views: [],
  /// View id → how many messages it holds, straight from the daemon. Never
  /// counted from the rows on screen: those are one page of one view.
  counts: {},
  activeViewId: null,
  /// Why the last evaluation could not answer ("building", "unavailable",
  /// "off"), or null. An empty list is a different statement.
  unavailableReason: null,
  loading: false,

  loadViews: async () => {
    const views = await daemonCall('views.list', {});
    set({ views: Array.isArray(views) ? views : [] });
    return get().views;
  },

  refreshCounts: async () => {
    try {
      const counts = await daemonCall('views.counts', { accounts: accountsPayload() });
      set({ counts: counts && typeof counts === 'object' ? counts : {} });
    } catch {
      // A count that would not come is not worth an error in the sidebar.
    }
  },

  openView: async (view) => {
    const id = typeof view === 'string' ? view : view?.id;
    if (!id) return false;
    set({ activeViewId: id, loading: true, unavailableReason: null });
    let reply;
    try {
      reply = await daemonCall('views.evaluate', { viewId: id, accounts: accountsPayload() });
    } catch (error) {
      set({ loading: false, unavailableReason: 'error' });
      console.warn('[views] could not run the view:', error?.message || error);
      return false;
    }
    set({ loading: false });
    if (!reply?.available) {
      // Not an empty view: the index could not answer at all.
      set({ unavailableReason: reply?.reason || 'unavailable' });
      return false;
    }
    useSearchStore.getState().showRows(reply.rows || []);
    return true;
  },

  closeView: () => {
    set({ activeViewId: null, unavailableReason: null });
    useSearchStore.getState().clearSearch();
  },

  saveView: async (view) => {
    const saved = await daemonCall('views.save', { view });
    await get().loadViews();
    return saved;
  },

  deleteView: async (id) => {
    await daemonCall('views.delete', { id });
    if (get().activeViewId === id) get().closeView();
    await get().loadViews();
  },

  /// The search on screen, as a view definition. `tags` are resolved from the
  /// names typed as `tag:` filters, so the saved view keeps working when a tag
  /// is renamed.
  defFromSearch: (tags = []) => {
    const { searchQuery, searchFilters } = useSearchStore.getState();
    const parsed = parseSearchQuery(searchQuery || '');
    const named = parsed.tags.map(name => tags
      .find(tag => tag.name?.toLocaleLowerCase() === name.toLocaleLowerCase())?.id)
      .filter(Boolean);
    return {
      query: parsed.text,
      tags: named,
      sender: searchFilters?.sender || null,
      hasAttachments: !!searchFilters?.hasAttachments,
      dateFrom: searchFilters?.dateFrom ? Math.floor(new Date(searchFilters.dateFrom).getTime() / 1000) : null,
      dateTo: searchFilters?.dateTo ? Math.floor(new Date(searchFilters.dateTo).getTime() / 1000) : null,
    };
  },
}));
