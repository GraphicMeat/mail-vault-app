import { create } from 'zustand';
import { startMailSearch, cancelMailSearch } from '../services/mailSearch.js';
import { buildSearchTargets } from '../services/searchTargets.js';
import { useMailStore } from './mailStore';
import { effectiveSearchMailboxConcurrency, useSettingsStore } from './settingsStore';
import { emailKey, SPECIAL_USE_MAP } from './slices/unifiedHelpers';
import { parseSearchQuery } from '../utils/searchQuery';
import { useTagStore } from './tagStore';
import { useFieldStore } from './fieldStore';
import { daemonCall } from '../services/daemonClient';
import * as searchRows from './searchRows';
import { registerRows } from './messageRows';

/// A `tag:` term that names no tag. It can match nothing, which is the point.
const MISSING_TAG = '\u0000none';

/// The rows a message must be identified by for the daemon to answer about it.
function askable(rows) {
    const items = [];
    const positions = [];
    rows.forEach((row, index) => {
      const accountId = row?._accountId || row?._srcAccountId;
      const mailbox = row?._mailbox;
      if (!accountId || !mailbox || row.uid == null) return;
      positions.push(index);
      items.push({ accountId, mailbox, uid: row.uid, ...(row.messageId ? { messageId: row.messageId } : {}) });
    });
    return { items, positions };
}

/// Which of these rows hold every named field condition. `value: null` asks
/// only that the field has been given some answer.
async function keepRowsWithFields(rows, conditions) {
  if (conditions.some(condition => !condition.fieldId)) return [];
  const { items, positions } = askable(rows);
  if (!items.length) return [];
  let lists = [];
  try {
    const reply = await daemonCall('fields.values', { items });
    lists = Array.isArray(reply?.values) ? reply.values : [];
  } catch {
    return [];
  }
  const keep = new Set();
  positions.forEach((rowIndex, askIndex) => {
    const values = lists[askIndex] || {};
    const matches = conditions.every(({ fieldId, value }) => {
      const held = values[fieldId];
      if (held === undefined) return false;
      if (value === null) return true;
      if (Array.isArray(held)) return held.some(entry => String(entry).toLocaleLowerCase() === value.toLocaleLowerCase());
      return String(held).toLocaleLowerCase() === value.toLocaleLowerCase();
    });
    if (matches) keep.add(rowIndex);
  });
  return rows.filter((_row, index) => keep.has(index));
}

/// Which of these rows carry every named tag. The daemon answers for the rows
/// it is handed, in order, so the key an assignment is stored under stays in
/// one place instead of being re-derived here.
async function keepRowsWithTags(rows, tagIds) {
  const { items, positions } = askable(rows);
  if (!items.length) return [];
  if (tagIds.includes(MISSING_TAG)) return [];
  let lists = [];
  try {
    const reply = await daemonCall('tags.for_messages', { items });
    lists = Array.isArray(reply?.tags) ? reply.tags : [];
  } catch {
    // The tag store could not answer; showing untagged rows would be a lie
    // about the filter, so the frame contributes nothing.
    return [];
  }
  const keep = new Set();
  positions.forEach((rowIndex, askIndex) => {
    const ids = lists[askIndex] || [];
    if (tagIds.every(tagId => ids.includes(tagId))) keep.add(rowIndex);
  });
  return rows.filter((_row, index) => keep.has(index));
}

let generation = 0;
let activeUnlisten = null;
let activeId = null;

function stopActiveRun() {
  const searchId = activeId;
  const unlisten = activeUnlisten;
  activeId = null;
  activeUnlisten = null;
  try { unlisten?.(); } catch { /* A stale listener is already harmless by ID. */ }
  if (searchId) void cancelMailSearch(searchId);
}

function toEpochSeconds(value, inclusiveEnd = false) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  if (inclusiveEnd && typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    date.setUTCHours(23, 59, 59, 0);
  }
  return Math.floor(date.getTime() / 1000);
}

/// Read through a function so the field lookup does not pin a store import
/// order at module load.
function mailStateForFields() {
  return useMailStore.getState();
}

function newSearchId(searchGeneration) {
  return globalThis.crypto?.randomUUID?.() || `mail-search-${Date.now()}-${searchGeneration}`;
}

export const useSearchStore = create((set, get) => ({
  searchActive: false,
  searchQuery: '',
  searchFilters: {
    location: 'all', // 'all' | 'server' | 'local'
    folder: 'current', // 'current' | 'all' | specific folder path
    sender: '',
    dateFrom: null,
    dateTo: null,
    hasAttachments: false,
  },
  searchResults: [],
  ...searchRows.emptyRows(),
  isSearching: false,
  activeSearchId: null,
  searchGeneration: 0,
  lastSequence: 0,
  searchSnapshot: null,
  searchFallback: null,
  searchError: null,
  // { done, total } while either daemon lane is in flight, else null.
  searchProgress: null,
  // { indexed, total, complete, matched, shown } when the offline index answered the vault
  // half of the last search, null when the scan did.
  searchIndexCoverage: null,

  /// Show rows the app did not search for — a saved view's result. They
  /// arrive in the same shape the index lane of a search produces, so they go
  /// through the same snapshot and the same `finalize`: custody glyphs, backup
  /// state and the copy-per-message rules are all in there, and a second
  /// render path would have to re-derive every one of them.
  showRows: (allRows) => {
    const mail = useMailStore.getState();
    // The index reads the vault, and a message deleted this session keeps its
    // vault copy until a sync prunes it (or for good, when archived). The
    // tombstones the delete wrote are what the mail list already hides it by.
    const tombstones = mail.deleteTombstones;
    const kept = tombstones?.size ? allRows.filter(row => !tombstones.has(emailKey(row))) : allRows;
    const searchSnapshot = {
      backedUpKeys: mail.backedUpKeys,
      backedUpScopes: mail.backedUpScopes,
      backupConfigured: mail.backupConfigured,
      activeAccountId: mail.activeAccountId,
      activeMailbox: mail.activeMailbox,
    };
    stopActiveRun();
    set({
      searchGeneration: ++generation,
      activeSearchId: null,
      lastSequence: 0,
      searchSnapshot,
      searchActive: true,
      isSearching: false,
      searchProgress: null,
      searchError: null,
      searchFallback: null,
      searchIndexCoverage: null,
      ...searchRows.showRows(kept, searchSnapshot),
    });
  },

  setSearchQuery: (query) => set({ searchQuery: query }),

  setSearchFilters: (filters) => set(state => ({
    searchFilters: { ...state.searchFilters, ...filters }
  })),

  handleSearchProgress: frame => {
    if (!frame) return;
    let accepted = false;
    let historyQuery = null;
    set(state => {
      if (frame.searchId !== state.activeSearchId
        || !Number.isFinite(frame.sequence)
        || frame.sequence <= state.lastSequence) return state;

      const frameRows = Array.isArray(frame.rows) ? frame.rows : [];
      const replaceAccountId = frame.replaceIndexAccountId;
      if (replaceAccountId != null && (typeof replaceAccountId !== 'string'
        || !replaceAccountId
        || frame.lane !== 'local'
        || frame.localMode !== 'index'
        || !Array.isArray(frame.rows)
        || frameRows.some(row => row?._accountId !== replaceAccountId))) return state;

      accepted = true;
      const terminal = !!frame.terminal;
      if (terminal && state.isSearching && state.searchQuery.trim()) historyQuery = state.searchQuery.trim();
      return {
        ...searchRows.addFrameRows(state, frameRows, replaceAccountId),
        lastSequence: frame.sequence,
        searchProgress: terminal ? null : { done: frame.completed ?? 0, total: frame.total ?? 0 },
        searchIndexCoverage: frame.coverage ?? state.searchIndexCoverage,
        searchFallback: frame.fallbackReason ?? state.searchFallback,
        searchError: frame.errorKey || state.searchError,
        isSearching: !terminal,
      };
    });
    if (historyQuery) useSettingsStore.getState().addSearchToHistory?.(historyQuery);
    if (accepted && frame.terminal && activeId === frame.searchId) {
      activeId = null;
      const unlisten = activeUnlisten;
      activeUnlisten = null;
      try { unlisten?.(); } catch { /* The terminal event already ended this run. */ }
    }
  },

  removeSearchResults: keys => {
    if (!keys?.length) return;
    set(state => searchRows.dropCopies(state, keys) || state);
  },

  restartSearch: () => get().performSearch(),

  performSearch: async () => {
    const runGeneration = ++generation;
    stopActiveRun();

    const { searchQuery, searchFilters } = get();
    const filters = { ...searchFilters };
    const query = String(searchQuery || '').trim();
    const mail = useMailStore.getState();
    const settings = useSettingsStore.getState();
    const searchSnapshot = {
      backedUpKeys: mail.backedUpKeys,
      backedUpScopes: mail.backedUpScopes,
      backupConfigured: mail.backupConfigured,
      activeAccountId: mail.activeAccountId,
      activeMailbox: mail.activeMailbox,
    };
    const {
      text: queryText, tags: tagNames, fields: fieldTerms, exclude, ...operators
    } = parseSearchQuery(query);
    // Typed operators win over the filter panel, for this search only: they
    // land on the copy, never on `searchFilters`.
    for (const [key, value] of Object.entries(operators)) {
      if (value) filters[key] = value;
    }
    // `in:sent` names a role every account has, so a unified view searches
    // each account's own Sent. A folder picked in the panel is one account's.
    if (operators.folder && (operators.folder === 'INBOX' || SPECIAL_USE_MAP[operators.folder])) {
      filters.everyAccount = true;
    }
    // A name nobody has a tag for resolves to nothing, and a search for it
    // must return nothing rather than silently ignoring the filter.
    const tagIds = tagNames.map(name => {
      const tag = useTagStore.getState().tags
        .find(item => item.name.toLocaleLowerCase() === name.toLocaleLowerCase());
      return tag ? tag.id : MISSING_TAG;
    });
    // A field name nobody has resolves to nothing, and a search for it must
    // return nothing rather than quietly dropping the condition.
    const schema = useFieldStore.getState().fieldsFor(mailStateForFields().activeAccountId) || [];
    const fieldConditions = fieldTerms.map(term => ({
      fieldId: schema.find(field => field.name.toLocaleLowerCase() === term.name.toLocaleLowerCase())?.id || null,
      value: term.value,
    }));
    const hasCriteria = !!(queryText || tagIds.length || fieldConditions.length || filters.sender || filters.dateFrom
      || filters.dateTo || filters.hasAttachments || filters.to || filters.unread || exclude.length
      || operators.folder);

    set({
      searchGeneration: runGeneration,
      activeSearchId: null,
      lastSequence: 0,
      searchSnapshot,
      searchResults: [],
      ...searchRows.emptyRows(),
      isSearching: hasCriteria,
      searchActive: hasCriteria,
      searchProgress: null,
      searchIndexCoverage: null,
      searchFallback: null,
      searchError: null,
    });
    if (!hasCriteria) return;

    let searchId = null;
    try {
      const targets = await buildSearchTargets(mail, settings, filters);
      if (runGeneration !== generation) return;

      searchId = newSearchId(runGeneration);
      const request = {
        searchId,
        query: queryText,
        sender: filters.sender || null,
        to: filters.to || null,
        unread: filters.unread ? true : null,
        exclude,
        dateFrom: toEpochSeconds(filters.dateFrom),
        dateTo: toEpochSeconds(filters.dateTo, true),
        hasAttachments: !!filters.hasAttachments,
        location: filters.location || 'all',
        concurrency: effectiveSearchMailboxConcurrency(settings),
        targets,
      };
      activeId = searchId;
      set({ activeSearchId: searchId });

      let ordered = Promise.resolve();
      const narrows = tagIds.length || fieldConditions.length;
      const onFrame = frame => {
        if (!narrows) return get().handleSearchProgress(frame);
        // Frames are sequenced and a later one is dropped once an earlier
        // sequence has landed, so the awaited filtering has to stay in order.
        ordered = ordered.then(async () => {
          let rows = Array.isArray(frame.rows) ? frame.rows : [];
          if (tagIds.length) rows = await keepRowsWithTags(rows, tagIds);
          if (fieldConditions.length && rows.length) rows = await keepRowsWithFields(rows, fieldConditions);
          else if (fieldConditions.length) rows = [];
          get().handleSearchProgress({ ...frame, rows });
        }).catch(() => {});
        return ordered;
      };
      const { unlisten } = await startMailSearch(request, onFrame, () => {
        const state = get();
        if (runGeneration !== generation || state.activeSearchId !== searchId || !state.isSearching) return;
        return state.performSearch();
      });
      if (runGeneration !== generation || get().activeSearchId !== searchId) {
        try { unlisten?.(); } catch { /* This run is already obsolete. */ }
        // A Clear can cancel before registration; after the ack, cancel is certain to find it.
        void cancelMailSearch(searchId);
        return;
      }
      if (get().isSearching) {
        activeUnlisten = unlisten;
      } else {
        if (activeId === searchId) activeId = null;
        try { unlisten?.(); } catch { /* A terminal event arrived before the start reply. */ }
      }
    } catch (error) {
      if (runGeneration !== generation) return;
      if (activeId === searchId) activeId = null;
      activeUnlisten = null;
      set({
        activeSearchId: null,
        isSearching: false,
        searchProgress: null,
        searchError: error?.message || 'errors.searchFailed',
      });
    }
  },

  clearSearch: () => {
    const searchGeneration = ++generation;
    stopActiveRun();
    set({
      searchGeneration,
      activeSearchId: null,
      lastSequence: 0,
      searchSnapshot: null,
      searchActive: false,
      searchQuery: '',
      searchFilters: {
        location: 'all',
        folder: 'current',
        sender: '',
        dateFrom: null,
        dateTo: null,
        hasAttachments: false,
      },
      searchResults: [],
      ...searchRows.emptyRows(),
      isSearching: false,
      searchProgress: null,
      searchIndexCoverage: null,
      searchFallback: null,
      searchError: null,
    });
  },
}));

// A search's rows are in none of the lists the mail store holds, so they are a
// container of their own: a hit is patched here (the list and both pools, or
// the next frame rebuilds the row from the pools) and found here by every
// resolver of a selection key.
//
// A row that names no account (in either field) or folder is not a row anything can key: the
// uid alone names a different message in every other folder, and painting
// another message's row read is worse than leaving a stale bold one.
const stamped = row => !!((row?._accountId || row?._srcAccountId) && row._mailbox);
registerRows({
  name: 'searchRows',
  store: useSearchStore,
  fields: ['searchResults', 'indexedSearchRows', 'searchRowsOutsideIndex'],
  rank: 50,
  rows: state => state.searchResults.filter(stamped),
  mapRows: (state, ctx) => searchRows.mapRows(state, row => {
    const key = stamped(row) ? ctx.hit(row) : null;
    return key === null ? row : ctx.mapRow(row, key);
  }),
});
