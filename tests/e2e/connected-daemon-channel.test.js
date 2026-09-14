/**
 * The app holds one long-lived `channel.open` connection to the daemon
 * (spec 2026-09-14 §3.2, src-tauri/src/daemon_channel.rs). A daemon event
 * must reach the frontend as a plain Tauri event, unchanged shape, through:
 *
 *   frontend invoke(daemon_channel_notify) -> app's channel `notify()`
 *   -> daemon `channel.open` connection -> channel::dispatch("daemon.ping")
 *   -> EventBus.emit("daemon-ping", ...) -> app's daemon_channel `pump()`
 *   -> app.emit("daemon-ping", ...) -> frontend listen("daemon-ping")
 *
 * This is the P0 round-trip proof from spec §4 ("A test event `daemon-ping`
 * goes round-trip through app to frontend"). Task 0.10 adds the
 * kill-the-daemon / `daemon-reconnected` case; this file covers only the
 * ping round-trip, written as this task's own red/green test since 0.10 was
 * not authored yet when this task ran.
 */

import { waitForApp } from './helpers.js';

describe('Daemon channel — ping round-trip', function () {
  this.timeout(60_000);

  before(async function () {
    await waitForApp();
  });

  it('a daemon.ping notification comes back as a daemon-ping Tauri event', async function () {
    await browser.execute(() => {
      window.__DAEMON_PING_EVENTS__ = [];
      window.__TAURI__.event.listen('daemon-ping', (e) => window.__DAEMON_PING_EVENTS__.push(e.payload))
        .then((stop) => { window.__DAEMON_PING_EVENTS_STOP__ = stop; });
    });
    await browser.waitUntil(() => browser.execute(() => typeof window.__DAEMON_PING_EVENTS_STOP__ === 'function'), {
      timeout: 10_000, timeoutMsg: 'daemon-ping listener never registered',
    });

    const nonce = `e2e-${Date.now()}`;
    const invoke = (n) => browser.executeAsync((n2, done) => {
      window.__TAURI__.core.invoke('daemon_channel_notify', { method: 'daemon.ping', params: { nonce: n2 } })
        .then(() => done({ ok: true }))
        .catch((e) => done({ __error: String((e && e.message) || e) }));
    }, n);

    // `notify()` is fire-and-forget by design (spec §3.2: "dropped when
    // disconnected") — the invoke always resolves `{ ok: true }` even if the
    // app's channel hasn't finished its on-demand daemon spawn yet, in which
    // case the notification is silently dropped, not queued. So retry the
    // invoke itself on each poll rather than sending it once: a single send
    // races the channel's first connect, and that drop is spec-conformant,
    // not a bug (Task 0.10 covers the post-connect respawn/reconnect case).
    // An actual invoke failure (command rejected) is a different, real bug —
    // throw immediately rather than retrying it away, same as the plan's own
    // Task 0.10 Step 1 `pingRoundTrip` helper does.
    await browser.waitUntil(async () => {
      const r = await invoke(nonce);
      if (!r || r.ok !== true) {
        throw new Error(`daemon_channel_notify invoke failed: ${JSON.stringify(r)}`);
      }
      return browser.execute((n) => (window.__DAEMON_PING_EVENTS__ || []).some((p) => p && p.nonce === n), nonce);
    }, {
      timeout: 30_000, interval: 500,
      timeoutMsg: `no daemon-ping event reached the frontend for nonce ${nonce} after retrying the notify for 30s`,
    });

    await browser.execute(() => window.__DAEMON_PING_EVENTS_STOP__ && window.__DAEMON_PING_EVENTS_STOP__());
  });
});
