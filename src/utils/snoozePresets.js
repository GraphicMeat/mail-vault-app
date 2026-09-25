import { addDays, presetNextMonday8am, presetTomorrow8am, wallClockAt, zonedTimeToEpoch } from './scheduledTime';

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/**
 * Snooze's presets as instants, in a fixed order: later today (18:00, or
 * three hours on after 15:00, none after 21:00), tomorrow 08:00, this
 * weekend (Saturday 08:00, weekdays only) and next week (Monday 08:00).
 * Wall clocks in `tz`, the user's own zone, via Scheduled Send's helpers.
 */
export function snoozePresets(now = Date.now(), tz = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const wall = wallClockAt(now, tz);
  const today = wall.slice(0, 10);
  const hour = Number(wall.slice(11, 13));
  const weekday = new Date(`${today}T00:00Z`).getUTCDay();
  const presets = [];
  if (hour < 15) presets.push({ id: 'laterToday', at: zonedTimeToEpoch(`${today}T18:00`, tz) });
  else if (hour < 21) presets.push({ id: 'laterToday', at: Math.floor((now + 3 * HOUR_MS) / MINUTE_MS) * MINUTE_MS });
  presets.push({ id: 'tomorrow', at: zonedTimeToEpoch(presetTomorrow8am(tz, now), tz) });
  if (weekday >= 1 && weekday <= 5) presets.push({ id: 'weekend', at: zonedTimeToEpoch(`${addDays(today, 6 - weekday)}T08:00`, tz) });
  presets.push({ id: 'nextWeek', at: zonedTimeToEpoch(presetNextMonday8am(tz, now), tz) });
  return presets;
}
