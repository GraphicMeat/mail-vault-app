/**
 * Text size is the webview's native zoom (utils/appFont.js). A unit test can
 * only mock `setZoom`; this one proves the real webview scales and that the
 * capability (`core:webview:allow-set-webview-zoom`) is granted: a refused
 * permission only logs a warning, so nothing else would notice.
 *
 * Zoom shrinks the CSS viewport by the factor, so `innerWidth` at 125% is the
 * 100% width / 1.25. The app font follows the setting in the same window.
 */
import { waitForApp } from './helpers.js';

const settle = (condition, message) => browser.waitUntil(condition, { timeout: 15_000, interval: 100, timeoutMsg: message });
const width = () => browser.execute(() => window.innerWidth);
const set = (key, value) => browser.execute((k, v) => {
  const s = window.__SETTINGS_STORE__.getState();
  s[k === 'textScale' ? 'setTextScale' : 'setAppFont'](v);
}, key, value);

describe('Text size and app font', () => {
  before(async () => { await waitForApp(); });
  after(async () => { await set('textScale', 1); await set('appFont', 'instrument-sans'); });

  it('zooms the whole window to the chosen text size and back', async () => {
    await set('textScale', 1);
    const base = await width();
    await set('textScale', 1.25);
    await settle(async () => Math.abs(await width() - base / 1.25) <= 2,
      `innerWidth never shrank to ${base / 1.25} (base ${base}); setZoom refused or not applied`);
    await set('textScale', 1);
    await settle(async () => Math.abs(await width() - base) <= 2, 'zoom did not return to 100%');
  });

  it('applies the chosen font to the app', async () => {
    await set('appFont', 'fira-code');
    await settle(() => browser.execute(() => getComputedStyle(document.body).fontFamily.includes('Fira Code')),
      'body never switched to Fira Code');
    // execute() does not await an async callback on tauri-wd: poll a sync check.
    await settle(() => browser.execute(() => [...document.fonts]
      .some(f => f.family.replace(/"/g, '') === 'Fira Code' && f.status === 'loaded')),
      'Fira Code face did not load from the bundle');
  });
});
