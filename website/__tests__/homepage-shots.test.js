import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

// Any screenshot the homepage still shows is pinned to one theme, whatever the site
// theme. The homepage shows clips instead of pillar screenshots and of the hero demo
// preview, in every language.
const theme = (img) => (/-light-\d+\.webp/.test(img.getAttribute('src')) ? 'light' : 'dark');

describe.each(['website/index.html', 'index.html', ...['de', 'fr', 'es', 'it', 'ja', 'ko', 'zh', 'pt-br'].map((l) => `website/${l}/index.html`)])('%s screenshots', (file) => {
  const dir = (file.match(/^website\/([a-z-]+)\/index\.html$/) || [, 'en'])[1];
  const doc = new JSDOM(readFileSync(file, 'utf8')).window.document;
  const shots = [...doc.querySelectorAll('picture img[src^="/screenshots/"]')];

  it('pins every screenshot to one theme', () => {
    for (const img of shots) {
      expect(img.closest('picture')?.querySelector('source[data-shot-dark]') ?? null).toBeNull();
      for (const c of img.getAttribute('srcset').split(',')) expect(theme({ getAttribute: () => c.trim().split(' ')[0] })).toBe(theme(img));
    }
  });

  it('shows the hero clip where the demo preview was', () => {
    expect(doc.querySelector('picture source[srcset*="/demo/assets/"]')).toBeNull();
    expect(doc.querySelector(`.hm-hero.hm-dark .hm-hero-media video[poster="/assets/clips/${dir}/hero-montage.jpg"]`)).not.toBeNull();
  });
});
