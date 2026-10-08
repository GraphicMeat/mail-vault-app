import { describe, expect, it } from 'vitest';
import { LOCALES } from '../../scripts/screenshots/locales.js';
import { webclipContent, todayPatterns } from '../../scripts/footage/lib/webclipContent.js';

// The website clips type and seed their own content per language (feature
// content only; bulk mail lists stay English). A locale that silently falls
// back to English would put English text in a translated window.
const en = webclipContent('en');
const flat = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? flat(v, `${p}${k}.`) : [[`${p}${k}`, v]]));

describe('website clip content', () => {
  it.each(LOCALES.map((l) => l.app))('%s has every group in its own words', (code) => {
    const c = webclipContent(code);
    const mine = flat(c).filter(([, v]) => typeof v === 'string' || Array.isArray(v));
    for (const [k, v] of mine) {
      const same = JSON.stringify(v) === JSON.stringify(flat(en).find(([e]) => e === k)?.[1]);
      expect(same, `${code} ${k} is still the English text`).toBe(false);
    }
    // Same shape as English, so the scene never reads a hole.
    expect(flat(c).map(([k]) => k)).toEqual(flat(en).map(([k]) => k));
    expect(c.tagging.wordings).toHaveLength(en.tagging.wordings.length);
    expect(c.tagging.body).toHaveLength(en.tagging.body.length);
  });

  it.each(['en', ...LOCALES.map((l) => l.app)])('%s: no em dash, no version-like number, no date of its own', (code) => {
    const text = JSON.stringify(webclipContent(code));
    expect(text).not.toMatch(/—/);
    expect(text).not.toMatch(/\b\d+\.\d+\.\d+\b/);
  });

  it.each(['en', ...LOCALES.map((l) => l.app)])('%s: the date patterns compile and catch today in the locale\'s own format', (code) => {
    const d = new Date(2026, 9, 8, 21, 30);
    const patterns = todayPatterns(code, d).map((p) => new RegExp(p, 'i'));
    const long = new Intl.DateTimeFormat(code, { dateStyle: 'medium' }).format(d);
    expect(patterns.some((r) => r.test(long)), `${code}: "${long}"`).toBe(true);
    const full = new Intl.DateTimeFormat(code, { dateStyle: 'long', timeStyle: 'short' }).format(d);
    expect(patterns.some((r) => r.test(full)), `${code}: "${full}"`).toBe(true);
  });

  it('falls back to English for a locale it does not know', () => {
    expect(webclipContent('xx')).toEqual(en);
  });
});
