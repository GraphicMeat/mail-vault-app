import { create } from 'zustand';
import { daemonCall } from '../services/daemonClient';
import { useMailStore } from './mailStore';
import { useSearchStore } from './searchStore.js';
import { useFieldStore } from './fieldStore';
import { useSettingsStore } from './settingsStore';
import { getAccountCacheMailboxes } from '../services/cacheManager';
import { flattenMailboxes, resolveEmailLocation } from './slices/unifiedHelpers.js';
import { parseSearchQuery } from '../utils/searchQuery';

/// What a view is called. A starter carries no name in the database — storing
/// "Needs reply" there would pin one language into the store — so it is
/// translated by its builtin id, unless the person renamed it.
export function viewLabel(view, translate) {
  if (view?.name) return view.name;
  // The caller hands its own translator in: this module imports none, and the
  // parameter is named in full because the translator-in-scope scanner reads
  // comments too and a one-letter call written anywhere here looks to it like
  // a missing import.
  if (view?.builtin) return translate(`views.builtin.${view.builtin}`);
  return '';
}

/// The part of a view's saved definition its layout comes from. A layout
/// change made against a different one is stale: an edit in Settings must not
/// stay hidden behind an old click in the toolbar.
export const viewPresentationStamp = def => JSON.stringify([def?.group || null, !!def?.showTimeline]);

/// How a saved view is shown: list or explorer, what the explorer groups by,
/// and whether the timeline is on. Each is what the person last picked while
/// the view was open (`viewOverrides`), else what the view was saved with. A
/// view that saved no grouping follows the app's own list mode.
export function effectiveViewConfig(view, settings) {
  const def = view?.def || {};
  const saved = settings.viewOverrides?.[view?.id];
  const override = saved?.stamp === viewPresentationStamp(def) ? saved : {};
  return {
    listView: override.listView ?? (def.group ? 'explorer' : settings.emailListView),
    grouping: override.grouping ?? (def.group || null),
    timeline: override.timeline ?? !!def.showTimeline,
    overridden: ['listView', 'grouping', 'timeline'].some(key => key in override),
  };
}

/// The list mode on screen right now, for code outside the list itself.
export function currentListView() {
  const settings = useSettingsStore.getState();
  const { views, activeViewId } = useViewStore.getState();
  const view = activeViewId && views.find(saved => saved.id === activeViewId);
  return view ? effectiveViewConfig(view, settings).listView : settings.emailListView;
}

/// How many views a free account may keep. The starters count: they are
/// ordinary rows a person can delete, so a free account that wants a view of
/// its own makes room by dropping one it never opens.
export const MAX_FREE_VIEWS = 3;

/// Is there room for one more view? The only place the cap is decided — both
/// doors that make a view (the + in Settings, "save this search") ask here,
/// and hiding a button is never the guard.
export function viewLimitReached(views, premium) {
  return !premium && (views?.length || 0) >= MAX_FREE_VIEWS;
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

/// Opening a view is an await, and a second click must not land under the
/// first one's rows. Same shape the search store uses for its own runs.
let runGeneration = 0;
/// The editor's preview runs its own generation: a keystroke in Settings must
/// not cancel the view somebody has open on the mail screen.
let previewGeneration = 0;

export const useViewStore = create((set, get) => ({
  views: [],
  /// View id → how many messages it holds, straight from the daemon. Never
  /// counted from the rows on screen: those are one page of one view.
  counts: {},
  activeViewId: null,
  /// The sidebar's + asked for a new view; the Views settings page consumes
  /// this once on open. A prop cannot cross that gap — Settings is a window of
  /// its own.
  pendingNew: false,
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
    const mine = ++runGeneration;
    // The search box is not what is on screen any more; leaving the query and
    // its filters behind would let a later restart run a search nobody typed.
    useSearchStore.getState().clearSearch();
    set({ activeViewId: id, loading: true, unavailableReason: null });
    let reply;
    try {
      reply = await daemonCall('views.evaluate', { viewId: id, accounts: accountsPayload() });
    } catch (error) {
      if (mine !== runGeneration) return false;
      set({ loading: false, unavailableReason: 'error' });
      console.warn('[views] could not run the view:', error?.message || error);
      return false;
    }
    // A view opened while this one was still running owns the screen now.
    if (mine !== runGeneration) return false;
    if (!reply?.available) {
      // Not an empty view: the index could not answer at all.
      set({ loading: false, unavailableReason: reply?.reason || 'unavailable' });
      return false;
    }
    const rows = reply.rows || [];
    // A view grouped by a field needs its values before the rows are on screen:
    // arriving one rendered row at a time, they would group every row as "no
    // value" and then reshuffle the list under the reader. Bounded by the
    // evaluate limit, and a load that fails only costs the grouping.
    const def = (typeof view === 'object' && view?.def) || get().views.find(saved => saved.id === id)?.def;
    if (def?.group?.startsWith('field:')) {
      const mail = useMailStore.getState();
      try {
        await useFieldStore.getState().loadRowValues(
          rows.map(email => ({ email, location: resolveEmailLocation(email, mail) })),
        );
      } catch (error) {
        console.warn('[views] could not load the field values to group by:', error?.message || error);
      }
      if (mine !== runGeneration) return false;
    }
    set({ loading: false });
    useSearchStore.getState().showRows(rows);
    // The badge beside every view is only true as of its last count, and
    // opening one is the moment a person looks at them.
    void get().refreshCounts();
    return true;
  },

  closeView: () => {
    runGeneration += 1;
    set({ activeViewId: null, unavailableReason: null });
    useSearchStore.getState().clearSearch();
  },

  saveView: async (view) => {
    const saved = await daemonCall('views.save', { view });
    await get().loadViews();
    void get().refreshCounts();
    // Editing the view on screen changes what it holds; showing the old rows
    // under the new name would be the worst of both.
    if (get().activeViewId === view.id) void get().openView(view.id);
    return saved;
  },

  reorderViews: async (ids) => {
    await daemonCall('views.reorder', { ids });
    await get().loadViews();
  },

  deleteView: async (id) => {
    await daemonCall('views.delete', { id });
    if (get().activeViewId === id) get().closeView();
    await get().loadViews();
    void get().refreshCounts();
  },

  /// Make a view, or say why not. Both doors route here so the cap is decided
  /// once: hiding the + in Settings would still leave "save this search" open.
  createView: async (view, premium) => {
    // The cap is a fact about what is stored, not about what this window has
    // loaded. A Settings window opens with an empty list, and deciding on that
    // handed a full account one more view; the sidebar's + arrives before the
    // first `views.list` has even answered.
    const views = await get().loadViews().catch(() => get().views);
    if (viewLimitReached(views, premium)) return { ok: false, reason: 'limit' };
    const saved = await get().saveView(view);
    return { ok: true, view: saved };
  },

  /// Every real attachment a definition finds — or, for a search, the rows on
  /// screen — written flat into `destDir` by the daemon. Replies
  /// `{ dir, files, skipped }`.
  exportAttachments: (def, destDir) =>
    daemonCall('views.export_attachments', { def, accounts: accountsPayload(), destDir }),
  exportRowAttachments: (rows, destDir) => daemonCall('views.export_attachments', {
    messages: rows.filter(row => row._accountId && row._mailbox && row.uid != null)
      .map(row => ({ accountId: row._accountId, mailbox: row._mailbox, uid: row.uid })),
    destDir,
  }),

  /// What a definition would find, for the editor's preview. Never shows its
  /// rows on the mail screen — that is what `openView` is for — and answers
  /// with the same "could not answer" the sidebar already speaks.
  previewDef: async (def, limit = 25) => {
    const mine = ++previewGeneration;
    let reply;
    try {
      reply = await daemonCall('views.evaluate', { def, accounts: accountsPayload(), limit });
    } catch (error) {
      if (mine !== previewGeneration) return null;
      console.warn('[views] could not preview the view:', error?.message || error);
      return { available: false, reason: 'error', rows: [], total: 0 };
    }
    if (mine !== previewGeneration) return null;
    if (!reply?.available) return { available: false, reason: reply?.reason || 'unavailable', rows: [], total: 0 };
    return { available: true, reason: null, rows: reply.rows || [], total: reply.total || 0 };
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
    // Typed operators win, as they do for the search itself. A view has no
    // home for `to:`, `in:` or `-word`; they are left out rather than
    // searched for as text.
    const dateFrom = parsed.dateFrom || searchFilters?.dateFrom;
    const dateTo = parsed.dateTo || searchFilters?.dateTo;
    return {
      query: parsed.text,
      tags: named,
      sender: parsed.sender || searchFilters?.sender || null,
      hasAttachments: parsed.hasAttachments || !!searchFilters?.hasAttachments,
      ...(parsed.unread ? { unread: true } : {}),
      dateFrom: dateFrom ? Math.floor(new Date(dateFrom).getTime() / 1000) : null,
      // The search's end day is inclusive (`toEpochSeconds`), so the view
      // keeps that whole day too, not just its first second.
      dateTo: dateTo ? Math.floor(new Date(dateTo).getTime() / 1000) + 86_399 : null,
    };
  },
}));
