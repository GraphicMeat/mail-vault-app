// ── Forced folder-list refetch ────────────────────────────────────────────
// The folder list is cached for ten minutes; activateAccount's loadMailboxes
// and loadEmails.js's Graph copy of the freshness rule both read it. Refresh
// invalidated the sync probe ("an explicit refresh must reach the server")
// but never this cache, so a folder created in webmail stayed invisible
// until the TTL ran out. The button now sets a one-shot flag that the next
// folder load for that account consumes.
const _forced = new Set();

export function forceMailboxRefetch(accountId) {
  if (accountId) _forced.add(accountId);
}

/** True exactly once after forceMailboxRefetch(accountId). */
export function takeForcedMailboxRefetch(accountId) {
  return _forced.delete(accountId);
}
