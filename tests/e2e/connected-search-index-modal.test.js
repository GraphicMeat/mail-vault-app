/**
 * A first build over a real backlog shows a corner chip, never a blocking modal;
 * the chip opens the details modal, Hide goes back to the chip, both close when the build completes.
 */
import { waitForApp } from './helpers.js';

describe('Search index progress chip', function () {
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

  it('shows a chip, not a modal, for a first build over the 2,000 seeded messages', async function () {
    await browser.waitUntil(() => visible('search-index-chip'), { timeout: 60_000, interval: 250, timeoutMsg: 'the progress chip never showed' });
    expect(await visible('search-index-progress-modal')).toBe(false);
    expect(await browser.execute(() => document.querySelector('[data-testid="search-index-chip"]').innerText)).toMatch(/\d+%/);
    const s = await status();
    expect(s.state).toBe('indexing');
    expect(s.firstPassDone).toBe(false);
    expect(s.total).toBeGreaterThanOrEqual(2000); // anti-vacuity: the seed ran
  });

  it('the chip opens the modal and Hide goes back to the chip', async function () {
    await click('search-index-chip');
    await browser.waitUntil(() => visible('search-index-progress-modal'), { timeout: 10_000, interval: 200, timeoutMsg: 'the chip did not open the modal' });
    await click('search-index-progress-hide');
    await browser.waitUntil(async () => !(await visible('search-index-progress-modal')) && (await visible('search-index-chip')),
      { timeout: 10_000, interval: 200, timeoutMsg: 'Hide did not go back to the chip' });
  });

  it('modal and chip close when the build completes', async function () {
    await browser.waitUntil(async () => { const s = await status(); return s.firstPassDone === true && s.complete === true; },
      { timeout: 180_000, interval: 1000, timeoutMsg: 'the first build never completed' });
    await browser.waitUntil(async () => !(await visible('search-index-progress-modal')) && !(await visible('search-index-chip')),
      { timeout: 10_000, interval: 200, timeoutMsg: 'the progress UI stayed after completion' });
  });
});
