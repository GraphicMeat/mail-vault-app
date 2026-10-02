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

// Record every IPC command the page sends, holding `quit_app` back: a quit
// ends the session. Tauri defines `__TAURI_INTERNALS__.invoke`, `.ipc` and
// wry's `window.ipc` read-only, so the spy sits on both transports underneath:
// the `fetch` to ipc://localhost/<cmd>, and the WebKit message handler that
// `window.ipc.postMessage` calls once Tauri falls back from the custom
// protocol (it did on CI, so the fetch spy alone let the real quit run).
// Scripts from WebDriver run in the page's own world (`webview.eval`).
function installIpcSpy() {
  const seen = [];
  const hooks = [];
  const restores = [];
  const record = (cmd) => { seen.push(cmd); return cmd === 'quit_app'; };

  const realFetch = window.fetch;
  window.fetch = function (input, ...rest) {
    const url = typeof input === 'string' ? input : input?.url;
    if (url && url.startsWith('ipc:')) {
      const cmd = decodeURIComponent(url.split('/').pop().split('?')[0]);
      if (record(cmd)) return new Promise(() => {});
    }
    return realFetch.call(this, input, ...rest);
  };
  restores.push(() => { window.fetch = realFetch; });
  hooks.push('fetch');

  const handler = window.webkit?.messageHandlers?.ipc;
  const proto = handler && Object.getPrototypeOf(handler);
  if (proto && typeof proto.postMessage === 'function') {
    const realPost = proto.postMessage;
    proto.postMessage = function (data, ...rest) {
      let cmd = null;
      try { cmd = typeof data === 'string' ? JSON.parse(data).cmd : null; } catch { /* binary payload */ }
      if (cmd && record(cmd)) return undefined;
      return realPost.call(this, data, ...rest);
    };
    restores.push(() => { proto.postMessage = realPost; });
    hooks.push('postMessage');
  }

  window.__e2eIpc = { seen, hooks, restore: () => restores.forEach(fn => fn()) };
}

const ipcSpy = () => browser.execute(() => {
  const spy = window.__e2eIpc;
  return spy ? { seen: spy.seen.slice(), hooks: spy.hooks.slice() } : null;
});

describe('Linux menu bar off at launch', function () {
  this.timeout(60_000);

  before(async function () {
    await waitForApp();
    if (!(await isLinux())) this.skip();
    await browser.execute(installIpcSpy);
  });

  after(async () => {
    await browser.execute(() => window.__e2eIpc?.restore());
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
    // The switch reached the shell through the page's own invoke path (the
    // same dynamic @tauri-apps/api/core import the quit handler uses), so a
    // spy that saw it will see quit_app too. A blind spy fails here, while
    // the session is still up, instead of letting the real quit end it.
    const before = await ipcSpy();
    assert.ok(
      before?.seen.includes('set_menu_bar_visible'),
      `IPC spy never saw set_menu_bar_visible (hooks: ${before?.hooks}, seen: ${before?.seen})`,
    );

    // The key is dispatched in the page: WebKitGTK's WebDriver never delivers
    // a Ctrl chord to it under xvfb. This proves the shortcut is wired in the
    // real window (main.jsx, IS_LINUX, the invoke path), not GTK's routing.
    await browser.execute(() => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'q', code: 'KeyQ', ctrlKey: true, bubbles: true, cancelable: true,
      }));
    });
    await browser.waitUntil(() => browser.execute(() => window.__e2eIpc.seen.includes('quit_app')), {
      timeout: 5_000, interval: 100, timeoutMsg: 'Ctrl+Q never asked the shell to quit',
    });
  });
});
