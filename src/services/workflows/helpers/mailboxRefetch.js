// ── Forced folder-list refetch ────────────────────────────────────────────
// The folder list is cached for ten minutes and only activateAccount reads
// it. Refresh invalidated the sync probe ("an explicit refresh must reach the
// server") but never this cache, so a folder created in webmail stayed
// invisible until the TTL ran out. The button now sets a one-shot flag that
// the next loadMailboxes for that account consumes.
const _forced = new Set();

export function forceMailboxRefetch(accountId) {
  if (accountId) _forced.add(accountId);
}

/** True exactly once after forceMailboxRefetch(accountId). */
export function takeForcedMailboxRefetch(accountId) {
  return _forced.delete(accountId);
}
