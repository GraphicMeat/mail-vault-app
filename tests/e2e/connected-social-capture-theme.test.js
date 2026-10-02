/**
 * E2E: the social export shoots the app window in the theme the user picked.
 *
 * The capture copies computed styles from the live DOM, so the live app has
 * to be in the picked theme while it reads: themeStore's transient
 * captureTheme flips data-theme and the reader frames rebuild their srcdoc in
 * that theme. Unit tests stub the frames; only the real webview shows whether
 * the capture waits long enough for a rebuilt frame to paint.
 *
 * The HTML fixture message is opened, the window is captured in the app's own
 * theme and in the other one, and the mean lightness of the chrome and of the
 * message frame is compared between the two shots. Afterwards the live app
 * must be back in its own theme.
 *
 * Every value an assertion reads is logged as one `[captheme]` JSON line.
 */

import { waitForApp, waitForEmails } from './helpers.js';
import { HTML_QUOTED_SUBJECT } from './mockImap.js';

const log = (tag, value) => console.log(`[captheme] ${tag} ${JSON.stringify(value)}`);

/** Capture in `theme` and return the mean lightness (0..1) of the chrome and of the frame's visible rect. */
function shoot(theme) {
  return browser.executeAsync((wanted, done) => {
    (async () => {
      const root = document.getElementById('root');
      const iframe = root.querySelector('iframe[sandbox]');
      const rootRect = root.getBoundingClientRect();
      const fr = iframe.getBoundingClientRect();
      const started = performance.now();
      const canvas = await window.__MV_CAPTURE_APP__({ redact: false, dict: null, theme: wanted });
      const ms = Math.round(performance.now() - started);
      const scale = canvas.width / rootRect.width;
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      const inFrame = (x, y) => x >= (fr.left - rootRect.left) * scale && x < (fr.right - rootRect.left) * scale
        && y >= (fr.top - rootRect.top) * scale && y < (fr.bottom - rootRect.top) * scale;
      const sum = { chrome: 0, frame: 0 };
      const n = { chrome: 0, frame: 0 };
      // Every 4th pixel each way is plenty for a mean.
      for (let y = 0; y < canvas.height; y += 4) {
        for (let x = 0; x < canvas.width; x += 4) {
          const i = (y * canvas.width + x) * 4;
          const l = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
          const k = inFrame(x, y) ? 'frame' : 'chrome';
          sum[k] += l;
          n[k] += 1;
        }
      }
      done({
        ms,
        chrome: n.chrome ? sum.chrome / n.chrome : null,
        frame: n.frame ? sum.frame / n.frame : null,
        frameArea: n.frame,
      });
    })().catch(e => done({ error: String(e?.message || e) }));
  }, theme);
}

describe('Social export app capture in the picked theme', function () {
  this.timeout(180_000);
  let own;

  before(async function () {
    await waitForApp();
    await waitForEmails();
    await browser.waitUntil(() => browser.execute(() => typeof window.__MV_CAPTURE_APP__ === 'function'),
      { timeout: 30_000, interval: 250, timeoutMsg: 'capture hook never loaded' });

    const clicked = await browser.execute((subject) => {
      for (const row of document.querySelectorAll('[data-testid="email-row"]')) {
        if ((row.textContent || '').includes(subject) && row.offsetHeight > 0) {
          row.click();
          return true;
        }
      }
      return false;
    }, HTML_QUOTED_SUBJECT);
    expect(clicked).toBe(true);
    await browser.waitUntil(() => browser.execute(() => {
      const iframe = document.querySelector('#root iframe[sandbox]');
      const doc = iframe?.contentDocument;
      return !!doc?.body && doc.readyState === 'complete' && iframe.getBoundingClientRect().height > 50;
    }), { timeout: 30_000, interval: 250, timeoutMsg: 'message frame never rendered' });
    // The frame's auto-size passes land up to 1s after load.
    await browser.pause(2000);
    own = await browser.execute(() => document.documentElement.getAttribute('data-theme'));
    log('own', own);
  });

  it('shoots the other theme, chrome and message frame both, then puts the app back', async function () {
    const other = own === 'dark' ? 'light' : 'dark';
    const same = await shoot(own);
    log('same', same);
    const flipped = await shoot(other);
    log('flipped', flipped);
    const after = await browser.execute(() => ({ dataTheme: document.documentElement.getAttribute('data-theme') }));
    log('after', after);

    expect(same.error).toBeUndefined();
    expect(flipped.error).toBeUndefined();
    expect(same.frameArea).toBeGreaterThan(100);
    const [light, dark] = own === 'light' ? [same, flipped] : [flipped, same];
    // Graphite light chrome sits near white, dark near black: a wide gap.
    expect(light.chrome - dark.chrome).toBeGreaterThan(0.3);
    // The message frame follows the app theme (emailViewerTheme 'system'):
    // Dark Reader in dark, the mail's own white in light.
    expect(light.frame - dark.frame).toBeGreaterThan(0.2);
    expect(after.dataTheme).toBe(own);
  });
});
