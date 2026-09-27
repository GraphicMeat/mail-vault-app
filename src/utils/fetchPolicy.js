/**
 * Download modes (Track H): how much mail an account keeps on this computer.
 * A port of the daemon's `FetchPolicy` (`src-core/src/fetch_mode.rs`); both
 * are tested against the same fixture
 * (`src-core/tests/fixtures/fetch-policy-cases.json`) so they cannot drift.
 *
 * `state` is the settings store's state (what frontend-settings.json holds
 * under `mailvault-settings.state`).
 */

export const FETCH_MODES = ['onDemand', 'keepRecent', 'indexOnly', 'hoarder'];
const DEFAULT_WINDOW_MONTHS = 3;
const U32_MAX = 0xffffffff;
const I32_MAX = 0x7fffffff;
// chrono's NaiveDate range: a cutoff outside it is "no cutoff" there.
const MIN_YEAR = -262144;
const MAX_YEAR = 262143;

const asMode = (v) => (FETCH_MODES.includes(v) ? v : null);

/**
 * The account's policy, or null for a hidden account (nothing is kept).
 * Mode: the per-account override, else the global mode, else the legacy
 * reading of the window (0 = keep everything = hoarder, else keepRecent).
 */
export function fetchPolicy(state, accountId) {
  if (state?.hiddenAccounts?.[accountId] === true) return null;
  const raw = state?.localCacheDurationMonths;
  const window = Number.isInteger(raw) && raw >= 0 && raw <= U32_MAX ? raw : null;
  const mode = asMode(state?.fetchModes?.[accountId])
    ?? asMode(state?.fetchMode)
    ?? (window === 0 ? 'hoarder' : 'keepRecent');
  return {
    mode,
    windowMonths: window ?? DEFAULT_WINDOW_MONTHS,
    hoarderPremium: state?.fetchModePremium === true,
  };
}

/**
 * `nowMs` minus `months` calendar months in UTC, the day clamped to the
 * target month's last day and the time of day kept (chrono's
 * `checked_sub_months`). null when it cannot be represented: no cutoff.
 * Not `Date.setMonth`, which works in local time and rolls over.
 */
function cutoffMs(nowMs, months) {
  if (months > I32_MAX) return null;
  const now = new Date(nowMs);
  if (Number.isNaN(now.getTime())) return null;
  const total = now.getUTCFullYear() * 12 + now.getUTCMonth() - months;
  const year = Math.floor(total / 12);
  const month = total - year * 12;
  if (year < MIN_YEAR || year > MAX_YEAR) return null;
  // setUTCFullYear, not Date.UTC: Date.UTC reads years 0-99 as 1900-1999.
  const lastDay = new Date(0);
  lastDay.setUTCFullYear(year, month + 1, 0);
  const cutoff = new Date(0);
  cutoff.setUTCFullYear(year, month, Math.min(now.getUTCDate(), lastDay.getUTCDate()));
  cutoff.setUTCHours(now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds(), now.getUTCMilliseconds());
  const ms = cutoff.getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Whether a body dated `dateMs` is kept on disk. onDemand: never; hoarder:
 * always; keepRecent / indexOnly: inside the window (0 = no cutoff). A date
 * that does not parse (NaN) is outside any window.
 */
export function keepsBody(policy, dateMs, nowMs) {
  if (policy.mode === 'onDemand') return false;
  if (policy.mode === 'hoarder') return true;
  if (policy.windowMonths === 0) return true;
  const cutoff = cutoffMs(nowMs, policy.windowMonths);
  return cutoff === null ? true : dateMs >= cutoff;
}
