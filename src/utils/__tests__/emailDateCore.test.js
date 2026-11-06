import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatEmailDateWith, formatTimeOf, intlLocaleFor } from '../emailDateCore.js';

// Local-time dates, so the cases hold in any time zone. Wednesday 4 November 2026, 15:00.
const NOW = new Date(2026, 10, 4, 15, 0);
const translate = (k) => (k === 'bulk.ops.yesterday' ? 'YESTERDAY' : k);
const at = (...a) => new Date(...a).getTime();
const fmt = (d, extra = {}) =>
  formatEmailDateWith(d, { dateFormat: 'auto', customDateFormat: '', timeFormat: '24h', appLocale: 'en', translate, now: NOW, ...extra });

afterEach(() => vi.unstubAllGlobals());

describe('formatEmailDateWith', () => {
  it('today shows the time per timeFormat', () => {
    expect(fmt(at(2026, 10, 4, 0, 0))).toBe('00:00');
    expect(fmt(at(2026, 10, 4, 9, 5), { timeFormat: '12h' })).toBe('9:05 AM');
  });

  it('yesterday runs from 00:00 to 23:59 of the day before', () => {
    expect(fmt(at(2026, 10, 3, 23, 59))).toBe('YESTERDAY');
    expect(fmt(at(2026, 10, 3, 0, 0))).toBe('YESTERDAY');
    expect(fmt(at(2026, 10, 2, 23, 59))).not.toBe('YESTERDAY');
  });

  it('this week (from Sunday) shows the weekday in the app language', () => {
    expect(fmt(at(2026, 10, 2, 12, 0), { appLocale: 'de' })).toBe('Montag');
    expect(fmt(at(2026, 10, 1, 0, 0), { appLocale: 'de' })).toBe('Sonntag');
    // Saturday before is last week: a date, not a weekday.
    expect(fmt(at(2026, 9, 31, 23, 59), { appLocale: 'de' })).toBe('31. Okt.');
  });

  it('auto shows the year only for a previous year', () => {
    vi.stubGlobal('navigator', { language: 'en-US' });
    expect(fmt(at(2026, 0, 1, 12, 0))).toBe('Jan 1');
    expect(fmt(at(2025, 11, 31, 12, 0))).toBe('Dec 31, 2025');
  });

  it('presets and custom patterns use the date-fns locale of the app language', () => {
    expect(fmt(at(2025, 11, 31), { dateFormat: 'yyyy-MM-dd' })).toBe('2025-12-31');
    expect(fmt(at(2026, 9, 1), { dateFormat: 'yyyy-MM-dd' })).toBe('10-01');
    expect(fmt(at(2025, 9, 1), { dateFormat: 'dd MMM yyyy', appLocale: 'de' })).toBe('01 Okt. 2025');
    expect(fmt(at(2025, 9, 1), { dateFormat: 'custom', customDateFormat: 'd/M/yy' })).toBe('1/10/25');
    // An invalid custom pattern falls back instead of throwing.
    expect(fmt(at(2025, 9, 1), { dateFormat: 'custom', customDateFormat: 'yyyy-ii-YYYY' })).toBe('Oct 1, 2025');
  });

  it('an invalid date is empty', () => {
    expect(fmt('not a date')).toBe('');
    expect(fmt(NaN)).toBe('');
  });
});

describe('intlLocaleFor / formatTimeOf', () => {
  it('the app language wins; English falls back to a valid navigator language', () => {
    expect(intlLocaleFor('ja')).toBe('ja');
    vi.stubGlobal('navigator', { language: 'en-GB' });
    expect(intlLocaleFor('en')).toBe('en-GB');
    vi.stubGlobal('navigator', { language: 'C' });
    expect(() => intlLocaleFor('en')).not.toThrow();
  });

  it('auto time uses Intl in the resolved locale', () => {
    vi.stubGlobal('navigator', { language: 'en-GB' });
    expect(formatTimeOf(new Date(2026, 0, 1, 14, 7), { timeFormat: 'auto', appLocale: 'en' })).toBe('14:07');
  });
});
