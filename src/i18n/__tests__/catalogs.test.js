import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import en from '../locales/en.json';
import identicalOk from '../locales/IDENTICAL_OK.json';
import es from '../locales/es.json';
import fr from '../locales/fr.json';
// NOT `it`: that shadows vitest's own `it`, and every test in this file then
// calls the Italian catalog object instead of declaring a case —
// "TypeError: default is not a function", reported at the it() line.
import itIT from '../locales/it.json';
import de from '../locales/de.json';
import ptBR from '../locales/pt-BR.json';
import ja from '../locales/ja.json';
import ko from '../locales/ko.json';
import zhHans from '../locales/zh-Hans.json';
import { PREMIUM_FEATURES } from '../../data/premiumFeatures.js';

const catalogs = { es, fr, it: itIT, de, 'pt-BR': ptBR, ja, ko, 'zh-Hans': zhHans };
const LOCALES = Object.keys(catalogs);
const SEARCH_KEYS = [
  'search.fallback.off',
  'search.fallback.building',
  'search.fallback.unavailable',
  'search.fallback.openSettings',
  'search.fallback.upgrade',
  'search.allSourcesFailed',
  'settings.searchIndex.concurrency',
  'settings.searchIndex.concurrencyHint',
  'settings.searchIndex.concurrencyFree',
  'premium.fastMultiFolderSearch.title',
  'premium.fastMultiFolderSearch.blurb',
];

const placeholders = (s) => (String(s).match(/\{\{(\w+)\}\}/g) || []).sort();
const slots = (s) => (String(s).match(/<(\d)>/g) || []).sort();
const ok = new Set(identicalOk);

// CJK has no plural distinction; Intl.PluralRules gives them "other" only.
const CATEGORIES = {
  es: ['one', 'other'], fr: ['one', 'other'], it: ['one', 'other'],
  de: ['one', 'other'], 'pt-BR': ['one', 'other'],
  ja: ['other'], ko: ['other'], 'zh-Hans': ['other'],
};

describe('daemon search copy and Premium catalog', () => {
  it('defines every search key in each app locale', () => {
    for (const [locale, catalog] of Object.entries({ en, ...catalogs })) {
      expect(SEARCH_KEYS.filter(key => !(key in catalog)), locale).toEqual([]);
      expect(SEARCH_KEYS.filter(key => !String(catalog[key] || '').trim()), locale).toEqual([]);
    }
  });

  it('registers one multi-folder-search feature in storage settings', () => {
    const features = PREMIUM_FEATURES.filter(feature => feature.id === 'fast-multi-folder-search');
    expect(features).toHaveLength(1);
    expect(features[0]).toMatchObject({
      titleKey: 'premium.fastMultiFolderSearch.title',
      blurbKey: 'premium.fastMultiFolderSearch.blurb',
      tab: 'storage',
    });
  });
});

// Every other check here compares a locale against English, so a key deleted
// from all nine catalogs at once passed them all while the app still used it,
// and t() rendered the raw key: `views.edit` in Settings > Views did. Literal
// keys only; a built key (`menu.${id}`) cannot be read off the source.
describe('keys the app uses', () => {
  const SRC = resolve(process.cwd(), 'src');
  const sources = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sources(path);
    return /\.jsx?$/.test(entry.name) && !/\.test\.jsx?$/.test(entry.name) ? [path] : [];
  });

  it('are all in the English catalog', () => {
    const missing = [];
    for (const file of sources(SRC)) {
      for (const [, , key] of readFileSync(file, 'utf8').matchAll(/\bt(?:r)?\(\s*(['"])([\w.-]+)\1/g)) {
        // A count picks the plural form, `key_one`/`key_other` (i18n/index.js).
        if (!(key in en) && !(`${key}_other` in en)) missing.push(`${file.slice(SRC.length + 1)}: ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

for (const loc of LOCALES) describe(`${loc} catalog`, () => {
  const cat = catalogs[loc];
  const shared = Object.keys(en).filter(k => k in cat);

  it('translates every English key', () => {
    expect(Object.keys(en).filter(k => !(k in cat))).toEqual([]);
  });

  it('invents no key English does not have', () => {
    expect(Object.keys(cat).filter(k => !(k in en))).toEqual([]);
  });

  it('preserves every {{placeholder}}', () => {
    expect(shared.filter(k => String(placeholders(en[k])) !== String(placeholders(cat[k])))).toEqual([]);
  });

  it('preserves every <0> markup slot', () => {
    expect(shared.filter(k => String(slots(en[k])) !== String(slots(cat[k])))).toEqual([]);
  });

  // A value byte-identical to English is almost always a skipped string.
  it('leaves nothing untranslated', () => {
    expect(shared.filter(k => cat[k] === en[k] && !ok.has(k))).toEqual([]);
  });

  // German runs long and will break fixed-width layout before anyone sees it.
  it('keeps every string under 2.5x the English length', () => {
    expect(shared
      .filter(k => en[k].length >= 8 && cat[k].length > en[k].length * 2.5)
      .map(k => `${k}: ${en[k].length} -> ${cat[k].length}`)).toEqual([]);
  });

  it('supplies exactly the plural categories this language uses', () => {
    const bases = [...new Set(Object.keys(en).filter(k => /_(?:one|other)$/.test(k))
      .map(k => k.replace(/_(?:one|other)$/, '')))];
    const missing = [];
    for (const b of bases) for (const c of CATEGORIES[loc]) if (!(`${b}_${c}` in cat)) missing.push(`${b}_${c}`);
    expect(missing).toEqual([]);
  });

  it('leaves no empty string', () => {
    expect(Object.entries(cat).filter(([, v]) => !String(v).trim()).map(([k]) => k)).toEqual([]);
  });
});
