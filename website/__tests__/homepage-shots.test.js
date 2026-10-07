import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

// The homepage shows light and dark captures side by side, whatever the site
// theme: only the hero demo follows the theme, every other shot is pinned. The
// English homepage now shows clips instead of pillar screenshots and of the hero
// demo preview; the rule holds for the frozen snapshot the locale homepages are
// built from.
const theme = (img) => (/-light-\d+\.webp/.test(img.getAttribute('src')) ? 'light' : 'dark');

describe.each(['website/index.html', 'index.html', 'website/i18n/frozen/index.html'])('%s screenshots', (file) => {
  const doc = new JSDOM(readFileSync(file, 'utf8')).window.document;
  const shots = [...doc.querySelectorAll('picture img[src^="/screenshots/"]')];

  it('pins every screenshot to one theme', () => {
    for (const img of shots) {
      expect(img.closest('picture')?.querySelector('source[data-shot-dark]') ?? null).toBeNull();
      for (const c of img.getAttribute('srcset').split(',')) expect(theme({ getAttribute: () => c.trim().split(' ')[0] })).toBe(theme(img));
    }
  });

  it.runIf(file.includes('/frozen/'))('mixes light and dark captures', () => {
    const themes = shots.map(theme);
    expect(themes).toContain('light');
    expect(themes).toContain('dark');
    themes.slice(1).forEach((t, i) => expect(t).not.toBe(themes[i]));
  });

  // The frozen page keeps its hero demo preview, which follows the site theme.
  // The English homepage shows the hero clip in its place, inside the dark hero.
  it.runIf(file.includes('/frozen/'))('keeps the hero demo preview following the site theme', () => {
    expect(doc.querySelector('picture source[data-shot-dark][srcset*="/demo/assets/"]')).not.toBeNull();
  });

  it.runIf(!file.includes('/frozen/'))('shows the hero clip where the demo preview was', () => {
    expect(doc.querySelector('picture source[srcset*="/demo/assets/"]')).toBeNull();
    expect(doc.querySelector('.hm-hero.hm-dark .hm-hero-media video[poster="/assets/clips/en/hero-montage.jpg"]')).not.toBeNull();
  });
});
