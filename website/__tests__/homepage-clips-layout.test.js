import { existsSync, readFileSync, statSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import * as i18n from '../i18n/i18n.mjs';

// The English homepage, laid out as clip cards: a hero with the price card, one
// download and the hero clip, four key points, six groups of clip cards, the
// small-things group and its row of links, a spec card, then the comparison, feedback and the
// closing download. English only for now: the locale homepages are built from a
// frozen snapshot of the previous English page and do not change.
const read = (f) => readFileSync(f, 'utf8');
const load = (f) => new JSDOM(read(f)).window.document;
const html = read('website/index.html');
const doc = load('website/index.html');
const CSS_FILE = 'website/assets/home-sections.css';
const css = existsSync(CSS_FILE) ? read(CSS_FILE) : '';
const plain = css.replace(/\/\*[\s\S]*?\*\//g, '');
const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
// A two-line heading read as one line: the <br> becomes a space.
const heading = (h) => h.innerHTML.replace(/<br>/g, ' ').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const before = (a, b) => Boolean(a && b && a.compareDocumentPosition(b) & 4);
// The text of every HTML comment on the page, one entry per comment.
const comments = [...html.matchAll(/<!--([\s\S]*?)-->/g)].map((m) => m[1]);
const shown = (els) => [...els].filter((el) => !el.closest('[hidden]'));
const LOCALES = ['de', 'fr', 'es', 'it', 'ja', 'ko', 'zh', 'pt-br'];

// Every `@media <query> { ... }` body, by brace counting.
function mediaBlocks(src, query) {
  const out = [];
  let at = src.indexOf(query);
  while (at !== -1) {
    const open = src.indexOf('{', at);
    let depth = 0, end = open;
    for (; end < src.length; end++) {
      if (src[end] === '{') depth++;
      else if (src[end] === '}' && --depth === 0) break;
    }
    out.push(src.slice(open + 1, end));
    at = src.indexOf(query, end);
  }
  return out;
}
// Declarations of every rule whose selector list contains `selector`, joined.
function rulesFor(src, selector) {
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m, out = '';
  while ((m = re.exec(src))) if (m[1].split(',').some((s) => s.trim() === selector)) out += m[2] + ';';
  return out;
}
// Width of a baseline or progressive JPEG, from its SOF marker.
function jpegWidth(file) {
  const b = readFileSync(file);
  for (let i = 2; i < b.length;) {
    if (b[i] !== 0xff) return 0;
    const marker = b[i + 1];
    const len = b.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc3) return b.readUInt16BE(i + 7);
    i += 2 + len;
  }
  return 0;
}

describe('hero', () => {
  const hero = doc.querySelector('.hm-hero');
  const card = hero.querySelector('.hm-offer');

  it('keeps one headline, word for word, under an early access badge', () => {
    expect(doc.querySelectorAll('h1')).toHaveLength(1);
    const h1 = hero.querySelector('h1');
    expect(h1.innerHTML).toBe('Your email.<br><span class="hm-grad">Yours to keep.</span>');
    const badge = hero.querySelector('.hm-badge');
    expect(badge).not.toBeNull();
    expect(before(badge, h1)).toBe(true);
    expect(badge.querySelector('[data-mv-price="{yearly}"]').textContent).toBe('$25');
  });

  it('sets the early access badge on three lines: the tag, the price with its discount, then the spots', () => {
    const badge = hero.querySelector('.hm-badge');
    const lines = [...badge.children];
    expect(lines.map((el) => el.className)).toEqual(['hm-badge-tag', 'hm-badge-line', 'hm-badge-spots']);
    expect(text(lines[0])).toBe('Early access');
    // Owner's call: the standard price after early access is struck through next to
    // the early bird price, with the discount in percent. Screen readers hear what it is.
    const price = lines[1];
    expect(price.querySelector('[data-mv-price="{yearly}"]').textContent).toBe('$25');
    const was = price.querySelector('s.hm-badge-was');
    expect(was).not.toBeNull();
    expect(was.querySelector('[data-mv-price="{standardYearly}"]').textContent).toBe('$39');
    expect(text(was.querySelector('.mv-sr-only'))).toBe('Standard price after early access:');
    const off = price.querySelector('.hm-badge-off');
    expect(off.dataset.mvPrice).toBe('{earlyBirdSavingsPercent}% off');
    expect(text(off)).toBe('36% off');
    // Both disappear with the early bird price once every spot is taken.
    expect(was.hasAttribute('data-mv-early')).toBe(true);
    expect(off.hasAttribute('data-mv-early')).toBe(true);
    // Static until the count answers: no number of spots taken without JavaScript.
    expect(text(lines[2])).toBe('Only 100 spots in total');
    expect(lines[2].dataset.mvSpots).toBe('{taken} of {cap} spots taken');
    expect(lines[2].dataset.mvSpotsFull).toBe('All {cap} spots are taken');
    // Each part breaks onto its own line.
    expect(rulesFor(plain, '.hm-badge')).toMatch(/flex-direction\s*:\s*column/);
  });

  it('puts "Free forever" on its own line above the early access badge, not inside it', () => {
    const free = hero.querySelector('.hm-free-label');
    const badge = hero.querySelector('.hm-badge');
    expect(free).not.toBeNull();
    expect(text(free)).toBe('Free forever');
    expect(free.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(free.nextElementSibling).toBe(badge);
    expect(badge.contains(free)).toBe(false);
    expect(text(badge)).not.toMatch(/free/i);
    // Block level, so it never shares the inline-flex badge's line.
    expect(rulesFor(plain, '.hm-hero .hm-free-label')).toMatch(/display\s*:\s*flex/);
  });

  it('leads with the app and keeping your copy, in two sentences', () => {
    expect(text(hero.querySelector('.hm-lead'))).toBe('A fast, private email app that keeps your mail on your computer. Delete it from the server whenever you like: your copy stays.');
  });

  it('splits the card into two tiers: the free download first, then the optional Premium prices', () => {
    expect([...card.children].map((el) => el.className)).toEqual(['hm-offer-free', 'hm-offer-premium']);
    const [free, premium] = card.children;
    expect(free.querySelector('.hm-hero-actions')).not.toBeNull();
    expect(premium.querySelector('.hm-hero-actions, [data-download], form')).toBeNull();
    expect(free.querySelector('.hm-offer-plans, [data-mv-price]')).toBeNull();
    // The free tier says what is free, once, right under the download.
    const line = free.querySelector('.hm-hero-actions ~ .hm-offer-free-line');
    expect(text(line)).toBe('The full app and unlimited manual backups. No account.');
    // A quiet line between the tiers, no second card.
    expect(rulesFor(plain, '.hm-offer-premium')).toMatch(/border-top\s*:\s*1px solid/);
    expect(plain).not.toMatch(/\.hm-offer-plan\s*\{[^}]*(?:border|background)\s*:/);
  });

  // Owner's call: "Free forever" reads at a glance next to the download, large
  // and green, with what is free in a smaller line under it.
  it('says "Free forever" large and green right under the download, then what is free in a smaller line', () => {
    const free = card.querySelector('.hm-offer-free');
    const title = free.querySelectorAll('.hm-offer-free-title');
    expect(title).toHaveLength(1);
    expect(text(title[0])).toBe('Free forever');
    // Directly under the button: only the phone-only lines (hidden on a computer) may sit between.
    let prev = title[0].previousElementSibling;
    while (prev && prev.matches('[data-hero-platform="mobile"]')) prev = prev.previousElementSibling;
    expect(prev).toBe(free.querySelector('.hm-hero-actions'));
    expect(title[0].nextElementSibling).toBe(free.querySelector('.hm-offer-free-line'));
    // A label, not a second button.
    expect(title[0].closest('.mv-button, .hm-hero-actions, a, button')).toBeNull();
    const size = (sel) => Number((rulesFor(plain, sel).match(/font-size\s*:\s*([\d.]+)rem/) || [])[1]);
    const rule = rulesFor(plain, '.hm-offer .hm-offer-free-title');
    expect(size('.hm-offer .hm-offer-free-title')).toBeGreaterThanOrEqual(1.25);
    expect(size('.hm-offer .hm-offer-free-title')).toBeLessThanOrEqual(1.4);
    expect(size('.hm-offer .hm-offer-free-title')).toBeGreaterThan(size('.hm-offer .hm-offer-free-line') * 1.3);
    expect(rule).toMatch(/font-weight\s*:\s*7\d\d/);
    expect(rule).toMatch(/color\s*:\s*#86efac/);
    // The old inline "Free forever:" lead-in is gone from the small line.
    expect(free.querySelector('.hm-offer-free-line strong')).toBeNull();
  });

  it('heads the Premium tier with its name, the Early Bird wording stepping aside once sold out', () => {
    const title = card.querySelector('.hm-offer-premium .hm-offer-head .hm-offer-title');
    expect(text(title)).toBe('Premium · Early Bird & Family Pricing');
    expect(title.hasAttribute('data-mv-early')).toBe(false);
    expect(text(title.querySelector('[data-mv-early]'))).toBe('· Early Bird & Family Pricing');
  });

  it('shows each plan on one row: price, the struck standard price and the discount', () => {
    const rows = card.querySelectorAll('.hm-offer-premium .hm-offer-plan');
    expect([...rows].map((r) => r.dataset.plan)).toEqual(['yearly', 'monthly']);
    const cases = [
      [rows[0], 'Yearly', '{yearly}', '$25', '/year', '{standardYearly}', '$39', '{earlyBirdSavingsPercent}% off', '36% off'],
      [rows[1], 'Monthly', '{monthly}', '$4', '/month', '{standardMonthly}', '$6', '{earlyBirdMonthlySavingsPercent}% off', '33% off'],
    ];
    for (const [row, name, token, amount, per, stdToken, std, offToken, off] of cases) {
      expect(text(row.querySelector('dt'))).toBe(name);
      expect(text(row.querySelector('.hm-offer-price'))).toBe(amount + per);
      expect(row.querySelector(`.hm-offer-price [data-mv-price="${token}"]`).textContent).toBe(amount);
      const was = row.querySelectorAll('s');
      expect(was).toHaveLength(1);
      expect(was[0].closest('.hm-offer-price')).toBeNull();
      expect(was[0].querySelector(`[data-mv-price="${stdToken}"]`).textContent).toBe(std);
      expect(text(was[0].querySelector('.mv-sr-only'))).toBe('Standard price after early access:');
      const chip = row.querySelector('.hm-offer-off');
      expect(chip.dataset.mvPrice).toBe(offToken);
      expect(text(chip)).toBe(off);
      // Both go with the early bird price once every spot is taken; the price stays.
      expect(was[0].hasAttribute('data-mv-early')).toBe(true);
      expect(chip.hasAttribute('data-mv-early')).toBe(true);
      expect(row.querySelector('.hm-offer-price').closest('[data-mv-early]')).toBeNull();
      expect([...row.children].map(text).join(' ')).toBe(`${name} ${amount}${per} Standard price after early access: ${std} ${off}`);
    }
    expect(card.querySelector('.hm-offer-plans input, .hm-offer-plans select, .hm-offer-plans button, .hm-offer-plans form')).toBeNull();
    // The struck prices in the hero: the badge's and one per plan row, nothing else.
    expect([...hero.querySelectorAll('s, del, strike')].map((el) => el.className)).toEqual(['hm-badge-was', 'hm-offer-was', 'hm-offer-was']);
    expect(rulesFor(plain, '.hm-offer-off')).toMatch(/border-radius/);
    expect(text(hero)).not.toMatch(/limited time|lifetime|for life|—/i);
  });

  it('says the discount once per place: no "below the standard price" lines on the homepage', () => {
    expect(text(doc.querySelector('main'))).not.toMatch(/below the standard price/i);
    expect(card.querySelector('.hm-offer-standard, .hm-offer-limit, .hm-offer-checks')).toBeNull();
    expect(text(card).match(/% off/g)).toHaveLength(2);
  });

  it('puts the Premium terms on one line, swapped for the sold-out line once every spot is taken', () => {
    const lines = card.querySelectorAll('.hm-offer-premium .hm-offer-terms');
    expect(lines).toHaveLength(1);
    const terms = lines[0];
    const copy = 'First 100 subscribers · up to 5 devices · 14-day free trial on yearly · your price stays the same while you stay subscribed.';
    expect(text(terms)).toBe(copy);
    expect(terms.children).toHaveLength(0);
    // The live count is the badge's job; this line keeps its words until the spots run out.
    expect(terms.dataset.mvSpots).toBe(copy);
    expect(terms.dataset.mvSpotsFull).toBe('All {cap} Early Bird spots are taken. Premium is now at the standard price. Up to 5 devices · 14-day free trial on yearly.');
    expect(before(card.querySelector('.hm-offer-plans'), terms)).toBe(true);
  });

  it('states the 100-spot limit in the badge and the Premium terms, counting spots taken, never spots left', () => {
    expect(text(hero.querySelector('.hm-badge'))).toContain('Only 100 spots in total');
    expect(text(card)).not.toContain('Limited to the first 100 subscribers');
    expect(text(card.querySelector('.hm-offer-terms'))).toMatch(/^First 100 subscribers/);
    expect(text(hero)).not.toMatch(/\b\d+ (spots )?left\b|selling fast|hurry|countdown/i);
    for (const el of hero.querySelectorAll('[data-mv-spots]')) {
      expect(el.dataset.mvSpots + el.dataset.mvSpotsFull).not.toMatch(/\bleft\b|—/);
    }
  });

  it('tells phone visitors a mobile app is coming, beside the email-me-the-link form', () => {
    const soon = card.querySelector('.hm-send-hint + .hm-mobile-soon[data-hero-platform="mobile"]');
    expect(soon).not.toBeNull();
    expect(soon.hidden).toBe(true);
    expect(soon.closest('.hm-hero-actions')).toBeNull();
    expect(soon.closest('.hm-offer-free')).not.toBeNull();
    expect(text(soon)).toBe('A mobile app is coming soon. Until then, MailVault runs on your computer.');
  });

  it('holds the one OS-detected download, and the phone form, at the top of the card', () => {
    const actions = card.querySelector('.hm-hero-actions');
    expect(card.querySelector('.hm-offer-free').firstElementChild).toBe(actions);
    expect([...actions.querySelectorAll('[data-hero-platform]')].map((el) => el.dataset.heroPlatform)).toEqual(['mac', 'windows', 'linux']);
    expect(actions.querySelector('#send-link-hero[data-send-link-primary]')).not.toBeNull();
    expect(card.querySelector('.hm-send-hint[data-hero-platform="mobile"]')).not.toBeNull();
    const downloads = shown(hero.querySelectorAll('.mv-button[data-download]'));
    expect(downloads).toHaveLength(1);
    expect(downloads[0].dataset.download).toBe('mac');
    expect(downloads[0].dataset.acquisitionPlacement).toBe('hero');
    // Three OS-detected buttons, plus one icon link per platform under them.
    expect(hero.querySelectorAll('[data-acquisition-destination="thank_you"]')).toHaveLength(6);
    expect(hero.querySelectorAll('.hm-hero-actions [data-acquisition-destination="thank_you"]')).toHaveLength(3);
    expect(hero.querySelectorAll('.hm-os-links [data-acquisition-destination="thank_you"]')).toHaveLength(3);
  });

  it('links the Premium tier to pricing as a hero CTA', () => {
    const link = card.querySelector('.hm-offer-premium .hm-offer-head a[href="/pricing.html"]');
    expect(text(link)).toBe('What Premium adds →');
    expect(link.dataset.acquisitionEvent).toBe('home_cta');
    expect(link.dataset.acquisitionPlacement).toBe('hero');
    expect(link.dataset.acquisitionDestination).toBe('pricing');
  });

  it('keeps the other ways to download in the free tier, and no demo link beside them', () => {
    const links = card.querySelector('.hm-offer-free .hm-hero-links');
    expect(hero.querySelectorAll('.hm-hero-links')).toHaveLength(1);
    expect(before(card.querySelector('.hm-hero-actions'), links)).toBe(true);
    const platforms = links.querySelector(':scope > a.mv-text-link[href="/get-started.html?plan=free#platforms"]');
    expect(platforms.dataset.acquisitionDestination).toBe('setup');
    expect(platforms.dataset.acquisitionPlacement).toBe('hero');
    const opener = links.querySelector('button.mv-text-link[data-send-link-open][aria-controls="send-link-hero"]');
    expect(opener.dataset.acquisitionDestination).toBe('email_link');
    expect(links.querySelector('[data-acquisition-destination="demo"]')).toBeNull();
  });

  // Owner's call: the other platforms as icons with links, not one text link.
  // Each icon goes where that platform's own button goes, with the same
  // download and acquisition attributes; "All formats" keeps the setup page.
  it('offers every platform as an icon link with its name, to the same target as its button', () => {
    const links = card.querySelector('.hm-offer-free .hm-hero-links');
    expect(hero.querySelectorAll('.hm-os-links')).toHaveLength(1);
    const row = links.querySelector(':scope > ul.hm-os-links');
    expect(row).not.toBeNull();
    const items = [...row.querySelectorAll(':scope > li > a')];
    const OS = [['mac', 'macOS', 'os-apple'], ['windows', 'Windows', 'os-windows'], ['linux', 'Linux', 'os-linux']];
    expect(items).toHaveLength(OS.length);
    OS.forEach(([platform, name, icon], i) => {
      const a = items[i];
      const button = card.querySelector(`.hm-hero-actions .mv-button[data-hero-platform="${platform}"]`);
      // A link, never a second button, and never hidden by the platform swap.
      expect(a.className).not.toMatch(/mv-button/);
      expect(a.hasAttribute('data-hero-platform')).toBe(false);
      expect(a.closest('[hidden]')).toBeNull();
      // Its accessible name says what it does and contains the visible name.
      expect(a.getAttribute('aria-label')).toBe(`Download for ${name}`);
      expect(text(a)).toBe(name);
      expect(a.querySelector(`svg[aria-hidden="true"] > use[href="#${icon}"]`), platform).not.toBeNull();
      expect(doc.getElementById(icon)?.tagName.toLowerCase()).toBe('symbol');
      expect(a.getAttribute('href')).toBe(button.getAttribute('href'));
      for (const attr of ['data-download', 'data-download-page', 'data-linux-deb', 'data-acquisition-download', 'data-acquisition-event', 'data-acquisition-placement', 'data-acquisition-destination']) {
        expect(a.getAttribute(attr), `${platform} ${attr}`).toBe(button.getAttribute(attr));
      }
      expect(a.dataset.acquisitionPlacement).toBe('hero');
      // After the buttons, so a first-match lookup still finds the button.
      expect(before(button, a)).toBe(true);
    });
    expect(text(card)).not.toContain('Other platforms and formats');
    const all = links.querySelector(':scope > a.mv-text-link[href="/get-started.html?plan=free#platforms"]');
    expect(text(all)).toBe('All formats →');
    expect(all.dataset.acquisitionEvent).toBe('home_cta');
    expect(before(row, all)).toBe(true);
    // The row stays on phones: it is not the final section's .hm-platforms, which phones hide.
    expect(row.classList.contains('hm-platforms')).toBe(false);
    expect(rulesFor(plain, '.hm-os-links svg')).toMatch(/fill\s*:\s*currentColor/);
  });

  it('drops the old price line and proof chips, keeping the download count under the card', () => {
    expect(hero.querySelector('.hm-price, .hm-facts')).toBeNull();
    const proof = hero.querySelector('[data-download-proof]');
    expect(proof.hidden).toBe(true);
    expect(before(hero.querySelector('.hm-hero-links'), proof)).toBe(true);
    expect(proof.closest('.hm-offer')).toBeNull();
  });

  it('reads label, badge, headline, lead, card, links, then the product visual', () => {
    const seq = ['.hm-free-label', '.hm-badge', 'h1', '.hm-lead', '.hm-offer', '#send-link-hero', '.hm-offer-free-title', '.hm-offer-free-line', '.hm-hero-links', '.hm-offer-premium', '.hm-hero-media'].map((s) => hero.querySelector(s));
    seq.forEach((el, i) => expect(el, String(i)).not.toBeNull());
    seq.slice(1).forEach((el, i) => expect(before(seq[i], el), String(i)).toBe(true));
  });

  it('fills the media slot with the hero clip: muted, lazy, its eager 1440 poster', () => {
    const media = hero.querySelector('.hm-hero-media');
    expect(media.dataset.clipSlot).toBe('hero-montage');
    const figure = media.querySelector('figure.mv-clip.hm-hero-clip');
    expect(figure.dataset.clip).toBe('hero-montage');
    expect(hero.querySelectorAll('video')).toHaveLength(1);
    const video = figure.querySelector('.mv-clip-media > video');
    for (const flag of ['muted', 'loop', 'playsinline']) expect(video.hasAttribute(flag), flag).toBe(true);
    expect(video.hasAttribute('autoplay')).toBe(false);
    expect(video.getAttribute('preload')).toBe('none');
    expect(video.getAttribute('poster')).toBe('/assets/clips/en/hero-montage.jpg');
    expect([video.getAttribute('width'), video.getAttribute('height')]).toEqual(['1440', '900']);
    expect(video.getAttribute('aria-label').length).toBeGreaterThan(60);
    expect(video.getAttribute('aria-label')).not.toMatch(/Describe exactly|—/);
    const sources = video.querySelectorAll('source');
    expect(sources).toHaveLength(1);
    expect(sources[0].getAttribute('src')).toBe('/assets/clips/en/hero-montage.mp4');
    expect(sources[0].getAttribute('type')).toBe('video/mp4');
    expect(statSync('website/assets/clips/en/hero-montage.mp4').size).toBeLessThan(1.6 * 1024 * 1024);
    expect(statSync('website/assets/clips/en/hero-montage.jpg').size).toBeLessThan(150 * 1024);
    expect(jpegWidth('website/assets/clips/en/hero-montage.jpg')).toBe(1440);
    // The clip replaces the old demo preview; no commented slot is left behind.
    expect(media.querySelector('picture, img')).toBeNull();
    expect(comments.filter((c) => c.includes('hero-montage'))).toEqual([]);
    expect(html).not.toContain('/demo/assets/demo-preview-en-');
  });

  it('opens the demo from one place: the launcher over the clip, with its acquisition attributes', () => {
    const media = hero.querySelector('.hm-hero-media');
    const link = media.querySelector('.hm-hero-clip .mv-clip-media > a.hm-hero-demo');
    expect(link.getAttribute('href')).toBe('/demo/?lang=en');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(link.getAttribute('aria-label')).toMatch(/new window/);
    expect(link.dataset.acquisitionEvent).toBe('home_cta');
    expect(link.dataset.acquisitionPlacement).toBe('hero_preview');
    expect(link.dataset.acquisitionDestination).toBe('demo');
    expect(text(link.querySelector('.mv-demo-launch'))).toBe('Open the demo ↗');
    // No corner badge restating it.
    expect(link.querySelector('.mv-demo-badge')).toBeNull();
    expect(link.querySelector('video, a, button')).toBeNull();
    // The only demo CTA in the hero, and the first one in the document.
    expect(hero.querySelectorAll('[href^="/demo/"]')).toHaveLength(1);
    expect(doc.querySelector('[data-acquisition-destination="demo"]')).toBe(link);
    // One button in the hero: the launcher is a styled span, not a .mv-button.
    expect(media.querySelector('.mv-button')).toBeNull();
    // A one-line caption under the clip.
    const caption = media.querySelector('figcaption');
    expect(text(caption)).toBe('A real inbox with 300 sample emails. No signup.');
    expect(caption.querySelector('br, a')).toBeNull();
  });

  it('loads the hero starter before the clip player, on this page only', () => {
    const scripts = [...doc.querySelectorAll('script[src]')].map((s) => s.getAttribute('src'));
    const starter = scripts.findIndex((s) => /^\/assets\/home-hero\.js\?v=[\w-]+$/.test(s));
    const player = scripts.findIndex((s) => s.startsWith('/assets/english-site.js?'));
    expect(starter).toBeGreaterThan(-1);
    expect(starter).toBeLessThan(player);
    expect(doc.querySelector('script[src^="/assets/home-hero.js"]').hasAttribute('defer')).toBe(true);
    for (const l of LOCALES) expect(read(`website/${l}/index.html`), l).not.toContain('home-hero.js');
    expect(read('website/i18n/frozen/index.html')).not.toContain('home-hero.js');
  });

  it('lays the visual left and the card right on desktop, in DOM order on phones', () => {
    expect(css).not.toBe('');
    const desktop = mediaBlocks(plain, '@media (min-width:761px)').join('\n');
    expect(rulesFor(desktop, '.hm-hero-media')).toMatch(/grid-column\s*:\s*1\b/);
    expect(rulesFor(desktop, '.hm-hero-side')).toMatch(/grid-column\s*:\s*2\b/);
    expect(rulesFor(plain.replace(/@media[^{]+\{[\s\S]*?\}\s*\}/g, ''), '.hm-hero-media')).not.toMatch(/grid-column/);
    expect(plain).not.toMatch(/\border\s*:/);
    expect(plain).not.toMatch(/display\s*:\s*contents/);
  });
});

describe('key points', () => {
  const strip = doc.getElementById('key-points');

  it('follows the hero', () => {
    expect(doc.querySelector('.hm-hero').nextElementSibling).toBe(strip);
  });

  it('names four points, each with an icon, a bold word and one line', () => {
    const items = strip.querySelectorAll('li');
    expect([...items].map((li) => text(li.querySelector('strong')))).toEqual(['Yours to keep', 'Every inbox', 'Private', 'Mac, Windows, Linux']);
    expect(text(items[3].querySelector(':scope > span:last-child'))).toBe('One app on all three. iPhone and Android apps are coming soon.');
    for (const li of items) {
      expect(li.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
      expect(text(li.querySelector(':scope > span:last-child'))).toMatch(/\.$/);
    }
  });
});

// The five long sections, each now a clip group with its headline and lead,
// then the small things, also a clip group. Every group shows its clip cards in
// plain rows (see homepage-clip-rows.test.js). Only real clips render; the clips still to be recorded wait as
// commented card markup.
const GROUPS = {
  backups: ['Free up your mailbox. Keep every message.', ['archive-delete', 'scheduled-backups', 'time-capsule', 'manual-backup']],
  'notion-mail': ["Notion Mail is gone. Your way of working isn't.", ['views', 'custom-fields', 'tagging-rules', 'ai-writing']],
  privacy: ["Your inbox is nobody's business. Not even ours.", ['search-local', 'sender-verification']],
  trackers: ['Read in private. Senders learn nothing.', ['trackers', 'link-safety', 'privacy-mode']],
  customize: ['Email that fits the way you work. Change almost anything.', ['chat-view', 'layouts', 'column-layout', 'explorer-view', 'quick-actions', 'shortcuts', 'notification-rules']],
  accounts: ['Every account. One calm window.', ['unified-inbox', 'undo-send', 'scheduled-send', 'insights']],
  more: ['Small things. Every day.', ['templates', 'tags', 'radial-menu', 'snooze', 'focus-session']],
};
// Each clip's Learn more link. Privacy mode has no feature page of its own;
// the radial menu, snooze and focus sessions have no page at all, so no link.
const LINKS = {
  'archive-delete': '/features/archive-and-delete.html',
  'scheduled-backups': '/features/scheduled-backups.html',
  'time-capsule': '/features/time-capsule.html',
  'manual-backup': '/features/local-backups.html',
  views: '/features/saved-views.html',
  'custom-fields': '/features/custom-fields.html',
  'tagging-rules': '/features/tagging-rules.html',
  'ai-writing': '/features/ai-writing.html',
  'search-local': '/features/local-vault.html',
  'sender-verification': '/features/sender-verification.html',
  trackers: '/features/email-tracker-blocking.html',
  'link-safety': '/features/link-safety.html',
  'privacy-mode': '/faq/premium.html#share-screenshots-privately',
  'chat-view': '/features/views.html',
  layouts: '/features/layouts.html',
  'column-layout': '/features/layouts.html',
  'explorer-view': '/features/views.html',
  'quick-actions': '/features/keyboard-shortcuts.html',
  shortcuts: '/features/keyboard-shortcuts.html',
  'notification-rules': '/features/notifications.html',
  'unified-inbox': '/features/unified-inbox.html',
  'undo-send': '/features/undo-send.html',
  'scheduled-send': '/features/scheduled-send.html',
  insights: '/features/insights.html',
  templates: '/features/templates.html',
  tags: '/features/tags.html',
};
const UNLINKED = ['radial-menu', 'snooze', 'focus-session'];
const ALL_CLIPS = Object.values(GROUPS).flatMap(([, clips]) => clips);
// The English feature pages that carry a clip (and the clips tag). Layouts now
// shows the column-layout clip; the theme clip stays on the homepage only.
const PAGES = ['archive-and-delete', 'scheduled-backups', 'time-capsule', 'local-backups', 'saved-views', 'custom-fields', 'tagging-rules', 'ai-writing', 'local-vault', 'sender-verification', 'email-tracker-blocking', 'link-safety', 'views', 'layouts', 'keyboard-shortcuts', 'notifications', 'unified-inbox', 'undo-send', 'scheduled-send', 'insights', 'templates', 'tags'];
// The Premium chip, exactly where the linked page says Premium. Focus sessions
// have no page; features.html lists them as Premium, so their card says so.
const PREMIUM = new Set(['archive-delete', 'scheduled-backups', 'time-capsule', 'trackers', 'privacy-mode', 'scheduled-send', 'focus-session']);
const PENDING = ['add-account', 'email-cleanup'];
const BATCH3 = ['tagging-rules', 'quick-actions', 'explorer-view', 'column-layout', 'shortcuts', 'notification-rules', 'templates', 'tags', 'radial-menu', 'snooze', 'focus-session'];

describe('clip groups', () => {
  it.each(Object.entries(GROUPS))('%s: two-line gradient headline, a short lead, its real clips in order', (id, [title, clips]) => {
    const group = doc.getElementById(id);
    expect(group?.tagName).toBe('SECTION');
    expect(group.classList.contains('hm-clip-group')).toBe(true);
    const h2 = group.querySelector('h2');
    expect(h2.querySelector('br')).not.toBeNull();
    expect(h2.querySelector('.hm-grad')).not.toBeNull();
    expect(heading(h2)).toBe(title);
    const lead = text(group.querySelector('.hm-center .hm-body'));
    expect(lead).not.toBe('');
    expect(lead.split(/[.!?](?:\s|$)/).filter(Boolean).length, lead).toBeLessThanOrEqual(2);
    expect([...group.querySelectorAll('figure.mv-clip')].map((f) => f.dataset.clip)).toEqual(clips);
    expect(group.querySelectorAll('.mv-clip-grid')).toHaveLength(1);
    expect(group.querySelector('.mv-clip-grid-3')).toBeNull();
    expect(group.querySelector('.mv-button, [data-download], [data-acquisition-download]')).toBeNull();
  });

  it('keeps the Notion Mail date and its article link; the alerts line became a clip', () => {
    const notion = doc.getElementById('notion-mail');
    expect(text(notion)).toContain('Notion Mail shut down on 22 September 2026');
    expect(notion.querySelector('a[href="/blog/notion-mail-closing.html"]')).not.toBeNull();
    const customize = doc.getElementById('customize');
    expect(customize.querySelector('.hm-group-link')).toBeNull();
    expect(text(customize.querySelector('figure[data-clip="notification-rules"] .mv-clip-title'))).toBe('Only the alerts you want');
  });

  it('shows every clip once on the page', () => {
    const shownClips = [...doc.querySelectorAll('main figure.mv-clip')].map((f) => f.dataset.clip);
    expect(shownClips).toEqual(['hero-montage', ...ALL_CLIPS]);
    expect(new Set(ALL_CLIPS).size).toBe(ALL_CLIPS.length);
    expect(ALL_CLIPS).toHaveLength(29);
    expect(plain).not.toMatch(/:not\(:has\(/);
  });

  it.each(ALL_CLIPS)('%s: a real clip over a lazy poster, a title, a caption, and its Learn more link where a page exists', (clip) => {
    const figure = doc.querySelector(`.hm-clip-group figure[data-clip="${clip}"]`);
    const media = figure.querySelector('.mv-clip-media');
    // The poster is a lazy image under the clip, so it loads without a script
    // and only near the screen. The video has no poster attribute of its own.
    const img = media.querySelector(':scope > img.mv-clip-poster');
    expect(img, clip).not.toBeNull();
    expect(img.getAttribute('src')).toBe(`/assets/clips/en/${clip}-poster.jpg`);
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(img.getAttribute('decoding')).toBe('async');
    expect([img.getAttribute('width'), img.getAttribute('height')]).toEqual(['640', '440']);
    expect(img.getAttribute('alt')).toBe('');
    const video = media.querySelector(':scope > video');
    expect(before(img, video)).toBe(true);
    for (const flag of ['muted', 'loop', 'playsinline']) expect(video.hasAttribute(flag)).toBe(true);
    expect(video.hasAttribute('autoplay')).toBe(false);
    expect(video.hasAttribute('poster')).toBe(false);
    expect(video.getAttribute('preload')).toBe('none');
    expect([video.getAttribute('width'), video.getAttribute('height')]).toEqual(['960', '660']);
    expect(video.querySelector('source').getAttribute('src')).toBe(`/assets/clips/en/${clip}.mp4`);
    const mp4 = `website/assets/clips/en/${clip}.mp4`;
    const poster = `website/assets/clips/en/${clip}-poster.jpg`;
    expect(existsSync(mp4), mp4).toBe(true);
    expect(statSync(mp4).size).toBeLessThan(260 * 1024);
    expect(existsSync(poster), poster).toBe(true);
    expect(statSync(poster).size).toBeLessThan(45 * 1024);
    expect(jpegWidth(poster)).toBe(640);
    expect(text(figure.querySelector('.mv-clip-title')).length).toBeGreaterThan(3);
    expect(text(figure.querySelector('.mv-clip-text'))).toMatch(/\.$/);
    const link = figure.querySelector('figcaption a.mv-text-link');
    if (UNLINKED.includes(clip)) {
      expect(LINKS[clip]).toBeUndefined();
      expect(figure.querySelector('a')).toBeNull();
    } else {
      const href = LINKS[clip];
      expect(link.getAttribute('href')).toBe(href);
      expect(existsSync('website' + href.replace(/#.*$/, '')), href).toBe(true);
      expect(text(link)).toMatch(/^Learn more/);
      expect(text(link.querySelector('.hm-sr'))).toBe(`about ${text(figure.querySelector('.mv-clip-title')).replace(/ Premium$/, '')}`);
    }
    // A card is no tab stop of its own: nothing scrolls it into view.
    expect(figure.hasAttribute('tabindex')).toBe(false);
    expect(Boolean(figure.querySelector('.mv-clip-title .hm-chip'))).toBe(PREMIUM.has(clip));
    const label = video.getAttribute('aria-label');
    expect(label.length).toBeGreaterThan(40);
    expect(label).not.toMatch(/Describe exactly/);
    const caption = text(figure.querySelector('.mv-clip-text'));
    expect(caption.split(/[.!?](?:\s|$)/).filter(Boolean).length, caption).toBeLessThanOrEqual(2);
    expect(figure.outerHTML).not.toMatch(/—|&mdash;/);
  });

  it('ships every batch-3 clip under 250 KB, with its 960 px still and a 15-41 KB 640 px poster', () => {
    for (const clip of BATCH3) {
      const mp4 = `website/assets/clips/en/${clip}.mp4`;
      const still = `website/assets/clips/en/${clip}.jpg`;
      expect(existsSync(mp4) && existsSync(still), clip).toBe(true);
      expect(statSync(mp4).size, mp4).toBeLessThan(250 * 1024);
      expect(jpegWidth(still), still).toBe(960);
      const poster = statSync(`website/assets/clips/en/${clip}-poster.jpg`).size;
      expect(poster, clip).toBeGreaterThan(15 * 1024);
      expect(poster, clip).toBeLessThanOrEqual(41 * 1024);
    }
  });

  it('describes tagging rules without claiming speed or naming a model', () => {
    const fig = doc.querySelector('figure[data-clip="tagging-rules"]');
    const words = text(fig) + ' ' + fig.querySelector('video').getAttribute('aria-label');
    expect(words).toContain('Invoice');
    expect(words).not.toMatch(/instant|immediately|in seconds|as it arrives|Apple Intelligence|model|provider|on your computer/i);
  });

  it('ships no card without its clip, and keeps the cards still to be recorded as commented markup', () => {
    for (const fig of doc.querySelectorAll('figure.mv-clip')) {
      const src = fig.querySelector('video source')?.getAttribute('src');
      expect(src && existsSync('website' + src), fig.dataset.clip).toBe(true);
    }
    expect([...doc.querySelectorAll('.hm-clip-group figure.mv-clip')].map((f) => f.dataset.clip).sort()).toEqual([...ALL_CLIPS].sort());
    for (const clip of PENDING) {
      expect(doc.querySelector(`[data-clip="${clip}"]`), clip).toBeNull();
      expect(comments.filter((c) => c.includes(`data-clip="${clip}"`)), clip).toHaveLength(1);
    }
    // A shown clip leaves no commented copy of its card behind.
    for (const clip of ALL_CLIPS) expect(comments.filter((c) => c.includes(`data-clip="${clip}"`)), clip).toEqual([]);
  });

  it('replaces the old clips section', () => {
    expect(doc.getElementById('clips')).toBeNull();
  });
});

describe('search card', () => {
  it('carries the measured search speed, worded as on the search feature page', () => {
    const caption = text(doc.querySelector('figure.mv-clip[data-clip="search-local"] .mv-clip-text'));
    expect(caption).toContain('In our test, 50,000 messages searched in under 15 ms.');
    expect(read('website/features/search.html')).toContain('In our test, 50,000 messages searched in under 15 ms.');
  });
});

describe('small things', () => {
  const more = doc.getElementById('more');

  // The features with no clip yet: one compact row of links under the clips.
  // Search has a clip card in #privacy, and the shortcuts and notification
  // features have theirs in #customize, so none of them is repeated here. The
  // native app has its own section (#native), so it left the row.
  const ROW = ['no-account', 'email-cleanup'];

  it('lists the features with no clip as a compact row of links under the clips', () => {
    expect(more.querySelector('.hm-icon-grid')).toBeNull();
    const row = more.querySelector('ul.hm-more-links');
    expect(row).not.toBeNull();
    expect(before(more.querySelector('.mv-clip-grid'), row)).toBe(true);
    const links = [...row.querySelectorAll('li > a')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual(ROW.map((p) => `/features/${p}.html`));
    for (const a of links) {
      expect(existsSync('website' + a.getAttribute('href')), a.getAttribute('href')).toBe(true);
      expect(text(a).length).toBeGreaterThan(3);
      expect(a.outerHTML).not.toMatch(/—|&mdash;/);
    }
    expect(links.map((a) => text(a))).toEqual(['No account with us', 'A tidier inbox Premium']);
    // Linked once on the page, from its own section.
    expect([...doc.querySelectorAll('main a[href="/features/native-app.html"]')].map((a) => a.closest('section').id)).toEqual(['native']);
    expect(text(more)).not.toContain('Light on your computer');
    expect([...row.querySelectorAll('.hm-chip')].map((c) => c.closest('a').getAttribute('href'))).toEqual(['/features/email-cleanup.html']);
    expect(more.querySelector('a[href="/features.html"]')).not.toBeNull();
  });

  it('repeats no feature a clip card already shows, anywhere on the page', () => {
    const clipped = new Set([...doc.querySelectorAll('.hm-clip-group figure.mv-clip figcaption a')].map((a) => a.getAttribute('href').replace(/#.*$/, '')));
    const row = [...more.querySelectorAll('.hm-more-links a')].map((a) => a.getAttribute('href').replace(/#.*$/, ''));
    expect(row.filter((h) => clipped.has(h))).toEqual([]);
    expect(new Set(row).size).toBe(row.length);
    // The search card in #privacy already covers search; no second search item.
    expect(more.querySelector('a[href="/features/search.html"]')).toBeNull();
    expect(text(more)).not.toContain('Find it in milliseconds');
    for (const gone of ['Hide who you write to', 'Know who really sent it', 'Free AI writing help', 'See your mail at a glance', 'Rules in plain words', 'Quiet hours']) {
      expect(text(more), gone).not.toContain(gone);
    }
  });
});

describe('spec card', () => {
  const spec = doc.getElementById('spec');

  it('states where everything lives', () => {
    expect(spec.querySelector('.hm-spec.hm-dark')).not.toBeNull();
    expect(text(spec.querySelector('.mv-eyebrow'))).not.toBe('');
    expect(spec.querySelector('h2').innerHTML).toBe('Plain files.<br><span class="hm-grad">Your disk.</span>');
    const rows = [...spec.querySelectorAll('dl > div')].map((d) => [text(d.querySelector('dt')), text(d.querySelector('dd'))]);
    expect(rows.map((r) => r[0])).toEqual(['Storage', 'Search index', 'Passwords', 'Account', 'Platforms']);
    const value = Object.fromEntries(rows);
    expect(value.Storage).toBe('Plain .eml files, Maildir-style');
    expect(value['Search index']).toBe('On your computer');
    expect(value.Passwords).toMatch(/Keychain/);
    expect(value.Passwords).toMatch(/Credential Manager/);
    expect(value.Passwords).toMatch(/Secret Service/);
    expect(value.Account).toBe('None');
    expect(value.Platforms).toBe('macOS, Windows, Linux');
  });
});

// Owner's call: why MailVault is fast, as a card of its own right before the
// spec card. Every line is checked against its source: the README's measured
// figures, the native app and search feature pages, and the build itself.
describe('built in Rust', () => {
  const sec = doc.getElementById('native');
  const readme = read('README.md');
  const rows = () => [...sec.querySelectorAll('dl.hm-spec-list > div')].map((d) => [text(d.querySelector('dt')), text(d.querySelector('dd'))]);

  it('sits right before the spec card, a dark card with a two-line heading and no eyebrow', () => {
    expect(sec?.tagName).toBe('SECTION');
    expect(sec.previousElementSibling).toBe(doc.getElementById('more'));
    expect(sec.nextElementSibling).toBe(doc.getElementById('spec'));
    expect(sec.querySelector('.hm-spec.hm-dark')).not.toBeNull();
    expect(sec.querySelector('.mv-eyebrow')).toBeNull();
    const h2 = sec.querySelector('h2');
    expect(sec.getAttribute('aria-labelledby')).toBe(h2.id);
    expect(h2.innerHTML).toBe('Built in Rust.<br><span class="hm-grad">Fast on your computer.</span>');
    expect(sec.querySelector('.mv-button, [data-download], form')).toBeNull();
  });

  it('says why, in the words of the native app page, and links to it', () => {
    const copy = text(sec.querySelector('.hm-spec-copy > p'));
    expect(copy).toBe("MailVault's core and its background helper are written in Rust. Sync, backups and search indexing run in that helper, a separate process, each job on its own thread, so the window stays responsive while they run. The window uses your system's own web engine instead of shipping a whole browser.");
    const native = read('website/features/native-app.html');
    for (const source of ['built with Rust and Tauri instead of shipping a whole browser', 'so the window stays responsive', 'Sync, backup and indexing run in a helper process, each job on its own thread.', 'Uses the system web view instead of bundling a browser.']) {
      expect(native, source).toContain(source);
    }
    const link = sec.querySelector('.hm-spec-copy a.mv-text-link[href="/features/native-app.html"]');
    expect(text(link)).toBe('How the native app works →');
  });

  it('lists the build: Rust, Tauri, the system web engine per platform, no bundled browser', () => {
    const value = Object.fromEntries(rows());
    expect(value.Core).toBe('Rust');
    expect(value['App shell']).toBe('Tauri');
    expect(value['Web engine']).toBe('WebKit on macOS and Linux, Microsoft WebView2 on Windows');
    expect(value['Bundled browser']).toBe('None');
    expect(value['Search index']).toBe('SQLite full-text, on your computer');
    // WebKit is never claimed for Windows: the Windows part of the line names WebView2 alone.
    const windows = value['Web engine'].split(',').filter((part) => /Windows/.test(part));
    expect(windows).toEqual([' Microsoft WebView2 on Windows']);
    expect(text(sec)).not.toMatch(/WebKit (?:on|for|\()\s*Windows/);
    // What the build says: Tauri 2 through wry, WKWebView, WebKitGTK and WebView2.
    expect(read('src-tauri/Cargo.toml')).toMatch(/^tauri = \{ version = "2"/m);
    const lock = read('Cargo.lock');
    for (const crate of ['wry', 'objc2-web-kit', 'webkit2gtk', 'webview2-com']) expect(lock, crate).toContain(`name = "${crate}"`);
    // The Windows installer fetches WebView2 when missing; no browser ships with the app.
    expect(read('src-tauri/tauri.conf.json')).toMatch(/"webviewInstallMode"\s*:\s*\{\s*"type"\s*:\s*"downloadBootstrapper"/);
    expect(read('src-core/src/search_index/db.rs')).toContain('USING fts5(');
  });

  it('quotes only measured figures, worded and qualified as the README states them', () => {
    const value = Object.fromEntries(rows());
    expect(rows().map((r) => r[0])).toEqual(['Core', 'App shell', 'Web engine', 'Bundled browser', 'Search index', 'Startup', 'Search', 'Long lists']);
    expect(value.Startup).toBe('Under a second');
    expect(readme).toMatch(/\| Startup \| under a second \|/);
    expect(value.Search).toBe('50,000 messages searched in under 15 ms in our test');
    expect(readme).toContain('50,000 messages searched in under 15 ms in our test');
    expect(read('website/features/search.html')).toContain('In our test, 50,000 messages searched in under 15 ms.');
    expect(value['Long lists']).toBe('Comfortable past 17,000 messages');
    expect(readme).toContain('comfortable past 17,000 messages');
    // No other number, no size or memory figure, no hype.
    expect(text(sec).replace(/WebView2/g, '').match(/\d[\d,]*/g)).toEqual(['50,000', '15', '17,000']);
    expect(text(sec)).not.toMatch(/\bMB\b|super fast|blazing|lightning|instant|—/i);
  });
});

describe('page order', () => {
  it('runs hero, key points, the six groups, small things, built in Rust, spec, comparison, feedback, download', () => {
    const ids = [...doc.querySelectorAll('main > section[id]')].map((s) => s.id);
    expect(Object.keys(GROUPS).at(-1)).toBe('more');
    expect(ids).toEqual(['key-points', ...Object.keys(GROUPS), 'native', 'spec', 'compare', 'feedback', 'newsletter', 'download']);
  });

  it('retires the free section and the old clips section', () => {
    for (const id of ['free', 'how-it-works', 'clips']) expect(doc.getElementById(id), id).toBeNull();
  });

  it('shrinks the community block to one line with the newsletter beside it', () => {
    const line = doc.getElementById('newsletter');
    expect(line.classList.contains('hm-community-line')).toBe(true);
    for (const sel of ['#want-this-btn', '#github-stars', '#vote-label', '#vote-status', 'form[data-subscribe]']) expect(line.querySelector(sel), sel).not.toBeNull();
  });

  it('has exactly one download button in the hero, one in the final section, none elsewhere', () => {
    const all = shown(doc.querySelectorAll('main .mv-button[data-download]'));
    expect(all.map((b) => b.dataset.acquisitionPlacement)).toEqual(['hero', 'final']);
  });
});

describe('Meatlytics tag and stylesheet', () => {
  const tagOf = (h) => (h.match(/<script defer src="\/gm\.js[^"]*" data-site="mailvault" data-tag="([^"]+)">\s*<\/script>/) || [])[1];

  it('tags the English homepage and the English clip pages clips-2026-10, their locale copies conversion-2026-10', () => {
    expect(PAGES).toHaveLength(22);
    for (const f of ['website/index.html', 'index.html', ...PAGES.map((p) => `website/features/${p}.html`)]) expect(tagOf(read(f)), f).toBe('clips-2026-10');
    for (const l of LOCALES) {
      for (const rel of ['index.html', ...PAGES.map((p) => `features/${p}.html`)]) expect(tagOf(read(`website/${l}/${rel}`)), `${l}/${rel}`).toBe('conversion-2026-10');
    }
  });

  it('loads the section styles on the English homepage only, at a new cache key', () => {
    expect(html).toMatch(/<link rel="stylesheet" href="\/assets\/home-sections\.css\?v=[\w-]+">/);
    expect(html).not.toMatch(/home-sections\.css\?v=[3-9]"/);
    for (const l of LOCALES) expect(read(`website/${l}/index.html`)).not.toContain('home-sections.css');
  });

  it('keeps mobile out of the structured data: the apps are coming, not available', () => {
    const ld = [...doc.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent);
    expect(ld.length).toBeGreaterThan(0);
    for (const block of ld) expect(block).not.toMatch(/iOS|iPhone|iPad|Android|mobile/i);
    const app = ld.map((b) => JSON.parse(b)).find((d) => d.operatingSystem);
    expect(app.operatingSystem).toBe('macOS, Windows, Linux');
  });

  it('keeps the root homepage identical', () => {
    expect(read('index.html')).toBe(html);
  });
});

describe('locale homepages stay as they are', () => {
  it('builds them from a frozen snapshot of the previous English page', () => {
    expect(i18n.FROZEN?.['index.html']).toBe('i18n/frozen/index.html');
    expect(existsSync('website/i18n/frozen/index.html')).toBe(true);
    expect(i18n.sourceHtml('index.html')).toBe(read('website/i18n/frozen/index.html'));
    expect(i18n.sourceHtml('features.html')).toBe(read('website/features.html'));
  });

  it.each(i18n.LOCALES.map((l) => l.dir))('%s: the build reproduces the committed homepage and clip pages byte for byte', (dir) => {
    const loc = i18n.LOCALES.find((l) => l.dir === dir);
    const dict = i18n.loadDict(loc);
    for (const rel of ['index.html', ...PAGES.map((p) => `features/${p}.html`)]) {
      const out = i18n.render(i18n.sourceHtml?.(rel) ?? read(`website/${rel}`), rel, loc, dict);
      expect(out === read(`website/${dir}/${rel}`), `${dir}/${rel}`).toBe(true);
    }
  });

  it('keeps every string of the frozen page in the corpus', () => {
    const corpus = Object.assign({}, ...Object.values(JSON.parse(read('website/i18n/corpus.json'))));
    const missing = i18n.collect(read('website/i18n/frozen/index.html')).filter((f) => !(f.key in corpus)).map((f) => f.text);
    expect(missing).toEqual([]);
  });
});
