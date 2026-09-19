/**
 * E2E: a delayed All Inboxes current-search response cannot leak across a
 * mailbox navigation. Yoda's mock delays only the `TEXT "body"` search shape;
 * Vader's dedicated Matrix mailbox supplies the new scope's matching result.
 */

import { waitForApp, waitForEmails, switchToFolder, clickSidebarItem } from './helpers.js';

const YODA = 'yoda@mock.test';
const VADER = 'vader@mock.test';
const QUERY = 'body';
const NEW_SCOPE_SUBJECT = 'Vader matrix 1';

const runSearch = (query, filters) => browser.execute((q, f) => {
  const store = window.__SEARCH_STORE__;
  if (!store) return false;
  store.setState({ searchQuery: q });
  store.getState().setSearchFilters(f);
  store.getState().performSearch();
  return true;
}, query, filters);

const snapshot = () => browser.execute(() => {
  const search = window.__SEARCH_STORE__?.getState?.();
  const mail = window.__MAIL_STORE__?.getState?.();
  return search && mail ? {
    activeSearchId: search.activeSearchId,
    searchQuery: search.searchQuery,
    isSearching: search.isSearching,
    progress: search.searchProgress,
    activeAccountId: mail.activeAccountId,
    activeMailbox: mail.activeMailbox,
    unifiedInbox: mail.unifiedInbox,
    rows: (search.searchResults || []).map((row) => ({
      subject: row.subject,
      accountId: row._accountId,
      mailbox: row._mailbox,
      source: row.source,
    })),
  } : null;
});

describe('Connected Search — context changes cancel delayed responses', function () {
  this.timeout(120_000);

  let vaderId;

  before(async function () {
    await waitForApp();
    await waitForEmails();

    const accounts = browser.mockAccounts || [];
    const yodaId = accounts.find((account) => account.email === YODA)?.id;
    vaderId = accounts.find((account) => account.email === VADER)?.id;
    expect(yodaId).toBeTruthy();
    expect(vaderId).toBeTruthy();

    // Prime each account's mailbox-tree cache before All Inboxes builds its
    // cross-account targets. Matrix is a dedicated Vader fixture.
    await switchToFolder(YODA, 'INBOX');
    await browser.waitUntil(async () => {
      const state = await snapshot();
      return state?.activeAccountId === yodaId && state.activeMailbox === 'INBOX';
    }, { timeout: 30_000, interval: 250, timeoutMsg: 'Yoda/INBOX never became active' });

    await switchToFolder(VADER, 'Matrix');
    await browser.waitUntil(async () => {
      const state = await snapshot();
      return state?.activeAccountId === vaderId && state.activeMailbox === 'Matrix';
    }, { timeout: 30_000, interval: 250, timeoutMsg: 'Vader/Matrix never became active' });

    expect(await clickSidebarItem('All Inboxes')).toBe(true);
    await browser.waitUntil(async () => {
      const state = await snapshot();
      return state?.unifiedInbox === true && state.activeMailbox === 'UNIFIED';
    }, { timeout: 20_000, interval: 250, timeoutMsg: 'All Inboxes never became active' });
  });

  it('does not republish All Inboxes rows after switching to another account mailbox', async function () {
    expect(await runSearch(QUERY, { folder: 'current', location: 'server' })).toBe(true);

    // The 5-second Yoda gate is reached only after the quicker account searches
    // have reported, leaving unfinished server work as evidence that the stale
    // response is genuinely in flight before navigation.
    await browser.waitUntil(async () => {
      const state = await snapshot();
      return state?.isSearching === true
        && state.progress?.total > state.progress?.done
        && state.activeSearchId;
    }, { timeout: 15_000, interval: 100, timeoutMsg: 'All Inboxes search never reached its delayed server response' });
    const oldSearchId = (await snapshot()).activeSearchId;

    expect(await clickSidebarItem(VADER)).toBe(true);
    await browser.waitUntil(async () => {
      const state = await snapshot();
      return state?.activeAccountId === vaderId && state.activeMailbox !== 'UNIFIED';
    }, { timeout: 20_000, interval: 200, timeoutMsg: 'Navigating to Vader never left All Inboxes' });
    let state = await snapshot();
    if (state.activeMailbox !== 'Matrix') {
      expect(await clickSidebarItem('Matrix')).toBe(true);
      await browser.waitUntil(async () => (await snapshot())?.activeMailbox === 'Matrix', {
        timeout: 20_000, interval: 200, timeoutMsg: 'Vader/Matrix never became the active mailbox',
      });
    }

    await browser.waitUntil(async () => {
      const current = await snapshot();
      return current?.rows.some((row) => row.subject === NEW_SCOPE_SUBJECT
        && row.accountId === vaderId && row.mailbox === 'Matrix');
    }, { timeout: 30_000, interval: 250, timeoutMsg: 'Vader/Matrix search never returned its matching row' });
    state = await snapshot();
    const newSearchId = state.activeSearchId;
    expect(newSearchId).not.toBe(oldSearchId);
    expect(state.rows.every((row) => row.accountId === vaderId && row.mailbox === 'Matrix')).toBe(true);

    // Let the mock's fixed delay expire. The old response is now delivered to
    // the daemon after cancellation; neither it nor a late event may alter the
    // new account/mailbox's result set.
    await browser.pause(5_500);
    state = await snapshot();
    expect(state.activeSearchId).toBe(newSearchId);
    expect(state.rows.some((row) => row.accountId !== vaderId || row.mailbox !== 'Matrix')).toBe(false);
    expect(state.rows.some((row) => row.subject.includes('Yoda message'))).toBe(false);
  });

  after(async function () {
    await browser.execute(() => window.__SEARCH_STORE__?.getState?.().clearSearch?.());
  });
});
