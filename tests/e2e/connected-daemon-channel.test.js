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
 * goes round-trip through app to frontend"). Task 0.10 (this file) adds the
 * kill-the-daemon case: after a SIGKILL the app's reconnect loop
 * (daemon_channel.rs `run`) respawns the daemon through
 * `ensure_daemon_running` and emits `daemon-reconnected` — proved here by a
 * pid-file change plus a heartbeat whose `pid` matches the new process, and
 * by a ping round-trip working again on the new connection.
 *
 * SIGKILL, not SIGTERM: a crash never runs the daemon's cleanup, so this also
 * proves the respawn path, not just a graceful-restart path.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { daemonExecutable, waitForApp } from './helpers.js';
import { appDataDir } from './mockImap.js';

/** The daemon writes this file at `get_data_dir()/daemon.pid` (src-daemon/src/main.rs),
 *  where `get_data_dir` is `dirs::data_local_dir().join("com.mailvault.app")` — the
 *  same macOS path `appDataDir()` computes for the app. `null` while the file is
 *  absent or mid-write, never a thrown error. */
const daemonPid = () => {
  try { return parseInt(readFileSync(join(appDataDir(browser.testDataDir), 'daemon.pid'), 'utf8').trim(), 10) || null; } catch { return null; }
};

// `error`/`stackTrace`/`stacktrace` keys on an executeAsync result are treated
// by the webdriver client as a failed protocol response and silently retried
// (CI connectionRetryCount 15) instead of coming back as this test's value —
// `__error` avoids that trap, matching the invoke helper already fixed below.
const invoke = (cmd, args) => browser.executeAsync((c, a, done) => {
  window.__TAURI__.core.invoke(c, a).then((v) => done({ ok: true, v }), (e) => done({ ok: false, __error: String((e && e.message) || e) }));
}, cmd, args);

describe('Daemon channel', function () {
  this.timeout(120_000);

  before(async function () {
    await waitForApp();
    await browser.executeAsync((done) => {
      window.__CHANNEL_EVENTS__ = [];
      Promise.all(['daemon-ping', 'daemon-reconnected'].map((name) =>
        window.__TAURI__.event.listen(name, (e) => window.__CHANNEL_EVENTS__.push({ name, payload: e.payload, at: Date.now() }))))
        .then(() => done(true), () => done(false));
    });
  });

  const events = (name) => browser.execute((n) => (window.__CHANNEL_EVENTS__ || []).filter((e) => e.name === n), name);

  // A `throw` from inside a `waitUntil` condition does NOT abort the wait:
  // webdriverio 9's Timer stores a rejected condition and keeps re-ticking
  // until the full timeout elapses, and `timeoutMsg` is lost with it. So
  // record a failure in this outer variable, return `true` to end the wait at
  // once, and throw only after `waitUntil` resolves.
  async function pingRoundTrip(nonce) {
    let invokeFailure = null;
    await browser.waitUntil(async () => {
      const r = await invoke('daemon_channel_notify', { method: 'daemon.ping', params: { nonce } });
      if (!r || r.ok !== true) {
        invokeFailure = r;
        return true; // end the wait now; checked below
      }
      // `notify()` is fire-and-forget by design (spec §3.2: "dropped when
      // disconnected") — the invoke resolves even when the app's channel
      // hasn't finished connecting (or is mid-reconnect after the kill
      // case), in which case the notification is silently dropped, not
      // queued. So retry the invoke itself on each poll rather than sending
      // it once.
      return (await events('daemon-ping')).some((e) => e.payload?.nonce === nonce);
    }, {
      timeout: 30_000, interval: 500,
      timeoutMsg: `daemon-ping ${nonce} never came back after retrying the notify for 30s`,
    });
    if (invokeFailure) {
      throw new Error(`daemon_channel_notify invoke failed: ${JSON.stringify(invokeFailure)}`);
    }
  }

  it('a ping notification comes back from the daemon as an event', async function () {
    await pingRoundTrip('first');
  });

  it('after SIGKILL the channel respawns the daemon and emits daemon-reconnected', async function () {
    const before = daemonPid();
    expect(before).toBeGreaterThan(0);

    // Never kill by name/pattern: confirm this exact pid is a live
    // mailvault-daemon process before signalling it (throws otherwise).
    expect(daemonExecutable(before).replace(/\.exe$/, '').endsWith('mailvault-daemon')).toBe(true);

    const reconnectsBefore = (await events('daemon-reconnected')).length;
    process.kill(before, 'SIGKILL');

    // `timeoutMsg` is evaluated once, eagerly, before the wait runs — it can
    // never report what the poll actually last saw. Catch the plain timeout
    // and rethrow with the last-observed count instead (ruling 2).
    try {
      await browser.waitUntil(async () => (await events('daemon-reconnected')).length > reconnectsBefore, {
        timeout: 30_000, interval: 250,
      });
    } catch {
      const reconnectsAfter = (await events('daemon-reconnected')).length;
      throw new Error(`daemon-reconnected never reached the frontend after the kill (count stayed at ${reconnectsAfter}, was ${reconnectsBefore} before the kill)`);
    }

    // The respawned daemon rewrites daemon.pid slightly after binding its
    // socket, possibly after the `daemon-reconnected` event lands — poll the
    // file until it actually changes rather than reading it once here.
    let after = null;
    try {
      await browser.waitUntil(() => {
        after = daemonPid();
        return after !== null && after !== before;
      }, { timeout: 15_000, interval: 250 });
    } catch {
      throw new Error(`daemon.pid never changed from ${before} after the respawn (last read: ${after === null ? 'missing/unreadable' : after})`);
    }
    expect(after).toBeGreaterThan(0);
    expect(after).not.toBe(before);

    const beat = await invoke('daemon_rpc', { method: 'daemon.heartbeat', params: {} });
    if (!beat.ok) throw new Error(`daemon_rpc heartbeat failed: ${JSON.stringify(beat)}`);
    expect(beat.v.pid).toBe(after);
  });

  it('the respawned daemon answers pings on the new channel', async function () {
    await pingRoundTrip('second');
  });
});
