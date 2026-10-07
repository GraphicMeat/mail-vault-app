// ── mailStore facade — composes domain slices into one Zustand store ──

import { create } from 'zustand';
import { createAccountSlice } from './slices/accountSlice';
import { createMessageListSlice, _resetNetworkRetry, _scheduleNetworkRetry } from './slices/messageListSlice';
import { createSelectionSlice } from './slices/selectionSlice';
import { createCacheSlice } from './slices/cacheSlice';
import { createComposeSlice } from './slices/composeSlice';
import { createUndoSlice } from './slices/undoSlice';
import { createSyncSlice } from './slices/syncSlice';
import { createUiSlice } from './slices/uiSlice';
import { useTagStore } from './tagStore';
import { useAutoTagStore } from './autoTagStore';
import { useSnoozeStore } from './snoozeStore';
import { useFollowUpStore } from './followUpStore';
import { registerRows, setIdentityStore, mapList } from './messageRows';
import { setListStore, shiftFollowUps } from './unreadCounts';

// Re-exports for external consumers
export { graphMessageToEmail } from '../services/graphConfig';
export { getGraphMessageId } from '../services/cacheManager';
import { t } from '../i18n/index.js';

/**
 * Returns emails for the active account (for cross-account analytics).
 * With the lightweight restore cache, only the active account's full
 * header set is available — cached descriptors hold only first-window data.
 */
export function getAccountCacheEmails() {
  const state = useMailStore.getState();
  const activeId = state.activeAccountId;
  if (!activeId) return [];
  return [{
    accountEmail: activeId,
    emails: state.emails || [],
    sentEmails: state.sentEmails || [],
  }];
}

export const useMailStore = create((...a) => ({
  ...createAccountSlice(...a),
  ...createMessageListSlice(...a),
  ...createSelectionSlice(...a),
  ...createCacheSlice(...a),
  ...createComposeSlice(...a),
  ...createUndoSlice(...a),
  ...createSyncSlice(...a),
  ...createUiSlice(...a),
}));

// ── Where a message row lives in this store ──
// Every container of rows, registered once (messageRows.js): a writer changes a
// row through patchEverywhere and a resolver reads the candidates through
// resolvePool, and neither keeps a list of these of its own.
setIdentityStore(useMailStore);
// The unread badge counts only what the list shows (unreadCounts).
setListStore(useMailStore);
const listPatch = (field) => (state, ctx) => {
  const next = mapList(state[field], ctx);
  return next === state[field] ? null : { [field]: next };
};
registerRows({ name: 'emails', store: useMailStore, fields: ['emails'], rank: 10,
  rows: s => s.emails, mapRows: listPatch('emails') });
registerRows({ name: 'sentEmails', store: useMailStore, fields: ['sentEmails'], rank: 20,
  rows: s => s.sentEmails, mapRows: listPatch('sentEmails') });
registerRows({ name: 'localEmails', store: useMailStore, fields: ['localEmails'], rank: 30,
  rows: s => s.localEmails, mapRows: listPatch('localEmails') });
// A projection of `emails`: a writer that re-derives the list afterwards
// (updateSortedEmails) skips it.
registerRows({ name: 'sortedEmails', store: useMailStore, fields: ['sortedEmails'], derived: true,
  mapRows: listPatch('sortedEmails') });
registerRows({ name: 'selectedEmail', store: useMailStore, fields: ['selectedEmail'], rank: 40,
  rows: s => (s.selectedEmail ? [s.selectedEmail] : []),
  held: s => (s.selectedEmail ? [s.selectedEmail] : []),
  mapRows: (state, ctx) => {
    const row = state.selectedEmail;
    const key = row && ctx.hit(row);
    if (key === null || !row) return null;
    const next = ctx.mapRow(row, key);
    return next === row ? null : { selectedEmail: next };
  } });
// The open thread is a snapshot of buildThreads' output: the list swaps a fresh
// one in only when its MEMBERS change, and a flag change moves none.
registerRows({ name: 'selectedThread', store: useMailStore, fields: ['selectedThread'],
  held: s => s.selectedThread?.emails,
  mapRows: (state, ctx) => {
    const thread = state.selectedThread;
    const emails = mapList(thread?.emails, ctx);
    return emails === thread?.emails ? null : { selectedThread: { ...thread, emails } };
  } });
// The body cache freezes the flags a message had when it was fetched, so a
// reopen of an uncorrected entry paints the state from before the change. Its
// keys are the scope keys themselves, and it is patched in place: the Map is
// no reactive state, and the entries carry their LRU stamps.
registerRows({ name: 'emailCache', store: useMailStore, fields: ['emailCache'],
  held: s => [...s.emailCache.values()].map(entry => entry?.email),
  mapRows: (state, ctx) => {
    for (const key of ctx.keys) {
      const entry = state.emailCache.get(key);
      if (!entry?.email) continue;
      const next = ctx.mapRow(entry.email, key);
      if (next !== entry.email) entry.email = next;
    }
    return null;
  } });

// ── Online/offline listeners for header loading pipeline ──
// When going offline: header loading pauses naturally (API calls will fail, backoff kicks in)
// When coming back online: resume header loading if it was in progress
window.addEventListener('online', () => {
  const state = useMailStore.getState();
  if (state._loadMorePausedOffline && state.hasMoreEmails && state.emails.length < state.totalEmails) {
    console.log('[mailStore] Back online — resuming header loading');
    useMailStore.setState({ _loadMorePausedOffline: false, _loadMoreRetryDelay: 0 });
    state.loadMoreEmails();
  }
});

window.addEventListener('offline', () => {
  console.log('[mailStore] Went offline — header loading will pause');
  useMailStore.setState({ _loadMorePausedOffline: true });
});

// ── Network recovery listeners ────────────────────────────────────────
// When online: if connection is in error state, trigger progressive retry
window.addEventListener('online', () => {
  const { connectionStatus } = useMailStore.getState();
  console.log('[mailStore] online event — connectionStatus=%s', connectionStatus);
  if (connectionStatus === 'error' || connectionStatus === 'disconnected') {
    _resetNetworkRetry();
    _scheduleNetworkRetry(useMailStore);
  }
});

window.addEventListener('offline', () => {
  console.log('[mailStore] offline event — marking disconnected');
  _resetNetworkRetry();
  useMailStore.setState({
    connectionStatus: 'error',
    connectionErrorType: 'offline',
    connectionError: t('store.mailStore.networkOffline'),
  });
});

// ── Auto Tags "hide from Inbox" (Phase 4) ──────────────────────────────
// A row's tags load asynchronously (the prefetch in updateSortedEmails,
// TagChips rendering a row) and a rule's enabled/hide state can flip while
// the Inbox is open — re-derive the list when either changes. Gated on an
// actual hide rule existing so accounts with the feature off (the default)
// see no extra recompute on every ordinary tag-store write.
useTagStore.subscribe(() => {
  if (useAutoTagStore.getState().hiddenTagIds().size) useMailStore.getState().updateSortedEmails();
});
useAutoTagStore.subscribe((state, prev) => {
  if (state.rules !== prev.rules) useMailStore.getState().updateSortedEmails();
});

// A local snooze holds its message out of the list until the row wakes
// (deriveDisplayRows), so a new, woken or reloaded row re-derives it.
useSnoozeStore.subscribe((state, prev) => {
  if (state.rows !== prev.rows) useMailStore.getState().updateSortedEmails();
});

// A follow-up reminder that went due, was opened or was dismissed changes the
// inbox list and its badge, whichever view is open.
useFollowUpStore.subscribe((state, prev) => {
  if (state.rows === prev.rows) return;
  shiftFollowUps(prev.rows, state.rows);
  useMailStore.getState().updateSortedEmails();
});
