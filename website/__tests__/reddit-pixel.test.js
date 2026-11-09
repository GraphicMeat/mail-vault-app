import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve('website');
const site = readFileSync(resolve(root, 'assets/english-site.js'), 'utf8');
const pixel = readFileSync(resolve(root, 'assets/reddit-pixel.js'), 'utf8');
const sessions = [];

// A visit on `search`; english-site.js decides whether the loader is injected, and the test then
// runs reddit-pixel.js itself (jsdom does not fetch scripts).
function visit(file, search = '', { gpc, sessionAd, choice } = {}) {
  const dom = new JSDOM(readFileSync(resolve(root, file), 'utf8'), { url: 'https://mailvaultapp.com/' + file + search, runScripts: 'outside-only' });
  sessions.push(dom);
  const w = dom.window;
  w.matchMedia = () => ({ matches: false });
  w.fetch = vi.fn().mockRejectedValue(new Error('offline'));
  w.AbortSignal.timeout = () => undefined;
  w.navigator.sendBeacon = vi.fn();
  if (gpc !== undefined) Object.defineProperty(w.navigator, 'globalPrivacyControl', { configurable: true, value: gpc });
  if (sessionAd) w.sessionStorage.setItem('mv-reddit-ad', '1');
  if (choice) w.localStorage.setItem('mv-reddit-consent', choice);
  w.eval(site);
  const loader = () => w.document.querySelector('script[src^="/assets/reddit-pixel.js"]');
  const run = () => w.eval(pixel);
  const bar = () => w.document.querySelector('.mv-adconsent');
  const pixelScript = () => w.document.querySelector('script[src^="https://www.redditstatic.com/ads/pixel.js"]');
  return { w, loader, run, bar, pixelScript };
}
afterEach(() => { sessions.splice(0).forEach(d => d.window.close()); });

describe('Reddit pixel stays out of everyone but consenting ad arrivals', () => {
  it('does not even fetch the loader for an ordinary visit', () => {
    expect(visit('index.html').loader()).toBeNull();
    expect(visit('pricing.html', '?utm_source=newsletter').loader()).toBeNull();
    expect(visit('index.html', '?utm_source=reddit').loader()).toBeNull(); // organic post, no paid medium
  });

  it('fetches the loader for a Reddit ad click id or a paid reddit utm', () => {
    expect(visit('index.html', '?rdt_cid=abc').loader()).not.toBeNull();
    expect(visit('index.html', '?utm_source=Reddit&utm_medium=paid_social').loader()).not.toBeNull();
  });

  it('keeps the ad visit flagged on the next page of the same session', () => {
    const first = visit('index.html', '?rdt_cid=abc');
    expect(first.w.sessionStorage.getItem('mv-reddit-ad')).toBe('1');
    expect(visit('pricing.html', '', { sessionAd: true }).loader()).not.toBeNull();
  });

  it('shows the bar and loads nothing from Reddit until Accept', () => {
    const v = visit('index.html', '?rdt_cid=abc');
    v.run();
    expect(v.bar()).not.toBeNull();
    expect(v.w.rdt).toBeUndefined();
    expect(v.pixelScript()).toBeNull();
    v.bar().querySelector('[data-choice="granted"]').click();
    expect(v.bar()).toBeNull();
    expect(v.pixelScript().src).toBe('https://www.redditstatic.com/ads/pixel.js?pixel_id=a2_jyqdj6oz5zbw');
    expect(Array.from(v.w.rdt.callQueue, a => Array.from(a))).toEqual([['init', 'a2_jyqdj6oz5zbw'], ['track', 'PageVisit']]);
    expect(v.w.localStorage.getItem('mv-reddit-consent')).toBe('granted');
  });

  it('remembers No thanks and never loads the pixel', () => {
    const v = visit('index.html', '?rdt_cid=abc');
    v.run();
    v.bar().querySelector('[data-choice="denied"]').click();
    expect(v.bar()).toBeNull();
    expect(v.w.rdt).toBeUndefined();
    const next = visit('pricing.html', '', { sessionAd: true, choice: 'denied' });
    next.run();
    expect(next.bar()).toBeNull();
    expect(next.w.rdt).toBeUndefined();
  });

  it('loads silently on a later page of the session once accepted', () => {
    const v = visit('pricing.html', '', { sessionAd: true, choice: 'granted' });
    v.run();
    expect(v.bar()).toBeNull();
    expect(v.pixelScript()).not.toBeNull();
  });

  it('treats Global Privacy Control as a refusal without asking', () => {
    const v = visit('index.html', '?rdt_cid=abc', { gpc: true });
    v.run();
    expect(v.bar()).toBeNull();
    expect(v.w.rdt).toBeUndefined();
    expect(v.w.localStorage.getItem('mv-reddit-consent')).toBe('denied');
  });

  it('never loads for a non-ad session even with a stored acceptance', () => {
    const v = visit('index.html', '', { choice: 'granted' });
    v.run();
    expect(v.bar()).toBeNull();
    expect(v.w.rdt).toBeUndefined();
  });

  it('withdraws from the privacy page: remembers the refusal and drops Reddit cookies', () => {
    const v = visit('privacy.html', '', { choice: 'granted' });
    expect(v.loader()).not.toBeNull(); // the withdraw button needs the file
    v.w.document.cookie = '_rdt_uuid=123; path=/';
    v.w.document.cookie = 'keep=1; path=/';
    v.run();
    v.w.document.querySelector('[data-ad-consent-reset]').click();
    expect(v.w.localStorage.getItem('mv-reddit-consent')).toBe('denied');
    expect(v.w.document.cookie).not.toContain('_rdt_uuid');
    expect(v.w.document.cookie).toContain('keep=1');
    expect(v.w.document.querySelector('[data-ad-consent-status]').textContent).toMatch(/off/i);
    expect(v.bar()).toBeNull();
  });

  it('keeps the policy honest about the pixel', () => {
    const html = readFileSync(resolve(root, 'privacy.html'), 'utf8');
    expect(html).toContain('id="advertising"');
    expect(html).toMatch(/Reddit Pixel/);
    expect(html).not.toMatch(/\(no Google Analytics, no tracking pixels\)/);
    expect(html).toContain('data-ad-consent-reset');
  });
});
