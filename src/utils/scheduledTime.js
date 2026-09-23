// Scheduled Send's timezone math — the wall clock + IANA tz the user picked
// is the source of truth; `fireAt` (epoch ms) is a cache the daemon compares
// against to fire. This is the only place that turns one into the other, so a
// DST rule change between scheduling and sending cannot move the send: the
// store recomputes every queued row's `fireAt` from `localTime`+`tz` at
// launch and pushes the corrected value back.
//
// No tz library in this project (and none is being added) — `Intl` already
// knows the rules.

// Building an Intl.DateTimeFormat is the expensive part and the zone list asks
// for two per zone (~840) every time the send instant crosses an hour; the
// formatters themselves never change, so they are built once per zone.
const formatters = new Map();
function formatter(tz, kind) {
  const key = `${tz}|${kind}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', kind === 'parts'
      ? { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit' }
      : { timeZone: tz, timeZoneName: kind });
    formatters.set(key, f);
  }
  return f;
}

function partsIn(tz, ms) {
  return Object.fromEntries(formatter(tz, 'parts').formatToParts(ms).map(p => [p.type, p.value]));
}

// ms east of UTC in `tz` at instant `ms`: its wall clock read as if it were
// UTC, minus the instant. Short by `ms`'s sub-second part, as the parts stop
// at seconds.
function offsetMsAt(tz, ms) {
  const p = partsIn(tz, ms);
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ms;
}

const pad = (n) => String(n).padStart(2, '0');

/**
 * `localTime` ("YYYY-MM-DDTHH:MM", as `<input type="datetime-local">` gives
 * it) interpreted in IANA `tz`, as an epoch ms instant.
 *
 * `Intl` has no wall-clock -> instant conversion, only instant -> wall-clock,
 * so this guesses the instant (treating the wall clock as if it were UTC),
 * reads back what `tz`'s offset actually is AT that guess, and corrects. One
 * pass is wrong exactly at a DST boundary — the guess can land on the wrong
 * side of the transition — so a second pass re-reads the offset at the
 * corrected instant and corrects again. Two passes converge because an IANA
 * zone changes offset at most once in the span this ever has to bridge.
 */
export function zonedTimeToEpoch(localTime, tz) {
  const guess = Date.parse(`${localTime}:00Z`);
  const offset1 = offsetMsAt(tz, guess);
  const offset2 = offsetMsAt(tz, guess - offset1);
  // ponytail: a spring-forward gap (the wall-clock minute this asked for does
  // not exist) has no "right" answer; this lands on the post-transition
  // instant rather than looping. Upgrade if a report ever needs the other side.
  return guess - offset2;
}

/** True when `localTime`+`tz` is already in the past relative to `now`. */
export function isPastLocalTime(localTime, tz, now = Date.now()) {
  return zonedTimeToEpoch(localTime, tz) <= now;
}

// Display only — a wall clock prints as itself, no tz conversion needed, so
// this never touches zonedTimeToEpoch. Formatted as if the picked numbers
// were UTC purely to borrow Intl's locale-aware month/weekday names.
export function formatWallClock(localTime, locale, options = { dateStyle: 'medium', timeStyle: 'short' }) {
  const [datePart, timePart] = localTime.split('T');
  const [y, m, d] = datePart.split('-').map(Number);
  const [h, min] = (timePart || '00:00').split(':').map(Number);
  const asIfUtc = new Date(Date.UTC(y, m - 1, d, h, min));
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' }).format(asIfUtc);
}

/** What the clock on the wall in `tz` reads at instant `ms`, as "YYYY-MM-DDTHH:MM". */
export function wallClockAt(ms, tz) {
  const p = partsIn(tz, ms);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** The calendar date `n` days after "YYYY-MM-DD". */
export function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// Presets are wall clocks IN `tz`: "tomorrow" is tomorrow where the email is
// going, which is not tomorrow here when the two sides of the date line
// disagree. Both land strictly after today in `tz`, so never in the past.
export function presetTomorrow8am(tz, now = Date.now()) {
  return `${addDays(wallClockAt(now, tz).slice(0, 10), 1)}T08:00`;
}

export function presetNextMonday8am(tz, now = Date.now()) {
  const today = wallClockAt(now, tz).slice(0, 10);
  const weekday = new Date(`${today}T00:00Z`).getUTCDay();
  return `${addDays(today, (8 - weekday) % 7 || 7)}T08:00`;
}

/**
 * `tz`'s offset from UTC at instant `ms`: `{ minutes, text: '+02:00' }`.
 * At an instant, not "now": New York is -04:00 in September and -05:00 after
 * the first Sunday of November, and the label must match the send.
 *
 * From the wall-clock parts, not `timeZoneName: 'longOffset'`: that is
 * WebKit 15.4+, and on an older macOS WKWebView it throws RangeError.
 */
export function utcOffsetAt(tz, ms) {
  const minutes = Math.round(offsetMsAt(tz, ms) / 60000) || 0; // no -0 for UTC
  const abs = Math.abs(minutes);
  return { minutes, text: `${minutes < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}` };
}

/** "America/New_York" -> "New York": the last segment, the way people say it. */
export function zoneCity(tz) {
  return tz.split('/').pop().replace(/_/g, ' ');
}

/**
 * The timezone picker's options for `zones` as they stand at instant `ms`:
 * label "(UTC-04:00) America/New York", value the IANA id untouched, sorted
 * by offset then id. Keywords let a search for "+2", "utc+2", "gmt+5:30" or
 * "EDT" find a zone whose label spells none of those.
 */
export function zoneOptions(zones, ms) {
  return zones.map(tz => {
    const { minutes, text } = utcOffsetAt(tz, ms);
    const sign = minutes < 0 ? '-' : '+';
    const h = Math.floor(Math.abs(minutes) / 60);
    const min = Math.abs(minutes) % 60;
    const short = min ? `${sign}${h}:${pad(min)}` : `${sign}${h}`;
    const keywords = [tz, zoneCity(tz), short, text, `utc${short}`, `gmt${short}`];
    if (!min) keywords.push(`${sign}${pad(h)}`);
    const abbr = formatter(tz, 'short').formatToParts(ms).find(p => p.type === 'timeZoneName')?.value;
    if (abbr && /^[A-Za-z]+$/.test(abbr)) keywords.push(abbr);
    return { value: tz, label: `(UTC${text}) ${tz.replace(/_/g, ' ')}`, keywords, minutes };
  }).sort((a, b) => a.minutes - b.minutes || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
}

// Every IANA zone `Intl` ships with the runtime: no date-picker dependency,
// no bundled tz data.
export const ALL_TIMEZONES = (() => {
  try { return Intl.supportedValuesOf('timeZone'); } catch { return [Intl.DateTimeFormat().resolvedOptions().timeZone]; }
})();

// ponytail: "which zone is a UTC offset" has no answer, only a likely one.
// The first of these that has the offset at the message's date wins, then any
// Region/City zone alphabetically. Add the recipient's city here, or let a
// hand pick be remembered (it is, through the schedule history), when a
// report says the guess was wrong.
const LIKELY_ZONES = [
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Anchorage',
  'Pacific/Honolulu', 'America/Halifax', 'America/Sao_Paulo',
  'Europe/London', 'Europe/Paris', 'Europe/Vilnius', 'Europe/Moscow',
  'Asia/Dubai', 'Asia/Karachi', 'Asia/Kolkata', 'Asia/Dhaka', 'Asia/Bangkok', 'Asia/Shanghai', 'Asia/Tokyo',
  'Australia/Sydney', 'Australia/Brisbane', 'Pacific/Auckland',
];

/**
 * The zone to preselect for a recipient, from the daemon's facts
 * (`scheduled.suggest_tz`): `{ tz, source: 'email', offset: '-04:00' }`,
 * `{ tz, source: 'history' }`, or null.
 *
 * 1. Their newest email's Date offset, at that email's date (New York is
 *    -04:00 in July and -05:00 in December): the zone last used for them if
 *    it had that offset then, else this machine's zone if it did, else a
 *    likely zone for the offset.
 * 2. The zone last used when scheduling to them.
 */
export function resolveSuggestedTz({ headerOffsetMinutes, headerDateMs, rememberedTz } = {}, { localTz, zones = ALL_TIMEZONES, now = Date.now() } = {}) {
  // A zone this runtime does not know throws in Intl; it is just not a match.
  const offsetOf = (tz, ms) => { try { return tz ? utcOffsetAt(tz, ms).minutes : null; } catch { return null; } };
  if (Number.isFinite(headerOffsetMinutes)) {
    const at = Number.isFinite(headerDateMs) ? headerDateMs : now;
    const fits = (tz) => offsetOf(tz, at) === headerOffsetMinutes;
    const regional = zones.filter(z => z.includes('/') && !/^(Etc|Antarctica)\//.test(z)).sort();
    const tz = [rememberedTz, localTz, ...LIKELY_ZONES].find(fits) || regional.find(fits);
    if (tz) {
      const abs = Math.abs(headerOffsetMinutes);
      const offset = `${headerOffsetMinutes < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
      return { tz, source: 'email', offset };
    }
  }
  if (offsetOf(rememberedTz, now) !== null) return { tz: rememberedTz, source: 'history' };
  return null;
}
