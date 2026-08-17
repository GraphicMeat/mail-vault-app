/**
 * A list window that is short of the cache must refill itself.
 *
 * Field report 2026-08-17 (v2.9.2, prod logs): the INBOX sidecar cache was
 * cleared by the UIDVALIDITY branch, the folder LIST came back empty off a dead
 * pooled socket, and the list settled at "3 of 11 emails" under a "Showing
 * cached data" banner. The daemon had written all 11 headers to disk 1.8s later
 * — the list never noticed. Clicking the banner's reload did nothing; a second
 * click 36s later showed all 11.
 *
 * Cause: every path that verifies the server compares the CACHE to the SERVER.
 * `mailboxIsUnchanged` answered "unchanged" (and inside its 10s TTL, answered it
 * without asking anything), so `loadServerEmails` returned without touching the
 * list. Nothing else re-checked the window against the cache, so a short window
 * stayed short for the session.
 *
 * The contract this pins: whatever left the window short, one activation puts
 * the full list back.
 *
 * SCOPE — read before trusting a green here. This is a CONTRACT test, not a
 * discriminating one: it passes against the pre-fix build too (verified on the
 * mini, 2026-08-17, both runs 841ms). Truncating the store leaves the in-memory
 * header memo and the restore descriptor holding the whole mailbox, so the next
 * activation repaints from memory before the probe path is reached. The field
 * case had neither — a launched-seconds-ago process with a cache that had just
 * been wiped — and reproducing that needs handles on `headerMemo` and
 * `cacheManager` that the app does not expose. The fix itself is pinned at the
 * unit layer (`tests/unit/shortWindowDrain.test.js`), and the empty-LIST half at
 * the Rust layer (`src-core/tests/imap_session.rs`,
 * `a_dropped_list_is_an_error_not_an_empty_folder_list`). What this spec is
 * worth: it fails if ANY of the three recovery paths — memo repaint, descriptor
 * repaint, cache drain — stops putting the list back after a short paint.
 */

import assert from 'node:assert';
import { waitForApp, waitForEmails } from './helpers.js';

const BANNER = '[data-testid="cached-data-banner"]';
const COUNT = '[data-testid="email-list-count"]';

/** Store truth, not DOM truth — the list is virtualized, rows are a window. */
const storeSnapshot = () => browser.execute(() => {
  const s = window.__MAIL_STORE__.getState();
  return {
    emails: s.emails.length,
    sorted: s.sortedEmails.length,
    total: s.totalEmails,
    accountId: s.activeAccountId,
    mailbox: s.activeMailbox,
    hasMore: s.hasMoreEmails,
    banner: !!s.suspectEmptyServerData,
  };
});

/**
 * Reproduce the field state: the cache is whole, the window is one row, and the
 * banner is up. Truncating the store IS the bug — in production a poisoned
 * header memo and an aborted post-sync re-read produced the same short window.
 */
async function truncateWindowTo(keep) {
  return browser.execute((n) => {
    const store = window.__MAIL_STORE__;
    const s = store.getState();
    store.setState({
      emails: s.emails.slice(0, n),
      // The restore path paints its window with pagination disarmed on purpose
      // ("a placeholder must not arm pagination"), which is the state the real
      // reload click lands in.
      hasMoreEmails: false,
      loadingMore: false,
      suspectEmptyServerData: {
        accountId: s.activeAccountId,
        type: 'mailboxes',
        message: 'Server returned empty folder list unexpectedly. Showing cached folders while verifying.',
        timestamp: Date.now(),
      },
    });
    store.getState().updateSortedEmails();
    return store.getState().emails.length;
  }, keep);
}

async function waitForWindow(expected, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    last = await storeSnapshot();
    if (last.emails >= expected) return last;
    await browser.pause(250);
  }
  return last;
}

describe('short list window', function () {
  let full;

  before(async function () {
    this.timeout(180_000);
    await waitForApp();
    await waitForEmails();
    full = await storeSnapshot();
    assert.ok(full.emails >= 4,
      `Precondition: need a loaded mailbox to shorten, store holds ${full.emails}`);
    console.log(`[short-window] baseline: ${full.emails} of ${full.total} in ${full.mailbox}`);
  });

  it('refills from the cached-data banner reload', async function () {
    this.timeout(120_000);

    const kept = await truncateWindowTo(1);
    assert.strictEqual(kept, 1, 'window should be truncated to one row');

    // The user-visible symptom, verbatim: "1 of N emails" under the banner.
    const header = await browser.execute((sel) => document.querySelector(sel)?.textContent || '', COUNT);
    assert.ok(/^1 of /.test(header), `Expected a short-window header, got "${header}"`);
    const bannerUp = await browser.execute((sel) => !!document.querySelector(sel), BANNER);
    assert.ok(bannerUp, 'banner must be showing — this spec is about its reload button');

    const clicked = await browser.execute((sel) => {
      const btn = document.querySelector(`${sel} button`);
      if (!btn) return false;
      btn.click();
      return true;
    }, BANNER);
    assert.ok(clicked, 'no reload button inside the cached-data banner');

    const after = await waitForWindow(full.emails);
    assert.ok(
      after.emails >= full.emails,
      `One reload click must restore the list: ${after.emails} of ${after.total} (was ${full.emails})`
    );

    const headerAfter = await browser.execute((sel) => document.querySelector(sel)?.textContent || '', COUNT);
    assert.ok(!/^1 of /.test(headerAfter), `Header still short after reload: "${headerAfter}"`);
  });

  it('refills on a plain re-activation, with no click and no probe reset', async function () {
    this.timeout(120_000);

    // Wait out nothing and reset nothing: this is the path a background
    // refresh takes, where the sync probe legitimately answers "unchanged"
    // (its 10s TTL was just stamped by the reload above). Pre-fix this returned
    // without touching the list and the window stayed at one row.
    const kept = await truncateWindowTo(1);
    assert.strictEqual(kept, 1, 'window should be truncated to one row');

    await browser.execute((accountId, mailbox) => {
      window.__MAIL_STORE__.getState().activateAccount(accountId, mailbox);
    }, full.accountId, full.mailbox);

    const after = await waitForWindow(full.emails);
    assert.ok(
      after.emails >= full.emails,
      `Re-activation must reconcile the window against the cache: ${after.emails} of ${after.total} (was ${full.emails})`
    );
  });

  after(async function () {
    // Leave a whole list behind — later specs in the run share this account.
    this.timeout(60_000);
    await waitForWindow(full?.emails ?? 1, 20_000);
  });
});
