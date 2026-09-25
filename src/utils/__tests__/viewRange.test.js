import { describe, expect, it } from 'vitest';
import { downloadChoices, narrowDef, rangeBounds, viewWindow } from '../viewRange';

const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h);
const sec = (y, m, d) => Math.floor(new Date(y, m - 1, d).getTime() / 1000);

describe('view date windows', () => {
  it('resolves calendar ranges to whole local months and years', () => {
    const now = at(2026, 9, 25);
    expect(rangeBounds('thisMonth', now)).toEqual({ from: sec(2026, 9, 1), to: sec(2026, 10, 1) - 1 });
    expect(rangeBounds('lastMonth', now)).toEqual({ from: sec(2026, 8, 1), to: sec(2026, 9, 1) - 1 });
    expect(rangeBounds('thisYear', now)).toEqual({ from: sec(2026, 1, 1), to: sec(2027, 1, 1) - 1 });
    expect(rangeBounds('lastYear', now)).toEqual({ from: sec(2025, 1, 1), to: sec(2026, 1, 1) - 1 });
    expect(rangeBounds('someday', now)).toBeNull();
  });

  it('last month in January is last December', () => {
    expect(rangeBounds('lastMonth', at(2027, 1, 10))).toEqual({ from: sec(2026, 12, 1), to: sec(2027, 1, 1) - 1 });
  });

  it('a range wins over the rolling window, which wins over the saved dates', () => {
    const now = at(2026, 9, 25);
    const nowSec = Math.floor(now.getTime() / 1000);
    expect(viewWindow({ range: 'lastMonth', withinDays: 7 }, now)).toEqual(rangeBounds('lastMonth', now));
    expect(viewWindow({ withinDays: 7, dateFrom: 1 }, now)).toEqual({ from: nowSec - 7 * 86_400, to: null });
    expect(viewWindow({ dateFrom: 1, dateTo: 2 }, now)).toEqual({ from: 1, to: 2 });
    expect(viewWindow({}, now)).toEqual({ from: null, to: null });
  });
});

describe('what the download button offers', () => {
  const now = at(2026, 9, 25);

  it('a rolling window across two months offers all of it, this month, or the last one', () => {
    const def = { withinDays: 30, hasAttachments: true };
    const [all, later, earlier] = downloadChoices(def, now);
    const from = Math.floor(now.getTime() / 1000) - 30 * 86_400;
    expect(all).toMatchObject({ key: 'all', from, to: null });
    expect(later).toMatchObject({ key: 'later', from: sec(2026, 9, 1), to: null });
    expect(later.month.getMonth()).toBe(8);
    // Narrowed, never widened: "August" starts where the 30 days start.
    expect(earlier).toMatchObject({ key: 'earlier', from, to: sec(2026, 9, 1) - 1 });
    expect(earlier.month.getMonth()).toBe(7);
  });

  it('one month, a long range, or no range at all is one download of everything', () => {
    expect(downloadChoices({ range: 'thisMonth' }, now)).toBeNull();
    expect(downloadChoices({ range: 'lastMonth' }, now)).toBeNull();
    expect(downloadChoices({ withinDays: 7 }, now)).toBeNull();
    expect(downloadChoices({ withinDays: 90 }, now)).toBeNull();
    expect(downloadChoices({ range: 'lastYear' }, now)).toBeNull();
    expect(downloadChoices({}, now)).toBeNull();
  });

  it('a week that crosses the turn of the month splits too', () => {
    expect(downloadChoices({ withinDays: 7 }, at(2026, 10, 3))?.map(choice => choice.key)).toEqual(['all', 'later', 'earlier']);
  });

  it('narrows the definition to the choice, and leaves it alone for everything', () => {
    const def = { withinDays: 30, sender: 'acme', hasAttachments: true };
    expect(narrowDef(def, { key: 'all' })).toBe(def);
    expect(narrowDef(def, { key: 'earlier', from: 5, to: 9 }))
      .toEqual({ ...def, range: null, withinDays: null, dateFrom: 5, dateTo: 9 });
  });
});
