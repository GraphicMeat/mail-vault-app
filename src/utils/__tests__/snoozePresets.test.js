import { describe, it, expect, afterEach, vi } from 'vitest';
import { snoozePresets } from '../snoozePresets';

// UTC throughout, so the wall clock the presets compute on is the one the
// test writes down. 2026-09-25 is a Friday.
const at = (y, mo, d, h, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);
const byId = (list) => Object.fromEntries(list.map(p => [p.id, p.at]));

afterEach(() => vi.useRealTimers());

function frozen(ms) {
  vi.useFakeTimers();
  vi.setSystemTime(ms);
  return snoozePresets(undefined, 'UTC');
}

describe('snoozePresets', () => {
  it('on a Friday afternoon: later today is three hours on, the weekend is tomorrow morning', () => {
    const presets = byId(frozen(at(2026, 9, 25, 16)));
    expect(presets.laterToday).toBe(at(2026, 9, 25, 19));
    expect(presets.tomorrow).toBe(at(2026, 9, 26, 8));
    expect(presets.weekend).toBe(at(2026, 9, 26, 8));
    expect(presets.nextWeek).toBe(at(2026, 9, 28, 8));
  });

  it('before 15:00 later today is 18:00', () => {
    const presets = byId(frozen(at(2026, 9, 22, 10, 30))); // Tuesday
    expect(presets.laterToday).toBe(at(2026, 9, 22, 18));
    expect(presets.weekend).toBe(at(2026, 9, 26, 8));
    expect(presets.nextWeek).toBe(at(2026, 9, 28, 8));
  });

  it('offers no later today late at night and no weekend on the weekend', () => {
    const presets = byId(frozen(at(2026, 9, 26, 22))); // Saturday night
    expect(presets.laterToday).toBeUndefined();
    expect(presets.weekend).toBeUndefined();
    expect(presets.tomorrow).toBe(at(2026, 9, 27, 8));
    expect(presets.nextWeek).toBe(at(2026, 9, 28, 8));
  });

  it('next week from a Monday is the Monday after, never today', () => {
    const presets = byId(frozen(at(2026, 9, 28, 9)));
    expect(presets.nextWeek).toBe(at(2026, 10, 5, 8));
  });

  it('keeps a fixed order and never offers a time in the past', () => {
    const now = at(2026, 9, 25, 16);
    const list = frozen(now);
    expect(list.map(p => p.id)).toEqual(['laterToday', 'tomorrow', 'weekend', 'nextWeek']);
    expect(list.every(p => p.at > now)).toBe(true);
  });
});
