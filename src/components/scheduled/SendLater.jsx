import React, { useEffect, useState } from 'react';
import { ChevronUp, ChevronDown, X } from 'lucide-react';
import { useT } from '../../i18n/index.js';
import { useSettingsStore } from '../../stores/settingsStore';
import { intlLocale, hour12For } from '../../utils/dateFormat';
import { formatWallClock, wallClockAt, zoneCity } from '../../utils/scheduledTime';
import { clampDelay } from '../../utils/sendPlan';

const CHIPS = [5, 30, 60, 180];
const WHEN = { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' };

// A clock that stops while the panel is open lies about "at 14:35".
function useNow() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/** "2 hr 30 min" in the UI locale, with no catalog keys: Intl knows the units. */
export function formatDelay(minutes, locale = intlLocale()) {
  const unit = (unit, n) => new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'short' }).format(n);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return [h && unit('hour', h), (m || !h) && unit('minute', m)].filter(Boolean).join(' ');
}

/** The one line that says when an armed plan goes: under Send and in the panel. */
function usePlanText(plan, draft) {
  const t = useT();
  const hour12 = hour12For(useSettingsStore(s => s.timeFormat));
  const now = useNow();
  const locale = intlLocale();
  const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (plan?.kind === 'in' && plan.minutes > 0) {
    const time = formatWallClock(wallClockAt(now + plan.minutes * 60_000, here), locale,
      { ...(plan.minutes >= 12 * 60 ? WHEN : { hour: 'numeric', minute: '2-digit' }), hour12 });
    return t('compose.later.sendsIn', { duration: formatDelay(plan.minutes, locale), time });
  }
  if (plan?.kind === 'at' && draft?.localTime) {
    return t('compose.later.sendsAt', { time: formatWallClock(draft.localTime, locale, { ...WHEN, hour12 }), city: zoneCity(draft.tz) });
  }
  return '';
}

// One number, typed or stepped. Typing shifts digits in from the right, the
// way a clock field does: "0" "2" "5" reads 02 then 25. Steps and typed
// values both go through the caller, which clamps the total.
function Spin({ value, label, onType, onStep, testId }) {
  const stepClass = 'flex items-center justify-center h-4 w-5 rounded text-mail-text-muted hover:text-mail-text hover:bg-mail-surface-hover';
  return (
    <div className="flex items-center gap-0.5">
      <input
        type="text"
        inputMode="numeric"
        role="spinbutton"
        aria-label={label}
        aria-valuenow={value}
        data-testid={testId}
        value={String(value).padStart(2, '0')}
        onFocus={(e) => e.target.select()}
        onChange={(e) => onType(Number(e.target.value.replace(/\D/g, '').slice(-2)) || 0)}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
          e.preventDefault();
          onStep(e.key === 'ArrowUp' ? 1 : -1);
        }}
        className="w-11 h-9 text-center text-lg tabular-nums text-mail-text bg-mail-bg border border-mail-border
                  rounded-md outline-none focus:border-mail-accent"
      />
      <div className="flex flex-col">
        <button type="button" tabIndex={-1} aria-hidden="true" data-testid={`${testId}-up`} onClick={() => onStep(1)} className={stepClass}>
          <ChevronUp size={12} />
        </button>
        <button type="button" tabIndex={-1} aria-hidden="true" data-testid={`${testId}-down`} onClick={() => onStep(-1)} className={stepClass}>
          <ChevronDown size={12} />
        </button>
      </div>
    </div>
  );
}

/**
 * "Send in" hours and minutes, never past `max` minutes (24h 0m, or the free
 * undo window). Hours step by an hour, minutes by a minute across the hour.
 */
export function DelayPicker({ minutes, onChange, max, testIdPrefix = 'compose-later' }) {
  const t = useT();
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const set = (hours, mins) => onChange(clampDelay(hours, mins, max));
  const text = usePlanText({ kind: 'in', minutes });
  const chipClass = (on) => `px-2 py-1 text-xs rounded transition-colors ${on
    ? 'bg-mail-accent-fill text-white' : 'bg-mail-surface-hover hover:bg-mail-border text-mail-text'}`;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-sm text-mail-text-muted">
        <Spin value={h} label={t('compose.later.hours')} testId={`${testIdPrefix}-hours`}
          onType={(n) => set(Math.min(n, 24), m)} onStep={(d) => set(0, minutes + d * 60)} />
        <span aria-hidden="true">{t('compose.later.h')}</span>
        <Spin value={m} label={t('compose.later.minutes')} testId={`${testIdPrefix}-minutes`}
          onType={(n) => set(h, Math.min(n, 59))} onStep={(d) => set(0, minutes + d)} />
        <span aria-hidden="true">{t('compose.later.min')}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {CHIPS.filter(c => c <= max).map(c => (
          <button key={c} type="button" data-testid={`${testIdPrefix}-chip-${c}`} aria-pressed={c === minutes}
            onClick={() => onChange(c)} className={chipClass(c === minutes)}>
            {formatDelay(c)}
          </button>
        ))}
      </div>
      <p data-testid={`${testIdPrefix}-preview`} className="text-xs text-mail-text-muted min-h-4">{text}</p>
    </div>
  );
}

/** Under the footer once a plan is armed: when it goes, and the way back to Send now. */
export function SendPlanNote({ plan, draft, onClear }) {
  const t = useT();
  const text = usePlanText(plan, draft);
  if (!text) return null;
  return (
    <div className="flex items-center justify-end gap-1 px-5 pb-2 -mt-1 text-xs text-mail-text-muted">
      <span data-testid="compose-send-plan">{text}</span>
      <button type="button" data-testid="compose-send-plan-clear" aria-label={t('compose.later.clear')}
        title={t('compose.later.clear')} onClick={onClear}
        className="p-0.5 rounded hover:text-mail-text hover:bg-mail-surface-hover">
        <X size={12} />
      </button>
    </div>
  );
}
