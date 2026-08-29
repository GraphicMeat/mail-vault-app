import { describe, it, expect } from 'vitest';
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

const catalogs = { es, fr, it: itIT, de, 'pt-BR': ptBR, ja, ko, 'zh-Hans': zhHans };
const LOCALES = Object.keys(catalogs);

const placeholders = (s) => (String(s).match(/\{\{(\w+)\}\}/g) || []).sort();
const slots = (s) => (String(s).match(/<(\d)>/g) || []).sort();
const ok = new Set(identicalOk);

// CJK has no plural distinction; Intl.PluralRules gives them "other" only.
const CATEGORIES = {
  es: ['one', 'other'], fr: ['one', 'other'], it: ['one', 'other'],
  de: ['one', 'other'], 'pt-BR': ['one', 'other'],
  ja: ['other'], ko: ['other'], 'zh-Hans': ['other'],
};

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
