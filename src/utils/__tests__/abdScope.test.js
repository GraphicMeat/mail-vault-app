import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIRST_YEAR, dateScopeFor, olderCutoffDate, yearBounds, yearStartMs } from '../abdScope';

/**
 * A year is a calendar year in the reader's zone. The expected values below are
 * read back through the Date getters (local time) rather than written as epoch
 * numbers, so the specs hold in whatever zone the machine runs in.
 */
const NOW = new Date(2026, 8, 29, 12, 0, 0); // Sep 29 2026, midday, local

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
afterEach(() => vi.useRealTimers());

const isLocalMidnightJan1 = (ms, year) => {
  const d = new Date(ms);
  return d.getFullYear() === year && d.getMonth() === 0 && d.getDate() === 1
    && d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0;
};

describe('yearBounds', () => {
  it('runs from 1970 to next year, each year [local Jan 1, next local Jan 1)', () => {
    const bounds = yearBounds(NOW);
    expect(bounds[0].year).toBe(FIRST_YEAR);
    expect(bounds.at(-1).year).toBe(2027);
    expect(bounds).toHaveLength(2027 - FIRST_YEAR + 1);
    for (const { year, startMs, endMs } of bounds) {
      expect(isLocalMidnightJan1(startMs, year), String(year)).toBe(true);
      expect(isLocalMidnightJan1(endMs, year + 1), String(year)).toBe(true);
      expect(endMs).toBeGreaterThan(startMs);
    }
  });

  it('leaves no gap and no overlap between neighbouring years', () => {
    const bounds = yearBounds(NOW);
    for (let i = 1; i < bounds.length; i += 1) expect(bounds[i].startMs).toBe(bounds[i - 1].endMs);
  });

  it('follows the clock: next year is the last one', () => {
    vi.setSystemTime(new Date(2031, 0, 1, 0, 0, 1));
    expect(yearBounds().at(-1).year).toBe(2032);
  });
});

describe('older than 2 years', () => {
  it('cuts off at Jan 1 of the year before last, in local time', () => {
    const cutoff = olderCutoffDate(NOW);
    expect(isLocalMidnightJan1(cutoff.getTime(), 2024)).toBe(true);
  });

  it('moves with the calendar year, not with the day', () => {
    expect(olderCutoffDate(new Date(2026, 0, 1, 0, 0, 1)).getFullYear()).toBe(2024);
    expect(olderCutoffDate(new Date(2026, 11, 31, 23, 59, 59)).getFullYear()).toBe(2024);
    expect(olderCutoffDate(new Date(2027, 0, 1, 0, 0, 1)).getFullYear()).toBe(2025);
  });
});

describe('dateScopeFor', () => {
  it('All dates', () => {
    expect(dateScopeFor('all', { now: NOW })).toEqual({ kind: 'all' });
  });

  it('This year is a range that opens at local Jan 1 and has no end', () => {
    const scope = dateScopeFor('this_year', { now: NOW });
    expect(scope).toMatchObject({ kind: 'range', beforeMs: null });
    expect(isLocalMidnightJan1(scope.sinceMs, 2026)).toBe(true);
    expect(scope.sinceMs).toBe(yearStartMs(2026));
  });

  it('Last year is the one year before this one', () => {
    expect(dateScopeFor('last_year', { now: NOW })).toEqual({ kind: 'years', years: [2025] });
  });

  it('Older than 2 years is a range that ends at the cut-off and has no start', () => {
    const scope = dateScopeFor('older_than_2', { now: NOW });
    expect(scope).toMatchObject({ kind: 'range', sinceMs: null });
    expect(isLocalMidnightJan1(scope.beforeMs, 2024)).toBe(true);
  });

  it('Choose years sends the picked years once each, oldest first', () => {
    expect(dateScopeFor('years', { now: NOW, years: [2023, 2019, 2023, 2021] })).toEqual({ kind: 'years', years: [2019, 2021, 2023] });
    expect(dateScopeFor('years', { now: NOW })).toEqual({ kind: 'years', years: [] });
  });

  it('an unknown choice is All dates, never a silent narrowing', () => {
    expect(dateScopeFor('nonsense', { now: NOW })).toEqual({ kind: 'all' });
  });
});
