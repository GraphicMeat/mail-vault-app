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
    let beat = null;
    await browser.waitUntil(async () => {
      beat = await browser.executeAsync((done) => {
        window.__TAURI__.core.invoke('daemon_rpc', { method: 'daemon.heartbeat', params: {} })
          .then(done, (e) => done({ error: String(e) }));
      });
      return beat && beat.alive === true;
    }, { timeout: 30_000, interval: 1000, timeoutMsg: 'daemon never answered a heartbeat' });
    expect(typeof beat.buildId).toBe('string');
    expect(beat.buildId.length).toBeGreaterThan(0);
    expect(beat.pid).toBeGreaterThan(0);
  });
});
