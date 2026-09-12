import { describe, expect, it } from 'vitest';
import {
  DEMO_LOCALES,
  demoLocaleFromLocation,
  demoSitePath,
  normalizeDemoLocale,
} from '../locale.js';
import { DEMO_CATALOG_KEYS, DEMO_CATALOGS, demoTranslate } from '../translations.js';

describe('demo locale contract', () => {
  it('accepts only supported app language codes', () => {
    expect(DEMO_LOCALES).toEqual(['en', 'de', 'fr', 'es', 'it', 'pt-BR', 'ja', 'ko', 'zh-Hans']);
    for (const code of DEMO_LOCALES) expect(normalizeDemoLocale(code)).toBe(code);
    expect(normalizeDemoLocale('xx')).toBeNull();
    expect(normalizeDemoLocale('en-US')).toBeNull();
    expect(normalizeDemoLocale(null)).toBeNull();
  });

  it('reads an explicit valid lang query without falling back', () => {
    expect(demoLocaleFromLocation({ search: '?lang=de' })).toBe('de');
    expect(demoLocaleFromLocation({ search: '?lang=pt-BR' })).toBe('pt-BR');
    expect(demoLocaleFromLocation({ search: '?lang=invalid' })).toBeNull();
    expect(demoLocaleFromLocation({ search: '' })).toBeNull();
  });

  it('maps app languages to site directories and preserves query/hash', () => {
    expect(demoSitePath('/get-started.html?plan=free#download', 'de'))
      .toBe('/de/get-started.html?plan=free#download');
    expect(demoSitePath('/de/get-started.html?plan=free#download', 'en'))
      .toBe('/get-started.html?plan=free#download');
    expect(demoSitePath('/faq.html', 'zh-Hans')).toBe('/zh/faq.html');
    expect(demoSitePath('/de/faq.html', 'fr')).toBe('/fr/faq.html');
  });

  it('keeps all shell catalogs key-identical and localizes the visible chrome', () => {
    for (const code of DEMO_LOCALES) {
      expect(Object.keys(DEMO_CATALOGS[code]).sort()).toEqual([...DEMO_CATALOG_KEYS].sort());
      for (const key of ['meta.title', 'meta.description', 'brand.title', 'brand.pill', 'actions.aria', 'actions.reset', 'explanation.heading', 'tour.open', 'tour.back', 'tour.next', 'tour.explore', 'storage.durable']) {
        expect(demoTranslate(code, key)).toBeTruthy();
        if (code !== 'en') expect(demoTranslate(code, key)).not.toBe(demoTranslate('en', key));
      }
    }
  });
});
