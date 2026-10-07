import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { LOCALES, render, loadDict, sourceHtml } from '../i18n/i18n.mjs';

// Short muted clips recorded in the app. English only until the owner
// approves them: each feature page's figure carries data-i18n-en-only, and the
// locale homepages are built from a frozen snapshot of the English homepage
// from before the clips, so no locale page gets an untranslated caption.
// Clip => the English feature page that shows it.
const CLIPS = {
  'archive-delete': 'archive-and-delete',
  'scheduled-backups': 'scheduled-backups',
  'time-capsule': 'time-capsule',
  trackers: 'email-tracker-blocking',
  'link-safety': 'link-safety',
  'undo-send': 'undo-send',
  'unified-inbox': 'unified-inbox',
  'manual-backup': 'local-backups',
  views: 'saved-views',
  'custom-fields': 'custom-fields',
  'ai-writing': 'ai-writing',
  'search-local': 'local-vault',
  'sender-verification': 'sender-verification',
  'chat-view': 'views',
  layouts: 'layouts',
  'scheduled-send': 'scheduled-send',
  insights: 'insights',
};
// Privacy mode has no feature page; its homepage card links to the Premium FAQ.
const HOME_ONLY = { 'privacy-mode': '/faq/premium.html#share-screenshots-privately' };
const GROUPS = [
  ['archive-delete', 'scheduled-backups', 'time-capsule', 'manual-backup'],
  ['views', 'custom-fields', 'ai-writing'],
  ['search-local', 'sender-verification'],
  ['trackers', 'link-safety', 'privacy-mode'],
  ['chat-view', 'layouts'],
  ['unified-inbox', 'undo-send', 'scheduled-send', 'insights'],
];
const load = (file) => new JSDOM(readFileSync(file, 'utf8')).window.document;
const home = load('website/index.html');
const visible = (els) => [...els].filter((el) => !el.closest('[hidden]'));

function checkFigure(figure, clip, poster = `${clip}.jpg`) {
  expect(figure.dataset.clip).toBe(clip);
  const video = figure.querySelector('video');
  expect(video, clip).not.toBeNull();
  for (const flag of ['muted', 'loop', 'playsinline']) expect(video.hasAttribute(flag), `${clip} ${flag}`).toBe(true);
  // No autoplay attribute: english-site.js starts a clip only once it is on screen.
  expect(video.hasAttribute('autoplay')).toBe(false);
  expect(video.getAttribute('preload')).toBe('none');
  expect(video.getAttribute('poster')).toBe(`/assets/clips/en/${poster}`);
  expect(video.getAttribute('width')).toBe('960');
  expect(video.getAttribute('height')).toBe('660');
  expect(video.getAttribute('aria-label').length).toBeGreaterThan(30);
  const sources = video.querySelectorAll('source');
  expect(sources).toHaveLength(1);
  expect(sources[0].getAttribute('src')).toBe(`/assets/clips/en/${clip}.mp4`);
  expect(sources[0].getAttribute('type')).toBe('video/mp4');
  for (const name of [`${clip}.mp4`, poster]) {
    const file = `website/assets/clips/en/${name}`;
    expect(existsSync(file), file).toBe(true);
    expect(statSync(file).size, file).toBeLessThan(260 * 1024);
  }
  const caption = figure.querySelector('figcaption');
  expect(caption.querySelector('.mv-clip-title').textContent.trim().length).toBeGreaterThan(3);
  expect(caption.querySelector('.mv-clip-text').textContent.trim()).toMatch(/\.$/);
  expect(figure.outerHTML).not.toMatch(/—|&mdash;/);
  expect(figure.querySelector('.mv-button')).toBeNull();
}

// The homepage shows the clips in three groups (see homepage-clips-layout.test.js
// for the layout); here, each card against the same rules as the feature pages.
describe('homepage clips', () => {
  const groups = [...home.querySelectorAll('main > section.hm-clip-group')];

  it('shows eighteen clips in six headed groups, after the key points', () => {
    expect(groups.map((g) => [...g.querySelectorAll('figure.mv-clip')].map((f) => f.dataset.clip))).toEqual(GROUPS);
    expect(home.getElementById('key-points').nextElementSibling).toBe(groups[0]);
    for (const g of groups) {
      expect(g.querySelector('.hm-body').textContent.trim()).not.toBe('');
      expect(g.querySelector('h2').textContent.trim()).not.toBe('');
    }
  });

  it.each([...Object.keys(CLIPS), ...Object.keys(HOME_ONLY)])('%s is a muted, lazy clip with a light poster and a caption', (clip) => {
    checkFigure(home.querySelector(`.hm-clip-group figure[data-clip="${clip}"]`), clip, `${clip}-poster.jpg`);
  });

  it.each([...Object.entries(CLIPS).map(([c, p]) => [c, `/features/${p}.html`]), ...Object.entries(HOME_ONLY)])('%s links to %s with its own accessible name', (clip, href) => {
    const link = home.querySelector(`.hm-clip-group figure[data-clip="${clip}"] figcaption a`);
    expect(link.getAttribute('href')).toBe(href);
    expect(link.classList.contains('mv-text-link')).toBe(true);
    expect(link.textContent).toMatch(/^Learn more/);
  });

  it('gives every Learn more link a distinct accessible name', () => {
    const names = groups.flatMap((g) => [...g.querySelectorAll('figcaption a')].map((a) => a.textContent.trim()));
    expect(names).toHaveLength(18);
    expect(new Set(names).size).toBe(18);
  });

  it('adds no button, and no download', () => {
    for (const g of groups) {
      expect(g.querySelector('.mv-button, button, [data-download], [data-acquisition-download]')).toBeNull();
      expect(g.textContent).not.toMatch(/—/);
    }
  });

  it('keeps the root copy of the homepage identical', () => {
    expect(readFileSync('index.html', 'utf8')).toBe(readFileSync('website/index.html', 'utf8'));
  });
});

describe.each(Object.entries(CLIPS))('feature page for %s', (clip, page) => {
  const doc = load(`website/features/${page}.html`);
  const figures = doc.querySelectorAll('figure.mv-clip');

  it('carries exactly one clip, its own', () => {
    expect(figures).toHaveLength(1);
    checkFigure(figures[0], clip);
  });

  it('puts it right after the hero, before the first content section', () => {
    const spot = figures[0].closest('.mv-clip-spot');
    expect(spot).not.toBeNull();
    expect(spot.hasAttribute('data-i18n-en-only')).toBe(true);
    const hero = doc.querySelector('main .fp-hero, main header');
    expect(hero.nextElementSibling).toBe(spot);
  });

  it('adds no second download button and no link back to itself', () => {
    const spot = figures[0].closest('.mv-clip-spot');
    expect(spot.querySelector('.mv-button, button, [data-download]')).toBeNull();
    expect(spot.querySelector(`a[href$="/features/${page}.html"]`)).toBeNull();
    expect(visible(doc.querySelectorAll('main .mv-button[data-download]'))).toHaveLength(1);
  });
});

describe('locale pages stay free of the English clips', () => {
  const pages = ['index.html', ...Object.values(CLIPS).map((p) => `features/${p}.html`)];
  const english = [...home.querySelectorAll('.hm-clip-group figcaption')].map((n) => n.textContent.replace(/\s+/g, ' ').trim());

  it.each(LOCALES.map((l) => l.dir))('%s renders no clip, no marker and no clip caption', (dir) => {
    const loc = LOCALES.find((l) => l.dir === dir);
    const dict = loadDict(loc);
    for (const rel of pages) {
      const out = render(sourceHtml(rel), rel, loc, dict);
      expect(out, `${dir}/${rel}`).not.toMatch(/mv-clip|data-i18n-en-only|\/assets\/clips\//);
      const text = new JSDOM(out).window.document.body.textContent.replace(/\s+/g, ' ');
      for (const s of english) expect(text, `${dir}/${rel}`).not.toContain(s);
    }
  });

  it.each(LOCALES.map((l) => l.dir))('%s committed pages carry no clip', (dir) => {
    for (const rel of pages) expect(readFileSync(`website/${dir}/${rel}`, 'utf8'), `${dir}/${rel}`).not.toMatch(/mv-clip|\/assets\/clips\//);
  });
});

// The player: plays a clip while at least half of it is on screen, pauses it
// when it leaves, never starts before the visitor scrolls, never autoplays for
// reduced motion, and reports the first play of each clip once.
describe('clip player', () => {
  const source = readFileSync('website/assets/english-site.js', 'utf8');
  const sessions = [];
  afterEach(() => { sessions.splice(0).forEach((d) => d.window.close()); });
  const MARKUP = `<!doctype html><html lang="en"><body class="mv-site"><main>
<figure class="mv-clip" data-clip="trackers"><video muted loop playsinline preload="none" poster="/assets/clips/en/trackers.jpg" aria-label="a"><source src="/assets/clips/en/trackers.mp4" type="video/mp4"></video><figcaption>a</figcaption></figure>
<figure class="mv-clip" data-clip="undo-send"><video muted loop playsinline preload="none" poster="/assets/clips/en/undo-send.jpg" aria-label="b"><source src="/assets/clips/en/undo-send.mp4" type="video/mp4"></video><figcaption>b</figcaption></figure>
</main></body></html>`;

  function page({ reduce = false, observer = true, play } = {}) {
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
    w.HTMLMediaElement.prototype.play = vi.fn(function () { plays.push(this.closest('figure').dataset.clip); return play ? play() : Promise.resolve(); });
    w.HTMLMediaElement.prototype.pause = vi.fn(function () { pauses.push(this.closest('figure').dataset.clip); });
    w.eval(source);
    const videos = [...w.document.querySelectorAll('video')];
    const see = (video, ratio) => observers.forEach((o) => o.cb([{ target: video, isIntersecting: ratio > 0, intersectionRatio: ratio }], o));
    const scroll = () => w.dispatchEvent(new w.Event('scroll'));
    return { w, doc: w.document, videos, observers, plays, pauses, see, scroll };
  }

  it('waits for the first scroll, so nothing plays above the fold on load', () => {
    const { observers, plays, scroll } = page();
    expect(observers.flatMap((o) => o.targets)).toHaveLength(0);
    expect(plays).toEqual([]);
    scroll();
    expect(observers).toHaveLength(1);
    expect(observers[0].targets).toHaveLength(2);
  });

  it('plays a clip at least half on screen and pauses it when it leaves', () => {
    const { videos, plays, pauses, see, scroll } = page();
    scroll();
    see(videos[0], 0.3);
    expect(plays).toEqual([]);
    see(videos[0], 0.6);
    expect(plays).toEqual(['trackers']);
    see(videos[0], 0.1);
    expect(pauses).toContain('trackers');
  });

  it('never autoplays for reduced motion', () => {
    const { videos, observers, plays, see, scroll } = page({ reduce: true });
    scroll();
    see(videos[0], 1);
    expect(observers).toHaveLength(0);
    expect(plays).toEqual([]);
  });

  it('does not play in a hidden tab, and pauses when the tab is hidden', () => {
    const { w, doc, videos, plays, pauses, see, scroll } = page();
    let hidden = true;
    Object.defineProperty(doc, 'hidden', { configurable: true, get: () => hidden });
    scroll();
    see(videos[0], 0.8);
    expect(plays).toEqual([]);
    hidden = false;
    doc.dispatchEvent(new w.Event('visibilitychange'));
    expect(plays).toEqual(['trackers']);
    hidden = true;
    doc.dispatchEvent(new w.Event('visibilitychange'));
    expect(pauses).toContain('trackers');
  });

  it('swallows a refused play()', async () => {
    const { videos, plays, see, scroll } = page({ play: () => Promise.reject(new Error('NotAllowedError')) });
    scroll();
    expect(() => see(videos[0], 0.9)).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(plays).toEqual(['trackers']);
  });

  it('runs without IntersectionObserver and never plays', () => {
    const { videos, plays, scroll } = page({ observer: false });
    scroll();
    videos[0].dispatchEvent(new videos[0].ownerDocument.defaultView.Event('playing'));
    expect(plays).toEqual([]);
  });

  it('reports the first play of each clip once', () => {
    const { w, videos, scroll } = page();
    scroll();
    videos[0].dispatchEvent(new w.Event('playing'));
    videos[0].dispatchEvent(new w.Event('playing'));
    videos[1].dispatchEvent(new w.Event('playing'));
    expect(w.gm.mock.calls.filter(([name]) => name === 'clip_play')).toEqual([
      ['clip_play', { page_version: 'homepage-en-20261002', clip: 'trackers' }],
      ['clip_play', { page_version: 'homepage-en-20261002', clip: 'undo-send' }],
    ]);
  });
});

// The hero clip: home-hero.js starts it once the page has loaded, with no
// scroll, on screens wider than 760 px. Never with reduced motion. With
// Save-Data it becomes its still poster, so nothing can play or fetch it.
// Phones keep the scroll rule of english-site.js, which also pauses the hero off
// screen and reports its first play.
describe('hero clip start', () => {
  // Read leniently, so each test below fails on its own where the starter is missing.
  const STARTER = 'website/assets/home-hero.js';
  const starter = existsSync(STARTER) ? readFileSync(STARTER, 'utf8') : '';
  const player = readFileSync('website/assets/english-site.js', 'utf8');
  const sessions = [];
  afterEach(() => { sessions.splice(0).forEach((d) => d.window.close()); });
  const MARKUP = `<!doctype html><html lang="en"><body class="mv-site"><main>
<section class="hm-hero"><figure class="mv-clip hm-hero-clip" data-clip="hero-montage"><div class="mv-clip-media"><video muted loop playsinline preload="none" poster="/assets/clips/en/hero-montage.jpg" width="1440" height="900" aria-label="A quick tour"><source src="/assets/clips/en/hero-montage.mp4" type="video/mp4"></video></div></figure></section>
<figure class="mv-clip" data-clip="trackers"><video muted loop playsinline preload="none" poster="/assets/clips/en/trackers-poster.jpg" aria-label="a"><source src="/assets/clips/en/trackers.mp4" type="video/mp4"></video><figcaption>a</figcaption></figure>
</main></body></html>`;

  function page({ reduce = false, phone = false, saveData, hidden = false, loaded = false, idleApi = true } = {}) {
    const dom = new JSDOM(MARKUP, { url: 'https://mailvaultapp.com/', runScripts: 'outside-only', pretendToBeVisual: true });
    sessions.push(dom);
    const w = dom.window;
    w.matchMedia = (q) => ({ matches: (reduce && /prefers-reduced-motion:\s*reduce/.test(q)) || (phone && /max-width:\s*760px/.test(q)) });
    w.fetch = vi.fn().mockRejectedValue(new Error('offline'));
    w.AbortSignal.timeout = () => undefined;
    w.navigator.sendBeacon = vi.fn();
    w.gm = vi.fn();
    if (saveData !== undefined) Object.defineProperty(w.navigator, 'connection', { configurable: true, value: { saveData } });
    let state = loaded ? 'complete' : 'loading';
    Object.defineProperty(w.document, 'readyState', { configurable: true, get: () => state });
    let isHidden = hidden;
    Object.defineProperty(w.document, 'hidden', { configurable: true, get: () => isHidden });
    const idle = [];
    if (idleApi) w.requestIdleCallback = (cb) => idle.push(cb);
    else delete w.requestIdleCallback;
    const observers = [];
    w.IntersectionObserver = class {
      constructor(cb) { this.cb = cb; this.targets = []; observers.push(this); }
      observe(t) { this.targets.push(t); }
      unobserve() {}
      disconnect() {}
    };
    const plays = [], pauses = [];
    w.HTMLMediaElement.prototype.play = vi.fn(function () { plays.push(this.closest('figure').dataset.clip); return Promise.resolve(); });
    w.HTMLMediaElement.prototype.pause = vi.fn(function () { pauses.push(this.closest('figure').dataset.clip); });
    // In page order: the starter, then the clip player.
    w.eval(starter);
    w.eval(player);
    const doc = w.document;
    return {
      w, doc, plays, pauses, observers, idle,
      video: () => doc.querySelector('.hm-hero-clip video'),
      load: () => { state = 'complete'; w.dispatchEvent(new w.Event('load')); },
      flush: () => idle.splice(0).forEach((cb) => cb({ didTimeout: false, timeRemaining: () => 50 })),
      scroll: () => w.dispatchEvent(new w.Event('scroll')),
      see: (video, ratio) => observers.forEach((o) => o.cb([{ target: video, isIntersecting: ratio > 0, intersectionRatio: ratio }], o)),
      setHidden: (v) => { isHidden = v; doc.dispatchEvent(new w.Event('visibilitychange')); },
    };
  }

  it('starts the hero after the load event and an idle moment, with no scroll', () => {
    const p = page();
    expect(p.plays).toEqual([]);
    expect(p.idle).toHaveLength(0);
    p.load();
    expect(p.plays).toEqual([]);
    expect(p.idle).toHaveLength(1);
    p.flush();
    expect(p.plays).toEqual(['hero-montage']);
    // The feature clips still wait for the first scroll.
    expect(p.observers.flatMap((o) => o.targets)).toHaveLength(0);
  });

  it('starts at once when the page has already loaded', () => {
    const p = page({ loaded: true });
    expect(p.idle).toHaveLength(1);
    p.flush();
    expect(p.plays).toEqual(['hero-montage']);
  });

  it('falls back to a short timer without requestIdleCallback', async () => {
    const p = page({ idleApi: false });
    p.load();
    expect(p.plays).toEqual([]);
    await new Promise((r) => setTimeout(r, 450));
    expect(p.plays).toEqual(['hero-montage']);
  });

  it('never starts early with reduced motion, and the player never starts it either', () => {
    const p = page({ reduce: true });
    p.load();
    p.flush();
    p.scroll();
    expect(p.idle).toHaveLength(0);
    expect(p.observers).toHaveLength(0);
    expect(p.plays).toEqual([]);
  });

  it('never plays with Save-Data: the hero becomes its still poster', () => {
    const p = page({ saveData: true });
    expect(p.video()).toBeNull();
    const still = p.doc.querySelector('.hm-hero-clip img.hm-hero-still');
    expect(still.getAttribute('src')).toBe('/assets/clips/en/hero-montage.jpg');
    expect(still.getAttribute('alt')).toBe('A quick tour');
    expect([still.getAttribute('width'), still.getAttribute('height')]).toEqual(['1440', '900']);
    expect(p.doc.querySelector('.hm-hero-clip source')).toBeNull();
    p.load();
    p.flush();
    p.scroll();
    expect(p.observers.flatMap((o) => o.targets).map((t) => t.closest('figure').dataset.clip)).toEqual(['trackers']);
    expect(p.plays).toEqual([]);
  });

  it('treats saveData false like any other visit', () => {
    const p = page({ saveData: false });
    p.load();
    p.flush();
    expect(p.plays).toEqual(['hero-montage']);
  });

  it('leaves phones to the scroll rule: the hero sits under the price card', () => {
    const p = page({ phone: true });
    p.load();
    p.flush();
    expect(p.idle).toHaveLength(0);
    expect(p.plays).toEqual([]);
    p.scroll();
    const targets = p.observers.flatMap((o) => o.targets);
    expect(targets).toContain(p.video());
    p.see(p.video(), 0.6);
    expect(p.plays).toEqual(['hero-montage']);
    p.see(p.video(), 0.1);
    expect(p.pauses).toContain('hero-montage');
  });

  it('waits for a hidden tab, starts when it shows, pauses when it hides', () => {
    const p = page({ hidden: true });
    p.load();
    p.flush();
    expect(p.plays).toEqual([]);
    p.setHidden(false);
    expect(p.plays).toEqual(['hero-montage']);
    p.setHidden(true);
    expect(p.pauses).toContain('hero-montage');
  });

  it('leaves a page the visitor has already scrolled to the clip player', () => {
    const p = page();
    Object.defineProperty(p.w, 'scrollY', { configurable: true, value: 600 });
    p.load();
    p.flush();
    expect(p.plays).toEqual([]);
  });

  it('reports the first hero play once, as clip_play hero-montage', () => {
    const p = page();
    p.video().dispatchEvent(new p.w.Event('playing'));
    p.video().dispatchEvent(new p.w.Event('playing'));
    expect(p.w.gm.mock.calls.filter(([name]) => name === 'clip_play')).toEqual([
      ['clip_play', { page_version: 'homepage-en-20261002', clip: 'hero-montage' }],
    ]);
  });
});
