import { describe, it, expect, afterEach, vi } from 'vitest';
import { setLocale } from '../../i18n/index.js';
import { formatDateOnly } from '../dateFormat.js';

afterEach(async () => { await setLocale('en'); vi.unstubAllGlobals(); });

const JAN_5 = new Date('2026-01-05T12:00:00Z');
const only = () => formatDateOnly(JAN_5, { alwaysShowYear: true });

/**
 * Every assertion here has to be one English CANNOT satisfy. The first version
 * of this file asserted /Jan/i for German and /1月|2026/ for Japanese, and
 * passed against untouched English output — "Jan" is also the German
 * abbreviation, and "2026" is in the English string. A locale test that the
 * source locale passes is testing nothing.
 */
describe('dateFormat follows the app language', () => {
  it('puts the day first with a German ordinal dot, which English never does', async () => {
    await setLocale('de');
    expect(only()).toMatch(/^5\./);
  });

  it('uses Japanese date markers, which English has no glyph for', async () => {
    await setLocale('ja');
    expect(only()).toContain('年');
    expect(only()).toContain('月');
  });

  it('gives three different renderings for en, de and ja', async () => {
    await setLocale('en'); const en = only();
    await setLocale('de'); const de = only();
    await setLocale('ja'); const ja = only();
    expect(new Set([en, de, ja]).size).toBe(3);
  });

  it('does not throw when navigator.language is the POSIX "C" locale', () => {
    vi.stubGlobal('navigator', { language: 'C' });
    expect(() => only()).not.toThrow();
  });
});
