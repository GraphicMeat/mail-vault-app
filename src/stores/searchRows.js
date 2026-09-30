// ── The one owner of a search's rows ──
//
// A search's rows live in three places: the two pools the lanes fill
// (`indexedSearchRows`, per account, replaced whole by the index lane, and
// `searchRowsOutsideIndex`, appended by every other frame) and `searchResults`,
// which is `finalize` of the pools — deduped, ranked, shielded. The list is a
// projection: the next frame rebuilds it from the pools, so anything that
// changes a row (a read mark, a verdict, a removal) has to change the pools
// too, or the next frame brings the old row back. Every write goes through
// this file; the store holds no row logic of its own.

import { useMailStore } from './mailStore';
import { useSettingsStore } from './settingsStore';
import { emailKey } from './slices/unifiedHelpers';
import { normalizeMessageId } from '../utils/emailParser';
import { isBackedUp } from '../components/email/MessageStateIcon';
import { annotateRowAlerts } from './slices/rowAlerts';

// Merge incremental daemon rows without losing the existing custody/location
// preference rules.
export function finalize(allResults, scan = {}) {
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

  perMessage.sort((a, b) => {
    const dateA = new Date(a.date || a.internalDate || 0);
    const dateB = new Date(b.date || b.internalDate || 0);
    return dateB - dateA;
  });
  // The same shields the folder list paints, or a hit wears none of them.
  return annotateRowAlerts(perMessage, useMailStore.getState(), useSettingsStore.getState());
}


export const emptyRows = () => ({
  indexedSearchRows: {},
  searchRowsOutsideIndex: [],
  excludedSearchCopies: new Set(),
});

const poolRows = ({ indexedSearchRows, searchRowsOutsideIndex }) => [
  ...Object.values(indexedSearchRows).flat(),
  ...searchRowsOutsideIndex,
];

// The pools as `pools`, and the list derived from them.
function project(state, pools) {
  return { ...pools, searchResults: finalize(poolRows(pools), state.searchSnapshot || {}) };
}

/// Rows the app did not search for (a saved view's result): one pool, no index lane.
export function showRows(rows, snapshot) {
  return {
    ...emptyRows(),
    searchRowsOutsideIndex: rows,
    searchResults: finalize(rows, snapshot),
  };
}

/// One frame of a running search. `replaceAccountId` is the index lane's
/// answer for that account, replacing what it delivered before.
export function addFrameRows(state, rows, replaceAccountId) {
  const fresh = rows.filter(row => !state.excludedSearchCopies.has(emailKey(row)));
  return project(state, replaceAccountId == null
    ? {
      indexedSearchRows: state.indexedSearchRows,
      searchRowsOutsideIndex: [...state.searchRowsOutsideIndex, ...fresh],
    }
    : {
      indexedSearchRows: { ...state.indexedSearchRows, [replaceAccountId]: fresh },
      searchRowsOutsideIndex: state.searchRowsOutsideIndex,
    });
}

/// Change rows in place, in the list and in both pools. `mapRow` returns the
/// row itself when it does not apply, so an untouched state comes back as
/// null and nothing repaints.
export function mapRows(state, mapRow) {
  if (!state.searchResults.length) return null;
  let changed = false;
  const map = rows => rows.map(row => {
    const next = mapRow(row);
    if (next !== row) changed = true;
    return next;
  });
  const searchResults = map(state.searchResults);
  if (!changed) return null;
  return {
    searchResults,
    indexedSearchRows: Object.fromEntries(Object.entries(state.indexedSearchRows)
      .map(([accountId, rows]) => [accountId, map(rows)])),
    searchRowsOutsideIndex: map(state.searchRowsOutsideIndex),
  };
}

/// Take copies out for the rest of the run: a row a later frame carries again
/// (the vault still holds a deleted message) stays out. `keys` are `emailKey`s.
export function dropCopies(state, keys) {
  const copyKeys = new Set(keys);
  const removed = [...poolRows(state), ...state.searchResults]
    .filter(row => copyKeys.has(emailKey(row)))
    .map(emailKey);
  if (!removed.length) return null;

  const excludedSearchCopies = new Set([...state.excludedSearchCopies, ...removed]);
  const keep = row => !excludedSearchCopies.has(emailKey(row));
  const indexedSearchRows = Object.fromEntries(Object.entries(state.indexedSearchRows)
    .map(([accountId, rows]) => [accountId, rows.filter(keep)]));
  const searchRowsOutsideIndex = state.searchRowsOutsideIndex.filter(keep);
  // A listed row no pool carries (the pools only ever lose rows here) is kept.
  const represented = new Set([...Object.values(indexedSearchRows).flat(), ...searchRowsOutsideIndex].map(emailKey));
  searchRowsOutsideIndex.push(...state.searchResults.filter(row => keep(row) && !represented.has(emailKey(row))));
  return project(state, { indexedSearchRows, searchRowsOutsideIndex, excludedSearchCopies });
}
