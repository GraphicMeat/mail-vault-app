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

// The Rust renderer fetches remote images itself and lists them; the standard
// renderer's iframe loads remote images directly (the app CSP allows nothing
// else in the reader; a pop-out window has no app CSP) and they are counted,
// not listed. The note must be true in both modes.
const KEY = 'netActivity.notShown.webContent';
const OLD_EN = 'Remote images and other web content inside emails. Images are counted above.';
const catalogs = { en, es, fr, it: itIT, de, 'pt-BR': ptBR, ja, ko, 'zh-Hans': zhHans };

describe(KEY, () => {
  it('no longer claims all remote images are unlisted', () => {
    expect(en[KEY]).not.toContain('Remote images and other web content inside emails');
    expect(en[KEY]).toContain('Rust renderer');
  });
  it('is true for both renderers: the standard one loads remote images (fonts and styles only in a pop-out window, which has no app CSP), counted above; the Rust one lists its images', () => {
    expect(en[KEY]).toContain('remote images, counted above but not listed');
    expect(en[KEY]).toContain('in an email opened in its own window, the fonts and styles it links to');
    expect(en[KEY]).not.toMatch(/such as images, fonts and styles/);
  });
  it.each(Object.keys(catalogs))('%s names the Rust renderer\'s images by their purpose label', (loc) => {
    expect(catalogs[loc][KEY]).toContain(catalogs[loc]['netActivity.purposes.emailImages']);
  });
  it('uses each script\'s own punctuation', () => {
    expect(catalogs['zh-Hans'][KEY]).not.toMatch(/[,;:()]/);
    expect(catalogs.ja[KEY]).not.toMatch(/[,;:()]/);
  });
  it.each(Object.keys(catalogs))('%s carries a reworded, non-empty value', (loc) => {
    const v = catalogs[loc][KEY];
    expect(typeof v).toBe('string');
    expect(v.trim().length).toBeGreaterThan(0);
    expect(v).not.toBe(OLD_EN);
    if (loc !== 'en') expect(v).not.toBe(en[KEY]);
  });
});
