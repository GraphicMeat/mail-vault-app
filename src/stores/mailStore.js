// ── mailStore facade — composes domain slices into one Zustand store ──

import { create } from 'zustand';
import { createAccountSlice } from './slices/accountSlice';
import { createMessageListSlice, _resetNetworkRetry, _scheduleNetworkRetry } from './slices/messageListSlice';
import { createSelectionSlice } from './slices/selectionSlice';
import { createCacheSlice } from './slices/cacheSlice';
import { createComposeSlice } from './slices/composeSlice';
import { createSyncSlice } from './slices/syncSlice';
import { createUiSlice } from './slices/uiSlice';

// Re-exports for external consumers
export { graphMessageToEmail } from '../services/graphConfig';
export { getGraphMessageId } from '../services/cacheManager';

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
  ...createSyncSlice(...a),
  ...createUiSlice(...a),
}));

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
    connectionError: 'Network offline',
  });
});
