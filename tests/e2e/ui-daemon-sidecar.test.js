/**
 * The app spawns a real daemon, not the empty placeholder CI used to ship.
 * ui-* specs run in CI without VITE_E2E: no store seams, only the Tauri bridge.
 */
import { waitForApp } from './helpers.js';

describe('Daemon sidecar', function () {
  this.timeout(60_000);

  before(async function () {
    await waitForApp();
  });

  it('answers a heartbeat with a build id', async function () {
    // `done({ error: ... })` looks like a failed WebDriver protocol response to
    // the webdriver client itself (any execute result with a truthy `error`
    // field), which retries the whole executeAsync with backoff instead of
    // resolving it — one attempt can eat 100s+ under CI's connectionRetryCount,
    // and wdio kills the test at the 60s suite timeout with a bare
    // `Error: Timeout`, before waitUntil's own timeoutMsg ever gets to run.
    // `__error` (as connected-daemon-channel.test.js / connected-backup-dot.test.js
    // already use) is not a reserved field, so it resolves normally and the
    // condition below just sees a falsy `alive` and keeps polling.
    //
    // A throw inside a waitUntil condition also hides timeoutMsg (webdriverio
    // 9.24's Timer swallows a rejected condition and keeps ticking) — so this
    // never throws inside the condition either; it records the last result and
    // rethrows only after waitUntil settles.
    let beat = null;
    try {
      await browser.waitUntil(async () => {
        beat = await browser.executeAsync((done) => {
          window.__TAURI__.core.invoke('daemon_rpc', { method: 'daemon.heartbeat', params: {} })
            .then(done, (e) => done({ __error: String(e) }));
        });
        return beat && beat.alive === true;
      }, { timeout: 30_000, interval: 1000 });
    } catch (e) {
      throw new Error(`daemon never answered a heartbeat; last result: ${JSON.stringify(beat)}`);
    }
    expect(typeof beat.buildId).toBe('string');
    expect(beat.buildId.length).toBeGreaterThan(0);
    expect(beat.pid).toBeGreaterThan(0);
  });
});
