import React from 'react';
import { useT } from '../../i18n/index.js';
import { isPastLocalTime } from '../../utils/scheduledTime';

// Every IANA zone `Intl` ships with the runtime — no date-picker dependency,
// no bundled tz data.
const ALL_TIMEZONES = (() => {
  try { return Intl.supportedValuesOf('timeZone'); } catch { return [Intl.DateTimeFormat().resolvedOptions().timeZone]; }
})();

const LOCAL_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function pad(n) { return String(n).padStart(2, '0'); }

/** A JS Date, read through its own local getters, as a datetime-local value. */
export function toInputValue(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function tomorrow8am(from = new Date()) {
  const d = new Date(from);
  d.setDate(d.getDate() + 1);
  d.setHours(8, 0, 0, 0);
  return d;
}

function nextMonday8am(from = new Date()) {
  const d = new Date(from);
  const addDays = (8 - d.getDay()) % 7 || 7; // always strictly in the future
  d.setDate(d.getDate() + addDays);
  d.setHours(8, 0, 0, 0);
  return d;
}

/**
 * Native controls only: `<input type="datetime-local">` + a `<select>` of
 * every zone `Intl.supportedValuesOf('timeZone')` knows. Shared by
 * ComposeModal's "Schedule send" picker and the Scheduled folder's Reschedule
 * action, so past-time refusal and preset math live in exactly one place.
 *
 * Refuses a past time HERE ONLY — this component never gates sending itself,
 * only the caller's submit button; catch-up (a row already due when the app
 * launches) must send, and does not go through this at all.
 *
 * ponytail: presets compute from the machine's own local wall clock, not from
 * whichever `tz` is currently selected — picking a non-default display zone
 * and then a preset gives 8am machine-local, relabeled. Upgrade if that
 * combination turns out to matter.
 */
export function SchedulePicker({ localTime, tz, onChange, presets = true, testIdPrefix = 'schedule' }) {
  const t = useT();
  const past = LOCAL_TIME_RE.test(localTime || '') && isPastLocalTime(localTime, tz);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <input
          type="datetime-local"
          aria-label={t('scheduled.picker.time')}
          data-testid={`${testIdPrefix}-time`}
          value={localTime}
          onChange={(e) => onChange({ localTime: e.target.value, tz })}
          className="flex-1 bg-transparent text-mail-text text-sm py-1 px-2
                    border border-mail-border rounded-md outline-none"
        />
        <select
          aria-label={t('scheduled.picker.timezone')}
          data-testid={`${testIdPrefix}-tz`}
          value={tz}
          onChange={(e) => onChange({ localTime, tz: e.target.value })}
          className="bg-transparent text-mail-text text-sm py-1 px-2
                    border border-mail-border rounded-md outline-none max-w-[45%]"
        >
          {!ALL_TIMEZONES.includes(tz) && <option value={tz}>{tz}</option>}
          {ALL_TIMEZONES.map(z => <option key={z} value={z}>{z}</option>)}
        </select>
      </div>
      {presets && (
        <div className="flex items-center gap-2">
          <button type="button" data-testid={`${testIdPrefix}-preset-tomorrow`}
            onClick={() => onChange({ localTime: toInputValue(tomorrow8am()), tz })}
            className="px-2 py-1 text-xs bg-mail-surface-hover rounded hover:bg-mail-border transition-colors">
            {t('scheduled.picker.presetTomorrow')}
          </button>
          <button type="button" data-testid={`${testIdPrefix}-preset-monday`}
            onClick={() => onChange({ localTime: toInputValue(nextMonday8am()), tz })}
            className="px-2 py-1 text-xs bg-mail-surface-hover rounded hover:bg-mail-border transition-colors">
            {t('scheduled.picker.presetMonday')}
          </button>
        </div>
      )}
      {past && (
        <p role="alert" data-testid={`${testIdPrefix}-past-error`} className="text-xs text-mail-danger">
          {t('scheduled.picker.pastTime')}
        </p>
      )}
    </div>
  );
}
