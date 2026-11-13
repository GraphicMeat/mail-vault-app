// The sync state the list header shows: the active account's, or in All Inboxes every account's
// taken together, so another inbox's pass and its failure show as the active one's would.

/**
 * `syncState` is the store's accountId -> { state: 'idle'|'syncing'|'error', code, at }. With one
 * account it is that account's entry as is. With several: syncing while any is, else the first
 * failed one's error, else idle; `at` is the oldest report, 0 while an account has none, so a
 * "done after the pull" check (`at > pulled`) holds only once every account has reported.
 */
export function combinedSync(syncState, accountIds) {
  if (accountIds.length === 1) return syncState?.[accountIds[0]] ?? null;
  const states = accountIds.map((id) => syncState?.[id] ?? null);
  const known = states.filter(Boolean);
  if (!known.length) return null;
  const at = known.length === states.length ? Math.min(...known.map((s) => s.at)) : 0;
  if (known.some((s) => s.state === 'syncing')) return { state: 'syncing', code: null, at };
  const failed = known.find((s) => s.state === 'error');
  if (failed) return { state: 'error', code: failed.code, at };
  return { state: 'idle', code: null, at };
}
