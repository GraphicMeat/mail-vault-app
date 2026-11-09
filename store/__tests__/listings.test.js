// Store listing copy: every file exists in the app's 9 locales, stays inside the store limits, and
// keeps the Plan 4 rules (no em dash, no web price or web checkout, no "open source", the honest
// 15-minute background wording, the subscription terms).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const LOCALES = fs.readdirSync(path.resolve(ROOT, '../src/i18n/locales'))
  .filter((f) => f.endsWith('.json') && f !== 'IDENTICAL_OK.json')
  .map((f) => f.replace('.json', ''))
  .sort();

const APPLE = { name: 30, subtitle: 30, keywords: 100, promotional_text: 170, description: 4000, release_notes: 4000 };
const GOOGLE = { title: 30, short_description: 80, full_description: 4000 };

const read = (store, locale, file) => fs.readFileSync(path.join(ROOT, store, locale, `${file}.txt`), 'utf8').replace(/\n$/, '');
const all = [];
for (const [store, files] of [['apple', APPLE], ['google', GOOGLE]]) {
  for (const locale of LOCALES) for (const [file, max] of Object.entries(files)) all.push({ store, locale, file, max });
}

describe('store listings', () => {
  it('covers the nine app locales', () => {
    expect(LOCALES).toHaveLength(9);
    for (const store of ['apple', 'google']) {
      expect(fs.readdirSync(path.join(ROOT, store)).sort()).toEqual(LOCALES);
    }
  });

  it.each(all)('$store/$locale/$file exists and fits $max characters', ({ store, locale, file, max }) => {
    const text = read(store, locale, file);
    expect(text.trim().length).toBeGreaterThan(0);
    expect([...text].length).toBeLessThanOrEqual(max);
  });

  it('has no unexpected files', () => {
    for (const [store, files] of [['apple', APPLE], ['google', GOOGLE]]) {
      for (const locale of LOCALES) {
        expect(fs.readdirSync(path.join(ROOT, store, locale)).sort()).toEqual(Object.keys(files).map((f) => `${f}.txt`).sort());
      }
    }
  });

  it('keeps Apple keywords comma separated with no spaces after commas', () => {
    for (const locale of LOCALES) expect(read('apple', locale, 'keywords')).not.toMatch(/,\s|\s,/);
  });

  it('never uses an em dash, an en dash, a price, a web checkout or "open source"', () => {
    for (const { store, locale, file } of all) {
      const text = read(store, locale, file);
      expect(text, `${store}/${locale}/${file}`).not.toMatch(/[—–]/);
      expect(text, `${store}/${locale}/${file}`).not.toMatch(/[$€£¥]|\bUSD\b|\bEUR\b/);
      expect(text, `${store}/${locale}/${file}`).not.toMatch(/mailvault:\/\/|\/pricing|checkout|open[- ]source/i);
    }
  });

  it('puts the 15 minute background wording, the subscription terms and both links in every description', () => {
    for (const store of ['apple', 'google']) {
      const file = store === 'apple' ? 'description' : 'full_description';
      for (const locale of LOCALES) {
        const text = read(store, locale, file);
        expect(text, `${store}/${locale}`).toContain('15');
        expect(text, `${store}/${locale}`).toContain('https://mailvaultapp.com/terms.html');
        expect(text, `${store}/${locale}`).toContain('https://mailvaultapp.com/privacy.html');
        expect(text, `${store}/${locale}`).toMatch(/24/);
      }
    }
  });
});
