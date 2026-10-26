/**
 * E2E: click a word of a social card to redact or reveal it, in the real webview.
 *
 * Unit tests mock the rasterizer, and jsdom lays nothing out. Only WKWebView
 * (or WebView2) shows that the hit map is real: every word of the redacted
 * card has a rect inside the canvas, a masked word keeps its mask's place, and
 * a show / hide mark changes the pixels where that word sits and nowhere the
 * mark did not name.
 *
 * Every value an assertion reads is logged as one `[clickredact]` JSON line.
 */

import { waitForApp, waitForEmails } from './helpers.js';

const log = (tag, value) => console.log(`[clickredact] ${tag} ${JSON.stringify(value)}`);

const MESSAGE = {
  uid: 515151,
  subject: 'Project Falcon update for Mia Example',
  from: { name: 'Parcel Desk', address: 'parcel@prize-mail.example' },
  to: [{ name: 'Mia Example', address: 'mia@recipient.example' }],
  date: '2026-09-28T23:42:00Z',
  html: '<div style="padding:24px"><p>Dear Mia Example, the Falcon launch moved to Friday.</p>'
    + '<p>Questions? Reply to parcel@prize-mail.example.</p></div>',
};

describe('Social export: click a word to redact or reveal it', function () {
  this.timeout(240_000);

  before(async function () {
    await waitForApp();
    await waitForEmails();
    await browser.waitUntil(() => browser.execute(() => typeof window.__MV_SOCIAL_CONTENT__ === 'function'),
      { timeout: 30_000, interval: 250, timeoutMsg: 'social content hook never loaded' });
  });

  // Builds the card, and reads the words and the pixels under chosen words in the page.
  const card = (options, probe = []) => browser.executeAsync((message, options, probe, done) => {
    (async () => {
      const content = await window.__MV_SOCIAL_CONTENT__(
        { ...message, date: new Date(message.date) },
        { content: 'card', theme: 'light', mailTheme: 'light', ...options },
      );
      const words = (content.mvWords || []).map(w => ({ k: w.k, on: w.on, rects: w.rects }));
      const ctx = content.getContext('2d');
      const sum = (rect) => {
        const [x, y, w, h] = rect.map(Math.round);
        const data = ctx.getImageData(x, y, Math.max(1, w), Math.max(1, h)).data;
        let s = 0;
        for (let i = 0; i < data.length; i += 4) s += data[i] + data[i + 1] + data[i + 2];
        return s;
      };
      const probes = Object.fromEntries(probe.map((k) => {
        const w = words.find(x => x.k === k);
        return [k, w ? sum(w.rects[0]) : null];
      }));
      done({ w: content.width, h: content.height, words, probes });
    })().catch(e => done({ error: String(e?.message || e) }));
  }, MESSAGE, options, probe);

  const word = (r, k) => r.words.find(w => w.k === k);

  it('maps every readable word of the redacted card to a rect inside the canvas, masked ones as on', async function () {
    const r = await card({ redact: true });
    log('redacted', { w: r.w, h: r.h, words: r.words.length, mia: word(r, 'mia'), falcon: word(r, 'falcon') });
    expect(r.error).toBeUndefined();
    expect(r.words.length).toBeGreaterThan(10);
    for (const w of r.words) {
      for (const [x, y, rw, rh] of w.rects) {
        expect(rw).toBeGreaterThan(0);
        expect(rh).toBeGreaterThan(0);
        expect(x).toBeGreaterThanOrEqual(0);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(x + rw).toBeLessThanOrEqual(r.w + 1);
        expect(y + rh).toBeLessThanOrEqual(r.h + 1);
      }
    }
    // Names and the address are masked; a plain word of the body is not.
    expect(word(r, 'mia')?.on).toBe(true);
    expect(word(r, 'parcel@prize-mail.example')?.on).toBe(true);
    expect(word(r, 'friday')?.on).toBe(false);
    // The header sits above the body: the header's Mia is higher than the body's Dear.
    const headMia = word(r, 'mia').rects[0][1];
    expect(headMia).toBeLessThan(word(r, 'dear').rects[0][1]);
  });

  it('show reveals the word everywhere it appears, and paints different pixels where it sits', async function () {
    const masked = await card({ redact: true }, ['mia', 'friday']);
    const shown = await card({ redact: true, marks: { mia: 'show' } }, ['mia', 'friday']);
    log('show', { masked: masked.probes, shown: shown.probes, mia: word(shown, 'mia') });
    expect(word(shown, 'mia')?.on).toBe(false);
    // Every Mia on the card read back as readable (subject, To row and body alike).
    expect(shown.words.filter(w => w.k === 'mia').every(w => !w.on)).toBe(true);
    expect(shown.probes.mia).not.toBe(masked.probes.mia);
    // A word nobody clicked keeps its pixels, give or take layout moving it: same sum when it did not move.
    expect(word(shown, 'friday')?.on).toBe(false);
    expect(word(masked, 'mia')?.on).toBe(true);
  });

  it('hide masks a word the detector missed, with the redact box on or off', async function () {
    const plain = await card({ redact: false }, ['falcon']);
    expect(word(plain, 'falcon')?.on).toBe(false);
    const hiddenOff = await card({ redact: false, marks: { falcon: 'hide' } }, ['falcon']);
    log('hide', { plain: plain.probes, hiddenOff: hiddenOff.probes });
    expect(word(hiddenOff, 'falcon')?.on).toBe(true);
    expect(hiddenOff.probes.falcon).not.toBe(plain.probes.falcon);
    // Nothing else was detected with the box off: Mia stays readable.
    expect(word(hiddenOff, 'mia')?.on).toBe(false);
    const hiddenOn = await card({ redact: true, marks: { falcon: 'hide' } });
    expect(word(hiddenOn, 'falcon')?.on).toBe(true);
    expect(word(hiddenOn, 'mia')?.on).toBe(true);
  });

  it('hideTo leaves the To row off the card and out of the map', async function () {
    const withTo = await card({ redact: false });
    const noTo = await card({ redact: false, hideTo: true });
    log('hideTo', { withTo: withTo.h, noTo: noTo.h, to: withTo.words.filter(w => w.k === 'recipient.example').length });
    expect(noTo.h).toBeLessThan(withTo.h);
    expect(noTo.words.some(w => w.k === 'mia@recipient.example')).toBe(false);
    expect(withTo.words.some(w => w.k === 'mia@recipient.example')).toBe(true);
  });
});
