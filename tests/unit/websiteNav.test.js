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
import { readFileSync, readdirSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { ITEMS, DOWNLOAD_HREF, navPages, renderNav, applyNav } from '../../website/i18n/nav.mjs';

// The legacy generator still serves localized pages. English pages now use
// the shared mv-header shell, applied after changelog generation.
const pages = navPages();
const legacyPage = `<nav role="banner" class="fixed top-0 left-0 right-0 z-50 glass">
<div>Old menu</div>
<!-- i18n:switcher --><a href="/de/">Deutsch</a><!-- /i18n:switcher -->
</nav>`;
const englishPages = (dir = 'website') => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const file = `${dir}/${entry.name}`;
  // `/demo/` is a Vite application entry; its real React shell is tested by
  // the demo workflow suite rather than the generated marketing nav audit.
  if (entry.isDirectory()) return ['node_modules', 'api', 'i18n', 'oauth', 'demo'].includes(entry.name) ? [] : englishPages(file);
  return entry.name.endsWith('.html') && /<html[^>]*lang="en"/.test(readFileSync(file, 'utf8')) ? [file] : [];
});
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
  it('checks the current English shell on every content page', () => {
    const files = englishPages();
    expect(files.length).toBeGreaterThanOrEqual(47);
    expect(files).toEqual(expect.arrayContaining(['website/index.html', 'website/changelog.html', 'website/privacy.html', 'website/terms.html']));
    const expected = ['/#how-it-works', '/features.html', '/pricing.html', '/blog.html', '/docs.html', '/demo/?lang=en'];
    for (const file of files) {
      const dom = new JSDOM(readFileSync(file, 'utf8'));
      try {
        const doc = dom.window.document;
        expect([...doc.querySelectorAll('.mv-navlinks a')].map(a => a.getAttribute('href')), file).toEqual(expected);
        expect([...doc.querySelectorAll('.mv-mobile-menu nav a')].map(a => a.getAttribute('href')), file).toEqual([...expected, '/get-started.html?plan=free']);
        expect(doc.querySelector('.mv-mobile-menu summary'), file).not.toBeNull();
        expect(doc.querySelector('.mv-language a[hreflang="de"]'), file).not.toBeNull();
        expect(doc.querySelector('script[src^="/assets/english-site.js"]'), file).not.toBeNull();
      } finally { dom.window.close(); }
    }
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
    const header = html => html.match(/<header class="mv-header">[\s\S]*?<\/header>/)?.[0];
    // Links localize to their own page; the shared primary navigation stays identical.
    expect(header(read('changelog.html'))).toBeTruthy();
    const changelogLinks = labelsIn(header(read('changelog.html')));
    const homepageLinks = labelsIn(header(read('index.html')));
    expect(changelogLinks).toEqual(homepageLinks);
    expect(readFileSync('scripts/generate-changelog.cjs', 'utf8')).toContain('style-english-pages.py');
    expect(readFileSync('scripts/generate-changelog.cjs', 'utf8')).toContain('nav.html');
  });
});

describe('nav injection', () => {
  it('is idempotent — a second pass changes nothing', () => {
    const once = applyNav(legacyPage);
    expect(applyNav(once)).toBe(once);
  });

  it('leaves the language switcher alone', () => {
    expect(applyNav(legacyPage)).toContain('<!-- i18n:switcher -->');
  });

  it('keeps the homepage logo scrolling to the top instead of reloading', () => {
    expect(renderNav({ home: true })).toContain('window.scrollTo');
    expect(renderNav({ home: false })).toContain('<a href="/" class="flex items-center gap-3">');
  });

  it('reports rather than silently skips a banner it cannot parse', () => {
    expect(applyNav('<html><body>no banner</body></html>')).toBe(null);
  });
});
