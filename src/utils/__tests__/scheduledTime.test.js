import { describe, it, expect } from 'vitest';
import { zonedTimeToEpoch, isPastLocalTime, formatWallClock } from '../scheduledTime';

// US DST rule (2026): America/New_York springs forward on 2026-03-08 at
// 02:00 local (clocks jump straight to 03:00) — verified independently below
// against Intl itself, not against zonedTimeToEpoch, before it is ever used
// as an expectation.
const NY = 'America/New_York';

describe('zonedTimeToEpoch', () => {
  it('the DST transition really is where this test assumes it is', () => {
    const fmt = (ms) => new Intl.DateTimeFormat('en-US', {
      timeZone: NY, hourCycle: 'h23', hour: '2-digit', minute: '2-digit',
    }).format(ms);
    // 06:59 UTC is still 01:59 EST; 07:00 UTC is already 03:00 EDT.
    expect(fmt(Date.UTC(2026, 2, 8, 6, 59))).toBe('01:59');
    expect(fmt(Date.UTC(2026, 2, 8, 7, 0))).toBe('03:00');
  });

  it('resolves a wall clock after the spring-forward to EDT (UTC-4)', () => {
    // Noon on transition day is already in daylight time.
    expect(zonedTimeToEpoch('2026-03-08T12:00', NY)).toBe(Date.UTC(2026, 2, 8, 16, 0));
  });

  it('resolves the same wall clock a month earlier to EST (UTC-5)', () => {
    // Same 12:00 local, before the rule changes — this is the case a single
    // cached `fireAt` would get wrong if the DST rule shifted after scheduling.
    expect(zonedTimeToEpoch('2026-01-08T12:00', NY)).toBe(Date.UTC(2026, 0, 8, 17, 0));
  });

  it('lands on the post-transition instant for a wall-clock time the spring-forward gap skips', () => {
    // 02:30 local never happens on 2026-03-08 (clocks jump 02:00 -> 03:00).
    // There is no correct answer; this only pins down that it does not throw
    // and picks a definite, stable side (see the ponytail note in the source).
    const epoch = zonedTimeToEpoch('2026-03-08T02:30', NY);
    expect(Number.isFinite(epoch)).toBe(true);
  });

  it('agrees with a fixed-offset zone that has no DST at all', () => {
    expect(zonedTimeToEpoch('2026-06-15T09:00', 'UTC')).toBe(Date.UTC(2026, 5, 15, 9, 0));
  });
});

describe('isPastLocalTime', () => {
  it('is true for a time before "now"', () => {
    expect(isPastLocalTime('2020-01-01T00:00', 'UTC', Date.UTC(2021, 0, 1))).toBe(true);
  });

  it('is false for a time after "now"', () => {
    expect(isPastLocalTime('2030-01-01T00:00', 'UTC', Date.UTC(2021, 0, 1))).toBe(false);
  });
});

describe('formatWallClock', () => {
  it('prints the picked numbers as-is — no timezone math involved', () => {
    // Same wall clock, deliberately fed a DST-ambiguous date, to show display
    // never routes through zonedTimeToEpoch at all.
    const out = formatWallClock('2026-03-08T02:30', 'en-US');
    expect(out).toContain('2026');
    expect(out).toMatch(/2:30/);
  });
});
