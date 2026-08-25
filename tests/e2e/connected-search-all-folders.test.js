/**
 * E2E: "All folders" searches all folders on the server, not just INBOX.
 *
 * Reported by bson73 (discussion #1): 59 nested folders, and a backup that
 * looked smaller than his server. One search had two meanings of "all" — the
 * vault half walked every folder, the server half SELECTed INBOX and stopped —
 * under a results header that said "in all folders". A message that lives in a
 * nested folder and was never backed up therefore read as a message that isn't
 * there.
 *
 * The fixture is luke: INBOX holds "Luke message N", Archive holds
 * "Luke archive N". The spec searches from INBOX for an Archive subject with
 * location 'server', so neither the in-memory INBOX headers nor the local vault
 * can answer — only a server search that leaves INBOX can. Before the fix this
 * returns nothing at all.
 */

import { waitForApp, waitForEmails, switchToFolder } from './helpers.js';

const ACCOUNT = 'luke@mock.test';
const ARCHIVE_SUBJECT = 'Luke archive 2';

/** Search with an explicit scope, the way the filter dropdown sets it. */
const searchScoped = (query, filters) => browser.execute(async (q, f) => {
  const store = window.__SEARCH_STORE__;
  if (!store) return false;
  store.setState({ searchQuery: q });
  store.getState().setSearchFilters(f);
  await store.getState().performSearch();
  return true;
}, query, filters);

const resultRow = (subject) => browser.execute((want) => {
  const rows = window.__SEARCH_STORE__?.getState?.().searchResults || [];
  const hit = rows.find((r) => r.subject === want);
  return hit ? { uid: hit.uid, mailbox: hit._mailbox || null, source: hit.source || null } : null;
}, subject);

const viewerState = () => browser.execute(() => {
  const s = window.__MAIL_STORE__?.getState?.();
  const e = s?.selectedEmail;
  return {
    loading: !!s?.loadingEmail,
    subject: e?.subject || null,
    body: e ? (e.text || e.textBody || e.html || e.htmlBody || '') : '',
    page: document.body.innerText || '',
  };
});

const clickRow = (subject) => browser.execute((want) => {
  for (const row of document.querySelectorAll('[data-testid="email-row"]')) {
    const lines = (row.innerText || '').split('\n').map((l) => l.trim());
    if (lines.includes(want)) { row.click(); return true; }
  }
  return false;
}, subject);

describe('Connected Search — "all folders" means all folders', function () {
  this.timeout(180_000);

  before(async function () {
    await waitForApp();
    await waitForEmails();
    // INBOX, deliberately: the whole bug is that the server search never left
    // the folder it was pinned to, and INBOX is that folder.
    await switchToFolder(ACCOUNT, 'INBOX');
  });

  it('finds a message that lives outside INBOX', async function () {
    await browser.waitUntil(
      async () => await searchScoped(ARCHIVE_SUBJECT, { folder: 'all', location: 'server' }),
      { timeout: 20_000, interval: 500, timeoutMsg: 'Search store never became available' },
    );
    await browser.waitUntil(async () => (await resultRow(ARCHIVE_SUBJECT)) !== null, {
      timeout: 60_000,
      interval: 500,
      timeoutMsg: `"${ARCHIVE_SUBJECT}" never appeared — the server search never left INBOX`,
    });

    const hit = await resultRow(ARCHIVE_SUBJECT);
    expect(hit.source).toBe('server-search');
    // And it names the folder it was found in, not the selected one.
    expect(hit.mailbox).not.toBe('INBOX');
    expect((hit.mailbox || '').toLowerCase()).toContain('archive');
  });

  it('opens that hit as its own message', async function () {
    await browser.waitUntil(async () => await clickRow(ARCHIVE_SUBJECT), {
      timeout: 20_000, interval: 400,
      timeoutMsg: `Search never rendered a row titled "${ARCHIVE_SUBJECT}"`,
    });
    await browser.waitUntil(async () => {
      const v = await viewerState();
      return !v.loading && (v.body.length > 0 || v.page.includes('no longer in'));
    }, { timeout: 30_000, interval: 400, timeoutMsg: 'Viewer never settled on a body or an error' });

    const v = await viewerState();
    expect(v.subject).toBe(ARCHIVE_SUBJECT);
    expect(v.body.toLowerCase()).toContain('luke archive 2');
    expect(v.page).not.toContain('no longer in');
  });

  it('still searches only the active folder when the scope is "current"', async function () {
    // The results list replaces the folder header while a search is active, so
    // clear it before asking the sidebar to move: opening the Archive hit above
    // may have left the store holding Archive headers, and step 1 of a search
    // reads whatever is in memory.
    await browser.execute(() => window.__SEARCH_STORE__?.getState?.().clearSearch?.());
    await switchToFolder(ACCOUNT, 'INBOX');
    await searchScoped(ARCHIVE_SUBJECT, { folder: 'current', location: 'server' });
    // A scoped search that quietly widened would be the same lie in reverse.
    await browser.pause(1_000);
    expect(await resultRow(ARCHIVE_SUBJECT)).toBe(null);

    await searchScoped('Luke message 3', { folder: 'current', location: 'server' });
    await browser.waitUntil(async () => (await resultRow('Luke message 3')) !== null, {
      timeout: 30_000, interval: 500, timeoutMsg: 'Current-folder search found nothing in INBOX',
    });
    expect((await resultRow('Luke message 3')).mailbox).toBe('INBOX');
  });

  after(async function () {
    await browser.execute(() => {
      window.__SEARCH_STORE__?.getState?.().clearSearch?.();
      window.__SEARCH_STORE__?.setState?.({ searchActive: false, searchResults: [], searchQuery: '' });
    });
  });
});
