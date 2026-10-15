import { create } from 'zustand';
import { daemonCall } from '../services/daemonClient';
import { useMailStore } from './mailStore';
import { useSearchStore } from './searchStore.js';
import { useFieldStore } from './fieldStore';
import { useSettingsStore } from './settingsStore';
import { useViewHideStore } from './viewHideStore';
import { ownAddresses } from '../utils/ownAddresses';
import { getAccountCacheMailboxes } from '../services/cacheManager';
import { flattenMailboxes, resolveEmailLocation, rowIdentity } from './slices/unifiedHelpers.js';
import { parseSearchQuery } from '../utils/searchQuery';
import { appendTerms, parseGroups, serializeGroups } from '../utils/queryGroups';
import { runAttachmentExport, startExportJob, viewExportKey } from '../services/attachmentExport';

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

/// How a saved view shows when nothing was changed for it. A view that saved
/// no grouping follows the app's own list mode.
export function viewDefaults(view, settings) {
  const def = view?.def || {};
  return {
    listView: def.group ? 'explorer' : settings.emailListView,
    grouping: def.group || null,
    timeline: !!def.showTimeline,
  };
}

/// How a saved view is shown: list or explorer, what the explorer groups by,
/// and whether the timeline is on. Each is what the person last picked while
/// the view was open (`viewOverrides`), else `viewDefaults`. `overridden`
/// says the result differs from those defaults, not that a choice was ever
/// stored: picking the saved layout again leaves nothing for Reset to reset.
export function effectiveViewConfig(view, settings) {
  const defaults = viewDefaults(view, settings);
  const saved = settings.viewOverrides?.[view?.id];
  const override = saved?.stamp === viewPresentationStamp(view?.def || {}) ? saved : {};
  const config = {
    listView: override.listView ?? defaults.listView,
    grouping: override.grouping ?? defaults.grouping,
    timeline: override.timeline ?? defaults.timeline,
  };
  return { ...config, overridden: Object.keys(config).some(key => config[key] !== defaults[key]) };
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

/// Does the view search for no words at all? Adding words to such a view
/// narrows it from "everything its filters find" to those words, so the
/// builder warns first. Read through the parser: a saved `|| &&` is no words.
export function viewQueryIsEmpty(view) {
  return !serializeGroups(parseGroups(view?.def?.query || ''));
}

/// The folders of one account, and which of them are its bin, junk and
/// archive. A folder's name is a per-mailbox word, so "not the bin" is only
/// answerable here, never in the daemon.
export function accountPayload(account, mail) {
  const tree = getAccountCacheMailboxes(account.id)
    || (account.id === mail.activeAccountId ? mail.mailboxes : [])
    || [];
  const boxes = flattenMailboxes(tree);
  const specialUse = {};
  for (const box of boxes) {
    const use = box.specialUse || box.special_use;
    if (use && !specialUse[use]) specialUse[use] = box.path;
  }
  // The default From and every alias: "to me", "not from me" and Notes to
  // Self count them as the account's own, like the login.
  const login = (account.email || '').trim().toLowerCase();
  const settings = useSettingsStore.getState?.() || {};
  const aliases = ownAddresses({ account, sendAsAddress: settings.sendAsAddresses?.[account.id], aliases: settings.aliases?.[account.id] })
    .filter(address => address.toLowerCase() !== login);
  return {
    accountId: account.id,
    address: account.email || '',
    ...(aliases.length ? { aliases } : {}),
    // Local folders by display name too, so the daemon names their hits the
    // way their lists do (see searchTargets).
    knownMailboxes: [...boxes.map(box => box.path).filter(Boolean), ...(mail.localFolders?.[account.id] || []).map(f => f.name)],
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
/// The count on its way, and the one queued behind it (`refreshCounts`).
let countsInFlight = null;
let countsNext = null;
/// The membership ask on its way, and the one queued behind it
/// (`refreshHiddenMembers`).
let hiddenInFlight = null;
let hiddenNext = null;

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

  /// `keepOnEmpty`: the daemon answers `{}` while the index cannot count, and a
  /// change made mid-build should not blank badges that were true a moment ago.
  /// One count at a time. Each runs every view over every account on the
  /// index lock a view being opened waits on, and opening a view, saving one,
  /// a tag change and the scheduler below all ask: run side by side they
  /// stacked into seconds of lock the next click queued behind. A call made
  /// while one runs gets the single count that starts after it.
  refreshCounts: ({ keepOnEmpty = false } = {}) => {
    if (countsInFlight) {
      countsNext ??= countsInFlight.then(() => {
        countsNext = null;
        return get().refreshCounts({ keepOnEmpty });
      });
      return countsNext;
    }
    countsInFlight = (async () => {
      try {
        const counts = await daemonCall('views.counts', { accounts: accountsPayload() });
        const next = counts && typeof counts === 'object' ? counts : {};
        if (keepOnEmpty && !Object.keys(next).length) return;
        set({ counts: next });
        // Whatever changed what a view counts changed what it holds. Not on
        // the early return above: an index mid-build would answer "unknown"
        // and briefly show every hidden message again.
        void refreshHiddenMembers();
      } catch {
        // A count that would not come is not worth an error in the sidebar.
      } finally {
        countsInFlight = null;
      }
    })();
    return countsInFlight;
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
      useSearchStore.getState().showRows([]);
      console.warn('[views] could not run the view:', error?.message || error);
      return false;
    }
    // A view opened while this one was still running owns the screen now.
    if (mine !== runGeneration) return false;
    if (!reply?.available) {
      // Not an empty view: the index could not answer at all, and the list
      // says why (`unavailableReason`). No rows either way: left alone, the
      // list kept showing the folder behind the view under the view's name,
      // and select-all acted on mail the view never found.
      set({ loading: false, unavailableReason: reply?.reason || 'unavailable' });
      useSearchStore.getState().showRows([]);
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
    set(state => ({
      loading: false,
      ...(typeof reply.total === 'number' ? { counts: { ...state.counts, [id]: reply.total } } : {}),
    }));
    useSearchStore.getState().showRows(rows);
    // The badge beside every view is only true as of its last count, and
    // opening one is the moment a person looks at them.
    void get().refreshCounts();
    return true;
  },

  closeView: () => {
    runGeneration += 1;
    set({ activeViewId: null, unavailableReason: null, loading: false });
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

  /// The builder's words added to a saved view, each as a group of its own
  /// (`appendTerms`); every other filter is kept, and a view that already has
  /// every word is not saved again. Answers `{ ok: true,
  /// wasEmpty }`, `wasEmpty` saying the view searched for no words before, or
  /// `{ ok: false, reason: 'missing' }` for a view that is gone.
  addTermsToView: async (viewId, terms) => {
    let view = get().views.find(saved => saved.id === viewId);
    if (!view) view = (await get().loadViews()).find(saved => saved.id === viewId);
    if (!view) return { ok: false, reason: 'missing' };
    const wasEmpty = viewQueryIsEmpty(view);
    const before = view.def?.query || '';
    const query = appendTerms(before, terms);
    // Every word already its own group: nothing to save, nothing to re-run.
    if (query === appendTerms(before, [])) return { ok: true, wasEmpty };
    await get().saveView({ ...view, def: { ...(view.def || {}), query } });
    return { ok: true, wasEmpty };
  },

  /// A new view of the builder's words, named after the first, reading the
  /// email's account and, when given, its folder. Through `createView`, so the
  /// free cap is decided in the one place: answers what it answers.
  createViewFromTerms: async (terms, { accountId, mailbox = null } = {}, premium) => {
    const name = (terms || []).map(term => String(term ?? '').trim()).find(Boolean) || '';
    const view = {
      id: globalThis.crypto?.randomUUID?.() || `view-${Date.now()}`,
      name,
      icon: 'tag',
      // The daemon puts a new view last on its own (see the Views page).
      position: 0,
      builtin: null,
      def: {
        query: appendTerms('', terms),
        accounts: accountId ? [accountId] : [],
        mailboxes: mailbox ? [mailbox] : [],
      },
    };
    return get().createView(view, premium);
  },

  /// The open email's distinctive words, best first:
  /// `{ available, keywords: [{ term, tf, df }] }`. The email is placed the
  /// way every other row action places it (`rowIdentity`); one that cannot be
  /// placed (a unified row with no stamp) has no words to offer. A message the
  /// daemon cannot find rejects.
  loadKeywords: async (email) => {
    const where = rowIdentity(email, useMailStore.getState());
    if (!where || where.uid == null) return { available: false, keywords: [] };
    return daemonCall('views.keywords', where);
  },

  /// Who sends and what subjects carry one word, across the person's accounts:
  /// `{ available, total, senders, subjects }`.
  loadKeywordDetail: (term) => daemonCall('views.keyword_detail', { term, accounts: accountsPayload() }),

  /// Every real attachment a definition finds — or, for a search, the rows on
  /// screen — written flat into `destDir` by the daemon, as a job whose
  /// progress sits under `viewExportKey` while it runs. Answers
  /// `{ dir, files, skipped }`.
  /// `folder` is the one the person picked, `destDir` the new folder inside
  /// it: the shell holds the picked folder's access for the job
  /// (`startExportJob`).
  exportAttachments: (def, destDir, folder) => runAttachmentExport(viewExportKey(get().activeViewId), jobId =>
    startExportJob('views.export_attachments', folder, { def, accounts: accountsPayload(), destDir, jobId })),
  exportRowAttachments: (rows, destDir, folder) => runAttachmentExport(viewExportKey(null), jobId =>
    startExportJob('views.export_attachments', folder, {
      messages: rows.filter(row => row._accountId && row._mailbox && row.uid != null)
        .map(row => ({ accountId: row._accountId, mailbox: row._mailbox, uid: row.uid })),
      destDir,
      jobId,
    })),

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

/// The badges after a change: a read, a star, a move or a delete made here,
/// or one a sync reports, can change what any view holds. Those come in
/// bursts (a select-all, the reads of a scroll, a sync naming ten folders),
/// so the count is asked for once, a beat after the last of them, off the
/// click path, and never twice at once: a change made while one count is on
/// its way asks for one more after it. The daemon counts from the search
/// index, which may take a moment more to catch up; the next change counts
/// again.
const COUNTS_DELAY_MS = 600;
let countsTimer = null;
let countsRunning = false;
let countsAgain = false;

export function scheduleViewCountsRefresh() {
  clearTimeout(countsTimer);
  countsTimer = setTimeout(runScheduledCounts, COUNTS_DELAY_MS);
}

async function runScheduledCounts() {
  countsTimer = null;
  if (countsRunning) {
    countsAgain = true;
    return;
  }
  // No view, no badge to keep true.
  if (!useViewStore.getState().views.length) return;
  countsRunning = true;
  try {
    await useViewStore.getState().refreshCounts({ keepOnEmpty: true });
  } finally {
    countsRunning = false;
    if (countsAgain) {
      countsAgain = false;
      scheduleViewCountsRefresh();
    }
  }
}

const hideViewMailOn = () => !!useSettingsStore.getState?.()?.hideViewMail;
/// The views picked to hide, or null for never picked (every view).
const hideViewMailViews = () => {
  const ids = useSettingsStore.getState?.()?.hideViewMailViews;
  return Array.isArray(ids) ? ids : null;
};

/// Which messages the saved views hold, for the lists that leave them out
/// (`useViewHideStore`). Only asked while `hideViewMail` is on; off, the
/// membership is forgotten so nothing stays hidden. The daemon runs every
/// view over every account on the index lock for this, so one ask at a time
/// and an ask made during one gets the single ask that starts after it, as
/// `refreshCounts` does. A failure leaves the membership unknown, which
/// shows everything.
export function refreshHiddenMembers() {
  if (!hideViewMailOn() || hideViewMailViews()?.length === 0) {
    // A queued ask finds the setting off and asks nothing.
    useViewHideStore.getState().clear();
    return Promise.resolve();
  }
  if (hiddenInFlight) {
    hiddenNext ??= hiddenInFlight.then(() => {
      hiddenNext = null;
      return refreshHiddenMembers();
    });
    return hiddenNext;
  }
  hiddenInFlight = (async () => {
    try {
      const viewIds = hideViewMailViews();
      const reply = await daemonCall('views.hidden_members', viewIds
        ? { accounts: accountsPayload(), viewIds }
        : { accounts: accountsPayload() });
      // Turned off (or every view unpicked) while the answer was on its way:
      // it must not hide anything.
      if (!hideViewMailOn() || hideViewMailViews()?.length === 0) useViewHideStore.getState().clear();
      else useViewHideStore.getState().setMembers(reply);
    } catch {
      useViewHideStore.getState().clear();
    } finally {
      hiddenInFlight = null;
    }
  })();
  return hiddenInFlight;
}

/// The setting flipped or the picked views changed: on asks, off forgets. Also fires when the persisted
/// settings load at launch. `subscribe?.`: many specs mock the settings store
/// with `getState` alone, and importing this module must not throw there.
let stopHideViewMailWatch = null;
function watchHideViewMail() {
  stopHideViewMailWatch?.();
  stopHideViewMailWatch = useSettingsStore.subscribe?.((state, previous) => {
    if (state.hideViewMail === previous?.hideViewMail
      && state.hideViewMailViews === previous?.hideViewMailViews) return;
    void refreshHiddenMembers();
  }) || null;
}
watchHideViewMail();

export function __resetViewCountsForTests() {
  clearTimeout(countsTimer);
  countsTimer = null;
  countsRunning = false;
  countsAgain = false;
  countsInFlight = null;
  countsNext = null;
  hiddenInFlight = null;
  hiddenNext = null;
  watchHideViewMail();
}
