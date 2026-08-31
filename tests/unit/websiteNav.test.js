/*
 * The site menu drifted twice, the same way both times: every new page was
 * copy-pasted from an older one and froze that page's menu. The second audit
 * found 43 of 47 English pages with no Pricing link and one page — ai-setup.html
 * — with no mobile menu at all, which is invisible unless you narrow a window.
 *
 * `website/i18n/nav.mjs` now generates the menu, so these tests do not check
 * copy: they check that no page has escaped the generator, and that the two
 * halves the generator does NOT own (the toggle script, and changelog.html's
 * release-time regeneration) still line up with it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { ITEMS, DOWNLOAD_HREF, navPages, renderNav, applyNav } from '../../website/i18n/nav.mjs';

const pages = navPages();
const read = (rel) => readFileSync(`website/${rel}`, 'utf8');

// The nav element only, with the language switcher removed — the switcher links
// to /de/pricing.html etc., so leaving it in makes every page look compliant.
const navOf = (html) => {
  const open = html.indexOf('<nav role="banner"');
  const close = html.indexOf('</nav>', open);
  return html
    .slice(open, close)
    .replace(/<!-- i18n:switcher -->[\s\S]*?<!-- \/i18n:switcher -->/, '');
};

const labelsIn = (nav) => [
  ...new Set([...nav.matchAll(/>([A-Za-z][^<]*)<\/a>/g)].map((m) => m[1].trim())),
];

describe('website nav', () => {
  it('finds every page that has a menu', () => {
    expect(pages.length).toBeGreaterThanOrEqual(47);
    expect(pages).toContain('index.html');
    // The localizer skips these three; a menu still has to be a menu on them.
    expect(pages).toEqual(expect.arrayContaining(['changelog.html', 'privacy.html', 'terms.html']));
  });

  it.each(pages)('%s carries the canonical item set', (rel) => {
    expect(labelsIn(navOf(read(rel)))).toEqual([...ITEMS.map((i) => i.label), 'Download']);
  });

  it.each(pages)('%s has a mobile menu and the script that opens it', (rel) => {
    const html = read(rel);
    expect(html, 'no #mobile-menu').toContain('id="mobile-menu"');
    expect(html, 'no #mobile-menu-btn').toContain('id="mobile-menu-btn"');
    // Markup without the listener is a hamburger that does nothing — the exact
    // shape ai-setup.html shipped in.
    expect(html, 'no toggle script').toContain("getElementById('mobile-menu-btn')");
  });

  it.each(pages)('%s is generated, not hand-written', (rel) => {
    expect(read(rel)).toContain('<!-- nav:main -->');
  });

  /**
   * The links row must not appear until `lg`.
   *
   * Measured, not guessed: six items are 564px of links in Italian, and turning
   * the desktop row on at `md` (768px) pushed the bar 79px past its container.
   * Five items fitted, which is why adding Pricing is what exposed it. English
   * is 484px and would have said `md` was fine — so this is pinned rather than
   * left to whoever next reads the markup and thinks `md` looks tidier.
   */
  it('shows the links row only from lg, where the longest locale still fits', () => {
    const nav = renderNav();
    expect(nav).toContain('hidden lg:flex');
    expect(nav).not.toContain('hidden md:flex');
    expect(nav).toMatch(/id="mobile-menu-btn"[^>]*class="lg:hidden/);
    expect(nav).toContain('<div id="mobile-menu" class="hidden lg:hidden pb-4">');
  });

  it('points Download at the homepage section, which gates the version', () => {
    for (const rel of pages) {
      expect(navOf(read(rel)), rel).toContain(`href="${DOWNLOAD_HREF}"`);
    }
  });

  it('regenerates changelog.html from the same partial the pages use', () => {
    // changelog.html is rewritten on every release. When it carried its own copy
    // it silently reverted the menu, so the generator reads i18n/nav.html.
    const partial = readFileSync('website/i18n/nav.html', 'utf8').trimEnd();
    expect(partial).toBe(renderNav().trimEnd());
    expect(read('changelog.html')).toContain(partial);
    expect(readFileSync('scripts/generate-changelog.cjs', 'utf8')).toContain('nav.html');
  });
});

describe('nav injection', () => {
  it('is idempotent — a second pass changes nothing', () => {
    const once = applyNav(read('faq.html'));
    expect(applyNav(once)).toBe(once);
  });

  it('leaves the language switcher alone', () => {
    expect(applyNav(read('index.html'))).toContain('<!-- i18n:switcher -->');
  });

  it('keeps the homepage logo scrolling to the top instead of reloading', () => {
    expect(renderNav({ home: true })).toContain('window.scrollTo');
    expect(renderNav({ home: false })).toContain('<a href="/" class="flex items-center gap-3">');
  });

  it('reports rather than silently skips a banner it cannot parse', () => {
    expect(applyNav('<html><body>no banner</body></html>')).toBe(null);
  });
});
