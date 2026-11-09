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
function visit(file, search = '', { gpc, sessionAd, choice, loc, conv } = {}) {
  const dom = new JSDOM(readFileSync(resolve(root, file), 'utf8'), { url: 'https://mailvaultapp.com/' + file + search, runScripts: 'outside-only' });
  sessions.push(dom);
  const w = dom.window;
  w.matchMedia = () => ({ matches: false });
  // Cloudflare's /cdn-cgi/trace: `loc` is the visitor's country; no `loc` means the lookup failed.
  w.fetch = loc ? vi.fn().mockResolvedValue({ ok: true, text: async () => 'fl=1\nloc=' + loc + '\nts=1\n' }) : vi.fn().mockRejectedValue(new Error('offline'));
  w.AbortSignal.timeout = () => undefined;
  w.navigator.sendBeacon = vi.fn();
  if (gpc !== undefined) Object.defineProperty(w.navigator, 'globalPrivacyControl', { configurable: true, value: gpc });
  if (sessionAd) w.sessionStorage.setItem('mv-reddit-ad', '1');
  if (choice) w.localStorage.setItem('mv-reddit-consent', choice);
  if (conv) w.sessionStorage.setItem('mv-reddit-conv', conv);
  w.eval(site);
  const loader = () => w.document.querySelector('script[src^="/assets/reddit-pixel.js"]');
  const run = async () => { w.eval(pixel); await new Promise(r => setTimeout(r, 0)); };
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

  it('asks inside the EEA, UK and Switzerland, and loads nothing from Reddit until Accept', async () => {
    for (const loc of ['LT', 'DE', 'GB', 'CH']) {
      const v = visit('index.html', '?rdt_cid=abc', { loc });
      await v.run();
      expect(v.bar(), loc).not.toBeNull();
      expect(v.w.rdt, loc).toBeUndefined();
      expect(v.pixelScript(), loc).toBeNull();
    }
    const v = visit('index.html', '?rdt_cid=abc', { loc: 'LT' });
    await v.run();
    v.bar().querySelector('[data-choice="granted"]').click();
    expect(v.bar()).toBeNull();
    expect(v.pixelScript().src).toBe('https://www.redditstatic.com/ads/pixel.js?pixel_id=a2_jyqdj6oz5zbw');
    expect(Array.from(v.w.rdt.callQueue, a => Array.from(a))).toEqual([['init', 'a2_jyqdj6oz5zbw'], ['track', 'PageVisit']]);
    expect(v.w.localStorage.getItem('mv-reddit-consent')).toBe('granted');
  });

  it('asks when the country is unknown or the lookup fails', async () => {
    for (const loc of [undefined, 'XX', 'T1']) {
      const v = visit('index.html', '?rdt_cid=abc', { loc });
      await v.run();
      expect(v.bar(), String(loc)).not.toBeNull();
      expect(v.w.rdt, String(loc)).toBeUndefined();
    }
  });

  it('loads straight away, with no bar, outside those regions', async () => {
    for (const loc of ['US', 'CA', 'JP']) {
      const v = visit('index.html', '?rdt_cid=abc', { loc });
      await v.run();
      expect(v.bar(), loc).toBeNull();
      expect(v.pixelScript(), loc).not.toBeNull();
      expect(Array.from(v.w.rdt.callQueue, a => Array.from(a))).toEqual([['init', 'a2_jyqdj6oz5zbw'], ['track', 'PageVisit']]);
    }
  });

  it('never loads outside those regions after the visitor turned it off, or with GPC', async () => {
    const off = visit('index.html', '?rdt_cid=abc', { loc: 'US', choice: 'denied' });
    await off.run();
    expect(off.w.rdt).toBeUndefined();
    const gpc = visit('index.html', '?rdt_cid=abc', { loc: 'US', gpc: true });
    await gpc.run();
    expect(gpc.w.rdt).toBeUndefined();
    expect(gpc.bar()).toBeNull();
    expect(gpc.w.localStorage.getItem('mv-reddit-consent')).toBe('denied');
  });

  it('remembers No thanks and never loads the pixel', async () => {
    const v = visit('index.html', '?rdt_cid=abc', { loc: 'LT' });
    await v.run();
    v.bar().querySelector('[data-choice="denied"]').click();
    expect(v.bar()).toBeNull();
    expect(v.w.rdt).toBeUndefined();
    const next = visit('pricing.html', '', { sessionAd: true, choice: 'denied', loc: 'LT' });
    await next.run();
    expect(next.bar()).toBeNull();
    expect(next.w.rdt).toBeUndefined();
  });

  it('loads silently on a later page of the session once accepted', async () => {
    const v = visit('pricing.html', '', { sessionAd: true, choice: 'granted', loc: 'LT' });
    await v.run();
    expect(v.bar()).toBeNull();
    expect(v.pixelScript()).not.toBeNull();
  });

  it('never loads for a non-ad session even with a stored acceptance', async () => {
    const v = visit('index.html', '', { choice: 'granted', loc: 'US' });
    await v.run();
    expect(v.bar()).toBeNull();
    expect(v.w.rdt).toBeUndefined();
  });

  it('reports a Lead conversion on the thank-you page, same id on reload, none elsewhere', async () => {
    const v = visit('thank-you.html', '', { sessionAd: true, loc: 'US' });
    await v.run();
    const calls = Array.from(v.w.rdt.callQueue, a => Array.from(a));
    expect(calls.map(c => c[0] + ':' + c[1])).toEqual(['init:a2_jyqdj6oz5zbw', 'track:PageVisit', 'track:Lead']);
    const id = calls[2][2].conversionId;
    expect(id).toMatch(/\S{8,}/);
    expect(v.w.sessionStorage.getItem('mv-reddit-conv')).toBe(id);
    const again = visit('thank-you.html', '', { sessionAd: true, loc: 'US', conv: id });
    await again.run();
    expect(Array.from(again.w.rdt.callQueue, a => Array.from(a))[2][2]).toEqual({ conversionId: id });
    const de = visit('de/thank-you.html', '', { sessionAd: true, loc: 'US' });
    await de.run();
    expect(Array.from(de.w.rdt.callQueue, a => a[1])).toContain('Lead');
    const home = visit('index.html', '', { sessionAd: true, loc: 'US' });
    await home.run();
    expect(Array.from(home.w.rdt.callQueue, a => a[1])).not.toContain('Lead');
  });

  it('after consent in the EEA, the thank-you page reports the conversion too', async () => {
    const v = visit('thank-you.html', '', { sessionAd: true, choice: 'granted', loc: 'LT' });
    await v.run();
    expect(Array.from(v.w.rdt.callQueue, a => a[1])).toContain('Lead');
  });

  it('withdraws from the privacy page: remembers the refusal and drops Reddit cookies', async () => {
    const v = visit('privacy.html', '', { choice: 'granted' });
    expect(v.loader()).not.toBeNull(); // the withdraw button needs the file
    v.w.document.cookie = '_rdt_uuid=123; path=/';
    v.w.document.cookie = 'keep=1; path=/';
    await v.run();
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
    expect(html).toMatch(/European Economic Area, the United Kingdom and Switzerland/);
    expect(html).toMatch(/Lead/);
    expect(html).not.toMatch(/\(no Google Analytics, no tracking pixels\)/);
    expect(html).toContain('data-ad-consent-reset');
  });
});
