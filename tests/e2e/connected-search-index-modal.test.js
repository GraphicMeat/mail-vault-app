/**
 * Spec 2026-09-14 §5.6: a first build over a real backlog opens the progress
 * modal; Hide minimizes it to a chip; both close when the build completes.
 */
import { waitForApp } from './helpers.js';

describe('Search index progress modal', function () {
  this.timeout(240_000);

  const visible = (id) => browser.execute((i) => {
    const el = document.querySelector(`[data-testid="${i}"]`);
    return !!el && el.offsetHeight > 0;
  }, id);
  const click = (id) => browser.execute((i) => { document.querySelector(`[data-testid="${i}"]`).click(); return true; }, id);
  const status = () => browser.executeAsync((done) => {
    window.__TAURI_INTERNALS__.invoke('daemon_rpc', { method: 'search_index_status', params: {} }).then(done, (e) => done({ error: String(e) }));
  });

  before(async function () {
    await waitForApp();
  });

  it('opens for a first build over the 2,000 seeded messages', async function () {
    await browser.waitUntil(() => visible('search-index-progress-modal'), { timeout: 60_000, interval: 250, timeoutMsg: 'the progress modal never opened' });
    const s = await status();
    expect(s.state).toBe('indexing');
    expect(s.firstPassDone).toBe(false);
    expect(s.total).toBeGreaterThanOrEqual(2000); // anti-vacuity: the seed ran
  });

  it('Hide minimizes it to a chip that shows the percent', async function () {
    await click('search-index-progress-hide');
    await browser.waitUntil(async () => !(await visible('search-index-progress-modal')) && (await visible('search-index-chip')),
      { timeout: 10_000, interval: 200, timeoutMsg: 'Hide did not minimize to the chip' });
    expect(await browser.execute(() => document.querySelector('[data-testid="search-index-chip"]').innerText)).toMatch(/\d+%/);
  });

  it('the chip reopens the modal', async function () {
    await click('search-index-chip');
    await browser.waitUntil(() => visible('search-index-progress-modal'), { timeout: 10_000, interval: 200, timeoutMsg: 'the chip did not reopen the modal' });
    await click('search-index-progress-hide');
  });

  it('modal and chip close when the build completes', async function () {
    await browser.waitUntil(async () => { const s = await status(); return s.firstPassDone === true && s.complete === true; },
      { timeout: 180_000, interval: 1000, timeoutMsg: 'the first build never completed' });
    await browser.waitUntil(async () => !(await visible('search-index-progress-modal')) && !(await visible('search-index-chip')),
      { timeout: 10_000, interval: 200, timeoutMsg: 'the progress UI stayed after completion' });
  });
});
