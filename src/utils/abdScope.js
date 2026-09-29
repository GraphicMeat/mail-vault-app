// Date scope for an Archive & delete job (part-d design 3.8).
//
// A "year" is a calendar year in the USER's time zone. The daemon does not
// know that zone (and SEARCH SINCE/BEFORE would judge a message by the zone
// the server stamped it in), so the app sends one [start, end) pair per year
// and the daemon buckets each message's full received instant against them.
// `new Date(y, 0, 1)` is local midnight on Jan 1: the runtime's zone rules,
// DST included, decide the instant.

export const FIRST_YEAR = 1970;

/** Local midnight at the start of `year`, in ms. */
export const yearStartMs = (year) => new Date(year, 0, 1).getTime();

/** One `{ year, startMs, endMs }` per year from 1970 to next year, in local time. */
export function yearBounds(now = new Date()) {
  const bounds = [];
  for (let year = FIRST_YEAR; year <= now.getFullYear() + 1; year += 1) {
    bounds.push({ year, startMs: yearStartMs(year), endMs: yearStartMs(year + 1) });
  }
  return bounds;
}

/** "Older than 2 years" means before Jan 1 of the year before last: in 2026, before 2024-01-01 local. */
export const olderCutoffDate = (now = new Date()) => new Date(now.getFullYear() - 2, 0, 1);

export const DATE_CHOICES = ['all', 'this_year', 'last_year', 'older_than_2', 'years'];

/**
 * The daemon's `DateScope` JSON for a UI choice. `range` always names both
 * ends (null where open) so the shape never depends on which end is set.
 */
export function dateScopeFor(choice, { now = new Date(), years = [] } = {}) {
  const year = now.getFullYear();
  switch (choice) {
    case 'this_year': return { kind: 'range', sinceMs: yearStartMs(year), beforeMs: null };
    case 'last_year': return { kind: 'years', years: [year - 1] };
    case 'older_than_2': return { kind: 'range', sinceMs: null, beforeMs: olderCutoffDate(now).getTime() };
    case 'years': return { kind: 'years', years: [...new Set(years)].sort((a, b) => a - b) };
    default: return { kind: 'all' };
  }
}
