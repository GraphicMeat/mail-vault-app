/**
 * Spec 2026-09-14 §5.7.2 (R6): SIGKILL the daemon mid-build; the channel respawns
 * it, the frontend re-pushes its config, and indexing resumes from the committed
 * batches: progress never goes back to zero.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { waitForApp } from './helpers.js';
import { appDataDir } from './mockImap.js';

describe('Search index resume', function () {
  this.timeout(300_000);
  let preKill = 0;
  let killedAt = 0;
  let oldPid = 0;

  const dataDir = () => appDataDir(browser.testDataDir);
  const daemonPid = () => { try { return parseInt(readFileSync(join(dataDir(), 'daemon.pid'), 'utf8').trim(), 10) || 0; } catch { return 0; } };
  const status = () => browser.executeAsync((done) => {
    window.__TAURI_INTERNALS__.invoke('daemon_rpc', { method: 'search_index_status', params: {} }).then(done, (e) => done({ error: String(e) }));
  });
  const visible = (id) => browser.execute((i) => { const el = document.querySelector(`[data-testid="${i}"]`); return !!el && el.offsetHeight > 0; }, id);

  before(async function () {
    await waitForApp();
    await browser.executeAsync((done) => {
      window.__IDX_EVENTS__ = [];
      window.__TAURI__.event.listen('search-index-progress', (e) => window.__IDX_EVENTS__.push({ at: Date.now(), ...e.payload })).then(() => done(true), () => done(false));
    });
  });

  it('commits the first batch of the 3,000-message build', async function () {
    let s;
    await browser.waitUntil(async () => { s = await status(); return s.indexed >= 500 && s.firstPassDone === false; },
      { timeout: 90_000, interval: 250, timeoutMsg: 'the first 500 never committed' });
    expect(s.total).toBeGreaterThanOrEqual(3000);
    preKill = s.indexed;
    oldPid = daemonPid();
    expect(oldPid).toBeGreaterThan(0);
  });

  it('after SIGKILL the respawned daemon resumes, never from zero', async function () {
    killedAt = Date.now();
    process.kill(oldPid, 'SIGKILL');
    await browser.waitUntil(() => { const p = daemonPid(); return p > 0 && p !== oldPid; },
      { timeout: 30_000, interval: 250, timeoutMsg: 'no new daemon after the kill' });
    await browser.waitUntil(() => browser.execute((t) => window.__IDX_EVENTS__.some((e) => e.at > t && e.available), killedAt),
      { timeout: 60_000, interval: 250, timeoutMsg: 'no progress event from the respawned daemon' });
    const after = await browser.execute((t) => window.__IDX_EVENTS__.filter((e) => e.at > t && e.available).map((e) => e.indexed), killedAt);
    expect(Math.min(...after)).toBeGreaterThanOrEqual(preKill);
    const s = await status();
    expect(s.indexed).toBeGreaterThanOrEqual(preKill);
    expect(s.firstPassDone).toBe(false);
    // Task 1.10 review I2: the UI only shows again 1500ms after the new
    // daemon's first indexing emit (open delay, deviation 5) — a bare
    // expect right after the 250ms-poll waitUntil above races that delay.
    await browser.waitUntil(async () => (await visible('search-index-progress-modal')) || (await visible('search-index-chip')),
      { timeout: 10_000, interval: 250, timeoutMsg: 'no progress UI after respawn' });
  });

  it('the resumed build finishes with every seeded message', async function () {
    await browser.waitUntil(async () => { const s = await status(); return s.firstPassDone === true && s.indexed >= 3000; },
      { timeout: 180_000, interval: 1000, timeoutMsg: 'the resumed build never finished' });
    const logs = readdirSync(join(dataDir(), 'logs')).filter((f) => f.startsWith('daemon.log'));
    const starts = logs.map((f) => readFileSync(join(dataDir(), 'logs', f), 'utf8').split('search index worker started').length - 1).reduce((a, b) => a + b, 0);
    expect(starts).toBeGreaterThanOrEqual(2); // anti-vacuity: two daemons really ran the index
  });
});
