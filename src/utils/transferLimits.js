// Shared resolution logic for per-account daily transfer limits (data-usage
// feature). Mirrors the daemon's semantics exactly: the daemon owns the
// defaults (`src-core/src/transfer_limits.rs`, `default_limits`) and enforces
// them; this file repeats the two numbers only to show them, and
// tests/unit/transferLimits.test.js reads them out of the Rust source so the
// copies cannot drift. See the `transferLimits` settings shape in settingsStore.

// Gmail allows about 2,500 MB a day down and 500 MB up, across every client of
// the account. That is the figure the banner and the usage bar measure against
// while "Pause background downloads at daily limit" is OFF: nothing of ours
// stops a download then, and Gmail's own cut-off is the only limit there is.
export const GMAIL_LIMIT_DOWN_BYTES = 2500 * 1024 * 1024;

// The daemon's default, applied only when the cap is ON and the download field
// is empty (`background_down_limit`): 500 MB short of Gmail's own limit, so
// backups stop early and leave room for everyday mail. Only Gmail has a known
// default; other providers are unlimited. Upload has one figure, 500 MB.
export const GMAIL_DEFAULT_DOWN_BYTES = 2000 * 1024 * 1024;
export const GMAIL_DEFAULT_UP_BYTES = 500 * 1024 * 1024;

/**
 * Whether the daemon applies Gmail's defaults to this account. Decided by the
 * IMAP host, exactly as `default_limits(host)` does (the host contains "gmail"
 * or "googlemail", case-insensitive), never by the email domain: a Workspace
 * address on imap.gmail.com is Gmail, and an @gmail.com address pointed at
 * another server is not.
 */
export function isGmailAccount(account) {
  const host = String(account?.imapHost || '').toLowerCase();
  return host.includes('gmail') || host.includes('googlemail');
}

/**
 * The figure an EMPTY limit field stands for on a Gmail account: 2000 MB down
 * when the cap is on (what the daemon enforces), Gmail's own 2500 MB when it is
 * off; upload is 500 MB either way. `null` off Gmail (unlimited).
 */
export function providerDefaultBytes(isGmail, capEnabled, direction) {
  if (!isGmail) return null;
  if (direction === 'up') return GMAIL_DEFAULT_UP_BYTES;
  return capEnabled ? GMAIL_DEFAULT_DOWN_BYTES : GMAIL_LIMIT_DOWN_BYTES;
}

/**
 * Resolve the daily limit (in bytes) that warn/cap checks compare usage
 * against for one direction. A number the user typed wins. A blank field is the
 * provider default for Gmail (see `providerDefaultBytes`: it depends on the
 * cap), unlimited (null) otherwise.
 */
export function resolveDailyLimitBytes(limitConfig, isGmail, direction) {
  const explicit = direction === 'down'
    ? limitConfig?.dailyDownLimitBytes
    : limitConfig?.dailyUpLimitBytes;
  if (explicit != null) return { limitBytes: explicit, isProviderDefault: false };
  const fallback = providerDefaultBytes(isGmail, limitConfig?.capEnabled === true, direction);
  if (fallback != null) return { limitBytes: fallback, isProviderDefault: true };
  return { limitBytes: null, isProviderDefault: false };
}

/**
 * Whether an account's background download cap changed in a way that can
 * change what the daemon lets through today: the cap switched on or off, or a
 * new download limit. The warning and the upload limit never stop a download.
 * Takes the account's `transferLimits` entry before and after.
 */
export function downloadCapChanged(prev, next) {
  return (prev?.capEnabled === true) !== (next?.capEnabled === true)
    || (prev?.dailyDownLimitBytes ?? null) !== (next?.dailyDownLimitBytes ?? null);
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
