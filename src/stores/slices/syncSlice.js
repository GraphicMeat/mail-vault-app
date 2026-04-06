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
