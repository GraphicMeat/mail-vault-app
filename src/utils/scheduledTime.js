// Scheduled Send's timezone math — the wall clock + IANA tz the user picked
// is the source of truth; `fireAt` (epoch ms) is a cache the daemon compares
// against to fire. This is the only place that turns one into the other, so a
// DST rule change between scheduling and sending cannot move the send: the
// store recomputes every queued row's `fireAt` from `localTime`+`tz` at
// launch and pushes the corrected value back.
//
// No tz library in this project (and none is being added) — `Intl` already
// knows the rules.

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
  const offsetAt = (ms) => {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      }).formatToParts(ms).map(p => [p.type, p.value])
    );
    const asIfUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    return asIfUtc - ms; // ms east of UTC at this instant
  };
  const offset1 = offsetAt(guess);
  const offset2 = offsetAt(guess - offset1);
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
export function formatWallClock(localTime, locale) {
  const [datePart, timePart] = localTime.split('T');
  const [y, m, d] = datePart.split('-').map(Number);
  const [h, min] = (timePart || '00:00').split(':').map(Number);
  const asIfUtc = new Date(Date.UTC(y, m - 1, d, h, min));
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(asIfUtc);
}
