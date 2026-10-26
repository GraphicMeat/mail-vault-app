/**
 * E2E: click a word of the App window shot to redact or reveal it, in the real
 * webview.
 *
 * The shot masks the live UI itself (React fields, the reader frame), so the
 * user's clicked words have to reach those passes, and the hit map is measured
 * on the live UI. jsdom lays nothing out: only the real webview shows that the
 * map has real rects, that a masked word reads back under its original's key,
 * and that show / hide marks change what the shot masks.
 *
 * Every value an assertion reads is logged as one `[clickapp]` JSON line.
 */

import { waitForApp, waitForEmails } from './helpers.js';
import { SENDER_AUTH_SUBJECT } from './mockImap.js';

const log = (tag, value) => console.log(`[clickapp] ${tag} ${JSON.stringify(value)}`);
const SENDER_NAME = 'Verified Sender';

describe('Social export: click a word of the App window shot', function () {
  this.timeout(240_000);

  before(async function () {
    await waitForApp();
    await waitForEmails();
    await browser.waitUntil(() => browser.execute(() => typeof window.__MV_CAPTURE_APP__ === 'function'),
      { timeout: 30_000, interval: 250, timeoutMsg: 'capture hook never loaded' });
    const clickRow = () => browser.execute((subject) => {
      const row = [...document.querySelectorAll('[data-testid="email-row"]')]
        .find(r => r.offsetHeight > 0 && (r.innerText || '').includes(subject));
      if (!row) return false;
      row.click();
      return true;
    }, SENDER_AUTH_SUBJECT);
    const named = () => browser.execute((name) => {
      const header = document.querySelector('[data-testid="sender-header"]');
      return !!header && (header.innerText || '').includes(name);
    }, SENDER_NAME);
    await browser.waitUntil(async () => clickRow(), { timeout: 60_000, interval: 1000, timeoutMsg: 'fixture row never appeared' });
    await browser.waitUntil(async () => {
      if (await named()) return true;
      await clickRow();
      return false;
    }, { timeout: 45_000, interval: 1000, timeoutMsg: 'the viewer header never named the fixture sender' });
    await browser.pause(2500);
  });

  // One shot with the hit map: the marks go in as the sets a dictionary carries.
  const shot = (marks = {}) => browser.executeAsync((marks, done) => {
    (async () => {
      const dict = {
        fullNames: new Set(), tokens: new Set(), unspaced: new Set(), unspacedMax: 0, size: 0,
        show: new Set(marks.show || []), hide: new Set(marks.hide || []), ...(marks.detect === false ? { detect: false } : {}),
      };
      const canvas = await window.__MV_CAPTURE_APP__({ redact: true, dict, wantWords: true });
      done({
        w: canvas.width, h: canvas.height, text: window.__MV_CAPTURE_TEXT__(),
        words: (canvas.mvWords || []).map(w => ({ k: w.k, on: w.on, rects: w.rects })),
      });
    })().catch(e => done({ error: String(e?.message || e) }));
  }, marks);

  const states = (r, k) => r.words.filter(w => w.k === k).map(w => w.on);

  it('maps real words with rects inside the picture, and a masked name reads back as on under its own words', async function () {
    const r = await shot();
    log('map', { w: r.w, h: r.h, words: r.words.length, verified: states(r, 'verified'), sender: states(r, 'sender') });
    expect(r.error).toBeUndefined();
    expect(r.words.length).toBeGreaterThan(20);
    for (const w of r.words) {
      for (const [x, y, rw, rh] of w.rects) {
        expect(rw).toBeGreaterThan(0);
        expect(rh).toBeGreaterThan(0);
        expect(x).toBeGreaterThanOrEqual(-1);
        expect(y).toBeGreaterThanOrEqual(-1);
        expect(x + rw).toBeLessThanOrEqual(r.w + 1);
        expect(y + rh).toBeLessThanOrEqual(r.h + 1);
      }
    }
    // The sender's name is masked on screen, and the map still knows which words it hides.
    expect(r.text).not.toContain(SENDER_NAME);
    expect(states(r, 'verified').length).toBeGreaterThan(0);
    expect(states(r, 'verified').every(Boolean)).toBe(true);
    expect(states(r, 'sender').every(Boolean)).toBe(true);
  });

  it('show reveals the words everywhere on screen, and the map reads them as readable', async function () {
    const r = await shot({ show: ['verified', 'sender'] });
    log('show', { verified: states(r, 'verified'), sender: states(r, 'sender') });
    expect(r.error).toBeUndefined();
    expect(r.text).toContain(SENDER_NAME);
    expect(states(r, 'verified').length).toBeGreaterThan(0);
    expect(states(r, 'verified').every(on => !on)).toBe(true);
    // Back to masked once the shot is over: the marks lived for the capture alone.
    const after = await shot();
    expect(after.text).not.toContain(SENDER_NAME);
  });

  it('hide masks a readable word of the UI everywhere it appears', async function () {
    const plain = await shot();
    const pick = plain.words.find(w => !w.on && /^[a-z]{5,}$/.test(w.k) && w.k !== 'verified');
    log('pick', pick?.k);
    expect(pick).toBeTruthy();
    const r = await shot({ hide: [pick.k] });
    log('hide', { k: pick.k, states: states(r, pick.k) });
    expect(states(r, pick.k).length).toBeGreaterThan(0);
    expect(states(r, pick.k).every(Boolean)).toBe(true);
    // And the shot itself no longer holds the word anywhere (the clone is what is drawn).
    expect(r.text).not.toMatch(new RegExp(`\\b${pick.k}\\b`, 'i'));
    // The rest of the shot keeps its masks.
    expect(r.text).not.toContain(SENDER_NAME);
  });

  it('with the redact box off (detect:false) only the hide words are masked', async function () {
    const plain = await shot();
    const pick = plain.words.find(w => !w.on && /^[a-z]{5,}$/.test(w.k) && w.k !== 'verified');
    const r = await shot({ detect: false, hide: [pick.k] });
    log('detect-off', { k: pick.k, picked: states(r, pick.k), verified: states(r, 'verified') });
    expect(states(r, pick.k).every(Boolean)).toBe(true);
    expect(r.text).not.toMatch(new RegExp(`\\b${pick.k}\\b`, 'i'));
    // Nothing was detected: the name reads as it is.
    expect(r.text).toContain(SENDER_NAME);
    expect(states(r, 'verified').every(on => !on)).toBe(true);
  });
});
