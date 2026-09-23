import React, { useEffect, useMemo, useState } from 'react';
import { useT } from '../../i18n/index.js';
import { useSettingsStore } from '../../stores/settingsStore';
import { intlLocale, hour12For } from '../../utils/dateFormat';
import {
  isPastLocalTime, zonedTimeToEpoch, wallClockAt, formatWallClock, zoneOptions, zoneCity,
  presetTomorrow8am, presetNextMonday8am, ALL_TIMEZONES,
} from '../../utils/scheduledTime';
import { Combobox } from '../ui/Combobox';
import { DateTimePicker } from '../ui/DateTimePicker';

const LOCAL_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const HOUR_MS = 3_600_000;
const CLOCK = { hour: 'numeric', minute: '2-digit' };
const WHEN = { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' };

/**
 * One date-time field over one searchable timezone list, each the full width:
 * side by side in Compose's 26rem panel, "(UTC-03:00) Buenos Aires" or a
 * long date got cut off however the row was split. Shared by ComposeModal's
 * "Schedule send" picker and the Scheduled folder's Reschedule action, so
 * past-time refusal and preset math live in exactly one place.
 *
 * Refuses a past time HERE ONLY — this component never gates sending itself,
 * only the caller's submit button; catch-up (a row already due when the app
 * launches) must send, and does not go through this at all.
 *
 * Zone labels carry the UTC offset AT THE SEND INSTANT, not today's: a send
 * after the clocks change is labelled with the offset it will actually go
 * out under.
 *
 * `tzNote` says where a preselected zone came from (compose's suggestion
 * for the recipient); the caller drops it once the user picks a zone.
 */
export function SchedulePicker({ localTime, tz, onChange, presets = true, testIdPrefix = 'schedule', tzNote = null }) {
  const t = useT();
  const hour12 = hour12For(useSettingsStore(s => s.timeFormat));
  const locale = intlLocale();
  const [now, setNow] = useState(Date.now);
  // The "now" line is a clock; one that stops while the panel is open lies.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const picked = LOCAL_TIME_RE.test(localTime || '');
  const past = picked && isPastLocalTime(localTime, tz);
  const sendAt = picked ? zonedTimeToEpoch(localTime, tz) : now;
  // ~420 zones x two Intl lookups: rebuilt when the send instant crosses an
  // hour, not on every render.
  const sendHour = Math.floor(sendAt / HOUR_MS);
  const zones = useMemo(() => zoneOptions(ALL_TIMEZONES, sendHour * HOUR_MS), [sendHour]);

  // Read per render, not once: a laptop that travels changes zone mid-session.
  const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const away = tz !== here;
  const city = zoneCity(tz);
  const fmt = (wall, options) => formatWallClock(wall, locale, { ...options, hour12 });
  const nowHere = fmt(wallClockAt(now, here), CLOCK);

  const setTime = (next) => onChange({ localTime: next, tz });
  const presetClass = 'px-2 py-1 text-xs bg-mail-surface-hover rounded hover:bg-mail-border transition-colors';

  return (
    <div className="flex flex-col gap-2">
      <DateTimePicker
        value={localTime}
        tz={tz}
        onChange={setTime}
        ariaLabel={t('scheduled.picker.time')}
        placeholder={t('scheduled.picker.pickTime')}
        testId={`${testIdPrefix}-time`}
      />
      <Combobox
        value={tz}
        options={zones}
        onChange={(next) => onChange({ localTime, tz: next })}
        ariaLabel={t('scheduled.picker.timezone')}
        placeholder={t('scheduled.picker.searchTimezone')}
        testId={`${testIdPrefix}-tz`}
      />
      {tzNote && (
        <p data-testid={`${testIdPrefix}-tz-note`} className="text-xs text-mail-text-muted">{tzNote}</p>
      )}
      {presets && (
        <div className="flex items-center gap-2">
          <button type="button" data-testid={`${testIdPrefix}-preset-tomorrow`}
            onClick={() => setTime(presetTomorrow8am(tz))} className={presetClass}>
            {t('scheduled.picker.presetTomorrow')}
          </button>
          <button type="button" data-testid={`${testIdPrefix}-preset-monday`}
            onClick={() => setTime(presetNextMonday8am(tz))} className={presetClass}>
            {t('scheduled.picker.presetMonday')}
          </button>
        </div>
      )}
      <p data-testid={`${testIdPrefix}-now`} className="text-xs text-mail-text-muted">
        {away
          ? t('scheduled.picker.nowHereAndThere', { here: nowHere, there: fmt(wallClockAt(now, tz), CLOCK), city })
          : t('scheduled.picker.nowHere', { time: nowHere })}
      </p>
      {picked && away && (
        <p data-testid={`${testIdPrefix}-sends`} className="text-xs text-mail-text-muted">
          {t('scheduled.picker.sendsAt', { there: fmt(localTime, WHEN), city, here: fmt(wallClockAt(sendAt, here), WHEN) })}
        </p>
      )}
      {past && (
        <p role="alert" data-testid={`${testIdPrefix}-past-error`} className="text-xs text-mail-danger">
          {t('scheduled.picker.pastTime')}
        </p>
      )}
    </div>
  );
}
