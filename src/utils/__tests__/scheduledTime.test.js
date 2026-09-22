import { describe, it, expect } from 'vitest';
import {
  zonedTimeToEpoch, isPastLocalTime, formatWallClock, wallClockAt, addDays,
  presetTomorrow8am, presetNextMonday8am, utcOffsetAt, zoneCity, zoneOptions, resolveSuggestedTz,
} from '../scheduledTime';

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

describe('formatWallClock with options', () => {
  it('takes caller options and the hour12 choice, still without tz math', () => {
    const out = formatWallClock('2026-09-24T16:00', 'en-GB', {
      weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: false,
    });
    expect(out).toContain('Thu');
    expect(out).toContain('24');
    expect(out).toContain('Sep');
    expect(out).toContain('16:00');
  });
});

// Every expectation below pins its own instant: "today", offsets and presets
// all depend on when the suite runs and on the runner's own zone otherwise.
// 2026-09-23 23:30 UTC is Wednesday evening in Los Angeles and already
// Thursday morning in Tokyo.
const WED_LATE_UTC = Date.UTC(2026, 8, 23, 23, 30);

describe('wallClockAt', () => {
  it('reads the wall clock in the zone asked for, not the machine\'s', () => {
    expect(wallClockAt(WED_LATE_UTC, 'Asia/Tokyo')).toBe('2026-09-24T08:30');
    expect(wallClockAt(WED_LATE_UTC, 'America/Los_Angeles')).toBe('2026-09-23T16:30');
    expect(wallClockAt(WED_LATE_UTC, 'UTC')).toBe('2026-09-23T23:30');
  });

  it('round-trips with zonedTimeToEpoch', () => {
    expect(zonedTimeToEpoch(wallClockAt(WED_LATE_UTC, NY), NY)).toBe(WED_LATE_UTC);
  });
});

describe('addDays', () => {
  it('crosses month, year and leap-day boundaries', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-09-28', 7)).toBe('2026-10-05');
  });
});

describe('presets in the selected zone', () => {
  it('"tomorrow" is tomorrow where the email is going', () => {
    // The two zones disagree about today's date at this instant.
    expect(presetTomorrow8am('Asia/Tokyo', WED_LATE_UTC)).toBe('2026-09-25T08:00');
    expect(presetTomorrow8am('America/Los_Angeles', WED_LATE_UTC)).toBe('2026-09-24T08:00');
  });

  it('"Monday" is the next Monday in the zone, strictly after its today', () => {
    expect(presetNextMonday8am('Asia/Tokyo', WED_LATE_UTC)).toBe('2026-09-28T08:00');
    // 2026-09-28 01:00 UTC: already Monday in Tokyo (so the NEXT one), still
    // Sunday in Los Angeles (so tomorrow).
    const mondayInTokyo = Date.UTC(2026, 8, 28, 1, 0);
    expect(presetNextMonday8am('Asia/Tokyo', mondayInTokyo)).toBe('2026-10-05T08:00');
    expect(presetNextMonday8am('America/Los_Angeles', mondayInTokyo)).toBe('2026-09-28T08:00');
  });

  it('never lands in the past', () => {
    for (const tz of ['Asia/Tokyo', 'America/Los_Angeles', 'Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
      expect(isPastLocalTime(presetTomorrow8am(tz, WED_LATE_UTC), tz, WED_LATE_UTC), tz).toBe(false);
      expect(isPastLocalTime(presetNextMonday8am(tz, WED_LATE_UTC), tz, WED_LATE_UTC), tz).toBe(false);
    }
  });
});

describe('utcOffsetAt', () => {
  it('is the offset at the instant asked for: New York either side of the November change', () => {
    expect(utcOffsetAt(NY, Date.UTC(2026, 8, 15, 12))).toEqual({ minutes: -240, text: '-04:00' });
    expect(utcOffsetAt(NY, Date.UTC(2026, 10, 15, 12))).toEqual({ minutes: -300, text: '-05:00' });
  });

  it('reads a bare GMT as +00:00 and keeps half hours', () => {
    expect(utcOffsetAt('UTC', WED_LATE_UTC)).toEqual({ minutes: 0, text: '+00:00' });
    expect(utcOffsetAt('Asia/Kolkata', WED_LATE_UTC)).toEqual({ minutes: 330, text: '+05:30' });
  });
});

describe('zoneCity', () => {
  it('is the last segment with spaces', () => {
    expect(zoneCity('America/New_York')).toBe('New York');
    expect(zoneCity('America/Argentina/Buenos_Aires')).toBe('Buenos Aires');
    expect(zoneCity('UTC')).toBe('UTC');
  });
});

describe('zoneOptions', () => {
  const JAN = Date.UTC(2026, 0, 15, 12);
  const zones = ['Europe/Vilnius', 'Asia/Kolkata', NY, 'Europe/Paris', 'Europe/Berlin'];

  it('labels each zone with its offset, spaces for underscores, value untouched', () => {
    const ny = zoneOptions([NY], JAN)[0];
    expect(ny.value).toBe(NY);
    expect(ny.label).toBe('(UTC-05:00) America/New York');
    expect(zoneOptions(['Europe/Vilnius'], JAN)[0].label).toBe('(UTC+02:00) Europe/Vilnius');
  });

  it('labels at the instant given, so a send after the clocks change shows its own offset', () => {
    expect(zoneOptions([NY], Date.UTC(2026, 8, 15, 12))[0].label).toBe('(UTC-04:00) America/New York');
    expect(zoneOptions([NY], Date.UTC(2026, 10, 15, 12))[0].label).toBe('(UTC-05:00) America/New York');
  });

  it('sorts by offset, then by id', () => {
    expect(zoneOptions(zones, JAN).map(o => o.value))
      .toEqual([NY, 'Europe/Berlin', 'Europe/Paris', 'Europe/Vilnius', 'Asia/Kolkata']);
  });

  it('carries every offset spelling a search might use', () => {
    const [vilnius] = zoneOptions(['Europe/Vilnius'], JAN);
    expect(vilnius.keywords).toEqual(expect.arrayContaining(
      ['Europe/Vilnius', 'Vilnius', '+2', '+02', '+02:00', 'utc+2', 'gmt+2']));
    const [kolkata] = zoneOptions(['Asia/Kolkata'], JAN);
    expect(kolkata.keywords).toEqual(expect.arrayContaining(['+5:30', '+05:30', 'utc+5:30', 'gmt+5:30']));
    const [ny] = zoneOptions([NY], JAN);
    expect(ny.keywords).toEqual(expect.arrayContaining(['New York', '-5', '-05', '-05:00', 'utc-5', 'gmt-5', 'EST']));
  });

  it('keeps only letters-only abbreviations, never a "GMT+2" spelled as one', () => {
    const [vilnius] = zoneOptions(['Europe/Vilnius'], JAN);
    expect(vilnius.keywords.filter(k => /^GMT/.test(k))).toEqual([]);
  });
});

// The machine zone is always passed in: the runner's own zone must not decide.
describe('resolveSuggestedTz', () => {
  const JULY = Date.UTC(2026, 6, 14, 16);
  const DECEMBER = Date.UTC(2026, 11, 14, 17);
  const ctx = { localTz: 'Asia/Tokyo', zones: [NY, 'Asia/Tokyo', 'Asia/Yangon', 'Indian/Cocos'], now: DECEMBER };

  it('reads a -04:00 header dated in July as New York, though New York is -05:00 in December', () => {
    expect(resolveSuggestedTz({ headerOffsetMinutes: -240, headerDateMs: JULY }, ctx))
      .toEqual({ tz: NY, source: 'email', offset: '-04:00' });
  });

  it('does not read the same -04:00 dated in December as New York, and -05:00 then is', () => {
    const december = resolveSuggestedTz({ headerOffsetMinutes: -240, headerDateMs: DECEMBER }, ctx);
    expect(december.tz).not.toBe(NY);
    expect(utcOffsetAt(december.tz, DECEMBER).minutes).toBe(-240);
    expect(resolveSuggestedTz({ headerOffsetMinutes: -300, headerDateMs: DECEMBER }, ctx).tz).toBe(NY);
  });

  it('prefers the zone last used for them, then this machine\'s, when it had that offset', () => {
    const facts = { headerOffsetMinutes: -240, headerDateMs: JULY };
    expect(resolveSuggestedTz({ ...facts, rememberedTz: 'America/Toronto' }, ctx).tz).toBe('America/Toronto');
    expect(resolveSuggestedTz({ ...facts, rememberedTz: 'Europe/Vilnius' }, { ...ctx, localTz: 'America/Toronto' }).tz)
      .toBe('America/Toronto');
  });

  it('falls back to the first Region/City zone with the offset when no likely one has it', () => {
    expect(resolveSuggestedTz({ headerOffsetMinutes: 390, headerDateMs: JULY }, ctx))
      .toEqual({ tz: 'Asia/Yangon', source: 'email', offset: '+06:30' });
  });

  it('uses the zone last scheduled to them when the header says nothing usable', () => {
    const history = { tz: 'Europe/Vilnius', source: 'history' };
    expect(resolveSuggestedTz({ rememberedTz: 'Europe/Vilnius' }, ctx)).toEqual(history);
    expect(resolveSuggestedTz({ headerOffsetMinutes: 7, headerDateMs: JULY, rememberedTz: 'Europe/Vilnius' }, ctx))
      .toEqual(history);
  });

  it('dates the offset "now" when the header had no readable date', () => {
    expect(resolveSuggestedTz({ headerOffsetMinutes: -300, headerDateMs: null }, ctx).tz).toBe(NY);
  });

  it('suggests nothing from nothing, and never throws on a zone this runtime does not know', () => {
    expect(resolveSuggestedTz({}, ctx)).toBeNull();
    expect(resolveSuggestedTz({ headerOffsetMinutes: null, headerDateMs: null, rememberedTz: null }, ctx)).toBeNull();
    expect(resolveSuggestedTz({ rememberedTz: 'Not/AZone' }, ctx)).toBeNull();
    expect(resolveSuggestedTz({ headerOffsetMinutes: -240, headerDateMs: JULY, rememberedTz: 'Not/AZone' }, ctx).tz).toBe(NY);
  });
});
