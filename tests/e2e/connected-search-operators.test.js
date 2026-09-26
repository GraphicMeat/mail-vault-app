/**
 * E2E: search operators typed into the query narrow what comes back.
 *
 * Luke's INBOX fixture (mockImap.js `mailbox`): "Luke message N" from
 * "Sender N <senderN@example.com>", even UIDs read, odd UIDs unread. So
 * `from:sender1` is uids 1 and 10-19, both read and unread.
 *
 * The search runs with location 'all', so the local lane (index or scan) and
 * the server lane (the mock's UID SEARCH) both answer and are merged. A lane
 * that ignored an operator would put its extra rows in the result, which is
 * what each narrowing assertion would catch.
 *
 * Anti-vacuity: the baseline must hold read rows and "Luke message 12", or the
 * unread and exclude assertions would pass without narrowing anything.
 *
 * Driven through `window.__SEARCH_STORE__`, as connected-search-index does.
 */
import { waitForApp, waitForEmails, switchToFolder } from './helpers.js';

const LUKE = 'luke@mock.test';

describe('Search operators', function () {
  this.timeout(300_000);

  const runSearch = (query) => browser.execute((q) => {
    const store = window.__SEARCH_STORE__;
    if (!store) return false;
    store.setState({ searchQuery: q });
    store.getState().setSearchFilters({ folder: 'current', location: 'all' });
    store.getState().performSearch();
    return true;
  }, query);

  const searchSettled = () => browser.execute(() => {
    const s = window.__SEARCH_STORE__?.getState?.();
    return !!s && s.searchActive === true && s.isSearching === false;
  });

  const results = () => browser.execute(() => (window.__SEARCH_STORE__?.getState?.().searchResults || [])
    .map((r) => ({
      subject: r.subject,
      from: r.from?.address || '',
      unread: !(r.flags || []).some((f) => f === '\\Seen' || f === 'seen'),
    })));

  const filtersOnScreen = () => browser.execute(() => window.__SEARCH_STORE__?.getState?.().searchFilters);

  async function search(query) {
    expect(await runSearch(query)).toBe(true);
    await browser.waitUntil(searchSettled, { timeout: 60_000, interval: 200, timeoutMsg: `search "${query}" never settled` });
    return results();
  }

  const subjects = (rows) => rows.map((r) => r.subject).sort();

  let baseline = [];

  before(async function () {
    await waitForApp();
    await waitForEmails();
    await switchToFolder(LUKE, 'INBOX');
    baseline = await search('from:sender1');
  });

  after(async function () {
    await browser.execute(() => window.__SEARCH_STORE__?.getState?.().clearSearch?.());
  });

  it('from: keeps only that sender, read and unread alike', async function () {
    expect(baseline.length).toBeGreaterThan(2);
    expect(baseline.every((r) => r.from.includes('sender1'))).toBe(true);
    expect(baseline.some((r) => !r.unread)).toBe(true);
    expect(baseline.some((r) => r.unread)).toBe(true);
    expect(subjects(baseline)).toContain('Luke message 12');
  });

  it('from: with is:unread narrows to that sender\'s unread mail', async function () {
    const unread = await search('from:sender1 is:unread');
    expect(unread.length).toBeGreaterThan(0);
    expect(unread.every((r) => r.unread && r.from.includes('sender1'))).toBe(true);
    expect(subjects(unread)).toEqual(subjects(baseline.filter((r) => r.unread)));
    // The operator applied to that search only; the filter panel is untouched.
    expect((await filtersOnScreen()).sender).toBe('');
  });

  it('-"phrase" leaves out the messages that hold it', async function () {
    expect(subjects(baseline)).toContain('Luke message 12');
    const kept = await search('from:sender1 -"message 12"');
    expect(kept.length).toBeGreaterThan(0);
    expect(subjects(kept)).not.toContain('Luke message 12');
    expect(subjects(kept)).toEqual(subjects(baseline.filter((r) => r.subject !== 'Luke message 12')));
  });
});
