/**
 * E2E: the social card renders its header and body in their own themes, in
 * the real webview.
 *
 * Unit tests mock the rasterizer and never run Dark Reader. Only WKWebView
 * (or WebView2) shows that a dark body frame really runs the nonced Dark
 * Reader tags under its CSP and comes out dark, that the header and body
 * stack, and how long the PNG encode holds the main thread.
 *
 * Every value an assertion reads is logged as one `[socialcard]` JSON line.
 */

import { waitForApp } from './helpers.js';

const log = (tag, value) => console.log(`[socialcard] ${tag} ${JSON.stringify(value)}`);

const BODY = '<div style="background:#ffffff;color:#111111;padding:24px">'
  + '<p>Hello there, this is a plain light email body with enough text to fill a few lines of the card.</p>'.repeat(6)
  + '</div>';

describe('Social card: Appearance and Email content themes', function () {
  this.timeout(180_000);

  before(async function () {
    await waitForApp();
    await browser.waitUntil(() => browser.execute(() => typeof window.__MV_SOCIAL_CARD__ === 'function'),
      { timeout: 30_000, interval: 250, timeoutMsg: 'social card hook never loaded' });
  });

  const render = (appearance, mail) => browser.executeAsync((body, appearance, mail, done) => {
    (async () => {
      const message = { subject: 'Theme probe', from: { name: 'Probe', address: 'probe@example.com' }, to: [{ address: 'me@example.com' }], date: new Date('2026-09-28T23:42:00Z') };
      const started = performance.now();
      const canvas = await window.__MV_SOCIAL_CARD__({ message, bodyHtml: body, appearance, mail, palette: 'indigo' });
      const ms = Math.round(performance.now() - started);
      const ctx = canvas.getContext('2d');
      // Mean luminance of a strip: the header's top rows, the body's middle.
      const lum = (y0, h) => {
        const d = ctx.getImageData(0, y0, canvas.width, h).data;
        let sum = 0;
        for (let i = 0; i < d.length; i += 4) sum += (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
        return +(sum / (d.length / 4)).toFixed(3);
      };
      done({ ms, w: canvas.width, h: canvas.height, head: lum(4, 16), body: lum(Math.round(canvas.height * 0.7), 16) });
    })().catch(e => done({ error: String(e?.message || e) }));
  }, BODY, appearance, mail);

  // Cold first: the first render pays warmup. A main-thread ticker records the
  // longest gap while it runs, which is how long the UI could not respond.
  it('logs how long a cold card render and an app capture hold the main thread', async function () {
    const r = await browser.executeAsync((body, done) => {
      (async () => {
        const watch = async (fn) => {
          let last = performance.now(); let longest = 0; let ticking = true;
          const tick = () => { const now = performance.now(); longest = Math.max(longest, now - last); last = now; if (ticking) setTimeout(tick, 0); };
          setTimeout(tick, 0);
          const t0 = performance.now();
          await fn();
          ticking = false;
          return { ms: Math.round(performance.now() - t0), longestMainGapMs: Math.round(longest) };
        };
        const message = { subject: 'Cold probe', from: { name: 'Probe', address: 'probe@example.com' }, to: [], date: new Date() };
        const card = await watch(() => window.__MV_SOCIAL_CARD__({ message, bodyHtml: body, appearance: 'light', mail: 'light', palette: 'indigo' }));
        const app = typeof window.__MV_CAPTURE_APP__ === 'function' ? await watch(() => window.__MV_CAPTURE_APP__({ redact: false, dict: null })) : null;
        done({ card, app });
      })().catch(e => done({ error: String(e?.message || e) }));
    }, BODY);
    log('main-thread', r);
    expect(r.error).toBeUndefined();
  });

  for (const [appearance, mail] of [['light', 'light'], ['dark', 'light'], ['light', 'dark'], ['dark', 'dark']]) {
    it(`renders a ${appearance} header over a ${mail} body`, async function () {
      const r = await render(appearance, mail);
      log(`${appearance}/${mail}`, r);
      expect(r.error).toBeUndefined();
      expect(r.w).toBeGreaterThan(1000);
      // The body strip crosses lines of text, so a light body reads ~0.8, a dark one ~0.25.
      if (appearance === 'dark') expect(r.head).toBeLessThan(0.3); else expect(r.head).toBeGreaterThan(0.85);
      if (mail === 'dark') expect(r.body).toBeLessThan(0.4); else expect(r.body).toBeGreaterThan(0.7);
    });
  }

  it('renders light/light again after the dark ones (timing control, logged only)', async function () {
    const r = await render('light', 'light');
    log('light/light again', r);
    expect(r.error).toBeUndefined();
  });

  // The finished picture: a tall card at 16:9 on sunset with the lockup. Logged
  // as a JPEG so the run log carries it out for a human to look at.
  it('composes a tall card whole at 16:9 with the lockup', async function () {
    const r = await browser.executeAsync((body, done) => {
      (async () => {
        const { composeSocialImage, loadWatermark, sizes } = window.__MV_SOCIAL_COMPOSE__;
        const message = { subject: 'Your account has been disabled', from: { name: 'Probe', address: 'probe@example.com' }, to: [{ address: 'me@example.com' }], date: new Date('2026-09-28T23:42:00Z') };
        const content = await window.__MV_SOCIAL_CARD__({ message, bodyHtml: body.repeat(5), appearance: 'light', mail: 'light', palette: 'indigo' });
        const watermark = await loadWatermark();
        const out = composeSocialImage({ content, size: sizes.landscape, background: { type: 'gradient', id: 'sunset' }, padding: 64, radius: 16, shadow: true, chrome: true, theme: 'light', watermark, maxSize: { w: 1600, h: 900 } });
        done({ contentH: content.height, w: out.width, h: out.height, watermark: !!watermark, jpeg: out.toDataURL('image/jpeg', 0.85) });
      })().catch(e => done({ error: String(e?.message || e) }));
    }, BODY);
    console.log(`[socialcard-jpeg] ${r.jpeg}`);
    log('compose', { ...r, jpeg: r.jpeg?.length });
    expect(r.error).toBeUndefined();
    expect(r.watermark).toBe(true);
  });

  it('encodes the PNG in a worker: the main thread keeps ticking, unlike toBlob', async function () {
    const r = await browser.executeAsync((done) => {
      const c = document.createElement('canvas');
      c.width = 3200; c.height = 1800;
      const ctx = c.getContext('2d');
      const g = ctx.createLinearGradient(0, 0, 3200, 1800);
      g.addColorStop(0, '#ff5f57'); g.addColorStop(1, '#28c840');
      ctx.fillStyle = g; ctx.fillRect(0, 0, 3200, 1800);
      ctx.fillStyle = '#000'; ctx.font = '40px sans-serif';
      for (let y = 60; y < 1800; y += 50) ctx.fillText(`line ${y} the quick brown fox jumps over the lazy dog`.repeat(3), 10, y);
      const t0 = performance.now();
      let callMs;
      c.toBlob((blob) => {
        const totalMs = Math.round(performance.now() - t0);
        const s0 = performance.now();
        c.toDataURL('image/png');
        const syncDataUrlMs = Math.round(performance.now() - s0);
        // The app's encode: a ticker on the main thread counts the longest gap
        // between its ticks while the worker encodes.
        let last = performance.now(); let longest = 0; let ticking = true;
        const tick = () => { const now = performance.now(); longest = Math.max(longest, now - last); last = now; if (ticking) setTimeout(tick, 0); };
        setTimeout(tick, 0);
        const w0 = performance.now();
        window.__MV_ENCODE_PNG__(c).then((b64) => {
          ticking = false;
          done({ callMs, totalMs, bytes: blob?.size ?? 0, syncDataUrlMs, workerMs: Math.round(performance.now() - w0), workerB64: b64.length, longestMainGapMs: Math.round(longest) });
        }, (e) => done({ error: String(e?.message || e) }));
      }, 'image/png');
      callMs = Math.round(performance.now() - t0);
    });
    log('encode', r);
    expect(r.error).toBeUndefined();
    expect(r.bytes).toBeGreaterThan(0);
    expect(r.workerB64).toBeGreaterThan(1000);
    // The worker encode never holds the main thread the way toBlob does.
    expect(r.longestMainGapMs).toBeLessThan(r.callMs / 2);
  });
});
