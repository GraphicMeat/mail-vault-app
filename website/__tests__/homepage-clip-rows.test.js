import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { existsSync, readFileSync } from 'node:fs';

// The homepage clip groups are plain rows of clip cards that flow down the
// page: two columns at most on desktop, one on phones, an odd last card across
// the whole row. Nothing in a group scrolls: no carousel, no overflow, no inner
// scrollbar, no arrows. home-clips.js only shows a clip over its lazy poster
// once it plays; english-site.js plays and pauses it.
// Read leniently, so each test fails on its own where a file is missing.
const read = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : '');
const html = read('website/index.html');
const doc = new JSDOM(html).window.document;
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '');
const sections = strip(read('website/assets/home-sections.css'));
const site = strip(read('website/assets/english-site.css'));
const reveal = read('website/assets/home-clips.js');
const player = read('website/assets/english-site.js');
const GROUPS = ['backups', 'notion-mail', 'privacy', 'trackers', 'customize', 'accounts', 'more'];
const before = (a, b) => Boolean(a && b && a.compareDocumentPosition(b) & 4);

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
// Every [selector, declarations] pair in a stylesheet, media bodies included.
function rules(src) {
  const re = /([^{}]+)\{([^{}]*)\}/g;
  const out = [];
  let m;
  while ((m = re.exec(src))) out.push([m[1].replace(/^[\s\S]*\{/, '').trim(), m[2]]);
  return out;
}
const SCROLLS = /overflow(?:-x|-y|-inline|-block)?\s*:\s*[^;]*\b(?:auto|scroll)\b|scroll-snap|scroll-padding|scrollbar-|overscroll-behavior/;

describe('clip rows: markup', () => {
  it.each(GROUPS)('%s: centred two-line heading and lead, then one grid holding every card', (id) => {
    const group = doc.getElementById(id);
    const center = group.querySelector('.mv-wrap > .hm-center');
    expect(center, id).not.toBeNull();
    const h2 = center.querySelector('h2');
    expect(h2.querySelector('br')).not.toBeNull();
    expect(h2.querySelector('.hm-grad')).not.toBeNull();
    expect(center.querySelector('.hm-body')).not.toBeNull();
    const grids = group.querySelectorAll('.mv-clip-grid');
    expect(grids).toHaveLength(1);
    const grid = grids[0];
    expect(grid.parentElement).toBe(center.parentElement);
    expect(before(center, grid)).toBe(true);
    expect(grid.classList.contains('mv-clip-grid-3')).toBe(false);
    expect([...grid.children].every((c) => c.matches('figure.mv-clip'))).toBe(true);
    expect(grid.children.length).toBe(group.querySelectorAll('figure.mv-clip').length);
  });

  it.each(GROUPS)('%s: no carousel region, no arrows, no scroll-only tab stops', (id) => {
    const group = doc.getElementById(id);
    expect(group.querySelector('[role="region"], [aria-roledescription], [tabindex], button, [data-carousel-prev], [data-carousel-next]')).toBeNull();
    expect(group.querySelector('[class*="carousel"]')).toBeNull();
  });

  it('leaves no carousel markup anywhere on the page', () => {
    expect(html).not.toMatch(/carousel/i);
  });

  it('keeps the hero clip as it was: eager poster attribute, no lazy image, outside the groups', () => {
    const hero = doc.querySelector('.hm-hero-clip');
    expect(hero.querySelector('video').getAttribute('poster')).toBe('/assets/clips/en/hero-montage.jpg');
    expect(hero.querySelector('img')).toBeNull();
    expect(hero.closest('.hm-clip-group')).toBeNull();
  });

  it('loads the poster script on this page only, deferred, before the clip player', () => {
    const scripts = [...doc.querySelectorAll('script[src]')].map((s) => s.getAttribute('src'));
    const at = scripts.findIndex((s) => /^\/assets\/home-clips\.js\?v=[\w-]+$/.test(s));
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(scripts.findIndex((s) => s.startsWith('/assets/english-site.js?')));
    expect(doc.querySelector('script[src^="/assets/home-clips.js"]').hasAttribute('defer')).toBe(true);
    expect(html).not.toContain('home-clips.js?v=1"');
    for (const l of ['de', 'fr', 'es', 'it', 'ja', 'ko', 'zh', 'pt-br']) expect(read(`website/${l}/index.html`), l).not.toContain('home-clips.js');
  });
});

describe('clip rows: styles', () => {
  it('scrolls nothing on the homepage sections sheet', () => {
    expect(sections).not.toBe('');
    expect(sections).not.toMatch(SCROLLS);
  });

  it('lets no clip card, media box, caption or grid scroll in the shared sheet', () => {
    const clipRules = rules(site).filter(([sel]) => /mv-clip|hm-clip-group/.test(sel));
    expect(clipRules.length).toBeGreaterThan(5);
    for (const [sel, body] of clipRules) expect(body, sel).not.toMatch(SCROLLS);
  });

  it('lays the cards in two columns at most, one on phones', () => {
    expect(rulesFor(sections, '.hm-clip-group .mv-clip-grid')).toMatch(/grid-template-columns\s*:\s*repeat\(\s*2\s*,\s*minmax\(0,\s*1fr\)\s*\)/);
    const phone = mediaBlocks(sections, '@media (max-width:760px)').join('\n');
    expect(rulesFor(phone, '.hm-clip-group .mv-clip-grid')).toMatch(/grid-template-columns\s*:\s*1fr\b/);
    // No rule anywhere gives a clip grid three or more columns.
    for (const [sel, body] of [...rules(sections), ...rules(site)].filter(([s]) => /hm-clip-group|mv-clip-grid/.test(s) && !/mv-clip-grid-3/.test(s))) {
      expect(body, sel).not.toMatch(/repeat\(\s*(?:[3-9]|\d{2,}|auto-fill|auto-fit)\b/);
    }
  });

  it('spans an odd last card across the row, its clip beside its caption on desktop', () => {
    const last = '.hm-clip-group .mv-clip-grid > :last-child:nth-child(odd)';
    expect(rulesFor(sections, last)).toMatch(/grid-column\s*:\s*1\s*\/\s*-1/);
    const desktop = mediaBlocks(sections, '@media (min-width:761px)').join('\n');
    expect(rulesFor(desktop, last)).toMatch(/flex-direction\s*:\s*row/);
    expect(rulesFor(desktop, `${last} .mv-clip-media`)).toMatch(/flex\s*:\s*0 0 calc\(50% - 18px\)/);
  });

  it('layers the clip over its poster, shown only once it plays, never with display:none', () => {
    expect(rulesFor(sections, '.hm-clip-group .mv-clip-media')).toMatch(/position\s*:\s*relative/);
    const video = rulesFor(sections, '.hm-clip-group .mv-clip video');
    expect(video).toMatch(/position\s*:\s*absolute/);
    expect(video).toMatch(/opacity\s*:\s*0\b/);
    expect(video).toMatch(/background\s*:\s*transparent/);
    expect(video).not.toMatch(/display\s*:\s*none|visibility\s*:\s*hidden/);
    expect(rulesFor(sections, '.hm-clip-group .mv-clip.is-live video')).toMatch(/opacity\s*:\s*1/);
    expect(rulesFor(sections, '.mv-clip-poster')).toMatch(/aspect-ratio\s*:\s*960\s*\/\s*660/);
    const reduce = mediaBlocks(sections, '@media (prefers-reduced-motion:reduce)').join('\n');
    expect(reduce).toMatch(/\.hm-clip-group \.mv-clip video\s*\{[^}]*transition\s*:\s*none/);
  });
});

// The scripts against a small page shaped like the homepage: a hero clip and a
// group of three cards in a grid.
const card = (clip) => `<figure class="mv-clip" data-clip="${clip}"><div class="mv-clip-media"><img class="mv-clip-poster" src="/assets/clips/en/${clip}-poster.jpg" width="640" height="440" loading="lazy" decoding="async" alt=""><video muted loop playsinline preload="none" width="960" height="660" aria-label="${clip}"><source src="/assets/clips/en/${clip}.mp4" type="video/mp4"></video></div><figcaption><strong class="mv-clip-title">${clip}</strong><span class="mv-clip-text">${clip}.</span></figcaption></figure>`;
const MARKUP = `<!doctype html><html lang="en"><body class="mv-site"><main>
<section class="hm-hero"><figure class="mv-clip hm-hero-clip" data-clip="hero-montage"><div class="mv-clip-media"><video muted loop playsinline preload="none" poster="/assets/clips/en/hero-montage.jpg"></video></div></figure></section>
<section id="backups" class="hm-pillar hm-clip-group"><div class="mv-wrap"><div class="hm-center"><h2>Backups</h2><p class="hm-body">Lead.</p></div>
<div class="mv-clip-grid">${card('archive-delete')}${card('scheduled-backups')}${card('time-capsule')}</div></div></section>
</main></body></html>`;

describe('clip rows: lazy posters and playback', () => {
  const sessions = [];
  afterEach(() => { sessions.splice(0).forEach((d) => d.window.close()); });

  function page({ reduce = false, observer = true } = {}) {
    const dom = new JSDOM(MARKUP, { url: 'https://mailvaultapp.com/', runScripts: 'outside-only', pretendToBeVisual: true });
    sessions.push(dom);
    const w = dom.window;
    w.matchMedia = (q) => ({ matches: reduce && /prefers-reduced-motion:\s*reduce/.test(q) });
    w.fetch = vi.fn().mockRejectedValue(new Error('offline'));
    w.AbortSignal.timeout = () => undefined;
    w.navigator.sendBeacon = vi.fn();
    w.gm = vi.fn();
    const observers = [];
    if (observer) {
      w.IntersectionObserver = class {
        constructor(cb, options) { this.cb = cb; this.options = options; this.targets = []; observers.push(this); }
        observe(t) { this.targets.push(t); }
        unobserve() {}
        disconnect() {}
      };
    }
    const plays = [], pauses = [];
    w.HTMLMediaElement.prototype.play = vi.fn(function () { plays.push(this.closest('figure').dataset.clip); return Promise.resolve(); });
    w.HTMLMediaElement.prototype.pause = vi.fn(function () { pauses.push(this.closest('figure').dataset.clip); });
    w.eval(reveal);
    w.eval(player);
    const doc = w.document;
    const videos = [...doc.querySelectorAll('.hm-clip-group video')];
    const see = (video, ratio) => observers.forEach((o) => o.cb([{ target: video, isIntersecting: ratio > 0, intersectionRatio: ratio }], o));
    return { w, doc, videos, see, observers, plays, pauses, scrollPage: () => w.dispatchEvent(new w.Event('scroll')) };
  }

  it('carries no scrolling code: no arrows, no scrollBy, no scroll listener', () => {
    expect(reveal).not.toBe('');
    expect(reveal).not.toMatch(/carousel|scrollBy|scrollLeft|scrollWidth|addEventListener\(\s*'scroll'/);
  });

  it('shows the clip over its poster from the first frame it plays, and keeps it shown', () => {
    const p = page();
    const fig = p.videos[0].closest('figure');
    expect(fig.classList.contains('is-live')).toBe(false);
    p.videos[0].dispatchEvent(new p.w.Event('playing'));
    expect(fig.classList.contains('is-live')).toBe(true);
    p.videos[0].dispatchEvent(new p.w.Event('pause'));
    expect(fig.classList.contains('is-live')).toBe(true);
    expect(p.videos[1].closest('figure').classList.contains('is-live')).toBe(false);
  });

  it('leaves the hero clip alone', () => {
    const p = page();
    const hero = p.doc.querySelector('.hm-hero-clip');
    hero.querySelector('video').dispatchEvent(new p.w.Event('playing'));
    expect(hero.classList.contains('is-live')).toBe(false);
  });

  it('plays a card once half of it is on screen after the first scroll, and pauses it when it leaves', () => {
    const p = page();
    p.see(p.videos[0], 1);
    expect(p.plays).toEqual([]);
    p.scrollPage();
    expect(p.observers).toHaveLength(1);
    expect(p.observers[0].options?.root ?? null).toBeNull();
    p.see(p.videos[0], 1);
    p.see(p.videos[1], 0.4);
    expect(p.plays).toEqual(['archive-delete']);
    p.see(p.videos[0], 0.2);
    expect(p.pauses).toContain('archive-delete');
  });

  it('reports the first play of each clip once', () => {
    const p = page();
    p.videos[0].dispatchEvent(new p.w.Event('playing'));
    p.videos[0].dispatchEvent(new p.w.Event('playing'));
    expect(p.w.gm.mock.calls.filter(([name]) => name === 'clip_play')).toEqual([
      ['clip_play', { page_version: 'homepage-en-20261002', clip: 'archive-delete' }],
    ]);
  });

  it('plays nothing with reduced motion or without IntersectionObserver, so the posters stay', () => {
    for (const opts of [{ reduce: true }, { observer: false }]) {
      const p = page(opts);
      p.scrollPage();
      p.see(p.videos[0], 1);
      expect(p.plays, JSON.stringify(opts)).toEqual([]);
      expect(p.doc.querySelectorAll('.is-live')).toHaveLength(0);
    }
  });
});
