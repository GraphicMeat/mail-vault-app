import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../../i18n';
import { chartLocale, compareStable } from '../../utils/insights/chartFormat';
import '../../styles/insights-charts.css';

const DAY = 86400000;
const stamp = date => Date.parse(`${date}T00:00:00Z`);
const weekday = date => (new Date(stamp(date)).getUTCDay() + 6) % 7;
const available = day => day.available !== false && day.received != null && day.sent != null;
const valueFor = (day, direction) => direction === 'both' ? day.received + day.sent : day[direction];
const formatDate = (date, options) => new Intl.DateTimeFormat(chartLocale(), { ...options, timeZone: 'UTC' }).format(stamp(date));
const weeksFor = group => {
  const first = group[0].date;
  const last = group[group.length - 1].date;
  const start = stamp(first) - weekday(first) * DAY;
  return Math.floor((stamp(last) - start) / (7 * DAY)) + 1;
};
const fitsAnnualBlock = (group, width) => {
  const weeks = weeksFor(group);
  return 28 + weeks * 10 + (weeks - 1) * 3 <= width;
};

/** Days already contain logical-message totals. Never sum sender interactions. */
export default function ActivityCalendar({ days = [], direction = 'received', selectedDate, onSelectDate }) {
  const t = useT();
  const root = useRef(null);
  const buttons = useRef(new Map());
  const [width, setWidth] = useState(900);
  const [focusedDate, setFocusedDate] = useState(selectedDate);
  useEffect(() => {
    if (!root.current || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  const uniqueDays = useMemo(() => [...new Map((Array.isArray(days) ? days : []).map(day => [day.date, day])).values()]
    .sort((a, b) => compareStable(a.date, b.date)), [days]);
  const dates = useMemo(() => uniqueDays.map(d => d.date), [uniqueDays]);
  const currentFocus = dates.includes(focusedDate) ? focusedDate : dates.includes(selectedDate) ? selectedDate : dates[0];
  const maximum = Math.max(1, ...uniqueDays.filter(available).map(day => valueFor(day, direction)));
  const groups = useMemo(() => {
    const years = new Map();
    uniqueDays.forEach(day => {
      const year = day.date.slice(0, 4);
      if (!years.has(year)) years.set(year, []);
      years.get(year).push(day);
    });
    const result = [];
    years.forEach((yearDays, year) => {
      if (fitsAnnualBlock(yearDays, width)) {
        result.push(yearDays);
        return;
      }
      const quarters = new Map();
      yearDays.forEach(day => {
        const quarter = `${year}-${Math.floor((Number(day.date.slice(5, 7)) - 1) / 3)}`;
        if (!quarters.has(quarter)) quarters.set(quarter, []);
        quarters.get(quarter).push(day);
      });
      quarters.forEach(quarterDays => result.push(quarterDays));
    });
    return result;
  }, [uniqueDays, width]);
  const activate = day => { if (available(day)) onSelectDate?.(day.date); };
  const keyDown = (event, day) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault(); activate(day); return;
    }
    const offsets = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1,
      Home: -weekday(day.date), End: 6 - weekday(day.date) };
    if (!(event.key in offsets)) return;
    event.preventDefault();
    const index = Math.max(0, Math.min(dates.length - 1, dates.indexOf(day.date) + offsets[event.key]));
    setFocusedDate(dates[index]);
    buttons.current.get(dates[index])?.focus();
  };
  const totals = uniqueDays.filter(available).reduce((sum, day) => ({ received: sum.received + day.received, sent: sum.sent + day.sent }), { received: 0, sent: 0 });
  return <section ref={root} className="insights-chart insights-calendar" aria-label={t('insights.chart.calendar')}>
    {!uniqueDays.length && <p className="insights-chart-empty">{t(days === null ? 'insights.chart.unavailable' : 'insights.chart.noActivity')}</p>}
    {groups.map(group => {
      const first = group[0].date;
      const last = group[group.length - 1].date;
      const start = stamp(first) - weekday(first) * DAY;
      const weeks = weeksFor(group);
      const cellSize = Math.max(10, Math.min(18, (width - 40) / weeks - 3));
      const yearDays = uniqueDays.filter(day => day.date.slice(0, 4) === first.slice(0, 4));
      const annual = group.length === yearDays.length && fitsAnnualBlock(yearDays, width);
      const label = annual
        ? formatDate(first, { year: 'numeric' })
        : `${formatDate(first, { month: 'short' })} – ${formatDate(last, { month: 'short', year: 'numeric' })}`;
      const monthStarts = group.filter((day, index) => index === 0 || day.date.slice(5, 7) !== group[index - 1].date.slice(5, 7));
      return <div role="group" aria-label={label} key={first} className="insights-calendar-block" style={{ '--insights-cell': `${cellSize}px`, '--insights-weeks': weeks }}>
        <h3>{label}</h3>
        <div className="insights-calendar-months" aria-hidden="true">
          {monthStarts.map(day => <span key={day.date} style={{ gridColumn: `${Math.floor((stamp(day.date) - start) / (7 * DAY)) + 1} / span 3` }}>
            {formatDate(day.date, { month: 'short' })}
          </span>)}
        </div>
        <div className="insights-calendar-body">
          <div className="insights-calendar-weekdays" aria-hidden="true">
            {Array.from({ length: 7 }, (_, i) => <span key={i}>{new Intl.DateTimeFormat(chartLocale(), { weekday: 'narrow', timeZone: 'UTC' }).format(Date.UTC(2026, 8, 7 + i))}</span>)}
          </div>
          <div className="insights-calendar-cells">
            {group.map(day => {
              const known = available(day);
              const value = known ? valueFor(day, direction) : 0;
              const level = value > 0 ? Math.min(4, Math.ceil(value / maximum * 4)) : 0;
              const label = t(known ? 'insights.chart.dayLabel' : 'insights.chart.dayUnavailable', {
                date: formatDate(day.date, { day: 'numeric', month: 'long', year: 'numeric' }), received: day.received, sent: day.sent,
              });
              return <button type="button" key={day.date} ref={element => { if (element) buttons.current.set(day.date, element); else buttons.current.delete(day.date); }}
                className="insights-calendar-day" data-date={day.date} data-level={known ? level : 'unavailable'}
                style={{ gridRow: weekday(day.date) + 1, gridColumn: Math.floor((stamp(day.date) - start) / (7 * DAY)) + 1 }}
                title={label} aria-label={label} aria-pressed={selectedDate === day.date} aria-disabled={!known}
                tabIndex={currentFocus === day.date ? 0 : -1} onFocus={() => setFocusedDate(day.date)}
                onClick={() => activate(day)} onKeyDown={event => keyDown(event, day)} />;
            })}
          </div>
        </div>
      </div>;
    })}
    {uniqueDays.length > 0 && <div className="insights-calendar-footer">
      <span>{t('insights.chart.counts', totals)}</span>
      <div className="insights-calendar-legend"><span>{t('insights.chart.less')}</span>
        {[0, 1, 2, 3, 4].map(level => <i key={level} data-level={level} aria-hidden="true" />)}
        <span>{t('insights.chart.more')}</span>
      </div>
      {uniqueDays.some(day => !available(day)) && <span>{t('insights.chart.unavailable')}</span>}
    </div>}
  </section>;
}
