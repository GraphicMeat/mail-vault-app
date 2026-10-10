import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

// Every clip has a dark cut (<clip>.mp4, <clip>-poster.jpg, <clip>.jpg) and a light cut
// beside it (<clip>.light.mp4, <clip>-poster.light.jpg, <clip>.light.jpg). The site's
// theme is the `dark` class on <html> (the bar's toggle flips it), which no media
// query can see, so english-site.js picks the cut itself: at load, and again whenever
// the class changes. The hero sits on a dark band in either theme and keeps its clip.
const source = readFileSync('website/assets/english-site.js', 'utf8');

const MARKUP = `<!doctype html><html lang="en"><body class="mv-site"><button class="mv-theme" aria-label="Switch color theme"></button><main>
<section class="hm-hero hm-dark"><figure class="mv-clip hm-hero-clip" data-clip="hero-montage"><div class="mv-clip-media"><video muted loop playsinline preload="none" poster="/assets/clips/en/hero-montage.jpg"><source src="/assets/clips/en/hero-montage.mp4" type="video/mp4"></video></div></figure></section>
<div class="hm-clip-group"><figure class="mv-clip" data-clip="trackers"><div class="mv-clip-media"><img class="mv-clip-poster" src="/assets/clips/en/trackers-poster.jpg" loading="lazy" alt=""><video muted loop playsinline preload="none"><source src="/assets/clips/en/trackers.mp4" type="video/mp4"></video></div></figure></div>
<figure class="mv-clip" data-clip="undo-send"><div class="mv-clip-media"><video muted loop playsinline preload="none" poster="/assets/clips/en/undo-send.jpg"><source src="/assets/clips/en/undo-send.mp4" type="video/mp4"></video></div></figure>
</main></body></html>`;

const sessions = [];
afterEach(() => { sessions.splice(0).forEach((d) => d.window.close()); });

function page({ dark = false, stored } = {}) {
  const dom = new JSDOM(MARKUP, { url: 'https://mailvaultapp.com/', runScripts: 'outside-only', pretendToBeVisual: true });
  sessions.push(dom);
  const w = dom.window;
  if (stored) w.localStorage.theme = stored;
  w.matchMedia = (q) => ({ matches: dark && /prefers-color-scheme:\s*dark/.test(q) });
  w.fetch = vi.fn().mockRejectedValue(new Error('offline'));
  w.AbortSignal.timeout = () => undefined;
  w.navigator.sendBeacon = vi.fn();
  w.gm = vi.fn();
  const observers = [];
  w.IntersectionObserver = class {
    constructor(cb) { this.cb = cb; observers.push(this); }
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  const calls = [];
  w.HTMLMediaElement.prototype.load = vi.fn(function () { calls.push(['load', this.closest('figure').dataset.clip]); });
  w.HTMLMediaElement.prototype.play = vi.fn(function () { calls.push(['play', this.closest('figure').dataset.clip]); return Promise.resolve(); });
  w.HTMLMediaElement.prototype.pause = vi.fn();
  w.eval(source);
  const doc = w.document;
  const card = (clip) => doc.querySelector(`figure[data-clip="${clip}"]`);
  const src = (clip) => card(clip).querySelector('source').getAttribute('src');
  const poster = (clip) => card(clip).querySelector('video').getAttribute('poster');
  const still = (clip) => card(clip).querySelector('img.mv-clip-poster')?.getAttribute('src');
  const toggle = async () => { doc.querySelector('.mv-theme').click(); await new Promise((r) => setTimeout(r, 0)); };
  return { w, doc, calls, card, src, poster, still, toggle, observers };
}

describe('clip themes', () => {
  it('a dark visitor keeps the dark cuts and loads nothing new', () => {
    const p = page({ dark: true });
    expect(p.doc.documentElement.classList.contains('dark')).toBe(true);
    expect(p.src('trackers')).toBe('/assets/clips/en/trackers.mp4');
    expect(p.still('trackers')).toBe('/assets/clips/en/trackers-poster.jpg');
    expect(p.src('undo-send')).toBe('/assets/clips/en/undo-send.mp4');
    expect(p.poster('undo-send')).toBe('/assets/clips/en/undo-send.jpg');
    expect(p.calls.filter(([k]) => k === 'load')).toEqual([]);
  });

  it('a light visitor gets the light cut of every clip and poster before anything plays', () => {
    const p = page({ dark: false });
    expect(p.doc.documentElement.classList.contains('dark')).toBe(false);
    expect(p.src('trackers')).toBe('/assets/clips/en/trackers.light.mp4');
    expect(p.still('trackers')).toBe('/assets/clips/en/trackers-poster.light.jpg');
    expect(p.src('undo-send')).toBe('/assets/clips/en/undo-send.light.mp4');
    expect(p.poster('undo-send')).toBe('/assets/clips/en/undo-send.light.jpg');
    expect(p.calls.filter(([k]) => k === 'play')).toEqual([]);
  });

  it('a stored theme overrules the system one', () => {
    expect(page({ dark: true, stored: 'light' }).src('trackers')).toBe('/assets/clips/en/trackers.light.mp4');
    expect(page({ dark: false, stored: 'dark' }).src('trackers')).toBe('/assets/clips/en/trackers.mp4');
  });

  it('leaves the hero on its dark clip in either theme', () => {
    const p = page({ dark: false });
    expect(p.src('hero-montage')).toBe('/assets/clips/en/hero-montage.mp4');
    expect(p.poster('hero-montage')).toBe('/assets/clips/en/hero-montage.jpg');
    return p.toggle().then(() => {
      expect(p.src('hero-montage')).toBe('/assets/clips/en/hero-montage.mp4');
      expect(p.poster('hero-montage')).toBe('/assets/clips/en/hero-montage.jpg');
    });
  });

  it('flipping the toggle swaps every cut and poster, both ways', async () => {
    const p = page({ dark: false });
    await p.toggle();
    expect(p.doc.documentElement.classList.contains('dark')).toBe(true);
    expect(p.src('trackers')).toBe('/assets/clips/en/trackers.mp4');
    expect(p.still('trackers')).toBe('/assets/clips/en/trackers-poster.jpg');
    expect(p.poster('undo-send')).toBe('/assets/clips/en/undo-send.jpg');
    await p.toggle();
    expect(p.src('trackers')).toBe('/assets/clips/en/trackers.light.mp4');
    expect(p.still('trackers')).toBe('/assets/clips/en/trackers-poster.light.jpg');
    expect(p.poster('undo-send')).toBe('/assets/clips/en/undo-send.light.jpg');
  });

  it('reloads the clip it swapped, and plays it again only when it was playing', async () => {
    const p = page({ dark: false });
    const [, undo] = [...p.doc.querySelectorAll('.mv-clip video')].filter((v) => !v.closest('.hm-hero-clip'));
    Object.defineProperty(undo, 'paused', { value: false, configurable: true });
    await p.toggle();
    expect(p.calls).toContainEqual(['load', 'undo-send']);
    expect(p.calls).toContainEqual(['play', 'undo-send']);
    expect(p.calls).not.toContainEqual(['play', 'trackers']);
  });

  it('shows the poster again until the swapped clip plays', async () => {
    const p = page({ dark: false });
    const card = p.card('trackers');
    card.classList.add('is-live');
    await p.toggle();
    expect(card.classList.contains('is-live')).toBe(false);
    card.querySelector('video').dispatchEvent(new p.w.Event('playing'));
    expect(card.classList.contains('is-live')).toBe(true);
  });

  it('does not touch a card that is already on the right cut', async () => {
    const p = page({ dark: false });
    const before = p.calls.length;
    p.w.document.documentElement.classList.add('x');
    await new Promise((r) => setTimeout(r, 0));
    expect(p.calls.length).toBe(before);
    expect(p.src('trackers')).toBe('/assets/clips/en/trackers.light.mp4');
  });
});

// The player asks for <name>.light.<ext> for every card, so each dark file needs its light twin
// of the same size and weight class, or a light visitor gets a 404 where a clip should play.
import { existsSync, readdirSync, statSync } from 'node:fs';
const DIR = 'website/assets/clips/en';
const jpegSize = (file) => {
  const b = readFileSync(file);
  for (let i = 2; i < b.length - 9;) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m >= 0xc0 && m <= 0xc3) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
    i += 2 + b.readUInt16BE(i + 2);
  }
  return [0, 0];
};
const CARDS = existsSync(DIR)
  ? readdirSync(DIR).filter((f) => /^[a-z0-9-]+\.mp4$/.test(f) && f !== 'hero-montage.mp4').map((f) => f.replace('.mp4', ''))
  : [];

describe('light clip files', () => {
  it('there are cards to check', () => { expect(CARDS.length).toBeGreaterThanOrEqual(29); });
  it.each(CARDS)('%s: a light clip, card still and feature-page still beside the dark ones', (clip) => {
    const mp4 = `${DIR}/${clip}.light.mp4`, still = `${DIR}/${clip}-poster.light.jpg`, page = `${DIR}/${clip}.light.jpg`;
    for (const f of [mp4, still, page]) expect(existsSync(f), f).toBe(true);
    expect(statSync(mp4).size).toBeLessThan(260 * 1024);
    expect(statSync(still).size).toBeLessThan(45 * 1024);
    expect(jpegSize(still)).toEqual(jpegSize(`${DIR}/${clip}-poster.jpg`));
    expect(jpegSize(page)).toEqual(jpegSize(`${DIR}/${clip}.jpg`));
  });
});
