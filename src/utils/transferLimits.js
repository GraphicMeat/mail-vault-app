// Shared resolution logic for per-account daily transfer limits (data-usage
// feature). Mirrors the daemon's semantics exactly — see backend contract for
// `get_transfer_stats` and the `transferLimits` settings shape.

// Provider defaults applied only when capEnabled is on and no explicit limit
// was set. Only Gmail has a known default; other providers are unlimited.
export const GMAIL_DEFAULT_DOWN_BYTES = 2500 * 1024 * 1024;
export const GMAIL_DEFAULT_UP_BYTES = 500 * 1024 * 1024;

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

export function isGmailAccount(account) {
  const domain = (account?.email || '').split('@')[1]?.toLowerCase();
  return GMAIL_DOMAINS.has(domain);
}

/**
 * Resolve the daily limit (in bytes) that warn/cap checks compare usage
 * against for one direction. Missing entry or blank field = provider
 * default for Gmail, unlimited (null) otherwise.
 */
export function resolveDailyLimitBytes(limitConfig, isGmail, direction) {
  const explicit = direction === 'down'
    ? limitConfig?.dailyDownLimitBytes
    : limitConfig?.dailyUpLimitBytes;
  if (explicit != null) return { limitBytes: explicit, isProviderDefault: false };
  if (isGmail) {
    return {
      limitBytes: direction === 'down' ? GMAIL_DEFAULT_DOWN_BYTES : GMAIL_DEFAULT_UP_BYTES,
      isProviderDefault: true,
    };
  }
  return { limitBytes: null, isProviderDefault: false };
}

const WEEKDAY_INITIALS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

/**
 * The last `count` days of a stats file's `days` map, oldest → today, with
 * zero-filled gaps. Keys are UTC because that is how the Rust writer buckets
 * them (`transfer_stats::today_key`) — using local dates here would shift the
 * whole chart by a day for anyone west of UTC.
 */
export function lastDaysSeries(days, count = 7, now = new Date()) {
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (count - 1 - i)));
    const key = d.toISOString().slice(0, 10);
    const bucket = days?.[key] || {};
    return { key, label: WEEKDAY_INITIALS[d.getUTCDay()], down: bucket.down || 0, up: bucket.up || 0 };
  });
}
