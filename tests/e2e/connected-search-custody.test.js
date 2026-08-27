/**
 * E2E: a message you find through search is the same message you left in the
 * folder list, gold and all.
 *
 * Only-Copy Gold is the loudest claim the app makes, and it requires proof:
 * `_origin` / `serverDeleted` / `serverAbsent`, all three of which live in that
 * mailbox's local-index.json. Search built every row from `db.getLocalEmails`,
 * which reads .eml headers and deliberately never opens that file — so a
 * message MailVault had proved was the last copy left rendered gold in its
 * folder and plain grey one query away. Search is exactly where someone looks
 * for a message they are afraid has gone.
 *
 * Two halves, and the second is the one that is easy to miss: even with the
 * proof stamped on, `searchLocalEmails` finished by writing a flat
 * `source: 'local'` over every row, and `describeMessageState` reads
 * `email.source` FIRST — falling back to `custodySource` only when the field is
 * absent. So the constant outranked the proof and nothing changed on screen.
 *
 * Both scopes are exercised because they are different code paths: "this
 * folder" reads one mailbox, "all folders" walks every vault directory and
 * reads each one's index in turn.
 *
 * The ordinary archived message is not decoration. A fix that stamped gold on
 * every vault row would satisfy the first assertion and be far worse than the
 * bug; the grey row is what says the proof is still doing the deciding.
 */

import { waitForApp, waitForEmails, switchToFolder } from './helpers.js';

const LUKE = 'luke@mock.test';

describe('Search results carry their custody proof', function () {
  this.timeout(240000);

  // The message whose server copy this app destroys — proof `we-deleted`.
  let goldSubject = null;
  // Archived and nothing more: still on the server, and must stay grey.
  let plainSubject = null;

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

  /** Archive, then destroy the server copy through the app — leaves `serverDeleted`. */
  async function archiveAndDeleteFromServer(subject) {
    await archive(subject);
    expect(await clickRowCheckbox(subject)).toBe(true);
    expect(await clickBarButton('Delete from server')).toBe(true);
    // The confirmation's own button, told apart from the bar's by the title the
    // bar buttons carry and the popover's do not.
    const confirmed = await browser.execute(() => {
      for (const btn of document.querySelectorAll('button')) {
        const label = (btn.textContent || '').trim();
        const isConfirm = label === 'Delete' || label === 'Delete from server';
        if (isConfirm && btn.offsetHeight > 0 && !btn.getAttribute('title')) { btn.click(); return true; }
      }
      return false;
    });
    expect(confirmed).toBe(true);
    await browser.waitUntil(async () => !!(await rowFor(subject))?.icon?.startsWith('local-only'), {
      timeout: 60_000, interval: 500,
      timeoutMsg: `"${subject}" never went gold in the folder list — nothing to search for yet`,
    });
  }

  /**
   * Search the vault only. `location: 'local'` is the half this change touches:
   * it skips the in-memory list and the server, so every rendered row came out
   * of `db.searchLocalEmails` and nothing else can be supplying the verdict.
   */
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

  /** What the row the search produced actually carries, before any rendering. */
  const resultFor = (subject) => browser.execute((want) => {
    const hit = (window.__SEARCH_STORE__?.getState?.().searchResults || [])
      .find((r) => r.subject === want);
    return hit
      ? { source: hit.source ?? null, serverDeleted: hit.serverDeleted === true, isArchived: !!hit.isArchived }
      : null;
  }, subject);

  /** The icon the search RESULT row renders — the claim a person actually sees. */
  async function searchedIcon(query, folder, subject) {
    expect(await runLocalSearch(query, folder)).toBe(true);
    await browser.waitUntil(searchSettled, {
      timeout: 30_000, interval: 200,
      timeoutMsg: `Search (${folder}) for "${query}" never finished`,
    });
    await browser.waitUntil(async () => !!(await rowFor(subject)), {
      timeout: 30_000, interval: 300,
      timeoutMsg: `Search (${folder}) never rendered a row for "${subject}"`,
    });
    return (await rowFor(subject)).icon;
  }

  before(async function () {
    await waitForApp();
    await waitForEmails();
    await switchToFolder(LUKE, 'INBOX');

    // Two messages nothing else in the suite has claimed: neither already in
    // the vault (`saveEmailLocally` fails outright on a message the vault has
    // cached) nor already proven by an earlier spec. Oldest first, the way the
    // other custody specs pick, so the newest fixtures stay free.
    const fresh = (await rows()).filter((r) =>
      /Luke message \d+/.test(r.text) && !r.icon?.startsWith('archived') && !r.icon?.startsWith('local-only'));
    expect(fresh.length).toBeGreaterThan(1);
    goldSubject = fresh[fresh.length - 1].text.match(/Luke message \d+/)[0];
    plainSubject = fresh[fresh.length - 2].text.match(/Luke message \d+/)[0];

    await archiveAndDeleteFromServer(goldSubject);
    await archive(plainSubject);
  });

  after(async function () {
    try { await clearSearch(); } catch { /* best effort */ }
  });

  it('keeps a proven message gold when it is found in this folder', async function () {
    expect(await searchedIcon(goldSubject, 'current', goldSubject)).toMatch(/^local-only/);

    // The proof itself reached the row, not just a colour that happens to match.
    const hit = await resultFor(goldSubject);
    expect(hit).toBeTruthy();
    expect(hit.serverDeleted).toBe(true);
    // The field `describeMessageState` reads before it falls back to anything —
    // a flat 'local' here is what made the stamp invisible.
    expect(hit.source).toBe('local-only');
  });

  it('keeps it gold across an all-folders search, which walks every vault directory', async function () {
    expect(await searchedIcon(goldSubject, 'all', goldSubject)).toMatch(/^local-only/);
    expect((await resultFor(goldSubject)).source).toBe('local-only');
  });

  it('still finds it gold after a reload — the proof came off disk, not the session', async function () {
    // The stamp lives on the vault's index entry, and the rows search is built
    // from are rebuilt from that file on every read. A verdict that only existed
    // in the session would survive the two searches above and die here, which is
    // the same silence the original bug produced.
    await browser.execute(() => window.location.reload());
    await waitForApp();
    await waitForEmails();
    await switchToFolder(LUKE, 'INBOX');

    expect(await searchedIcon(goldSubject, 'all', goldSubject)).toMatch(/^local-only/);
    expect((await resultFor(goldSubject)).serverDeleted).toBe(true);
  });

  it('leaves an ordinary vault copy grey — the proof is still what decides', async function () {
    const icon = await searchedIcon(plainSubject, 'all', plainSubject);
    expect(icon).toMatch(/^archived/);
    expect(icon).not.toMatch(/^local-only/);

    const hit = await resultFor(plainSubject);
    expect(hit.isArchived).toBe(true);
    expect(hit.serverDeleted).toBe(false);
    expect(hit.source).toBe('local');
  });
});
