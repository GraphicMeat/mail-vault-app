import { describe, it, expect, vi, afterEach } from 'vitest';

// 'auto' for both settings forces the Intl.DateTimeFormat path — the one that
// reads the browser locale.
vi.mock('../../src/stores/settingsStore', () => ({
  useSettingsStore: {
    getState: () => ({ timeFormat: 'auto', dateFormat: 'auto', customDateFormat: null }),
  },
}));

const { formatTime, formatDateTime, formatDateOnly, formatDateLong, formatEmailDate } =
  await import('../../src/utils/dateFormat.js');

const DATE = new Date('2026-03-14T15:09:00Z');

afterEach(() => {
  vi.unstubAllGlobals();
});

// `navigator` is a browser global. Node only exposes it from 21 onwards, so
// these formatters threw `navigator is not defined` on CI's Node 20 while
// passing on a newer local Node — green locally, red in CI, on every commit.
// Intl treats an undefined locale as "use the runtime default", which is what
// reading the browser locale was approximating anyway.
describe('dateFormat without a navigator global', () => {
  const cases = [
    ['formatTime', () => formatTime(DATE)],
    ['formatDateTime', () => formatDateTime(DATE)],
    ['formatDateOnly', () => formatDateOnly(DATE)],
    ['formatDateLong', () => formatDateLong(DATE)],
    ['formatEmailDate', () => formatEmailDate('2020-01-05T08:30:00Z')],
  ];

  for (const [name, call] of cases) {
    it(`${name} still formats`, () => {
      vi.stubGlobal('navigator', undefined);
      expect(typeof navigator).toBe('undefined'); // precondition: Node 20 shape
      const out = call();
      expect(out).toBeTruthy();
      expect(out).toEqual(expect.any(String));
    });
  }

  it('uses navigator.language when one is available', () => {
    vi.stubGlobal('navigator', { language: 'en-GB' });
    // en-GB is 24-hour, so 15:09 UTC must not come back with an am/pm marker.
    expect(formatTime(DATE)).not.toMatch(/[ap]m/i);
  });
});
