import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { LOCALES, render, loadDict } from '../i18n/i18n.mjs';

// Seven short muted clips recorded in the app. English only until the owner
// approves them: the homepage section and each feature page's figure carry
// data-i18n-en-only, so no locale page gets an untranslated caption.
const CLIPS = {
  'archive-delete': 'archive-and-delete',
  'scheduled-backups': 'scheduled-backups',
  'time-capsule': 'time-capsule',
  trackers: 'email-tracker-blocking',
  'link-safety': 'link-safety',
  'undo-send': 'undo-send',
  'unified-inbox': 'unified-inbox',
};
const GROUPS = [['archive-delete', 'scheduled-backups', 'time-capsule'], ['trackers', 'link-safety', 'undo-send', 'unified-inbox']];
const load = (file) => new JSDOM(readFileSync(file, 'utf8')).window.document;
const home = load('website/index.html');
const visible = (els) => [...els].filter((el) => !el.closest('[hidden]'));

function checkFigure(figure, clip) {
  expect(figure.dataset.clip).toBe(clip);
  const video = figure.querySelector('video');
  expect(video, clip).not.toBeNull();
  for (const flag of ['muted', 'loop', 'playsinline']) expect(video.hasAttribute(flag), `${clip} ${flag}`).toBe(true);
  // No autoplay attribute: english-site.js starts a clip only once it is on screen.
  expect(video.hasAttribute('autoplay')).toBe(false);
  expect(video.getAttribute('preload')).toBe('none');
  expect(video.getAttribute('poster')).toBe(`/assets/clips/en/${clip}.jpg`);
  expect(video.getAttribute('width')).toBe('960');
  expect(video.getAttribute('height')).toBe('660');
  expect(video.getAttribute('aria-label').length).toBeGreaterThan(30);
  const sources = video.querySelectorAll('source');
  expect(sources).toHaveLength(1);
  expect(sources[0].getAttribute('src')).toBe(`/assets/clips/en/${clip}.mp4`);
  expect(sources[0].getAttribute('type')).toBe('video/mp4');
  for (const ext of ['mp4', 'jpg']) {
    const file = `website/assets/clips/en/${clip}.${ext}`;
    expect(existsSync(file), file).toBe(true);
    expect(statSync(file).size, file).toBeLessThan(260 * 1024);
  }
  const caption = figure.querySelector('figcaption');
  expect(caption.querySelector('.mv-clip-title').textContent.trim().length).toBeGreaterThan(3);
  expect(caption.querySelector('.mv-clip-text').textContent.trim()).toMatch(/\.$/);
  expect(figure.outerHTML).not.toMatch(/—|&mdash;/);
  expect(figure.querySelector('.mv-button')).toBeNull();
}

describe('homepage clips', () => {
  const section = home.getElementById('clips');

  it('sits directly after the hero', () => {
    expect(section).not.toBeNull();
    expect(home.querySelector('.hm-hero').nextElementSibling).toBe(section);
  });

  it('uses the two-line gradient heading', () => {
    const h2 = section.querySelector('h2');
    expect(h2.querySelector('br')).not.toBeNull();
    expect(h2.querySelector('.hm-grad')).not.toBeNull();
  });

  it('shows seven clips in two labelled groups', () => {
    expect(section.querySelectorAll('figure.mv-clip')).toHaveLength(7);
    const groups = section.querySelectorAll('.mv-clip-group');
    expect([...groups].map((g) => [...g.querySelectorAll('figure.mv-clip')].map((f) => f.dataset.clip))).toEqual(GROUPS);
    for (const g of groups) {
      expect(g.querySelector('.mv-eyebrow').textContent.trim()).not.toBe('');
      expect(g.querySelector('h3').textContent.trim()).not.toBe('');
    }
  });

  it.each(Object.keys(CLIPS))('%s is a muted, lazy clip with a caption', (clip) => {
    checkFigure(section.querySelector(`figure[data-clip="${clip}"]`), clip);
  });

  it.each(Object.entries(CLIPS))('%s links to /features/%s.html with its own accessible name', (clip, page) => {
    const link = section.querySelector(`figure[data-clip="${clip}"] figcaption a`);
    expect(link.getAttribute('href')).toBe(`/features/${page}.html`);
    expect(link.classList.contains('mv-text-link')).toBe(true);
    expect(link.textContent).toMatch(/^Learn more/);
  });

  it('gives every Learn more link a distinct accessible name', () => {
    const names = [...section.querySelectorAll('figcaption a')].map((a) => a.textContent.trim());
    expect(new Set(names).size).toBe(7);
  });

  it('adds no button, and no download', () => {
    expect(section.querySelector('.mv-button, button, [data-download], [data-acquisition-download]')).toBeNull();
    expect(section.textContent).not.toMatch(/—/);
  });

  it('keeps the root copy of the homepage identical', () => {
    expect(readFileSync('index.html', 'utf8')).toBe(readFileSync('website/index.html', 'utf8'));
  });

  it('marks the whole section English-only', () => {
    expect(section.hasAttribute('data-i18n-en-only')).toBe(true);
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
  const english = [...home.querySelectorAll('#clips figcaption, #clips h2, #clips h3, #clips .mv-eyebrow')].map((n) => n.textContent.replace(/\s+/g, ' ').trim());

  it.each(LOCALES.map((l) => l.dir))('%s renders no clip, no marker and no clip caption', (dir) => {
    const loc = LOCALES.find((l) => l.dir === dir);
    const dict = loadDict(loc);
    for (const rel of pages) {
      const out = render(readFileSync(`website/${rel}`, 'utf8'), rel, loc, dict);
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
