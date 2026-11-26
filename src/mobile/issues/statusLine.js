// What the line under the list title says about the sync: checking, failed, or when it last
// updated (iOS Mail's "Updated just now"). Pure: StatusLine.jsx draws it.

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** The "Updated ..." key and params for a pass that ended `at` (ms), seen from `now`. */
export function agoParts(at, now) {
  const ago = Math.max(0, now - at);
  if (ago < MINUTE) return { key: 'mobile.status.updatedNow', params: {} };
  if (ago < HOUR) return { key: 'mobile.status.updatedMinutes', params: { minutes: Math.floor(ago / MINUTE) } };
  if (ago < DAY) return { key: 'mobile.status.updatedHours', params: { hours: Math.floor(ago / HOUR) } };
  return { key: 'mobile.status.updatedDays', params: { days: Math.floor(ago / DAY) } };
}

/**
 * `sync` is the combined sync state (syncSummary.js): `{ state, code, at }` or null. Answers
 * `{ kind, key, params }`, or null while nothing has reported (`at` 0 is an account that has not).
 */
export function statusLine(sync, { now = Date.now(), accountCount = 1 } = {}) {
  if (!sync) return null;
  if (sync.state === 'syncing') {
    return accountCount > 1
      ? { kind: 'syncing', key: 'mobile.status.checkingMany', params: { accounts: accountCount } }
      : { kind: 'syncing', key: 'mobile.status.checking', params: {} };
  }
  if (sync.state === 'error') return { kind: 'error', key: 'mobile.status.failed', params: {} };
  if (!sync.at) return null;
  return { kind: 'idle', ...agoParts(sync.at, now) };
}
