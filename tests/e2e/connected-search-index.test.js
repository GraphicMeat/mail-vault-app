/**
 * E2E: vault search answers from the offline index, per account, and the
 * bodies toggle really changes what can be found.
 *
 * Anti-vacuity: the pre-index scan also finds body text, so "a body word was
 * found" proves nothing on its own. Every positive case also asserts
 * `matchedIn` (only index rows carry it), and the bodies-off case is a result
 * the scan could never produce.
 *
 * Every wait on the index is a wait on what search returns, not on the status
 * `state`: a configure or a rebuild reaches the worker through a channel, so
 * `idle` right after a click is still the pass before it.
 */
import { waitForApp, waitForEmails, switchToFolder, openSettings, closeSettings, clickSettingsNav } from './helpers.js';

const LUKE = 'luke@mock.test';
const VADER = 'vader@mock.test';
const LUKE_ID = '11111111-1111-4111-8111-111111111111';
const VADER_ID = '22222222-2222-4222-8222-222222222222';

describe('Search index', function () {
  this.timeout(300_000);
  let lukeSubject = null; // e.g. "Luke message 5"
  let vaderSubject = null;

  // ── Copied verbatim from connected-search-custody.test.js ──────────────
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
  // ────────────────────────────────────────────────────────────────────────

  /** An active search owns the list header, which `switchToFolder` waits on. */
  async function inboxOf(email) {
    await clearSearch();
    await switchToFolder(email, 'INBOX');
  }

  const indexStatus = () => browser.executeAsync((done) => {
    window.__TAURI_INTERNALS__.invoke('search_index_status', {}).then(done, (e) => done({ error: String(e) }));
  });

  const results = () => browser.execute(() => (window.__SEARCH_STORE__?.getState?.().searchResults || [])
    .map((r) => ({ subject: r.subject, accountId: r._accountId, matchedIn: r.matchedIn || null })));

  async function localSearch(query) {
    expect(await runLocalSearch(query, 'all')).toBe(true);
    await browser.waitUntil(searchSettled, { timeout: 30_000, interval: 200, timeoutMsg: `search "${query}" never settled` });
    return results();
  }

  /**
   * Search until the INDEX returns `subject` (only index rows carry `matchedIn`;
   * the scan answers until the first full pass, while status already reads
   * available); returns the hits of that search.
   */
  async function searchUntilFound(query, subject, what) {
    let hits = [];
    await browser.waitUntil(async () => {
      hits = await localSearch(query);
      return hits.some((r) => r.subject === subject && Array.isArray(r.matchedIn));
    }, { timeout: 60_000, interval: 1000, timeoutMsg: `the index never returned "${subject}" for "${query}" (${what})` });
    return hits;
  }

  async function waitIndexed(predicate, what) {
    await browser.waitUntil(async () => predicate(await indexStatus()), { timeout: 120_000, interval: 500, timeoutMsg: `index never ${what}` });
  }

  const bodyPhrase = (subject) => `body of ${subject.toLowerCase()}`; // "body of luke message 5"

  const toggleChecked = () => browser.execute(() =>
    document.querySelector('[data-testid="search-index-bodies"]')?.getAttribute('aria-checked') ?? null);

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

  before(async function () {
    await waitForApp();
    await waitForEmails();
    await switchToFolder(LUKE, 'INBOX');
    lukeSubject = await pickFresh(/Luke message \d+/);
    await archive(lukeSubject);
    await switchToFolder(VADER, 'INBOX');
    vaderSubject = await pickFresh(/Vader message \d+/);
    await archive(vaderSubject);
    await waitIndexed((s) => s.available === true && s.state === 'idle' && s.indexed >= 2, 'caught up with two archived messages');
  });

  after(async function () {
    // A case that failed mid-dialog must not leave Settings over the next spec.
    try { await closeSettings(); } catch { /* best effort */ }
    try { await clearSearch(); } catch { /* best effort */ }
    await browser.execute(() => {
      window.__SEARCH_INDEX_EVENTS_STOP__?.();
      window.__SETTINGS_STORE__?.getState?.().setSearchIndexBodies?.(true);
    });
    if (!lukeSubject) return; // `before` failed: nothing was turned off
    // Bodies back on reaches the worker through a channel. The next spec gets an
    // index that answers body text again, not one still re-parsing: `matchedIn`
    // tells an index answer from the scan's.
    await inboxOf(LUKE);
    await browser.waitUntil(async () => (await localSearch(bodyPhrase(lukeSubject)))
      .some((r) => r.subject === lukeSubject && (r.matchedIn || []).includes('body')), {
      timeout: 120_000, interval: 1000,
      timeoutMsg: `the index never found "${lukeSubject}" by its body again after the spec`,
    });
    await clearSearch();
  });

  it('is available and not the fallback scan', async function () {
    const s = await indexStatus();
    expect(s.available).toBe(true);
    expect(s.total).toBeGreaterThanOrEqual(s.indexed);
  });

  it('finds a luke message by a phrase that exists only in its body', async function () {
    await inboxOf(LUKE);
    const hits = await searchUntilFound(bodyPhrase(lukeSubject), lukeSubject, 'luke body');
    const hit = hits.find((r) => r.subject === lukeSubject);
    expect(hit.accountId).toBe(LUKE_ID);
    expect(hit.matchedIn).toContain('body');
    expect(hits.every((r) => r.accountId === LUKE_ID)).toBe(true);
  });

  it('keeps each account to its own vault (vader cannot find luke\'s body text, and finds its own)', async function () {
    await inboxOf(VADER);
    const own = await searchUntilFound(bodyPhrase(vaderSubject), vaderSubject, 'vader body');
    const hit = own.find((r) => r.subject === vaderSubject);
    expect(hit.accountId).toBe(VADER_ID);
    expect(hit.matchedIn).toContain('body');
    // After the positive search above, so the index is known to answer for vader.
    const lukeHits = await localSearch(bodyPhrase(lukeSubject));
    expect(lukeHits.find((r) => r.subject === lukeSubject)).toBeUndefined();
    expect(lukeHits.every((r) => r.accountId === VADER_ID)).toBe(true);
  });

  it('turning bodies off removes body matches but keeps subjects searchable', async function () {
    await openSettings();
    expect(await clickSettingsNav('Storage')).toBe(true);
    await browser.waitUntil(async () => (await toggleChecked()) !== null, { timeout: 10_000, timeoutMsg: 'bodies toggle never rendered' });
    expect(await toggleChecked()).toBe('true');
    await browser.execute(() => document.querySelector('[data-testid="search-index-bodies"]').click());
    await browser.waitUntil(async () => (await toggleChecked()) === 'false', { timeout: 5_000, timeoutMsg: 'bodies toggle never switched off' });
    await closeSettings();

    await inboxOf(LUKE);
    // The scan always reads bodies, so this can only go empty through the index.
    await browser.waitUntil(async () => !(await localSearch(bodyPhrase(lukeSubject))).some((r) => r.subject === lukeSubject), {
      timeout: 60_000, interval: 1000, timeoutMsg: 'body text was still found after turning bodies off',
    });
    const subjectHits = await searchUntilFound(lukeSubject, lukeSubject, 'subject with bodies off');
    expect(subjectHits.find((r) => r.subject === lukeSubject).matchedIn).toContain('subject');
  });

  it('turning bodies back on makes body text findable again', async function () {
    await browser.execute(() => window.__SETTINGS_STORE__.getState().setSearchIndexBodies(true));
    await inboxOf(LUKE);
    const hits = await searchUntilFound(bodyPhrase(lukeSubject), lukeSubject, 'body text after re-enabling');
    expect(hits.find((r) => r.subject === lukeSubject).matchedIn).toContain('body');
  });

  it('shows status in Settings and survives Rebuild', async function () {
    // A rebuild starts from an empty index, so a progress event reporting
    // indexed 0 is what proves the click did something: the searches below
    // would pass just as well against the index from before it.
    await browser.execute(() => {
      window.__SEARCH_INDEX_EVENTS__ = [];
      window.__TAURI__.event.listen('search-index-progress', (e) => window.__SEARCH_INDEX_EVENTS__.push(e.payload))
        .then((stop) => { window.__SEARCH_INDEX_EVENTS_STOP__ = stop; });
    });
    await browser.waitUntil(() => browser.execute(() => typeof window.__SEARCH_INDEX_EVENTS_STOP__ === 'function'), {
      timeout: 10_000, timeoutMsg: 'progress listener never registered',
    });

    await openSettings();
    expect(await clickSettingsNav('Storage')).toBe(true);
    // Rendered only once status() answers; counts carry locale separators.
    await browser.waitUntil(() => browser.execute(() =>
      /\d+ \/ \d+/.test(document.querySelector('[data-testid="search-index-status"]')?.textContent || '')), {
      timeout: 15_000, interval: 250, timeoutMsg: 'search-index-status never showed "N / M"',
    });
    await browser.waitUntil(() => browser.execute(() => {
      const btn = document.querySelector('[data-testid="search-index-rebuild"]');
      return !!btn && !btn.disabled;
    }), { timeout: 15_000, interval: 250, timeoutMsg: 'Rebuild never became enabled' });
    await browser.execute(() => document.querySelector('[data-testid="search-index-rebuild"]').click());

    await browser.waitUntil(() => browser.execute(() => {
      const events = window.__SEARCH_INDEX_EVENTS__ || [];
      const emptied = events.findIndex((e) => e.available === true && e.indexed === 0);
      return emptied >= 0 && events.slice(emptied).some((e) => e.state === 'idle' && e.indexed >= 2);
    }), { timeout: 120_000, interval: 500, timeoutMsg: 'no progress event showed the index emptied and refilled after Rebuild' });
    await closeSettings();

    await inboxOf(VADER);
    const own = await searchUntilFound(bodyPhrase(vaderSubject), vaderSubject, 'vader body after rebuild');
    expect(own.find((r) => r.subject === vaderSubject).matchedIn).toContain('body');
  });
});
