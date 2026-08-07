// ── syncSlice — runtime loading/sync flags ──
// These flags are set by other slices via get()/set().

export const createSyncSlice = (set, get) => ({
  loading: false,
  loadingMore: false,
  restoring: false, // true while hydrating from RestoreDescriptor
  _loadMoreRetryDelay: 0,
  _loadMorePausedOffline: false,
  suspectEmptyServerData: null, // null | { accountId, type: 'mailboxes'|'emails', message, timestamp }
  loadingProgress: null, // { loaded: N, total: M } during background loading
});

// State patch for any path that ends with the server verified as consistent
// with what we display. Central so no verified path can skip clearing
// suspectEmptyServerData — the fast paths (probe-unchanged, delta-noop) did,
// and the "Showing cached data" banner stuck for the rest of the session.
export function serverVerifiedPatch(extra = {}) {
  return {
    connectionStatus: 'connected',
    connectionError: null,
    connectionErrorType: null,
    suspectEmptyServerData: null,
    loading: false,
    loadingMore: false,
    ...extra,
  };
}
