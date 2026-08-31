/*
 * The site menu, in one place.
 *
 * Every page's nav used to be hand-copied from whichever page it was cloned
 * from, so each new page froze the menu at that page's state. Twice now the
 * result was the same defect: 43 of 47 English pages had no Pricing link — the
 * one link that leads to the money — and `ai-setup.html` shipped with no mobile
 * menu at all, which is invisible on a desktop.
 *
 * So the menu is generated. `renderNav()` is the only definition of it;
 * `injectNav()` splices it into each page between `<!-- nav:main -->` markers,
 * idempotently, the same way `i18n.mjs` already splices the hreflang block and
 * the language switcher. Changing a menu item means editing ITEMS below and
 * running `npm run i18n`.
 *
 * The links stay real markup in the static HTML rather than being written by
 * script on load, because they are the site's internal link graph and a crawler
 * has to see them.
 *
 * Not generated here: the mobile toggle script, which already lives at the
 * bottom of each page. `tests/unit/websiteNav.test.js` asserts every page with a
 * banner has both the menu and its script, which is what catches the next page
 * that is created by copy-paste.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// The canonical menu, in order. Adding an item here adds it to every page with
// a banner, English and localized alike — an existing label is already in the
// corpus, so a reordering ships translated with no new strings.
export const ITEMS = Object.freeze([
  { label: 'Features',  href: '/features.html' },
  { label: 'Pricing',   href: '/pricing.html' },
  { label: 'Use Cases', href: '/use-cases.html' },
  { label: 'Docs',      href: '/docs.html' },
  { label: 'Blog',      href: '/blog.html' },
  { label: 'GitHub',    href: 'https://github.com/GraphicMeat/mail-vault-app', external: true },
]);

// The links row appears at `lg`, not `md`.
//
// Six items do not fit a 768px bar in the verbose locales: measured, Italian
// ("Funzioni | Prezzi | Casi d'uso | Documentazione | Blog | GitHub") is 564px
// of links, and adding Pricing pushed the bar 79px past its container at exactly
// the width where `md:` turns the desktop row on. Five items fitted, which is
// why this never showed before.
//
// So the hamburger keeps the whole tablet band. Picking the breakpoint off the
// longest translation rather than off English is the point: English at 484px
// would have said `md:` was fine.

// The download CTA points at the homepage download section, not at GitHub
// releases: that section is what detects the platform and gates the version.
export const DOWNLOAD_HREF = '/#download';

const DESKTOP_LINK = 'text-slate-600 dark:text-slate-300 hover:text-primary-500 transition-colors';
const MOBILE_LINK = 'px-3 py-2 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-primary-500 transition-colors';

const ext = (i) => (i.external ? ' target="_blank"' : '');

/**
 * The whole banner interior. `home` swaps the logo link for a scroll-to-top,
 * which is what index.html did before the menu was generated.
 */
export function renderNav({ home = false } = {}) {
  const logo = home
    ? `<a href="#" onclick="window.scrollTo({top:0,behavior:'smooth'});return false;" class="flex items-center gap-3">`
    : `<a href="/" class="flex items-center gap-3">`;

  return `      <!-- nav:main -->
      <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="flex items-center justify-between h-16">
          ${logo}
            <img src="/icon-128.webp" alt="MailVault logo" class="w-8 h-8 rounded-lg" width="32" height="32">
            <span class="font-bold text-xl">Mail<span class="text-primary-500">Vault</span></span>
          </a>

          <div class="hidden lg:flex items-center gap-8">
${ITEMS.map((i) => `            <a href="${i.href}"${ext(i)} class="${DESKTOP_LINK}">${i.label}</a>`).join('\n')}
          </div>

          <div class="flex items-center gap-4">
            <button id="theme-toggle" aria-label="Toggle dark mode" class="p-2 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors min-w-11 min-h-11 inline-flex items-center justify-center">
              <svg class="w-5 h-5 hidden dark:block" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
                <path d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l.707.707a1 1 0 001.414-1.414l-.707-.707a1 1 0 00-1.414 1.414zm2.12-10.607a1 1 0 010 1.414l-.706.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM17 11a1 1 0 100-2h-1a1 1 0 100 2h1zm-7 4a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zM5.05 6.464A1 1 0 106.465 5.05l-.708-.707a1 1 0 00-1.414 1.414l.707.707zm1.414 8.486l-.707.707a1 1 0 01-1.414-1.414l.707-.707a1 1 0 011.414 1.414zM4 11a1 1 0 100-2H3a1 1 0 000 2h1z"/>
              </svg>
              <svg class="w-5 h-5 block dark:hidden" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
                <path d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z"/>
              </svg>
            </button>
            <a href="${DOWNLOAD_HREF}" class="hidden sm:inline-flex lamp-bg text-white px-4 py-2 rounded-lg font-medium hover:opacity-90 transition-opacity">
              Download
            </a>
            <!-- Mobile menu button -->
            <button id="mobile-menu-btn" aria-label="Menu" aria-controls="mobile-menu" aria-expanded="false" class="lg:hidden p-2 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors min-w-11 min-h-11 inline-flex items-center justify-center">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path id="menu-icon-open" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"/>
                <path id="menu-icon-close" class="hidden" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
              </svg>
            </button>
          </div>
        </div>

        <!-- Mobile menu -->
        <div id="mobile-menu" class="hidden lg:hidden pb-4">
          <div class="flex flex-col gap-2 pt-2 border-t border-slate-200 dark:border-slate-700">
${ITEMS.map((i) => `            <a href="${i.href}"${ext(i)} class="${MOBILE_LINK}">${i.label}</a>`).join('\n')}
            <a href="${DOWNLOAD_HREF}" class="sm:hidden mt-1 px-3 py-2 rounded-lg lamp-bg text-white font-medium text-center hover:opacity-90 transition-opacity">Download</a>
          </div>
        </div>
      </div>
      <!-- /nav:main -->
`;
}

// Every English page that has a menu — a wider set than the localizer's, which
// deliberately skips changelog/privacy/terms. Those three have menus too, and a
// menu being consistent has nothing to do with whether the page is translated.
const SKIP_DIRS = new Set(['de', 'fr', 'es', 'it', 'ja', 'ko', 'zh', 'pt-br', 'node_modules', 'assets', 'screenshots', 'api', 'i18n', 'src']);

export function navPages(root = ROOT) {
  const out = [];
  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(r)) walk(path.join(dir, entry.name), r);
      } else if (entry.name.endsWith('.html')) {
        if (fs.readFileSync(path.join(dir, entry.name), 'utf8').includes('role="banner"')) out.push(r);
      }
    }
  };
  walk(root, '');
  return out;
}

const OPEN = '<nav role="banner" class="fixed top-0 left-0 right-0 z-50 glass">';
const MARKED = /[ \t]*<!-- nav:main -->[\s\S]*?<!-- \/nav:main -->\n?/;

/**
 * Replace the banner interior with the canonical menu.
 *
 * On a page that has never been generated there are no markers yet, so
 * everything between the banner's open tag and whatever follows the menu — the
 * language switcher if the localizer already ran, else `</nav>` — is the old
 * hand-written menu and gets replaced wholesale. After the first pass the
 * markers are there and only the marked span moves, so the switcher and any
 * later hand-added sibling survive.
 */
export function applyNav(html, { home = false } = {}) {
  const block = renderNav({ home });
  if (MARKED.test(html)) return html.replace(MARKED, block);

  const open = html.indexOf(OPEN);
  if (open === -1) return null;
  const after = open + OPEN.length;
  const switcher = html.indexOf('<!-- i18n:switcher -->', after);
  const close = html.indexOf('</nav>', after);
  if (close === -1) return null;
  // Cut back to the start of the line the successor sits on, so its own
  // indentation is not swallowed.
  const successor = switcher !== -1 && switcher < close ? switcher : close;
  const cut = html.lastIndexOf('\n', successor) + 1;
  return html.slice(0, after) + '\n' + block + html.slice(cut);
}

/**
 * Where generators that are not this script read the menu from.
 *
 * `scripts/generate-changelog.cjs` rewrites changelog.html on every release and
 * used to carry its own hand-copied nav, which is why that page's menu was two
 * items behind the rest of the site. It now reads this file, so a release can no
 * longer revert the menu. `i18n/` is excluded from the deploy rsync, so this
 * never reaches the docroot.
 */
export const NAV_PARTIAL = path.join(HERE, 'nav.html');

export function injectNav(root = ROOT) {
  let touched = 0;
  const failed = [];
  fs.writeFileSync(NAV_PARTIAL, renderNav().trimEnd() + '\n');
  for (const rel of navPages(root)) {
    const file = path.join(root, rel);
    const src = fs.readFileSync(file, 'utf8');
    const out = applyNav(src, { home: rel === 'index.html' });
    if (out === null) { failed.push(rel); continue; }
    if (out !== src) { fs.writeFileSync(file, out); touched++; }
  }
  console.log(`nav: ${touched} page(s) updated, ${navPages(root).length} carry a menu`);
  if (failed.length) {
    console.error('nav: SKIPPED (no recognisable banner)\n  ' + failed.join('\n  '));
    process.exitCode = 1;
  }
  return { touched, failed };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  injectNav();
}
