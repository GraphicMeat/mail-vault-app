import { describe, it, expect } from 'vitest';
import { routeSend } from '../routeSend';
import { MAX_DELAY_MINUTES } from '../../utils/sendPlan';
import { zonedTimeToEpoch } from '../../utils/scheduledTime';

describe('routeSend', () => {
  const NOW = Date.UTC(2026, 8, 25, 12, 0, 20);
  const draft = { localTime: '2026-10-01T09:00', tz: 'Europe/Vilnius' };

  it('sends now under the global delay when nothing is armed', () => {
    expect(routeSend(null, draft, NOW, 'UTC')).toEqual({ delay: null });
    expect(routeSend({ kind: 'in', minutes: 0 }, draft, NOW, 'UTC')).toEqual({ delay: null });
  });

  it('a delay inside the undo window stays an undoable send, in seconds', () => {
    expect(routeSend({ kind: 'in', minutes: 1 }, draft, NOW, 'UTC')).toEqual({ delay: 60 });
    expect(routeSend({ kind: 'in', minutes: 5 }, draft, NOW, 'UTC')).toEqual({ delay: 300 });
  });

  it('a longer delay becomes a scheduled send at now + delay, never earlier', () => {
    const { draft: d } = routeSend({ kind: 'in', minutes: 90 }, draft, NOW, 'Asia/Tokyo');
    expect(d.tz).toBe('Asia/Tokyo');
    // 12:00:20 UTC + 90 min = 13:30:20, rounded up to 13:31 (22:31 in Tokyo).
    expect(d.localTime).toBe('2026-09-25T22:31');
    expect(zonedTimeToEpoch(d.localTime, d.tz)).toBeGreaterThanOrEqual(NOW + 90 * 60_000);
  });

  it('24 hours lands on the same minute tomorrow', () => {
    const { draft: d } = routeSend({ kind: 'in', minutes: MAX_DELAY_MINUTES }, draft, Date.UTC(2026, 8, 25, 12, 0), 'UTC');
    expect(d.localTime).toBe('2026-09-26T12:00');
  });

  it('a set time sends at the picked draft', () => {
    expect(routeSend({ kind: 'at' }, draft, NOW, 'UTC')).toEqual({ draft });
  });
});
