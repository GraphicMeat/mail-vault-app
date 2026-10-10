import { readFileSync, readdirSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

// Feature pages offer one download button, like the homepage: macOS without a
// script, and english-site.js swaps in the visitor's own platform (a phone gets
// the setup page). Every other platform sits behind one text link.
const LOCALES = ['de', 'fr', 'es', 'it', 'ja', 'ko', 'zh', 'pt-br'];
const english = ['features.html', ...readdirSync('website/features').filter((f) => f.endsWith('.html')).sort().map((f) => `features/${f}`)];
const pages = [...english, ...LOCALES.flatMap((l) => english.map((f) => `${l}/${f}`))];

describe.each(pages)('website/%s', (rel) => {
  const main = new JSDOM(readFileSync(`website/${rel}`, 'utf8')).window.document.querySelector('main');

  it('shows one download button, macOS without a script', () => {
    const shown = [...main.querySelectorAll('.mv-button')].filter((el) => !el.closest('[hidden]'));
    expect(shown).toHaveLength(1);
    expect(shown[0].dataset.heroPlatform).toBe('mac');
    expect(shown[0].dataset.download).toBe('mac');
    for (const platform of ['windows', 'linux', 'mobile']) {
      expect(main.querySelectorAll(`.mv-button[data-hero-platform="${platform}"][hidden]`)).toHaveLength(1);
    }
  });

  it('puts the other platforms behind one text link', () => {
    const links = main.querySelectorAll('a.mv-text-link[href$="/get-started.html?plan=free#platforms"]');
    expect(links).toHaveLength(1);
    expect(links[0].closest('[hidden]')).toBeNull();
  });
});
