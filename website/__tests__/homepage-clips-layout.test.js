import { existsSync, readFileSync, statSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import * as i18n from '../i18n/i18n.mjs';

// The English homepage, laid out as clip cards: a hero with the price card, one
// download and the hero clip, four key points, six groups of clips (two columns at most),
// the small-things grid, a spec card, then the comparison, feedback and the
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
    expect(text(badge)).toBe('Early access Free forever · Premium from $25/yr');
    expect(badge.querySelector('[data-mv-price="{yearly}"]').textContent).toBe('$25');
  });

  it('shows the plans as display rows in a card, early bird and standard price, nothing struck', () => {
    expect(card).not.toBeNull();
    expect(text(card.querySelector('.hm-offer-title'))).toBe('Early Bird & Family Pricing');
    const rows = card.querySelectorAll('.hm-offer-plan');
    expect([...rows].map((r) => r.dataset.plan)).toEqual(['yearly', 'monthly']);
    const [yearly, monthly] = rows;
    expect(yearly.querySelector('[data-mv-price="{yearly}"]').textContent).toBe('$25');
    expect(text(yearly)).toContain('$25/year');
    expect(text(yearly.querySelector('.hm-offer-standard'))).toBe('Standard price after early access: $39/year');
    expect(yearly.querySelector('[data-mv-price="{standardYearly}"]').textContent).toBe('$39');
    expect(monthly.querySelector('[data-mv-price="{monthly}"]').textContent).toBe('$4');
    expect(text(monthly)).toContain('$4/month');
    expect(text(monthly.querySelector('.hm-offer-standard'))).toBe('Standard price after early access: $6/month');
    expect(monthly.querySelector('[data-mv-price="{standardMonthly}"]').textContent).toBe('$6');
    expect(card.querySelector('.hm-offer-plans input, .hm-offer-plans select, .hm-offer-plans button, .hm-offer-plans form')).toBeNull();
    expect(hero.querySelector('s, del, strike')).toBeNull();
    expect(text(hero)).not.toMatch(/limited time|lifetime|for life|—/i);
  });

  it('holds the one OS-detected download, and the phone form, in the card', () => {
    const actions = card.querySelector('.hm-hero-actions');
    expect(actions).not.toBeNull();
    expect([...actions.querySelectorAll('[data-hero-platform]')].map((el) => el.dataset.heroPlatform)).toEqual(['mac', 'windows', 'linux']);
    expect(actions.querySelector('#send-link-hero[data-send-link-primary]')).not.toBeNull();
    expect(card.querySelector('.hm-send-hint[data-hero-platform="mobile"]')).not.toBeNull();
    const downloads = shown(hero.querySelectorAll('.mv-button[data-download]'));
    expect(downloads).toHaveLength(1);
    expect(downloads[0].dataset.download).toBe('mac');
    expect(downloads[0].dataset.acquisitionPlacement).toBe('hero');
    expect(hero.querySelectorAll('[data-acquisition-destination="thank_you"]')).toHaveLength(3);
  });

  it('lists the four promises as checks under the button', () => {
    expect([...card.querySelectorAll('.hm-offer-checks li')].map(text)).toEqual([
      'Free forever, unlimited manual backups',
      'Up to 5 devices per subscription',
      '14-day free trial on yearly',
      'No MailVault account',
    ]);
    expect(before(card.querySelector('.hm-hero-actions'), card.querySelector('.hm-offer-checks'))).toBe(true);
  });

  it('links the card to pricing as a hero CTA', () => {
    const link = card.querySelector('a[href="/pricing.html"]');
    expect(link.dataset.acquisitionEvent).toBe('home_cta');
    expect(link.dataset.acquisitionPlacement).toBe('hero');
    expect(link.dataset.acquisitionDestination).toBe('pricing');
  });

  it('keeps the text links under the card', () => {
    const links = hero.querySelector('.hm-hero-links');
    expect(before(card, links)).toBe(true);
    const platforms = links.querySelector('a.mv-text-link[href="/get-started.html?plan=free#platforms"]');
    expect(platforms.dataset.acquisitionDestination).toBe('setup');
    const demo = links.querySelector('a.mv-text-link[data-acquisition-destination="demo"]');
    expect(demo.getAttribute('href')).toBe('/demo/?lang=en');
    const opener = links.querySelector('button.mv-text-link[data-send-link-open][aria-controls="send-link-hero"]');
    expect(opener.dataset.acquisitionDestination).toBe('email_link');
  });

  it('drops the old price line and proof chips, keeping the download count under the links', () => {
    expect(hero.querySelector('.hm-price, .hm-facts')).toBeNull();
    const proof = hero.querySelector('[data-download-proof]');
    expect(proof.hidden).toBe(true);
    expect(before(hero.querySelector('.hm-hero-links'), proof)).toBe(true);
    expect(proof.closest('.hm-offer')).toBeNull();
  });

  it('reads badge, headline, lead, card, links, then the product visual', () => {
    const seq = ['.hm-badge', 'h1', '.hm-lead', '.hm-offer', '#send-link-hero', '.hm-hero-links', '.hm-hero-media'].map((s) => hero.querySelector(s));
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

  it('lays the demo launcher over the clip, after the text links, with its acquisition attributes', () => {
    const media = hero.querySelector('.hm-hero-media');
    const link = media.querySelector('.hm-hero-clip .mv-clip-media > a.hm-hero-demo');
    expect(link.getAttribute('href')).toBe('/demo/?lang=en');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(link.getAttribute('aria-label')).toMatch(/new window/);
    expect(link.dataset.acquisitionEvent).toBe('home_cta');
    expect(link.dataset.acquisitionPlacement).toBe('hero_preview');
    expect(link.dataset.acquisitionDestination).toBe('demo');
    expect(text(link.querySelector('.mv-demo-badge'))).toBe('Interactive demo');
    expect(text(link.querySelector('.mv-demo-launch'))).toBe('Open the demo ↗');
    expect(link.querySelector('video, a, button')).toBeNull();
    // The first demo CTA in the document stays the hero text link.
    const first = doc.querySelector('[data-acquisition-destination="demo"]');
    expect(first.closest('.hm-hero-links')).not.toBeNull();
    expect(first.dataset.acquisitionPlacement).toBe('hero');
    expect(before(first, link)).toBe(true);
    // One button in the hero: the launcher is a styled span, not a .mv-button.
    expect(media.querySelector('.mv-button')).toBeNull();
    expect(text(media.querySelector('figcaption'))).toContain('A real inbox. Ready to explore.');
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
    for (const li of items) {
      expect(li.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
      expect(text(li.querySelector(':scope > span:last-child'))).toMatch(/\.$/);
    }
  });
});

// The five long sections, each now a clip group with its headline and lead,
// then one group for the remaining everyday clips. Only real clips render; the
// clips still to be recorded wait as commented card markup.
const GROUPS = {
  backups: ['Free up your mailbox. Keep every message.', ['archive-delete', 'scheduled-backups', 'time-capsule', 'manual-backup']],
  'notion-mail': ["Notion Mail is gone. Your way of working isn't.", ['views', 'custom-fields', 'ai-writing']],
  privacy: ["Your inbox is nobody's business. Not even ours.", ['search-local', 'sender-verification']],
  trackers: ['Read in private. Senders learn nothing.', ['trackers', 'link-safety', 'privacy-mode']],
  customize: ['Email that fits the way you work. Change almost anything.', ['chat-view', 'layouts']],
  accounts: ['Every account. One calm window.', ['unified-inbox', 'undo-send', 'scheduled-send', 'insights']],
};
// Each clip's Learn more link. Privacy mode has no feature page of its own.
const LINKS = {
  'archive-delete': '/features/archive-and-delete.html',
  'scheduled-backups': '/features/scheduled-backups.html',
  'time-capsule': '/features/time-capsule.html',
  'manual-backup': '/features/local-backups.html',
  views: '/features/saved-views.html',
  'custom-fields': '/features/custom-fields.html',
  'ai-writing': '/features/ai-writing.html',
  'search-local': '/features/local-vault.html',
  'sender-verification': '/features/sender-verification.html',
  trackers: '/features/email-tracker-blocking.html',
  'link-safety': '/features/link-safety.html',
  'privacy-mode': '/faq/premium.html#share-screenshots-privately',
  'chat-view': '/features/views.html',
  layouts: '/features/layouts.html',
  'unified-inbox': '/features/unified-inbox.html',
  'undo-send': '/features/undo-send.html',
  'scheduled-send': '/features/scheduled-send.html',
  insights: '/features/insights.html',
};
// The English feature pages that carry their clip (and the clips tag).
const PAGES = Object.fromEntries(Object.entries(LINKS).filter(([, href]) => href.startsWith('/features/')).map(([clip, href]) => [clip, href.slice('/features/'.length, -'.html'.length)]));
// The Premium chip, exactly where the linked page says Premium.
const PREMIUM = new Set(['archive-delete', 'scheduled-backups', 'time-capsule', 'trackers', 'privacy-mode', 'scheduled-send']);
const PENDING = ['tagging-rules', 'add-account', 'quick-actions', 'email-cleanup'];

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
    expect(group.querySelector('.mv-clip-grid-3')).toBeNull();
    expect(group.querySelector('.mv-button, [data-download]')).toBeNull();
  });

  it('keeps the Notion Mail date, its article link and the alerts line', () => {
    const notion = doc.getElementById('notion-mail');
    expect(text(notion)).toContain('Notion Mail shut down on 22 September 2026');
    expect(notion.querySelector('a[href="/blog/notion-mail-closing.html"]')).not.toBeNull();
    expect(text(doc.getElementById('customize'))).toContain('Only the alerts you want');
  });

  it('has no empty group left, so the rules that hid one are gone', () => {
    for (const id of Object.keys(GROUPS)) expect(doc.getElementById(id).querySelectorAll('.mv-clip-grid > figure.mv-clip').length, id).toBeGreaterThanOrEqual(2);
    expect(plain).not.toMatch(/:not\(:has\(/);
  });

  it.each(Object.entries(LINKS))('%s: a real clip, a light poster, a title, a caption and a Learn more link', (clip, href) => {
    const figure = doc.querySelector(`.hm-clip-group figure[data-clip="${clip}"]`);
    const video = figure.querySelector('video');
    for (const flag of ['muted', 'loop', 'playsinline']) expect(video.hasAttribute(flag)).toBe(true);
    expect(video.hasAttribute('autoplay')).toBe(false);
    expect(video.getAttribute('preload')).toBe('none');
    expect(video.getAttribute('poster')).toBe(`/assets/clips/en/${clip}-poster.jpg`);
    expect(video.querySelector('source').getAttribute('src')).toBe(`/assets/clips/en/${clip}.mp4`);
    const mp4 = `website/assets/clips/en/${clip}.mp4`;
    const poster = `website/assets/clips/en/${clip}-poster.jpg`;
    expect(existsSync(mp4) && statSync(mp4).size).toBeLessThan(260 * 1024);
    expect(existsSync(poster), poster).toBe(true);
    expect(statSync(poster).size).toBeLessThan(45 * 1024);
    expect(jpegWidth(poster)).toBe(640);
    expect(text(figure.querySelector('.mv-clip-title')).length).toBeGreaterThan(3);
    expect(text(figure.querySelector('.mv-clip-text'))).toMatch(/\.$/);
    const link = figure.querySelector('figcaption a.mv-text-link');
    expect(link.getAttribute('href')).toBe(href);
    expect(existsSync('website' + href.replace(/#.*$/, '')), href).toBe(true);
    expect(text(link)).toMatch(/^Learn more/);
    expect(text(link.querySelector('.hm-sr'))).toBe(`about ${text(figure.querySelector('.mv-clip-title')).replace(/ Premium$/, '')}`);
    expect(Boolean(figure.querySelector('.mv-clip-title .hm-chip'))).toBe(PREMIUM.has(clip));
    const label = figure.querySelector('video').getAttribute('aria-label');
    expect(label.length).toBeGreaterThan(40);
    expect(label).not.toMatch(/Describe exactly/);
    const caption = text(figure.querySelector('.mv-clip-text'));
    expect(caption.split(/[.!?](?:\s|$)/).filter(Boolean).length, caption).toBeLessThanOrEqual(2);
    expect(figure.outerHTML).not.toMatch(/—|&mdash;/);
  });

  it('ships no card without its clip, and keeps the cards still to be recorded as commented markup', () => {
    for (const fig of doc.querySelectorAll('figure.mv-clip')) {
      const src = fig.querySelector('video source')?.getAttribute('src');
      expect(src && existsSync('website' + src), fig.dataset.clip).toBe(true);
    }
    expect([...doc.querySelectorAll('.hm-clip-group figure.mv-clip')].map((f) => f.dataset.clip).sort()).toEqual(Object.keys(LINKS).sort());
    for (const clip of PENDING) {
      expect(doc.querySelector(`[data-clip="${clip}"]`), clip).toBeNull();
      expect(comments.filter((c) => c.includes(`data-clip="${clip}"`)), clip).toHaveLength(1);
    }
    // A shown clip leaves no commented copy of its card behind.
    for (const clip of Object.keys(LINKS)) expect(comments.filter((c) => c.includes(`data-clip="${clip}"`)), clip).toEqual([]);
  });

  it('caps the grid at two columns and lets an odd last card span, never leaving a hole', () => {
    const grid = rulesFor(plain, '.hm-clip-group .mv-clip-grid');
    expect(grid).toMatch(/grid-template-columns\s*:\s*repeat\(\s*2\s*,/);
    for (const [, sel, body] of plain.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (/mv-clip/.test(sel)) expect(body, sel.trim()).not.toMatch(/repeat\(\s*[3-9]/);
    }
    expect(rulesFor(plain, '.hm-clip-group .mv-clip-grid > :last-child:nth-child(odd)')).toMatch(/grid-column\s*:\s*1\s*\/\s*-1/);
    const phone = mediaBlocks(plain, '@media (max-width:760px)').join('\n');
    expect(rulesFor(phone, '.hm-clip-group .mv-clip-grid')).toMatch(/grid-template-columns\s*:\s*1fr/);
  });

  it('replaces the old clips section', () => {
    expect(doc.getElementById('clips')).toBeNull();
  });
});

describe('small things', () => {
  const more = doc.getElementById('more');

  // Everything a clip card now shows has left the grid; the grid is the features
  // that have no clip yet, each linking to its own page.
  const SMALL = ['search', 'keyboard-shortcuts', 'templates', 'tags', 'tagging-rules', 'notifications', 'no-account', 'native-app', 'email-cleanup'];

  it('is a full three by three grid of icon cards, one per feature page', () => {
    const cards = more.querySelectorAll('.hm-icon-grid > a');
    expect(cards).toHaveLength(9);
    expect([...cards].map((a) => a.getAttribute('href'))).toEqual(SMALL.map((p) => `/features/${p}.html`));
    for (const a of cards) {
      expect(existsSync('website' + a.getAttribute('href')), a.getAttribute('href')).toBe(true);
      expect(a.querySelector('.hm-icon svg[aria-hidden="true"]')).not.toBeNull();
      expect(text(a.querySelector('strong'))).not.toBe('');
      expect(text(a.querySelector('span:not(.hm-icon)'))).toMatch(/\.$/);
      expect(a.outerHTML).not.toMatch(/—|&mdash;/);
    }
    const all = text(more);
    for (const fact of ['50,000 messages searched in under 15 ms', 'Tauri', 'rebind', 'every provider']) expect(all).toContain(fact);
    expect([...more.querySelectorAll('.hm-chip')].map((c) => c.closest('a').getAttribute('href'))).toEqual(['/features/email-cleanup.html']);
    expect(more.querySelector('video')).toBeNull();
    expect(rulesFor(plain, '.hm-icon-grid')).toMatch(/grid-template-columns\s*:\s*repeat\(\s*3\s*,/);
  });

  it('repeats no feature a clip card already shows', () => {
    const clipped = new Set([...doc.querySelectorAll('.hm-clip-group figure.mv-clip figcaption a')].map((a) => a.getAttribute('href').replace(/#.*$/, '')));
    const small = [...more.querySelectorAll('.hm-icon-grid > a')].map((a) => a.getAttribute('href').replace(/#.*$/, ''));
    expect(small.filter((h) => clipped.has(h))).toEqual([]);
    expect(new Set(small).size).toBe(small.length);
    for (const gone of ['Hide who you write to', 'Pick how mail reads', 'Arrange your window', 'Know who really sent it', 'Free AI writing help', 'See your mail at a glance']) {
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

describe('page order', () => {
  it('runs hero, key points, the six groups, small things, spec, comparison, feedback, download', () => {
    const ids = [...doc.querySelectorAll('main > section[id]')].map((s) => s.id);
    expect(ids).toEqual(['key-points', ...Object.keys(GROUPS), 'more', 'spec', 'compare', 'feedback', 'newsletter', 'download']);
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
    expect(Object.keys(PAGES)).toHaveLength(17);
    for (const f of ['website/index.html', 'index.html', ...Object.values(PAGES).map((p) => `website/features/${p}.html`)]) expect(tagOf(read(f)), f).toBe('clips-2026-10');
    for (const l of LOCALES) {
      for (const rel of ['index.html', ...Object.values(PAGES).map((p) => `features/${p}.html`)]) expect(tagOf(read(`website/${l}/${rel}`)), `${l}/${rel}`).toBe('conversion-2026-10');
    }
  });

  it('loads the section styles on the English homepage only', () => {
    expect(html).toMatch(/<link rel="stylesheet" href="\/assets\/home-sections\.css\?v=[\w-]+">/);
    for (const l of LOCALES) expect(read(`website/${l}/index.html`)).not.toContain('home-sections.css');
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
    for (const rel of ['index.html', ...Object.values(PAGES).map((p) => `features/${p}.html`)]) {
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
