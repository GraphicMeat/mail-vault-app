import { describe, it, expect } from 'vitest';
import en from '../locales/en.json';
import es from '../locales/es.json';
import fr from '../locales/fr.json';
import itIT from '../locales/it.json';
import de from '../locales/de.json';
import ptBR from '../locales/pt-BR.json';
import ja from '../locales/ja.json';
import ko from '../locales/ko.json';
import zhHans from '../locales/zh-Hans.json';

// The Appearance sample for Preview lines only shows the difference between
// 1, 2 and 3 lines if its text runs past three lines at the preview's width
// (about 60 Latin characters a line at its widest). A CJK or Hangul glyph is
// about two Latin ones wide, so width is counted, not characters.
const WIDE = /[ᄀ-ᇿ　-鿿가-힯＀-￯]/u;
const width = (s) => [...s].reduce((sum, ch) => sum + (WIDE.test(ch) ? 2 : 1), 0);

describe('listPreview.sample', () => {
  const catalogs = { en, es, fr, it: itIT, de, 'pt-BR': ptBR, ja, ko, 'zh-Hans': zhHans };
  for (const [locale, catalog] of Object.entries(catalogs)) {
    it(`${locale} runs well past three preview lines`, () => {
      const sample = catalog['listPreview.sample'];
      expect([...sample].length).toBeGreaterThan(200);
      expect(width(sample)).toBeGreaterThan(300);
    });
  }
});
