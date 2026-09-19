import { create } from 'zustand';
import { startMailSearch, cancelMailSearch } from '../services/mailSearch.js';
import { buildSearchTargets } from '../services/searchTargets.js';
import { useMailStore } from './mailStore';
import { effectiveSearchMailboxConcurrency, useSettingsStore } from './settingsStore';
import { emailKey } from './slices/unifiedHelpers';
import { normalizeMessageId } from '../utils/emailParser';
import { isBackedUp } from '../components/email/MessageStateIcon';

// Merge incremental daemon rows without losing the existing custody/location
// preference rules.
function finalize(allResults, scan = {}) {
  const sourcePriority = { 'local': 3, 'local-only': 3, 'server-search': 2, 'server': 1 };
  const preferMailbox = scan.activeMailbox === 'UNIFIED' ? 'INBOX' : scan.activeMailbox;
  const dedupe = (rows, keyOf, tieBreak) => {
    const seen = new Map();
    for (const email of rows) {
      const key = keyOf(email);
      const existing = seen.get(key);
      const byRank = existing && (sourcePriority[email.source] || 0) - (sourcePriority[existing.source] || 0);
      if (!existing || byRank > 0 || (byRank === 0 && tieBreak(email, existing))) {
        seen.set(key, email);
      }
    }
    return Array.from(seen.values());
  };

  // A bare uid is not a key: folder A's uid 34 and folder B's uid 34 are
  // two different messages, and this loop kept exactly one of them —
  // by source priority, so the row on screen could already be a message
  // other than the one that matched.
  // `emailKey` always returns a string, so the messageId fallback has to
  // be chosen on the uid, not on a falsy key that never comes.
  const perCopy = dedupe(allResults, e => (e.uid != null ? emailKey(e) : `mid:${e.messageId}`), () => false);
  // One message can still sit in two folders of one account: archived from
  // INBOX and backed up from a Gmail label. Two rows with two different
  // custody glyphs read as two messages. A tie goes to the copy the backup
  // drive is known to hold (each row's dot is read from its OWN folder's
  // scan), then to the open folder's copy.
  const vouched = (e) => isBackedUp(e, scan) === true;
  let unkeyed = 0;
  const perMessage = dedupe(perCopy, e => {
    const mid = normalizeMessageId(e.messageId);
    return mid ? `${e._accountId || e._srcAccountId || ''}|${mid}` : `#${unkeyed++}`;
  }, (e, existing) => (vouched(e) !== vouched(existing)
    ? vouched(e)
    : e._mailbox === preferMailbox && existing._mailbox !== preferMailbox));

  return perMessage.sort((a, b) => {
    const dateA = new Date(a.date || a.internalDate || 0);
    const dateB = new Date(b.date || b.internalDate || 0);
    return dateB - dateA;
  });
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

      accepted = true;
      const terminal = !!frame.terminal;
      if (terminal && state.isSearching && state.searchQuery.trim()) historyQuery = state.searchQuery.trim();
      return {
        searchResults: finalize([
          ...state.searchResults,
          ...(Array.isArray(frame.rows) ? frame.rows : []),
        ], state.searchSnapshot || {}),
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
    const hasCriteria = !!(query || filters.sender || filters.dateFrom || filters.dateTo || filters.hasAttachments);

    set({
      searchGeneration: runGeneration,
      activeSearchId: null,
      lastSequence: 0,
      searchSnapshot,
      searchResults: [],
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
        query,
        sender: filters.sender || null,
        dateFrom: toEpochSeconds(filters.dateFrom),
        dateTo: toEpochSeconds(filters.dateTo, true),
        hasAttachments: !!filters.hasAttachments,
        location: filters.location || 'all',
        concurrency: effectiveSearchMailboxConcurrency(settings),
        targets,
      };
      activeId = searchId;
      set({ activeSearchId: searchId });

      const { unlisten } = await startMailSearch(request, frame => get().handleSearchProgress(frame), () => {
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
      isSearching: false,
      searchProgress: null,
      searchIndexCoverage: null,
      searchFallback: null,
      searchError: null,
    });
  },
}));
