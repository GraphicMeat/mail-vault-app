// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import ActivityCalendar from '../ActivityCalendar';
let resize;
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { constructor(cb) { resize = cb; } observe() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const days = [
  { date: '2026-09-07', received: 0, sent: 0, value: 0 },
  { date: '2026-09-08', received: 8, sent: 2, value: 10 },
  { date: '2026-09-09', received: 3, sent: 1, value: 4 },
  { date: '2026-09-10', received: 1, sent: 9, value: 10 },
];
const series = (start, length) => Array.from({ length }, (_, i) => ({ date: new Date(Date.parse(start + 'T00:00:00Z') + i * 86400000).toISOString().slice(0, 10), received: 0, sent: 0, value: 0 }));
describe('activity calendar', () => {
  it('selects the actual calendar day with separate sent and received counts', () => {
    const onSelectDate = vi.fn();
    render(<ActivityCalendar days={days} direction="both" selectedDate="2026-09-09" onSelectDate={onSelectDate} />);
    const day = screen.getByRole('button', { name: /9 September 2026.*3 received.*1 sent/i });
    expect(day.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(day);
    expect(onSelectDate).toHaveBeenCalledWith('2026-09-09');
  });
  it.each([[2025, 365], [2024, 366]])('renders every date exactly once for %i including leap days, without padding buttons', (year, length) => {
    const { container } = render(<ActivityCalendar days={series(`${year}-01-01`, length)} direction="received" onSelectDate={() => {}} />);
    const cells = [...container.querySelectorAll('button[data-date]')];
    expect(cells).toHaveLength(length);
    expect(new Set(cells.map(c => c.dataset.date)).size).toBe(length);
    expect(screen.getByRole('button', { name: new RegExp(`^1 January ${year},`) })).toBeTruthy();
    expect(screen.getByRole('button', { name: new RegExp(`^31 December ${year},`) })).toBeTruthy();
    expect(container.textContent).toContain(String(year));
  });
  it('places Monday first and uses one intensity scale for the whole range', () => {
    const { container, rerender } = render(<ActivityCalendar days={days} direction="received" onSelectDate={() => {}} />);
    const cell = date => container.querySelector(`[data-date="${date}"]`);
    expect(cell('2026-09-07').style.gridRow).toBe('1');
    expect(cell('2026-09-09').style.gridRow).toBe('3');
    expect(Number(cell('2026-09-08').dataset.level)).toBeGreaterThan(Number(cell('2026-09-10').dataset.level));
    rerender(<ActivityCalendar days={days} direction="sent" onSelectDate={() => {}} />);
    expect(Number(cell('2026-09-10').dataset.level)).toBeGreaterThan(Number(cell('2026-09-08').dataset.level));
    rerender(<ActivityCalendar days={days} direction="both" onSelectDate={() => {}} />);
    expect(cell('2026-09-10').dataset.level).toBe(cell('2026-09-08').dataset.level);
    expect(cell('2026-09-07').dataset.level).toBe('0');
  });
  it('moves by day and week, handles Home/End, selects Enter/Space and clamps at boundaries', () => {
    const onSelectDate = vi.fn();
    render(<ActivityCalendar days={series('2026-09-07', 14)} direction="both" selectedDate="2026-09-07" onSelectDate={onSelectDate} />);
    const day = n => screen.getByRole('button', { name: new RegExp(`^${n} September 2026,`) });
    day(7).focus();
    fireEvent.keyDown(day(7), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(day(7));
    fireEvent.keyDown(day(7), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(day(14));
    fireEvent.keyDown(day(14), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(day(15));
    fireEvent.keyDown(day(15), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(day(14));
    fireEvent.keyDown(day(14), { key: 'End' });
    expect(document.activeElement).toBe(day(20));
    fireEvent.keyDown(day(20), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(day(20));
    fireEvent.keyDown(day(20), { key: 'Home' });
    expect(document.activeElement).toBe(day(14));
    fireEvent.keyDown(day(14), { key: 'Enter' });
    expect(onSelectDate).toHaveBeenLastCalledWith('2026-09-14');
    fireEvent.keyDown(day(14), { key: ' ' });
    expect(onSelectDate).toHaveBeenCalledTimes(2);
  });
  it('keeps zero activity distinct from unavailable coverage and prevents unavailable selections', () => {
    const onSelectDate = vi.fn();
    const { container } = render(<ActivityCalendar days={[days[0], { date: '2026-09-08', received: null, sent: null, value: null }]} direction="both" onSelectDate={onSelectDate} />);
    expect(container.querySelector('[data-date="2026-09-07"]').dataset.level).toBe('0');
    const unavailable = screen.getByRole('button', { name: /8 September 2026.*coverage unavailable/i });
    expect(unavailable.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(unavailable);
    expect(onSelectDate).not.toHaveBeenCalled();
  });
  it('stacks quarter blocks at narrow content width, with each date still appearing once', () => {
    const { container } = render(<ActivityCalendar days={series('2026-01-01', 365)} direction="both" onSelectDate={() => {}} />);
    act(() => resize([{ contentRect: { width: 320 } }]));
    expect(screen.getAllByRole('group', { name: /2026/ })).toHaveLength(4);
    expect(new Set([...container.querySelectorAll('button[data-date]')].map(c => c.dataset.date)).size).toBe(365);
  });
  it.each([600, 616, 700])('keeps every annual date inside %ipx content without clipping the final weeks', width => {
    const { container } = render(<ActivityCalendar days={series('2026-01-01', 365)} direction="received" onSelectDate={() => {}} />);
    act(() => resize([{ contentRect: { width } }]));
    for (const block of container.querySelectorAll('.insights-calendar-block')) {
      // The rendered day grid includes its weekday column and the gaps between weeks.
      const columns = Number(block.style.getPropertyValue('--insights-weeks'));
      const cell = parseFloat(block.style.getPropertyValue('--insights-cell'));
      expect(28 + columns * cell + (columns - 1) * 3).toBeLessThanOrEqual(width);
    }
    expect(container.querySelectorAll('button[data-date]')).toHaveLength(365);
    expect(new Set([...container.querySelectorAll('button[data-date]')].map(c => c.dataset.date)).size).toBe(365);
  });
});
