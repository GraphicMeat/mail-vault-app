/**
 * E2E Test: a long path never widens Backup Settings
 *
 * Both path fields on Settings > Backup & Restore > Backup Settings are
 * `flex-1 truncate`. `.truncate` is `overflow: clip` app-wide (index.css), and
 * clip is not a scroll container, so without an explicit `min-width: 0` the
 * field refuses to shrink below its nowrap text: a long container path pushed
 * the buttons past the card and the whole pane grew a horizontal scrollbar
 * (2026-09-07). A runner's real path is short, so the spec writes a long one
 * into both fields and measures the layout WebKit actually produces.
 */

import { waitForApp, openSettings, closeSettings, clickSettingsNav } from './helpers.js';

const LONG_PATH = '/Volumes/My Passport Ultra 4TB/Users/Rokas/Library/Containers/com.mailvault.app'
  + '/Data/Library/Application Support/com.mailvault.app/Maildir/a/much/deeper/backup/folder (app only)';

const FIELDS = ['vault-path', 'backup-path'];

describe('Backup Settings with a long path', function () {
  this.timeout(60_000);

  before(async function () {
    await waitForApp();
    await openSettings();
    expect(await clickSettingsNav('Backup & Restore')).toBe(true);
    // "Backup & Restore" also names the first sub-tab, and the sub-tab bar
    // renders after the sidebar: the last visible match is the sub-tab.
    await browser.execute(() => {
      const m = [...document.querySelectorAll('button')]
        .filter(b => b.offsetHeight > 0 && b.textContent.trim() === 'Backup Settings');
      m[m.length - 1]?.click();
    });
    // Poll through execute: tauri-wd cannot hand an element reference back
    // into a script, so `$(sel).waitForDisplayed()` dies on Node.contains.
    await browser.waitUntil(() => browser.execute((ids) =>
      ids.every((id) => (document.querySelector(`[data-testid="${id}"]`)?.offsetHeight ?? 0) > 0), FIELDS),
    { timeout: 10_000, interval: 250, timeoutMsg: 'Backup Settings path fields did not render' });
  });

  after(async function () {
    await closeSettings();
  });

  it('keeps every button of both path rows inside the row', async function () {
    // One assertion over the whole set: wdio's expect takes no message
    // argument, so a per-field check would only ever say "true is not false".
    const overflows = await browser.execute((ids, long) => {
      const out = {};
      for (const id of ids) {
        const el = document.querySelector(`[data-testid="${id}"]`);
        el.textContent = long;
        const row = el.parentElement;
        out[id] = row.scrollWidth > row.clientWidth;
      }
      return out;
    }, FIELDS, LONG_PATH);
    expect(overflows).toEqual(Object.fromEntries(FIELDS.map((id) => [id, false])));
  });

  it('never gives the settings pane a horizontal scrollbar', async function () {
    const pane = await browser.execute(() => {
      const el = document.querySelector('[data-testid="settings-content"]');
      return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
    });
    expect(pane.scrollWidth).toBeLessThanOrEqual(pane.clientWidth);
  });
});
