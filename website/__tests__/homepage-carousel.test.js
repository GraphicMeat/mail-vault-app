import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { existsSync, readFileSync } from 'node:fs';

// The homepage clip carousels: home-clips.js reveals the arrows, scrolls one
// card per press (no smooth scroll with reduced motion), disables an arrow at
// its end, and shows a clip over its lazy poster once it plays. Playback itself
// stays with english-site.js: its IntersectionObserver watches the viewport
// (no root), and the browser clips each card's visible area by the carousel's
// own scroll box, so a card scrolled sideways out of view reports a low ratio
// and pauses, and the card scrolled in reports a high one and plays.
// Read leniently, so each test fails on its own where the script is missing.
const CAROUSEL = 'website/assets/home-clips.js';
const carousel = existsSync(CAROUSEL) ? readFileSync(CAROUSEL, 'utf8') : '';
const player = readFileSync('website/assets/english-site.js', 'utf8');

const card = (clip, link = true) => `<figure class="mv-clip" data-clip="${clip}"${link ? '' : ' tabindex="0"'}><div class="mv-clip-media"><img class="mv-clip-poster" src="/assets/clips/en/${clip}-poster.jpg" width="640" height="440" loading="lazy" decoding="async" alt=""><video muted loop playsinline preload="none" width="960" height="660" aria-label="${clip}"><source src="/assets/clips/en/${clip}.mp4" type="video/mp4"></video></div><figcaption><strong class="mv-clip-title">${clip}</strong><span class="mv-clip-text">${clip}.</span>${link ? '<a class="mv-text-link" href="/features/x.html">Learn more</a>' : ''}</figcaption></figure>`;
const MARKUP = `<!doctype html><html lang="en"><body class="mv-site"><main>
<section id="backups" class="hm-pillar hm-clip-group"><div class="mv-wrap">
<div class="hm-carousel-head"><div class="hm-carousel-intro"><h2>Backups</h2></div>
<div class="hm-carousel-nav" hidden><button type="button" class="hm-carousel-btn" data-carousel-prev aria-controls="backups-track" aria-label="Previous clip" disabled><svg aria-hidden="true"></svg></button><button type="button" class="hm-carousel-btn" data-carousel-next aria-controls="backups-track" aria-label="Next clip"><svg aria-hidden="true"></svg></button></div></div>
<div class="hm-carousel-track" id="backups-track" role="region" aria-roledescription="carousel" aria-label="Backup clips" tabindex="0">${card('archive-delete')}${card('scheduled-backups')}${card('snooze', false)}</div>
</div></section>
</main></body></html>`;

describe('clip carousel', () => {
  const sessions = [];
  afterEach(() => { sessions.splice(0).forEach((d) => d.window.close()); });

  function page({ reduce = false, scrollWidth = 2400, clientWidth = 1000, observer = true } = {}) {
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
    const doc = w.document;
    const track = doc.getElementById('backups-track');
    // jsdom has no layout: the track reports the sizes a 1000 px wide carousel would.
    let left = 0;
    Object.defineProperty(track, 'scrollLeft', { configurable: true, get: () => left, set: (v) => { left = v; } });
    Object.defineProperty(track, 'scrollWidth', { configurable: true, get: () => scrollWidth });
    Object.defineProperty(track, 'clientWidth', { configurable: true, get: () => clientWidth });
    track.scrollBy = vi.fn();
    w.eval(carousel);
    w.eval(player);
    const [prev, next] = [doc.querySelector('[data-carousel-prev]'), doc.querySelector('[data-carousel-next]')];
    const scrollTo = (x) => { left = x; track.dispatchEvent(new w.Event('scroll')); };
    const videos = [...doc.querySelectorAll('video')];
    const see = (video, ratio) => observers.forEach((o) => o.cb([{ target: video, isIntersecting: ratio > 0, intersectionRatio: ratio }], o));
    return { w, doc, track, prev, next, scrollTo, videos, see, observers, plays, pauses, nav: doc.querySelector('.hm-carousel-nav'), scrollPage: () => w.dispatchEvent(new w.Event('scroll')) };
  }

  it('shows the arrows once the script runs: previous disabled at the start, next enabled', () => {
    const p = page();
    expect(p.nav.hidden).toBe(false);
    expect(p.prev.disabled).toBe(true);
    expect(p.next.disabled).toBe(false);
  });

  it('disables next at the end and enables previous, and back again at the start', () => {
    const p = page();
    p.scrollTo(700);
    expect([p.prev.disabled, p.next.disabled]).toEqual([false, false]);
    p.scrollTo(1400);
    expect([p.prev.disabled, p.next.disabled]).toEqual([false, true]);
    p.scrollTo(0);
    expect([p.prev.disabled, p.next.disabled]).toEqual([true, false]);
  });

  it('moves focus to the other arrow when the focused one hits its end', () => {
    const p = page();
    p.next.focus();
    expect(p.doc.activeElement).toBe(p.next);
    p.scrollTo(1400);
    expect(p.next.disabled).toBe(true);
    expect(p.doc.activeElement).toBe(p.prev);
  });

  it('scrolls by one card per press, smoothly', () => {
    const p = page();
    p.next.click();
    expect(p.track.scrollBy).toHaveBeenCalledTimes(1);
    const [{ left, behavior }] = p.track.scrollBy.mock.calls[0];
    expect(left).toBeGreaterThan(0);
    expect(behavior).toBe('smooth');
    p.scrollTo(700);
    p.prev.click();
    expect(p.track.scrollBy.mock.calls[1][0].left).toBeLessThan(0);
  });

  it('jumps without smooth scrolling for reduced motion', () => {
    const p = page({ reduce: true });
    p.next.click();
    expect(p.track.scrollBy.mock.calls[0][0].behavior).toBe('auto');
  });

  it('keeps the arrows hidden when every card already fits', () => {
    const p = page({ scrollWidth: 1000, clientWidth: 1000 });
    expect(p.nav.hidden).toBe(true);
  });

  it('plays the card in view and pauses it once it is scrolled sideways out of view', () => {
    const p = page();
    p.scrollPage();
    // One observer, on the viewport: no carousel root of its own to race with.
    expect(p.observers).toHaveLength(1);
    expect(p.observers[0].options?.root ?? null).toBeNull();
    expect(p.observers[0].targets).toEqual(p.videos);
    // The first card fills the carousel; the next one peeks in at 40%.
    p.see(p.videos[0], 1);
    p.see(p.videos[1], 0.4);
    expect(p.plays).toEqual(['archive-delete']);
    // One card to the right: the first is mostly out of the scroll box now.
    p.scrollTo(700);
    p.see(p.videos[0], 0.3);
    p.see(p.videos[1], 0.95);
    expect(p.pauses).toContain('archive-delete');
    expect(p.plays).toEqual(['archive-delete', 'scheduled-backups']);
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

  it('still reports the first play of each clip once', () => {
    const p = page();
    p.videos[0].dispatchEvent(new p.w.Event('playing'));
    p.videos[0].dispatchEvent(new p.w.Event('playing'));
    expect(p.w.gm.mock.calls.filter(([name]) => name === 'clip_play')).toEqual([
      ['clip_play', { page_version: 'homepage-en-20261002', clip: 'archive-delete' }],
    ]);
  });

  it('leaves the cards alone without IntersectionObserver: nothing plays, the arrows still work', () => {
    const p = page({ observer: false });
    p.scrollPage();
    expect(p.plays).toEqual([]);
    p.next.click();
    expect(p.track.scrollBy).toHaveBeenCalledTimes(1);
  });
});
