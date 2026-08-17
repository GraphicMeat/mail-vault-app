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
// The sync probe answers one question: does the CACHE match the SERVER. It says
// nothing about the list on screen, which is a window onto that cache and can be
// short of it — an aborted activation, a cache cleared by the UIDVALIDITY
// branch, a first load that failed on a dead socket. Nothing re-asked, so a
// window stuck at "3 of 11 emails" stayed there for the session: every later
// activation asked the same question, got "unchanged", and returned without
// touching the list. That is what made the banner's reload button look dead.
//
// Returns the patch that re-arms pagination, or null when the window already
// covers everything we know about — arming it then would page the server on
// every activation forever.
export function shortWindowPatch(shownCount, meta) {
  const total = Math.max(meta?.totalEmails ?? 0, meta?.totalCached ?? 0);
  if (!total || shownCount >= total) return null;
  return { hasMoreEmails: true, totalEmails: total };
}

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
