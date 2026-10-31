/**
 * E2E: Settings' graphics-card switch takes effect without a restart.
 *
 * With the Rust renderer on, a message draws on CPU render workers. Turning the
 * switch on, the next message draws, and a worker spawned with `--gpu` serves it;
 * turning it off, the next message draws again, on a worker without it. Every
 * body must still finish drawing across the switch (the retired worker's docs
 * reopen quietly). `render.gpuStatus` must name an adapter on the mini.
 *
 * Mac mini only (a real GPU): out of connected-ci, selected by wdio.blitz.conf.js.
 */
import { execFileSync } from 'node:child_process';
import { waitForApp, waitForEmails, switchToFolder } from './helpers.js';
import { BLITZ_FOLDER, BLITZ_THREAD_SUBJECT, BLITZ_TALL_SUBJECT } from './mockImap.js';

const setStore = (patch) => browser.execute((p) => window.__SETTINGS_STORE__.setState(p), patch);
const rpc = (method, params = {}) => browser.executeAsync((m, p, done) => {
  window.__TAURI__.core.invoke('daemon_rpc', { method: m, params: p }).then(done).catch((e) => done({ __error: String((e && e.message) || e) }));
}, method, params);
const workers = () => execFileSync('ps', ['-axo', 'command='], { encoding: 'utf8', maxBuffer: 16 << 20 })
  .split('\n').filter((c) => /mailvault-daemon\b.*--render-worker/.test(c));

async function open(subject, thread = false) {
  await browser.waitUntil(() => browser.execute((subject, thread) => {
    const row = [...document.querySelectorAll('[data-testid="email-row"]')].find((r) => r.offsetHeight > 0
      && (r.textContent || '').includes(subject) && (!thread || Number(r.getAttribute('data-thread-count') || 1) > 1));
    if (row) row.click();
    return !!row;
  }, subject, thread), { timeout: 30_000, interval: 300, timeoutMsg: `row ${subject} not found` });
}

/** A Blitz body with a decoded tile, and no body showing its failure view. */
async function drawn() {
  await browser.waitUntil(() => browser.execute(() => {
    const bodies = [...document.querySelectorAll('[data-renderer="blitz"]')];
    return bodies.length > 0 && bodies.some((b) => { const t = b.querySelector('[data-testid="blitz-tile"]'); return t && t.complete && t.naturalWidth > 0; });
  }), { timeout: 30_000, interval: 300, timeoutMsg: 'no Blitz body drew' });
  const failed = await browser.execute(() => document.querySelectorAll('[data-testid="blitz-failure-notice"], [data-testid="blitz-failure-bubble"]').length);
  expect(failed).toBe(0);
}

describe('Blitz graphics-card switch', function () {
  this.timeout(300_000);
  const luke = () => browser.mockAccounts[0].email;

  before(async () => {
    await waitForApp();
    await waitForEmails();
    await browser.setWindowSize(1280, 900);
    await setStore({ emailRenderer: 'blitz', blitzGpu: false, viewStyle: 'list' });
    await switchToFolder(luke(), BLITZ_FOLDER);
  });

  it('the probe names the graphics card', async () => {
    const s = await rpc('render.gpuStatus', { refresh: true });
    expect(s.__error).toBeUndefined();
    expect(s.compiled).toBe(true);
    expect(s.probe?.ok).toBe(true);
    expect(s.probe?.backend).toBe('Metal');
  });

  it('draws on the CPU, then on the GPU, then on the CPU again, with no restart', async () => {
    await open(BLITZ_TALL_SUBJECT);
    await drawn();
    expect(workers().length).toBeGreaterThan(0);
    expect(workers().some((c) => c.includes('--gpu'))).toBe(false);

    await setStore({ blitzGpu: true });
    await open(BLITZ_THREAD_SUBJECT, true);
    await drawn();
    await browser.waitUntil(() => workers().some((c) => c.includes('--gpu')), { timeout: 15_000, timeoutMsg: 'no --gpu worker after the switch' });
    const on = await rpc('render.gpuStatus');
    expect(on.active).toBe(true);
    expect(on.broken).toBeNull();

    await setStore({ blitzGpu: false });
    await open(BLITZ_TALL_SUBJECT);
    await drawn();
    await browser.waitUntil(() => workers().some((c) => !c.includes('--gpu')), { timeout: 15_000, timeoutMsg: 'no CPU worker after switching back' });
    expect((await rpc('render.gpuStatus')).active).toBe(false);
  });

  after(async () => {
    try { await setStore({ emailRenderer: 'web', blitzGpu: false }); } catch { /* app gone */ }
  });
});
