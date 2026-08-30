/**
 * E2E Test: UI localization
 *
 * The catalogs are unit-tested for parity; what a jsdom test cannot prove is
 * that a LIVE switch repaints. `t()` reads module state, and the only thing
 * React subscribes to is the settingsStore `language` field — load a catalog
 * without publishing that field and every string on screen stays in the old
 * language until some unrelated render happens along.
 *
 * `window.__I18N__` is the E2E seam (main.jsx, VITE_E2E=1). `setLocale` is
 * async and `browser.execute` never awaits an async callback, so every switch
 * here is fire-then-poll, never a single execute that returns the result.
 *
 * IMPORTANT: `language` is persisted (zustand/persist) and the whole wdio run
 * shares one HOME, so this file must leave the app on 'en' — otherwise every
 * spec after it reads German chrome and fails on an English selector.
 */

import { waitForApp } from './helpers.js';

// Anchors chosen because they render as BOTH a title attribute (collapsed
// sidebar) and button text (expanded), so neither sidebar state can hide them.
const PROBES = [
  { code: 'de', compose: 'Verfassen', settings: 'Einstellungen' },
  { code: 'ja', compose: '新規作成', settings: '設定' },
  { code: 'fr', compose: 'Écrire', settings: 'Paramètres' },
];

const EN = { compose: 'Compose', settings: 'Settings' };

// Negative control, 2026-08-30: deleting the `useSettingsStore.setState` from
// setLocale fails 3 of the 6 cases here — but NOT the first switch, which an
// unrelated render happens to repaint inside the wait. Three locales, not one,
// is what makes this file catch a missing publish.

const chromeStrings = () => browser.execute(() =>
  Array.from(document.querySelectorAll('button, [role="button"]'))
    .flatMap((el) => [el.getAttribute('title'), el.getAttribute('aria-label'), el.textContent])
    .filter(Boolean)
    .map((s) => s.trim())
    .filter(Boolean));

const has = (strings, needle) => strings.some((s) => s === needle || s.includes(needle));

async function switchTo(code) {
  await browser.execute((c) => { window.__I18N__.setLocale(c); }, code);
  await browser.waitUntil(
    async () => (await browser.execute(() => window.__I18N__.getLocale())) === code,
    { timeout: 10_000, timeoutMsg: `setLocale('${code}') never took effect in module state` },
  );
}

describe('UI localization', function () {
  this.timeout(60000);
  let appState;

  before(async function () {
    appState = await waitForApp();
    if (appState !== 'ready') this.skip();
  });

  // Runs even when a case throws mid-switch: a German app poisons the rest of
  // the suite, so the restore is not optional.
  after(async function () {
    if (appState !== 'ready') return;
    await browser.execute(() => { window.__I18N__?.setLocale('en'); });
    await browser.waitUntil(
      async () => (await browser.execute(() => window.__I18N__.getLocale())) === 'en',
      { timeout: 10_000, timeoutMsg: 'failed to restore English — later specs will fail' },
    ).catch(() => {});
  });

  it('exposes the i18n seam and boots in English', async function () {
    const seam = await browser.execute(() => !!window.__I18N__ && window.__I18N__.getLocale());
    expect(seam).toBe('en');

    const strings = await chromeStrings();
    expect(has(strings, EN.compose)).toBe(true);
    expect(has(strings, EN.settings)).toBe(true);
  });

  PROBES.forEach(({ code, compose, settings }) => {
    it(`repaints the sidebar into ${code} without a reload`, async function () {
      await switchTo(code);

      // Poll the DOM, not the store: the store write is what we are testing,
      // so an assertion on it would pass even if nothing repainted.
      await browser.waitUntil(
        async () => has(await chromeStrings(), compose),
        { timeout: 10_000, timeoutMsg: `sidebar never showed the ${code} compose label "${compose}"` },
      );

      const strings = await chromeStrings();
      expect(has(strings, settings)).toBe(true);
      // The English original must be GONE, or the switch only added a string.
      expect(strings.filter((s) => s === EN.compose)).toEqual([]);
      expect(strings.filter((s) => s === EN.settings)).toEqual([]);
    });
  });

  it('restores English on the way back', async function () {
    await switchTo('de');
    await browser.waitUntil(async () => has(await chromeStrings(), 'Verfassen'), { timeout: 10_000 });

    await switchTo('en');
    await browser.waitUntil(
      async () => has(await chromeStrings(), EN.compose),
      { timeout: 10_000, timeoutMsg: 'switching back to English never repainted' },
    );

    const strings = await chromeStrings();
    expect(strings.filter((s) => s === 'Verfassen')).toEqual([]);
  });

  it('translates a string built outside React', async function () {
    // `t()` is module state, so a service or plain util reaches the same
    // catalog the components do. If this drifts, error text stays English
    // while the chrome around it is translated.
    await switchTo('de');
    const viaT = await browser.execute(() => window.__I18N__.t('sidebar.compose'));
    expect(viaT).toBe('Verfassen');

    await switchTo('en');
    const back = await browser.execute(() => window.__I18N__.t('sidebar.compose'));
    expect(back).toBe('Compose');
  });
});
