/**
 * E2E Test: Linux menu bar switch, in a running app (UI-only)
 *
 * Settings > Appearance > Layout > Menu bar hides and shows the File/Logs
 * strip under the title bar. Launched with the default (shown), turning it
 * off must give its height back to the page and save the choice; turning it
 * on must take it again. Linux only: macOS has a global menu, Windows none,
 * and the switch is not rendered there.
 */

import assert from 'node:assert/strict';
import { waitForApp, closeSettings } from './helpers.js';
import {
  MENU_BAR_MIN_HEIGHT, isLinux, pageHeight, waitForPageHeight, openLayoutSettings,
  menuBarSwitch, clickMenuBarSwitch, savedShowMenuBar,
} from './linuxMenuBar.js';

describe('Linux menu bar switch', function () {
  this.timeout(60_000);

  before(async function () {
    await waitForApp();
    if (!(await isLinux())) this.skip();
    await openLayoutSettings();
  });

  after(async function () {
    await closeSettings();
  });

  it('is on by default', async () => {
    assert.equal(await menuBarSwitch(), true);
  });

  it('hides the bar when turned off, and shows it again when turned on', async () => {
    const shown = await pageHeight();

    await clickMenuBarSwitch();
    assert.equal(await menuBarSwitch(), false);
    const hidden = await waitForPageHeight(h => h >= shown + MENU_BAR_MIN_HEIGHT, `grew by the menu bar from ${shown}px`);
    await browser.waitUntil(() => savedShowMenuBar() === false, {
      timeout: 10_000, interval: 200, timeoutMsg: 'showMenuBar: false was never saved',
    });

    await clickMenuBarSwitch();
    assert.equal(await menuBarSwitch(), true);
    await waitForPageHeight(h => h === shown, `went back to ${shown}px from ${hidden}px`);
    await browser.waitUntil(() => savedShowMenuBar() === true, {
      timeout: 10_000, interval: 200, timeoutMsg: 'showMenuBar: true was never saved',
    });
  });
});
