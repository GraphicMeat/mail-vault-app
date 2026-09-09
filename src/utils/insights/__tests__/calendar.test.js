import { describe, expect, it } from 'vitest';
import { calendarCell, calendarDays, localDateKey } from '../calendar.js';

describe('Insights local calendar', () => {
  it('assigns receive instants across local midnight', () => {
    expect(localDateKey('2026-09-08T21:30:00Z', 'Europe/Vilnius')).toBe('2026-09-09');
    expect(localDateKey('2026-09-09T00:30:00+03:00', 'Europe/Vilnius')).toBe('2026-09-09');
    expect(localDateKey('2026-09-08T21:30:00Z', 'America/New_York')).toBe('2026-09-08');
  });

  it('keeps leap day and crosses a year boundary', () => {
    expect(calendarDays('2024-02-28', '2024-03-01')).toEqual(['2024-02-28', '2024-02-29', '2024-03-01']);
    expect(calendarDays('2025-12-31', '2026-01-02')).toEqual(['2025-12-31', '2026-01-01', '2026-01-02']);
    expect(calendarDays('2100-02-28', '2100-03-01')).toEqual(['2100-02-28', '2100-03-01']);
  });

  it('materializes a single date only once', () => {
    expect(calendarDays('2026-09-09', '2026-09-09')).toEqual(['2026-09-09']);
  });

  it('places partial weeks in a Monday-first grid without shifting Sunday', () => {
    expect(calendarCell('2026-09-09', '2026-09-09')).toEqual({ week: 0, weekday: 2 });
    expect(calendarCell('2026-09-13', '2026-09-09')).toEqual({ week: 0, weekday: 6 });
    expect(calendarCell('2026-09-14', '2026-09-09')).toEqual({ week: 1, weekday: 0 });
    expect(calendarCell('2027-01-04', '2026-12-31')).toEqual({ week: 1, weekday: 0 });
  });

  it('uses real calendar days through both DST changes', () => {
    expect(calendarDays('2026-03-28', '2026-03-30')).toEqual(['2026-03-28', '2026-03-29', '2026-03-30']);
    expect(calendarDays('2026-10-24', '2026-10-26')).toEqual(['2026-10-24', '2026-10-25', '2026-10-26']);
    expect(localDateKey('2026-03-29T00:59:00Z', 'Europe/Vilnius')).toBe('2026-03-29');
    expect(localDateKey('2026-03-29T01:01:00Z', 'Europe/Vilnius')).toBe('2026-03-29');
    expect(localDateKey('2026-10-25T00:30:00Z', 'Europe/Vilnius')).toBe('2026-10-25');
    expect(localDateKey('2026-10-25T01:30:00Z', 'Europe/Vilnius')).toBe('2026-10-25');
  });

  it.each([
    ['2026-09-10', '2026-09-09'], ['2026-02-29', '2026-03-01'],
    ['2026-09-00', '2026-09-09'], ['2026-9-01', '2026-09-09'],
    ['garbage', '2026-09-09'],
  ])('rejects an impossible or reversed range %s to %s', (start, end) => {
    expect(() => calendarDays(start, end)).toThrow(RangeError);
  });

  it('keeps invalid/missing timestamps unknown instead of using epoch or rolling dates', () => {
    expect(localDateKey(null, 'UTC')).toBeNull();
    expect(localDateKey('nonsense', 'UTC')).toBeNull();
    expect(localDateKey('2026-02-30T10:00:00Z', 'UTC')).toBeNull();
    expect(() => localDateKey('2026-09-09T00:00:00Z', 'Not/AZone')).toThrow(RangeError);
  });
});
