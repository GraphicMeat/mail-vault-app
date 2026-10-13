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

// The Rust renderer fetches remote images itself and counts them; the standard
// renderer's iframe loads web content directly and it is not listed. The note
// must be true in both modes.
const KEY = 'netActivity.notShown.webContent';
const OLD_EN = 'Remote images and other web content inside emails. Images are counted above.';
const catalogs = { en, es, fr, it: itIT, de, 'pt-BR': ptBR, ja, ko, 'zh-Hans': zhHans };

describe(KEY, () => {
  it('no longer claims all remote images are unlisted', () => {
    expect(en[KEY]).not.toContain('Remote images and other web content inside emails');
    expect(en[KEY]).toContain('Rust renderer');
  });
  it.each(Object.keys(catalogs))('%s carries a reworded, non-empty value', (loc) => {
    const v = catalogs[loc][KEY];
    expect(typeof v).toBe('string');
    expect(v.trim().length).toBeGreaterThan(0);
    expect(v).not.toBe(OLD_EN);
    if (loc !== 'en') expect(v).not.toBe(en[KEY]);
  });
});
