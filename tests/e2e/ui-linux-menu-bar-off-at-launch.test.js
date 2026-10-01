/**
 * E2E Test: Linux menu bar saved off, then the app launched (UI-only)
 *
 * wdio.conf.js seeds `showMenuBar: false` before this spec's app starts, as a
 * user who turned the bar off and restarted would have it. The shell then
 * never attaches the menu, so:
 * - the page already has the full height: turning the bar on attaches it and
 *   the page shrinks by its height, turning it off again gives it back;
 * - File > Quit's Ctrl+Q has no GTK accelerator, so the page must quit on it.
 */

import assert from 'node:assert/strict';
import { waitForApp, closeSettings } from './helpers.js';
import {
  MENU_BAR_MIN_HEIGHT, isLinux, pageHeight, waitForPageHeight, openLayoutSettings,
  menuBarSwitch, clickMenuBarSwitch,
} from './linuxMenuBar.js';

describe('Linux menu bar off at launch', function () {
  this.timeout(60_000);

  before(async function () {
    await waitForApp();
    if (!(await isLinux())) this.skip();
  });

  it('starts without the bar, and attaches it when turned on', async () => {
    await openLayoutSettings();
    assert.equal(await menuBarSwitch(), false);
    const hidden = await pageHeight();

    await clickMenuBarSwitch();
    const shown = await waitForPageHeight(h => h <= hidden - MENU_BAR_MIN_HEIGHT, `shrank by the menu bar from ${hidden}px`);

    await clickMenuBarSwitch();
    await waitForPageHeight(h => h === hidden, `went back to ${hidden}px from ${shown}px`);
    await closeSettings();
  });

  it('quits on Ctrl+Q from the page', async () => {
    // Record the command instead of running it: a quit ends the session.
    await browser.execute(() => {
      const internals = window.__TAURI_INTERNALS__;
      const invoke = internals.invoke;
      window.__e2eQuitCalls = 0;
      internals.invoke = (cmd, ...rest) => {
        if (cmd === 'quit_app') { window.__e2eQuitCalls += 1; return Promise.resolve(); }
        return invoke.call(internals, cmd, ...rest);
      };
    });
    await browser.keys(['Control', 'q']);
    await browser.keys(['Control']);
    await browser.waitUntil(() => browser.execute(() => window.__e2eQuitCalls > 0), {
      timeout: 5_000, interval: 100, timeoutMsg: 'Ctrl+Q never asked the shell to quit',
    });
  });
});
