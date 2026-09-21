/**
 * E2E: opening a message from the search list marks it read, like opening it
 * anywhere else does.
 *
 * Reported 2026-09-21: "search opening first email from search list does not
 * trigger the delayed mark as read functionality." It was not about search.
 * `selectEmail` marks on open from the in-memory cache, from Graph and from
 * IMAP — and the branch that serves a body the VAULT already holds fell
 * straight through to the publish with no mark at all. A search hit is the
 * common way to land on that branch (the vault half of a search answers with
 * messages whose bodies are on disk), and an archived message is the other.
 * The first open did nothing; a reopen marked it, because by then the body was
 * in the memory cache, which is the path that always worked.
 *
 * The second half is what a person actually sees: `searchResults` is the one
 * list no flag write maps, so even a correctly marked message kept its bold
 * search row until the query was run again.
 *
 * Shape: archive a fresh unread message (its body is then in the vault),
 * RELOAD so nothing is in the memory cache, then find it with a vault-only
 * search and open the hit.
 */

import { waitForApp, waitForEmails, reloadApp, switchToFolder } from './helpers.js';

const LUKE = 'luke@mock.test';
const DELAY_SECONDS = 3;

describe('A search hit answered from the vault marks itself read', function () {
  this.timeout(240_000);

  let subject = null;

  const rows = () => browser.execute(() =>
    [...document.querySelectorAll('[data-testid="email-row"]')].map((row) => ({
      text: (row.innerText || '').replace(/\s*\n\s*/g, ' | ').trim(),
      unread: row.classList.contains('bg-mail-surface'),
      icon: row.querySelector('[data-testid="msg-state-icon"]')?.getAttribute('data-state') || null,
    })));

  const rowFor = async (needle) => (await rows()).find((r) => r.text.includes(needle));

  /**
   * Archive through the store, not through a control.
   *
   * Deliberate: archiving is this spec's SETUP, not its subject, and every
   * control that archives is currently addressed differently by every spec
   * that uses one — the selection bar's verbs are a QuickActions set with an
   * inline limit (so which of them are buttons at all depends on
   * configuration), and a synthetic click on the row's own `title="Archive"`
   * button does nothing from the harness. The same `saveEmailsLocally` call
   * those controls make does archive: proven on the runner, `archived: 1`,
   * icon `archived`. Driving it directly keeps this file failing only for the
   * behaviour it is about.
   */
  async function archiveRow(needle) {
    const outcome = await browser.executeAsync((want, done) => {
      const state = window.__MAIL_STORE__.getState();
      const row = (state.sortedEmails || []).find((e) => (e.subject || '') === want);
      if (!row) { done(`no row for ${want}`); return; }
      Promise.resolve(state.saveEmailsLocally([row]))
        .then(() => done('ok'), (error) => done(String((error && error.message) || error)));
    }, needle);
    expect(outcome).toBe('ok');
    await browser.waitUntil(async () => !!(await rowFor(needle))?.icon?.startsWith('archived'), {
      timeout: 60_000, interval: 500, timeoutMsg: `"${needle}" never became an archived row`,
    });
  }

  const clickRow = (needle) => browser.execute((want) => {
    for (const row of document.querySelectorAll('[data-testid="email-row"]')) {
      if (!(row.innerText || '').includes(want)) continue;
      row.click();
      return true;
    }
    return false;
  }, needle);

  /** The vault half only: the hit's body is on disk, which is the branch under test. */
  const runLocalSearch = (query) => browser.execute((q) => {
    const store = window.__SEARCH_STORE__;
    if (!store) return false;
    store.setState({ searchQuery: q });
    store.getState().setSearchFilters({ folder: 'all', location: 'local' });
    store.getState().performSearch();
    return true;
  }, query);

  const searchSettled = () => browser.execute(() => {
    const s = window.__SEARCH_STORE__?.getState?.();
    return !!s && s.searchActive === true && s.isSearching === false;
  });

  const clearSearch = () => browser.execute(() => {
    window.__SEARCH_STORE__?.getState?.().clearSearch?.();
  });

  /** The hit as the search store holds it — the flags the row is drawn from. */
  const resultFlags = (want) => browser.execute((needle) => {
    const hit = (window.__SEARCH_STORE__?.getState?.().searchResults || [])
      .find((r) => (r.subject || '').includes(needle));
    return hit ? (hit.flags || []) : null;
  }, want);

  /** The flags the LIST holds for a subject — the row's own read state. */
  const storeFlags = (want) => browser.execute((needle) => {
    const state = window.__MAIL_STORE__.getState();
    const row = [...state.sortedEmails || [], ...state.localEmails || []]
      .find((e) => (e.subject || '').includes(needle));
    return row ? (row.flags || []) : null;
  }, want);

  const markReadCountdown = () => browser.execute(() =>
    window.__MAIL_STORE__?.getState?.().markReadProgress || null);

  const selectedIsSeen = () => browser.execute(() =>
    (window.__MAIL_STORE__?.getState?.().selectedEmail?.flags || []).includes('\\Seen'));

  before(async function () {
    await waitForApp();
    await waitForEmails();
    await switchToFolder(LUKE, 'INBOX');

    // The app's own default, restated because a spec that ran before this one
    // may have changed it: the countdown is the half of the report that names
    // a delay.
    await browser.execute((seconds) => {
      const settings = window.__SETTINGS_STORE__?.getState?.();
      settings?.setMarkAsReadMode?.('delay');
      settings?.setMarkAsReadDelay?.(seconds);
    }, DELAY_SECONDS);

    // Oldest first, the convention the other custody specs follow, so the
    // newest fixtures stay free. Unread, and not already claimed by a spec
    // that archived or emptied it.
    // On screen AND unread. The list is virtualized, so a subject the store
    // holds is not necessarily a row anything can click; and which class means
    // "unread" depends on the row style, so the flags come from the store.
    const fresh = await browser.execute(() => {
      const state = window.__MAIL_STORE__.getState();
      const unread = new Set((state.sortedEmails || [])
        .filter((e) => !(e.flags || []).includes('\\Seen') && !e.isArchived && e.source !== 'local-only')
        .map((e) => e.subject));
      return [...document.querySelectorAll('[data-testid="email-row"]')]
        .map((row) => ((row.innerText || '').match(/Luke message \d+/) || [null])[0])
        .filter((subject) => subject && unread.has(subject));
    });
    expect(fresh.length).toBeGreaterThan(0);
    // Oldest of the rendered window, so the newest fixtures stay free.
    subject = fresh[fresh.length - 1];

    // Archive puts the body in the vault. It is not an open, so the message
    // stays unread — which the assertion below depends on.
    await archiveRow(subject);
    expect(await storeFlags(subject)).not.toContain('\\Seen');

    // The memory cache is what made a REOPEN work while the first open did
    // nothing. A reload empties it, so the click below is a genuine first open.
    await reloadApp();
    await waitForEmails();
    await switchToFolder(LUKE, 'INBOX');
  });

  after(async function () {
    try { await clearSearch(); } catch { /* best effort */ }
  });

  it('starts the read countdown and marks the message read', async function () {
    expect(await runLocalSearch(subject)).toBe(true);
    await browser.waitUntil(searchSettled, {
      timeout: 60_000, interval: 300, timeoutMsg: `The vault search for "${subject}" never finished`,
    });
    await browser.waitUntil(async () => !!(await rowFor(subject)), {
      timeout: 60_000, interval: 300, timeoutMsg: `The search never rendered a row for "${subject}"`,
    });
    // Unread when it was found: nothing here has opened it yet.
    expect(await resultFlags(subject)).not.toContain('\\Seen');

    expect(await clickRow(subject)).toBe(true);

    // The delay itself — the word the report used. A mark that happened
    // instantly would also satisfy the assertion below, and would be a
    // different behaviour from the one the setting promises.
    await browser.waitUntil(async () => !!(await markReadCountdown()), {
      timeout: 30_000, interval: 100,
      timeoutMsg: 'Opening the search hit never started the mark-as-read countdown',
    });

    await browser.waitUntil(selectedIsSeen, {
      timeout: 30_000, interval: 300,
      timeoutMsg: `"${subject}" never became read after the delay`,
    });
  });

  it('repaints the search row itself, without rerunning the query', async function () {
    // `searchResults` is the one list every flag write used to miss, so the
    // row stayed bold over a message the rest of the app had marked read.
    await browser.waitUntil(async () => (await resultFlags(subject) || []).includes('\\Seen'), {
      timeout: 30_000, interval: 300,
      timeoutMsg: `The search row for "${subject}" kept the read state it was found with`,
    });
    // The rendered class cannot say it: an OPEN row is the selected row, and
    // the selected ground replaces the unread one. The flags the row is drawn
    // from are the honest handle, and they are what stayed stale.
    expect(await rowFor(subject)).toBeTruthy();
  });
});
