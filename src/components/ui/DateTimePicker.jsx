import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CalendarClock, ChevronLeft, ChevronRight } from 'lucide-react';
import { useT } from '../../i18n/index.js';
import { useSettingsStore } from '../../stores/settingsStore';
import { intlLocale, hour12For } from '../../utils/dateFormat';
import { formatWallClock, wallClockAt } from '../../utils/scheduledTime';
import { Popover } from './Popover';
import { FIELD_TRIGGER, anchorTo } from './field';
import { Spin } from './SpinField';

const VALUE_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/;
const pad = (n) => String(n).padStart(2, '0');
const SLOTS = Array.from({ length: 96 }, (_, i) => `${pad(Math.floor(i / 4))}:${pad((i % 4) * 15)}`);
// The time a day gets when it is picked before any time was.
const DEFAULT_TIME = '08:00';
const TRIGGER_FORMAT = { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' };

// Intl says 1 = Monday .. 7 = Sunday; `getWeekInfo()` is the current spelling,
// `weekInfo` the older accessor, and either may be missing. Monday otherwise.
function weekStart(locale) {
  try {
    const l = new Intl.Locale(locale || 'en');
    return ((l.getWeekInfo?.() ?? l.weekInfo)?.firstDay ?? 1) % 7; // as a JS getUTCDay()
  } catch {
    return 1;
  }
}

/**
 * Date and time in one field: a month calendar beside a column of 15-minute
 * slots, plus hour and minute fields (typed or stepped) for an exact minute. The value is a wall clock,
 * "YYYY-MM-DDTHH:MM", in `tz`, which is also where "today" is: days before it
 * and slots already gone today are disabled. Nothing here refuses a submit;
 * the caller's own past-time check stays the only gate.
 *
 * Every pick applies at once (no OK button); the panel closes on an outside
 * click or Escape.
 */
export function DateTimePicker({ value, onChange, tz, ariaLabel, testId, placeholder = '', className = '' }) {
  const hour12 = hour12For(useSettingsStore(s => s.timeFormat));
  useT(); // repaint on a language switch: the label below is locale-formatted
  const locale = intlLocale();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const triggerRef = useRef(null);

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  const label = VALUE_RE.test(value || '')
    ? formatWallClock(value, locale, { ...TRIGGER_FORMAT, hour12 })
    : '';

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label ? `${ariaLabel}, ${label}` : ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid={testId}
        data-value={value || ''}
        onClick={() => { setPos(anchorTo(triggerRef.current, 330)); setOpen(true); }}
        className={`${FIELD_TRIGGER} whitespace-nowrap ${className}`}
      >
        <CalendarClock size={14} className="shrink-0 text-mail-text-muted" aria-hidden="true" />
        <span className={label ? '' : 'text-mail-text-muted'}>{label || placeholder}</span>
      </button>
      <Popover
        open={open}
        onClose={close}
        handlesTab
        variant="panel"
        role="dialog"
        aria-label={ariaLabel}
        style={pos}
        onKeyDown={trapTab}
      >
        <Panel value={value} onChange={onChange} tz={tz} locale={locale} hour12={hour12} testId={testId} />
      </Popover>
    </>
  );
}

// The panel is portaled to body, so the host dialog's Tab trap would pull
// focus out of it; it cycles its own controls instead. Keys also stop here:
// they would otherwise bubble up the React tree into Compose's form.
function trapTab(e) {
  e.stopPropagation();
  if (e.key !== 'Tab') return;
  const items = [...e.currentTarget.querySelectorAll('button:not([disabled]):not([tabindex="-1"]), input')];
  const at = items.indexOf(document.activeElement);
  if (e.shiftKey ? at <= 0 : at === items.length - 1) {
    e.preventDefault();
    items[e.shiftKey ? items.length - 1 : 0]?.focus();
  }
}

// Mounted only while open, so the month on screen starts from the picked day
// (or today) every time the panel opens.
function Panel({ value, onChange, tz, locale, hour12, testId }) {
  const t = useT();
  const rootRef = useRef(null);
  const slotsRef = useRef(null);
  const [, day = '', time = ''] = VALUE_RE.exec(value || '') || [];
  const nowWall = wallClockAt(Date.now(), tz);
  const today = nowWall.slice(0, 10);
  const [month, setMonth] = useState(() => (day || today).slice(0, 7));

  const [y, m] = month.split('-').map(Number);
  const start = weekStart(locale);
  const lead = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() - start + 7) % 7;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const fmts = useMemo(() => ({
    month: new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }),
    weekday: new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }),
    day: new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeZone: 'UTC' }),
    slot: new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', hour12, timeZone: 'UTC' }),
  }), [locale, hour12]);
  // 2023-01-01 was a Sunday: day `start + i` of that week is column i's name.
  const weekdays = Array.from({ length: 7 }, (_, i) => fmts.weekday.format(Date.UTC(2023, 0, 1 + ((start + i) % 7))));
  const shiftMonth = (n) => setMonth(new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7));

  // Opening lands focus on the picked day, and the slot column on the picked
  // time (or now), not on midnight.
  useEffect(() => {
    rootRef.current?.querySelector(`[data-testid="${testId}-day-${day || today}"]:not([disabled])`)?.focus({ preventScroll: true });
    const [h, min] = (time || nowWall.slice(11)).split(':').map(Number);
    const col = slotsRef.current;
    const slot = col?.children[Math.min(95, Math.round((h * 60 + min) / 15))];
    if (slot) col.scrollTop = slot.offsetTop - col.clientHeight / 2 + slot.offsetHeight / 2;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const cell = 'h-8 w-8 rounded-md text-sm transition-colors disabled:opacity-30 disabled:cursor-default';
  const onDay = (d) => onChange(`${d}T${time || DEFAULT_TIME}`);
  const onTime = (hhmm) => onChange(`${day || today}T${hhmm}`);
  const [h, min] = (time || DEFAULT_TIME).split(':').map(Number);
  const setExact = (total) => {
    const mins = Math.min(Math.max(0, total), 24 * 60 - 1);
    onTime(`${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`);
  };

  return (
    <div ref={rootRef} className="flex flex-col gap-2">
    <div className="flex gap-3">
      <div className="w-[15.5rem]">
        <div className="flex items-center justify-between mb-1">
          <button type="button" aria-label={t('common.previousMonth')} disabled={month <= today.slice(0, 7)}
            onClick={() => shiftMonth(-1)}
            className="p-1 rounded-md text-mail-text-muted hover:text-mail-text hover:bg-mail-surface-hover disabled:opacity-30">
            <ChevronLeft size={16} aria-hidden="true" />
          </button>
          <span className="text-sm font-medium text-mail-text">{fmts.month.format(Date.UTC(y, m - 1, 1))}</span>
          <button type="button" aria-label={t('common.nextMonth')} onClick={() => shiftMonth(1)}
            className="p-1 rounded-md text-mail-text-muted hover:text-mail-text hover:bg-mail-surface-hover">
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="grid grid-cols-7 gap-0.5 justify-items-center">
          {weekdays.map((w, i) => (
            <div key={i} aria-hidden="true" className="text-[11px] text-mail-text-muted py-1">{w}</div>
          ))}
          {Array.from({ length: lead }, (_, i) => <div key={`lead-${i}`} />)}
          {Array.from({ length: daysInMonth }, (_, i) => {
            const d = `${month}-${pad(i + 1)}`;
            const picked = d === day;
            return (
              <button key={d} type="button" data-testid={`${testId}-day-${d}`} disabled={d < today}
                aria-pressed={picked} aria-label={fmts.day.format(Date.UTC(y, m - 1, i + 1))}
                onClick={() => onDay(d)}
                className={`${cell} ${picked ? 'bg-mail-accent-fill text-white'
                  : d === today ? 'text-mail-accent-text font-semibold hover:bg-mail-surface-hover'
                    : 'text-mail-text hover:bg-mail-surface-hover'}`}>
                {i + 1}
              </button>
            );
          })}
        </div>
      </div>
      <div className="w-24 flex flex-col gap-2">
        <div ref={slotsRef} className="relative h-56 overflow-y-auto flex flex-col gap-0.5 pr-1">
          {SLOTS.map(s => {
            const picked = s === time;
            return (
              <button key={s} type="button" data-testid={`${testId}-slot-${s}`}
                disabled={`${day || today}T${s}` <= nowWall} aria-pressed={picked}
                onClick={() => onTime(s)}
                className={`shrink-0 h-7 px-2 rounded-md text-sm text-left transition-colors disabled:opacity-30 disabled:cursor-default
                  ${picked ? 'bg-mail-accent-fill text-white' : 'text-mail-text hover:bg-mail-surface-hover'}`}>
                {fmts.slot.format(Date.UTC(2000, 0, 1, +s.slice(0, 2), +s.slice(3)))}
              </button>
            );
          })}
        </div>
      </div>
    </div>
    <div role="group" aria-label={t('common.exactTime')} className="flex items-center justify-end gap-1 text-sm text-mail-text-muted">
      <Spin value={h} label={t('compose.later.hours')} testId={`${testId}-hours`}
        onType={(n) => setExact(Math.min(n, 23) * 60 + min)} onStep={(d) => setExact(h * 60 + min + d * 60)} />
      <span aria-hidden="true">:</span>
      <Spin value={min} label={t('compose.later.minutes')} testId={`${testId}-minutes`}
        onType={(n) => setExact(h * 60 + Math.min(n, 59))} onStep={(d) => setExact(h * 60 + min + d)} />
    </div>
    </div>
  );
}
