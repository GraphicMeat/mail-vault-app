/**
 * E2E: attachment search finds text inside a plain-text attachment when the
 * attachments toggle and premium are both on.
 *
 * Anti-vacuity: `ATTACHMENT_SEARCH_TOKEN` appears ONLY inside the attachment
 * — never in the subject or body (see `seedAttachmentSearchMessage` in
 * mockImap.js) — so a hit proves the `attach` FTS column matched, not
 * `subject`/`body`/`from`/`to`. `assemble_rows` (src-tauri/src/search_index.rs)
 * only ever labels `matchedIn` from those four fields, never `attach`, so the
 * assertion is: the row comes back, and `matchedIn` is empty.
 *
 * The seed is pre-boot (`seedAttachmentSearchMessage`, wired in wdio.conf.js
 * `beforeSession`): the search-index sweep that discovers it runs during app
 * setup, same as every other Maildir-seed spec in this suite.
 *
 * Settings nav id: `SettingsPage.jsx` registers the search-index UI under tab
 * id `'storage'` (`{ id: 'storage', labelKey: 'settings.tab.storage', ... }`,
 * rendering `StorageSettings` → `SearchIndexSettings`), and `clickSettingsNav`
 * matches by the tab's rendered TEXT, not its id — `connected-search-index.
 * test.js` reaches the same tab with `clickSettingsNav('Storage')`. (An
 * earlier draft of this spec guessed `clickSettingsNav('vault')`, which does
 * not exist.)
 *
 * Search itself is driven the same way `connected-search-index.test.js` does
 * it — direct calls into `window.__SEARCH_STORE__` — copied verbatim from
 * that file's own "copied verbatim from connected-search-custody" block,
 * rather than typing into a DOM input: this codebase has no
 * `[data-testid="search-input"]` (that selector, from an earlier draft, does
 * not exist — the real search box is `[data-testid="mail-search-input"]`,
 * and the index spec bypasses it entirely to avoid IME/debounce timing).
 */
import { waitForApp, waitForEmails, switchToFolder, openSettings, closeSettings, clickSettingsNav } from './helpers.js';
import { setPremium } from './mockBilling.js';
import { ATTACHMENT_SEARCH_SUBJECT, ATTACHMENT_SEARCH_TOKEN } from './mockImap.js';

const LUKE = 'luke@mock.test';

describe('Attachment search', function () {
  this.timeout(300_000);

  // ── Copied verbatim from connected-search-index.test.js ──────────────────
  const runLocalSearch = (query, folder) => browser.execute((q, f) => {
    const store = window.__SEARCH_STORE__;
    if (!store) return false;
    store.setState({ searchQuery: q });
    store.getState().setSearchFilters({ folder: f, location: 'local' });
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

  const results = () => browser.execute(() => (window.__SEARCH_STORE__?.getState?.().searchResults || [])
    .map((r) => ({ subject: r.subject, matchedIn: r.matchedIn || null })));

  async function localSearch(query) {
    expect(await runLocalSearch(query, 'all')).toBe(true);
    await browser.waitUntil(searchSettled, { timeout: 30_000, interval: 200, timeoutMsg: `search "${query}" never settled` });
    return results();
  }

  const indexStatus = () => browser.executeAsync((done) => {
    window.__TAURI_INTERNALS__.invoke('search_index_status', {}).then(done, (e) => done({ error: String(e) }));
  });

  const toggleChecked = () => browser.execute(() =>
    document.querySelector('[data-testid="search-index-attachments"]')?.getAttribute('aria-checked') ?? null);
  // ──────────────────────────────────────────────────────────────────────────

  before(async function () {
    await waitForApp();
    await waitForEmails();
    // The toggle defaults to true (settingsStore.js), so premium is the only
    // thing missing: `effectiveSearchIndexConfig` (useSearchIndexConfig.js)
    // gates `attachments` on `hasPremiumAccess(billingProfile) && toggle`.
    await setPremium(true);
  });

  after(async function () {
    try { await closeSettings(); } catch { /* best effort */ }
    try { await clearSearch(); } catch { /* best effort */ }
    await setPremium(false);
  });

  it('shows the attachments toggle on by default', async function () {
    await openSettings();
    expect(await clickSettingsNav('Storage')).toBe(true);
    await browser.waitUntil(async () => (await toggleChecked()) !== null, { timeout: 10_000, timeoutMsg: 'attachments toggle never rendered' });
    expect(await toggleChecked()).toBe('true');
    await closeSettings();
  });

  it('finds a word that exists only inside a text attachment', async function () {
    await switchToFolder(LUKE, 'INBOX');

    let hits = [];
    await browser.waitUntil(async () => {
      hits = await localSearch(ATTACHMENT_SEARCH_TOKEN);
      return hits.some((r) => r.subject === ATTACHMENT_SEARCH_SUBJECT);
    }, {
      timeout: 120_000, interval: 1000,
      timeoutMsg: `the index never found "${ATTACHMENT_SEARCH_SUBJECT}" by its attachment text`,
    });

    const hit = hits.find((r) => r.subject === ATTACHMENT_SEARCH_SUBJECT);
    // The token is in neither subject nor body: an empty matchedIn is what
    // proves the hit came from the attachment column, not a false positive.
    expect(hit.matchedIn).toEqual([]);
  });

  it('the index reports attachments as available once configured', async function () {
    const s = await indexStatus();
    expect(s.available).toBe(true);
  });
});
