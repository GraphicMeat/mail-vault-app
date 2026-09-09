const formatters = new Map();
const MONTH_STARTS = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
const leap = year => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
const monthLength = (year, month) => month === 2 ? (leap(year) ? 29 : 28)
  : ([4, 6, 9, 11].includes(month) ? 30 : 31);
const keyOf = (year, month, day) => `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

function parts(date) {
  const match = typeof date === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new RangeError('Expected a local date in YYYY-MM-DD form');
  const [, year, month, day] = match.map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > monthLength(year, month)) {
    throw new RangeError('Invalid local calendar date');
  }
  return { year, month, day };
}

// Gregorian calendar arithmetic, independent of DST and elapsed clock time.
function ordinal({ year, month, day }) {
  const previous = year - 1;
  return previous * 365 + Math.floor(previous / 4) - Math.floor(previous / 100)
    + Math.floor(previous / 400) + MONTH_STARTS[month - 1]
    + (month > 2 && leap(year) ? 1 : 0) + day - 1;
}

/** Return a local YYYY-MM-DD key, or null for a missing/invalid ISO instant. */
export function localDateKey(instant, timeZone) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone, calendar: 'iso8601', numberingSystem: 'latn',
      year: 'numeric', month: '2-digit', day: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  if (instant instanceof Date) instant = Number.isFinite(instant.getTime()) ? instant.toISOString() : null;
  const match = typeof instant === 'string' && /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/i.exec(instant);
  if (!match) return null;
  try { parts(match[1]); } catch { return null; }
  if (+match[2] > 23 || +match[3] > 59 || +match[4] > 59 || +match[5] > 23 || +match[6] > 59) return null;
  const date = new Date(instant);
  if (!Number.isFinite(date.getTime())) return null;
  const values = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
  return `${values.year.padStart(4, '0')}-${values.month}-${values.day}`;
}

/** Inclusive real calendar dates. Invalid or reversed ranges are rejected. */
export function calendarDays(startDate, endDate) {
  let { year, month, day } = parts(startDate);
  parts(endDate);
  if (endDate < startDate) throw new RangeError('End date precedes start date');
  const days = [];
  for (;;) {
    const date = keyOf(year, month, day);
    days.push(date);
    if (date === endDate) return days;
    day += 1;
    if (day > monthLength(year, month)) {
      day = 1;
      month += 1;
      if (month === 13) { month = 1; year += 1; }
    }
  }
}

/** Monday = 0; the first, possibly partial, week is week zero. */
export function calendarCell(date, startDate) {
  const current = ordinal(parts(date));
  const start = ordinal(parts(startDate));
  return { week: Math.floor((current - start + start % 7) / 7), weekday: current % 7 };
}
