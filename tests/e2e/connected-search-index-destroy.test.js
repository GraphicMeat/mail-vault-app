/**
 * Spec 2026-09-14 §5.5: Delete removes the index files and turns indexing off;
 * search keeps working through the vault scan; Build brings the modal back.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { waitForApp, waitForEmails, switchToFolder, openSettings, closeSettings, clickSettingsNav } from './helpers.js';
import { appDataDir } from './mockImap.js';

const LUKE = 'luke@mock.test';

describe('Search index destroy', function () {
  this.timeout(300_000);
  let lukeSubject = null;

  // Copied verbatim from tests/e2e/connected-search-index.test.js:
  // `rows`, `rowFor`, `clickRowCheckbox`, `clickBarButton`, `archive`, `runLocalSearch`,
  // `searchSettled`, `clearSearch`, `inboxOf`, `results`, `localSearch`, `pickFresh`.
  // Copied unchanged; do NOT copy `indexStatus` (replaced by `status` below).
  const rows = () => browser.execute(() =>
    [...document.querySelectorAll('[data-testid="email-row"]')].map((row) => ({
      text: (row.innerText || '').replace(/\s*\n\s*/g, ' | ').trim(),
      icon: row.querySelector('[data-testid="msg-state-icon"]')?.getAttribute('data-state') || null,
    })));

  const rowFor = async (subject) => (await rows()).find((r) => r.text.includes(subject));

  const clickRowCheckbox = (subject) => browser.execute((needle) => {
    for (const row of document.querySelectorAll('[data-testid="email-row"]')) {
      if (!(row.innerText || '').includes(needle)) continue;
      const box = row.querySelector('input[type="checkbox"]');
      if (!box) return false;
      box.click();
      return true;
    }
    return false;
  }, subject);

  const clickBarButton = (title) => browser.execute((t) => {
    const btn = document.querySelector(`button[title="${t}"]`);
    if (!btn || btn.offsetHeight === 0) return false;
    btn.click();
    return true;
  }, title);

  async function archive(subject) {
    expect(await clickRowCheckbox(subject)).toBe(true);
    expect(await clickBarButton('Archive selected')).toBe(true);
    await browser.waitUntil(async () => !!(await rowFor(subject))?.icon?.startsWith('archived'), {
      timeout: 60_000, interval: 300,
      timeoutMsg: `"${subject}" never became an archived row`,
    });
  }

  const runLocalSearch = (query, folder) => browser.execute((q, f) => {
    const store = window.__SEARCH_STORE__;
    if (!store) return false;
    store.setState({ searchQuery: q });
    store.getState().setSearchFilters({ folder: f, location: 'local' });
    // Started, not awaited: this harness hands an async `execute` callback's
    // Promise back unresolved (it arrives as `{}`), so the settle is waited for
    // against the store below rather than returned from in here.
    store.getState().performSearch();
    return true;
  }, query, folder);

  const searchSettled = () => browser.execute(() => {
    const s = window.__SEARCH_STORE__?.getState?.();
    return !!s && s.searchActive === true && s.isSearching === false;
  });

  const clearSearch = () => browser.execute(() => {
    window.__SEARCH_STORE__?.getState?.().clearSearch?.();
  });

  /** An active search owns the list header, which `switchToFolder` waits on. */
  async function inboxOf(email) {
    await clearSearch();
    await switchToFolder(email, 'INBOX');
  }

  const results = () => browser.execute(() => (window.__SEARCH_STORE__?.getState?.().searchResults || [])
    .map((r) => ({ subject: r.subject, accountId: r._accountId, matchedIn: r.matchedIn || null })));

  async function localSearch(query) {
    expect(await runLocalSearch(query, 'all')).toBe(true);
    await browser.waitUntil(searchSettled, { timeout: 30_000, interval: 200, timeoutMsg: `search "${query}" never settled` });
    return results();
  }

  /**
   * A message nothing else has archived. Third-oldest, because
   * connected-search-custody claims the two oldest Luke rows. The phrase for
   * "Luke message 1" is also a substring of "Luke message 12"'s body, so every
   * assertion below matches the exact subject, never a count.
   */
  async function pickFresh(pattern) {
    const fresh = (await rows()).filter((r) =>
      pattern.test(r.text) && !r.icon?.startsWith('archived') && !r.icon?.startsWith('local-only'));
    expect(fresh.length).toBeGreaterThan(2);
    return fresh[fresh.length - 3].text.match(pattern)[0];
  }
  // ────────────────────────────────────────────────────────────────────────

  const status = () => browser.executeAsync((done) => {
    window.__TAURI_INTERNALS__.invoke('daemon_rpc', { method: 'search_index_status', params: {} }).then(done, (e) => done({ error: String(e) }));
  });
  const visible = (id) => browser.execute((i) => { const el = document.querySelector(`[data-testid="${i}"]`); return !!el && el.offsetHeight > 0; }, id);
  const indexFiles = () => ['', '-wal', '-shm'].map((s) => join(appDataDir(browser.testDataDir), 'search_index', `index.db${s}`)).filter(existsSync);

  before(async function () {
    await waitForApp();
    // The seeded build first: its progress modal would cover the rows the archive clicks.
    await browser.waitUntil(async () => { const s = await status(); return s.firstPassDone === true && s.complete === true; },
      { timeout: 150_000, interval: 1000, timeoutMsg: 'the seeded build never completed' });
    await browser.waitUntil(async () => !(await visible('search-index-progress-modal')), { timeout: 10_000, timeoutMsg: 'progress modal stayed open' });
    await waitForEmails();
    await switchToFolder(LUKE, 'INBOX');
    lukeSubject = await pickFresh(/Luke message \d+/);
    await archive(lukeSubject);
    expect(lukeSubject).toBeTruthy();
  });

  after(async function () {
    await closeSettings().catch(() => {});
  });

  it('Delete asks first, then removes the files and reports off', async function () {
    expect(indexFiles().length).toBeGreaterThan(0);
    await openSettings();
    expect(await clickSettingsNav('Storage')).toBe(true);
    await browser.waitUntil(() => visible('search-index-delete'), { timeout: 10_000, timeoutMsg: 'Delete button never rendered' });
    await browser.execute(() => document.querySelector('[data-testid="search-index-delete"]').click());
    await browser.waitUntil(() => browser.execute(() => !!document.querySelector('[role="alertdialog"]')), { timeout: 5_000, timeoutMsg: 'no confirm dialog' });
    expect((await status()).state).not.toBe('off'); // nothing happens before Confirm
    await browser.execute(() => { const b = document.querySelectorAll('[role="alertdialog"] button'); b[b.length - 1].click(); });
    // Both status() "off" and Settings' off row (search-index-off/Build) read
    // the `searchIndexEnabled` store flag, which SearchIndexSettings.jsx flips
    // to false BEFORE it awaits destroy() — so neither proves the files are
    // gone or that the reply was ok, not busy/failed (review 1.11 I2). Wait on
    // real evidence instead: the files gone, AND the confirm dialog closed
    // with no error shown (an ok reply, not busy/failed re-showing the row).
    try {
      await browser.waitUntil(
        async () => indexFiles().length === 0
          && !(await browser.execute(() => !!document.querySelector('[role="alertdialog"]')))
          && !(await visible('search-index-error')),
        { timeout: 10_000, interval: 250, timeoutMsg: 'index files never disappeared, or the confirm dialog/error never cleared' },
      );
    } catch (e) {
      console.log('[destroy spec] still present after Confirm:', indexFiles()); // failure detail, outside the polled condition
      throw e;
    }
    expect(indexFiles()).toEqual([]);
    await browser.waitUntil(() => visible('search-index-off'), { timeout: 5_000, timeoutMsg: 'Settings never said the index is off' });
    expect((await status()).state).toBe('off');
    await closeSettings();
  });

  it('search still finds the archived message through the vault scan', async function () {
    await inboxOf(LUKE);
    await browser.waitUntil(async () => (await localSearch(lukeSubject)).some((r) => r.subject === lukeSubject && r.matchedIn === null),
      { timeout: 60_000, interval: 1000, timeoutMsg: 'the scan fallback did not find the archived message' });
    expect(indexFiles()).toEqual([]); // a search must not recreate the index
  });

  it('Build turns indexing back on and the progress modal returns', async function () {
    await openSettings();
    expect(await clickSettingsNav('Storage')).toBe(true);
    await browser.waitUntil(() => visible('search-index-build'), { timeout: 10_000, timeoutMsg: 'Build button never rendered' });
    await browser.execute(() => document.querySelector('[data-testid="search-index-build"]').click());
    await closeSettings();
    await browser.waitUntil(() => visible('search-index-progress-modal'), { timeout: 60_000, interval: 250, timeoutMsg: 'Build did not bring the progress modal back' });
    expect((await status()).firstPassDone).toBe(false);
  });
});
