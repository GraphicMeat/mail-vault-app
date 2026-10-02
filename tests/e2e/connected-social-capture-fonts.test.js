/**
 * E2E: the social export's app-window capture draws the app's own font.
 *
 * The capture rasterizes the DOM through an SVG image. An SVG image cannot
 * reach the page's fonts, so the font has to be embedded in it; with
 * `font:false` the UI drew in a wider fallback face and every label wrapped.
 * Unit tests mock the rasterizer; only the real webview under the real CSP
 * shows whether the embedded font is used.
 *
 * A probe line in Instrument Sans is put on the app, captured, and the width
 * of its ink on the canvas is compared with its live width and with the same
 * text in the system face. Reading the pixels also proves the canvas is not
 * tainted (the export calls toDataURL on it).
 *
 * Every value an assertion reads is logged as one `[capfont]` JSON line.
 */

import { waitForApp, waitForEmails } from './helpers.js';

const log = (tag, value) => console.log(`[capfont] ${tag} ${JSON.stringify(value)}`);

const TEXT = 'Search Results 36 of 2,150 emails Saved in your vault and backup drive';

describe('Social export app capture draws in the app font', function () {
  this.timeout(180_000);

  before(async function () {
    await waitForApp();
    await waitForEmails();
    await browser.waitUntil(() => browser.execute(() => typeof window.__MV_CAPTURE_APP__ === 'function'),
      { timeout: 30_000, interval: 250, timeoutMsg: 'capture hook never loaded' });
  });

  after(async function () {
    await browser.execute(() => document.getElementById('mv-capfont-probe')?.remove());
  });

  it('embeds Instrument Sans: the captured line is as wide as the live one, not the fallback', async function () {
    const result = await browser.executeAsync((text, done) => {
      (async () => {
        const root = document.getElementById('root');
        const probe = document.createElement('div');
        probe.id = 'mv-capfont-probe';
        // A white bar across the whole window: the scan below reads only inside
        // it, so the app around it never counts as ink, whichever face draws.
        probe.style.cssText = 'position:fixed;left:0;right:0;top:0;height:56px;overflow:hidden;z-index:2147483647;'
          + 'background:#fff;color:#000;padding:8px;box-sizing:border-box;white-space:nowrap;font:400 20px/40px "Instrument Sans";';
        const live = document.createElement('span');
        live.textContent = text;
        const fallback = document.createElement('span');
        fallback.textContent = text;
        fallback.style.cssText = 'position:absolute;visibility:hidden;font:400 20px/40px -apple-system, Helvetica, sans-serif;';
        probe.append(live, fallback);
        root.appendChild(probe);
        await document.fonts.load('400 20px "Instrument Sans"');
        await document.fonts.ready;
        const liveRect = live.getBoundingClientRect();
        const barRect = probe.getBoundingClientRect();
        const rootRect = root.getBoundingClientRect();
        const started = performance.now();
        const canvas = await window.__MV_CAPTURE_APP__({ redact: false, dict: null });
        const ms = Math.round(performance.now() - started);
        const scale = canvas.width / rootRect.width;
        const x0 = Math.ceil((barRect.left - rootRect.left + 2) * scale);
        const y0 = Math.ceil((barRect.top - rootRect.top + 2) * scale);
        const w = Math.min(canvas.width - x0, Math.floor((barRect.width - 4) * scale));
        const h = Math.floor((barRect.height - 4) * scale);
        let pixels;
        try {
          pixels = canvas.getContext('2d').getImageData(x0, y0, w, h).data;
        } catch (e) {
          done({ error: `getImageData: ${e.message}`, ms });
          return;
        }
        let left = -1;
        let right = -1;
        for (let x = 0; x < w; x++) {
          for (let y = 0; y < h; y++) {
            const i = (y * w + x) * 4;
            if (pixels[i] + pixels[i + 1] + pixels[i + 2] < 300) { if (left < 0) left = x; right = x; break; }
          }
        }
        done({
          ms,
          barWidth: barRect.width,
          scale,
          liveWidth: liveRect.width,
          fallbackWidth: fallback.getBoundingClientRect().width,
          inkWidth: right < 0 ? null : (right - left + 1) / scale,
          checked: document.fonts.check('400 20px "Instrument Sans"'),
        });
      })().catch(e => done({ error: String(e?.message || e) }));
    }, TEXT);
    log('capture', result);
    expect(result.error).toBeUndefined();
    expect(result.inkWidth).not.toBeNull();
    // The two faces differ by several percent over this line; the ink must sit
    // with the live Instrument Sans width, well away from the fallback's.
    const gap = Math.abs(result.liveWidth - result.fallbackWidth);
    expect(gap).toBeGreaterThan(10);
    expect(Math.abs(result.inkWidth - result.liveWidth)).toBeLessThan(gap / 3);
  });
});
