/// The date window a saved view covers, in the app's local time. Mirrors
/// `app_db::views::{range_bounds, date_window}` in src-core, which is what the
/// daemon filters by; this copy only decides what the download button offers.

/// Calendar ranges, resolved when the view runs — "last month" in October is
/// September, not whatever month the view was saved in.
export const CALENDAR_RANGES = ['thisMonth', 'lastMonth', 'thisYear', 'lastYear'];

/// Unix seconds of local midnight on the 1st. `Date` rolls month -1 and 12 over
/// into the neighbouring year.
const monthStart = (year, month) => Math.floor(new Date(year, month, 1).getTime() / 1000);

export function rangeBounds(range, now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth();
  const span = {
    thisMonth: [y, m, y, m + 1],
    lastMonth: [y, m - 1, y, m],
    thisYear: [y, 0, y + 1, 0],
    lastYear: [y - 1, 0, y, 0],
  }[range];
  return span ? { from: monthStart(span[0], span[1]), to: monthStart(span[2], span[3]) - 1 } : null;
}

/// `{ from, to }` in unix seconds, either side `null` when open. A calendar
/// range wins, then the last N days, then the saved dates.
export function viewWindow(def, now = new Date()) {
  const ranged = def?.range && rangeBounds(def.range, now);
  if (ranged) return ranged;
  if (def?.withinDays) return { from: Math.floor(now.getTime() / 1000) - def.withinDays * 86_400, to: null };
  return { from: def?.dateFrom ?? null, to: def?.dateTo ?? null };
}

/// What "Download attachments" offers for a view. A window that touches
/// exactly two calendar months — the last 30 days, say — offers the whole of
/// it or either month on its own; anything else is one download of everything.
/// Each choice is the window narrowed, never widened: "last month" out of the
/// last 30 days starts where those 30 days start.
export function downloadChoices(def, now = new Date()) {
  const { from, to } = viewWindow(def, now);
  if (from == null) return null;
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const first = new Date(from * 1000);
  const last = new Date(Math.min(to ?? nowSeconds, nowSeconds) * 1000);
  const months = (last.getFullYear() - first.getFullYear()) * 12 + last.getMonth() - first.getMonth();
  if (months !== 1) return null;
  const split = monthStart(last.getFullYear(), last.getMonth());
  return [
    { key: 'all', from, to },
    { key: 'later', from: split, to, month: last },
    { key: 'earlier', from, to: split - 1, month: first },
  ];
}

/// The view's definition narrowed to one choice, for the daemon to run.
export const narrowDef = (def, choice) => (choice.key === 'all' ? def
  : { ...def, range: null, withinDays: null, dateFrom: choice.from, dateTo: choice.to });
