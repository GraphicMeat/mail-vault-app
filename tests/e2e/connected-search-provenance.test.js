/**
 * E2E: a search hit opens the message that matched, not the same UID in the
 * folder that happens to be selected.
 *
 * Reported by bson73 (discussion #1) against v2.10.1: searching found his
 * mail, clicking it said
 *   "Message UID 34 is no longer in INBOX.Archive.Projekt Nystart.Lieferanten.CRM Centralstation"
 * — and that folder is the one his SIDEBAR had selected, not the one the hit
 * lives in. Search results carried no `_mailbox`, so `resolveEmailLocation`
 * fell back to `activeMailbox` and the fetch went to the wrong folder.
 *
 * The fixture makes both failure modes reachable from one place. luke's
 * Archive holds uids 1-4 ("Luke archive N") and his INBOX holds 1-41
 * ("Luke message N"), so with Archive selected:
 *   - uid 3  exists in both  → the old code rendered ARCHIVE's message under
 *     the INBOX message's header. No error at all; just the wrong mail.
 *   - uid 30 exists only in INBOX → the old code got the server's honest
 *     "no longer in Archive" and showed the report bson73 saw.
 * A fix that only silences the error would still fail the first case.
 */

import { waitForApp, waitForEmails, switchToFolder } from './helpers.js';

const ACCOUNT = 'luke@mock.test';

/** Run a search the way the UI does, but set the folder scope explicitly. */
const searchAllFolders = (query) => browser.execute(async (q) => {
  const store = window.__SEARCH_STORE__;
  if (!store) return false;
  store.setState({ searchQuery: q });
  store.getState().setSearchFilters({ folder: 'all', location: 'all' });
  await store.getState().performSearch();
  return true;
}, query);

const resultRow = (subject) => browser.execute((want) => {
  const rows = window.__SEARCH_STORE__?.getState?.().searchResults || [];
  const hit = rows.find((r) => r.subject === want);
  return hit ? { uid: hit.uid, mailbox: hit._mailbox || null, accountId: hit._accountId || null } : null;
}, subject);

/** Click the rendered row whose subject is exactly `subject`. */
const clickRow = (subject) => browser.execute((want) => {
  for (const row of document.querySelectorAll('[data-testid="email-row"]')) {
    const lines = (row.innerText || '').split('\n').map((l) => l.trim());
    if (lines.includes(want)) { row.click(); return true; }
  }
  return false;
}, subject);

/**
 * What the viewer actually resolved: the store's `selectedEmail` is what
 * `selectEmail` fetched, and the page text is where an error toast lands. Read
 * both — a fix that renders nothing and a fix that renders the wrong message
 * are different failures and must not share an assertion.
 */
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

async function openHit(subject) {
  await browser.waitUntil(async () => await clickRow(subject), {
    timeout: 20_000, interval: 400,
    timeoutMsg: `Search never rendered a row titled "${subject}"`,
  });
  await browser.waitUntil(async () => {
    const v = await viewerState();
    return !v.loading && (v.body.length > 0 || v.page.includes('no longer in'));
  }, { timeout: 30_000, interval: 400, timeoutMsg: 'Viewer never settled on a body or an error' });
  return viewerState();
}

describe('Connected Search — a hit opens its own message', function () {
  this.timeout(180_000);

  before(async function () {
    await waitForApp();
    await waitForEmails();
    // Archive, not INBOX: the whole bug needs the selected folder to be a
    // folder the hit does NOT live in.
    await switchToFolder(ACCOUNT, 'Archive');
  });

  it('stamps the searched folder on a server-search result', async function () {
    await browser.waitUntil(async () => await searchAllFolders('Luke message 3'), {
      timeout: 20_000, interval: 500, timeoutMsg: 'Search store never became available',
    });
    await browser.waitUntil(async () => (await resultRow('Luke message 3')) !== null, {
      timeout: 30_000, interval: 500, timeoutMsg: 'Search never returned "Luke message 3"',
    });

    const hit = await resultRow('Luke message 3');
    expect(hit.uid).toBe(3);
    // Not 'Archive' — the folder the sidebar has selected.
    expect(hit.mailbox).toBe('INBOX');
  });

  it('opens the INBOX message, not the Archive message on the same UID', async function () {
    const v = await openHit('Luke message 3');
    expect(v.subject).toBe('Luke message 3');
    expect(v.body.toLowerCase()).toContain('body of luke message 3');
    // Archive's uid 3 is a real message; fetching it would have succeeded and
    // shown this instead, with no error anywhere.
    expect(v.body.toLowerCase()).not.toContain('luke archive');
    expect(v.page).not.toContain('no longer in');
  });

  it('opens a UID that exists in no other folder without reporting it missing', async function () {
    await searchAllFolders('Luke message 30');
    await browser.waitUntil(async () => (await resultRow('Luke message 30')) !== null, {
      timeout: 30_000, interval: 500, timeoutMsg: 'Search never returned "Luke message 30"',
    });

    const v = await openHit('Luke message 30');
    expect(v.subject).toBe('Luke message 30');
    expect(v.body.toLowerCase()).toContain('body of luke message 30');
    // The exact report: uid 30 is in INBOX and in no other folder, so a fetch
    // aimed at Archive gets the server's honest "no longer in Archive".
    expect(v.page).not.toContain('no longer in');
  });

  after(async function () {
    await browser.execute(() => {
      window.__SEARCH_STORE__?.getState?.().clearSearch?.();
      window.__SEARCH_STORE__?.setState?.({ searchActive: false, searchResults: [], searchQuery: '' });
    });
  });
});
