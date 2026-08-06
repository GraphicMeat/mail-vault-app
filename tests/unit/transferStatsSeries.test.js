import { describe, it, expect } from 'vitest';
import { lastDaysSeries } from '../../src/utils/transferLimits';

// Fixed instant, deliberately late in a UTC day so a local-time implementation
// west of UTC would produce a different window and fail here.
const NOW = new Date('2026-08-06T23:30:00Z');

describe('lastDaysSeries', () => {
  it('returns the last 7 UTC days oldest to newest, today last', () => {
    const series = lastDaysSeries({}, 7, NOW);
    expect(series).toHaveLength(7);
    expect(series[0].key).toBe('2026-07-31');
    expect(series[6].key).toBe('2026-08-06');
  });

  it('zero-fills days with no bucket and keeps the ones that have data', () => {
    const series = lastDaysSeries({ '2026-08-04': { down: 100, up: 5 } }, 7, NOW);
    const populated = series.filter(d => d.down || d.up);
    expect(populated).toEqual([{ key: '2026-08-04', label: 'T', down: 100, up: 5 }]);
    expect(series.every(d => Number.isFinite(d.down) && Number.isFinite(d.up))).toBe(true);
  });

  it('ignores buckets outside the window and survives a missing days map', () => {
    const series = lastDaysSeries({ '2026-07-01': { down: 999, up: 999 } }, 7, NOW);
    expect(series.some(d => d.down > 0)).toBe(false);
    expect(lastDaysSeries(undefined, 7, NOW)).toHaveLength(7);
  });

  it('labels each day with its UTC weekday initial', () => {
    // 2026-08-06 is a Thursday.
    expect(lastDaysSeries({}, 7, NOW)[6].label).toBe('T');
    expect(lastDaysSeries({}, 7, NOW)[2].label).toBe('S'); // 2026-08-02, Sunday
  });
});
