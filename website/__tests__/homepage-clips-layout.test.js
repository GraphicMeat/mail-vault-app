import { existsSync, readFileSync, statSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import * as i18n from '../i18n/i18n.mjs';

// The English homepage, laid out as clip cards: a hero with the price card and
// one download, four key points, three groups of clips (two columns at most),
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

  it('keeps the product visual a media slot that can take the hero clip', () => {
    const media = hero.querySelector('.hm-hero-media');
    expect(media.dataset.clipSlot).toBe('hero-montage');
    expect(media.querySelector('.mv-demo-card picture source[data-shot-dark]')).not.toBeNull();
    // The hero clip markup waits in a comment until hero-montage.mp4 exists.
    expect(html).toMatch(/<!--[\s\S]*data-clip="hero-montage"[\s\S]*-->/);
    expect(hero.querySelector('video')).toBeNull();
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
// rest wait as commented card markup.
const GROUPS = {
  backups: ['Free up your mailbox. Keep every message.', ['archive-delete', 'scheduled-backups', 'time-capsule']],
  'notion-mail': ["Notion Mail is gone. Your way of working isn't.", []],
  privacy: ["Your inbox is nobody's business. Not even ours.", []],
  trackers: ['Read in private. Senders learn nothing.', ['trackers', 'link-safety']],
  customize: ['Email that fits the way you work. Change almost anything.', []],
  accounts: ['Every account. One calm window.', ['unified-inbox', 'undo-send']],
};
const PAGES = {
  'archive-delete': 'archive-and-delete',
  'scheduled-backups': 'scheduled-backups',
  'time-capsule': 'time-capsule',
  trackers: 'email-tracker-blocking',
  'link-safety': 'link-safety',
  'undo-send': 'undo-send',
  'unified-inbox': 'unified-inbox',
};
const PREMIUM = new Set(['archive-delete', 'scheduled-backups', 'time-capsule', 'trackers']);
const BATCH_2 = ['manual-backup', 'views', 'custom-fields', 'tagging-rules', 'ai-writing', 'search-local', 'add-account', 'sender-verification', 'privacy-mode', 'chat-view', 'layouts', 'quick-actions', 'scheduled-send', 'email-cleanup'];

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

  it('hides the grid of a group whose clips are still to come', () => {
    expect(plain).toMatch(/\.hm-clip-group \.mv-clip-grid:not\(:has\(> \.mv-clip\)\)\s*\{\s*display\s*:\s*none/);
  });

  it.each(Object.entries(PAGES))('%s: a real clip, a light poster, a title, a caption and a Learn more link', (clip, page) => {
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
    expect(link.getAttribute('href')).toBe(`/features/${page}.html`);
    expect(text(link)).toMatch(/^Learn more/);
    expect(Boolean(figure.querySelector('.mv-clip-title .hm-chip'))).toBe(PREMIUM.has(clip));
    expect(figure.outerHTML).not.toMatch(/—|&mdash;/);
  });

  it('ships no card without its clip, and keeps the batch-2 cards as commented markup', () => {
    for (const fig of doc.querySelectorAll('figure.mv-clip')) {
      const src = fig.querySelector('video source')?.getAttribute('src');
      expect(src && existsSync('website' + src), fig.dataset.clip).toBe(true);
    }
    for (const clip of BATCH_2) {
      expect(doc.querySelector(`[data-clip="${clip}"]`), clip).toBeNull();
      expect(html, clip).toMatch(new RegExp(`<!--[^]*?data-clip="${clip}"[^]*?-->`));
    }
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

  it('is a three by three grid of icon cards that keeps the old facts', () => {
    const cards = more.querySelectorAll('.hm-icon-grid > a');
    expect(cards).toHaveLength(9);
    for (const a of cards) {
      expect(a.querySelector('.hm-icon svg[aria-hidden="true"]')).not.toBeNull();
      expect(text(a.querySelector('strong'))).not.toBe('');
      expect(text(a.querySelector('span:not(.hm-icon)'))).toMatch(/\.$/);
    }
    const all = text(more);
    for (const fact of ['50,000 messages searched in under 15 ms', 'Insights', 'Tauri', 'SPF, DKIM and DMARC']) expect(all).toContain(fact);
    expect(more.querySelector('a[href="/features/email-cleanup.html"] .hm-chip')).not.toBeNull();
    expect(more.querySelector('video')).toBeNull();
    expect(rulesFor(plain, '.hm-icon-grid')).toMatch(/grid-template-columns\s*:\s*repeat\(\s*3\s*,/);
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

  it('tags the English homepage and the seven English clip pages clips-2026-10, their locale copies conversion-2026-10', () => {
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
