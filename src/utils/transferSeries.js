// Chart shaping for the sidebar's data-usage bubble: no limits, no policy.

const WEEKDAY_INITIALS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

/**
 * The last `count` days of a stats file's `days` map, oldest to today, with
 * zero-filled gaps. Keys are UTC because that is how the Rust writer buckets
 * them (`transfer_stats::today_key`): using local dates here would shift the
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
