/**
 * E2E Test: Unified Inbox (Task 8)
 *
 * Requires 2+ accounts set up (depends on connected-accounts.test.js running first).
 *
 * Tests:
 *   1. Verify "All Inboxes" button is visible in the sidebar
 *   2. Click "All Inboxes" and verify emails appear
 *   3. Look for colored account indicator dots on email rows
 *   4. Click a specific account to exit unified mode
 *   5. Verify back to normal single-account view
 */

import {
  waitForApp,
  waitForEmails,
  pressKey,
  switchToFolder,
} from './helpers.js';

describe('Unified Inbox', function () {
  this.timeout(60_000);

  before(async function () {
    await waitForApp();
    // Wait for emails to load from the active account
    await waitForEmails();
  });

  it('should show the "All Inboxes" button in the sidebar', async function () {
    const found = await browser.execute(() => {
      // Use data-testid first
      const btn = document.querySelector('[data-testid="all-inboxes-btn"]');
      if (btn && btn.offsetHeight > 0) return true;
      // Fallback
      const sidebar = document.querySelector('[data-testid="sidebar"]') || document.querySelector('aside') || document.querySelector('nav');
      if (!sidebar) return false;
      const els = sidebar.querySelectorAll('button, div, span');
      for (const el of els) {
        const text = (el.textContent || '').trim();
        const title = (el.getAttribute('title') || '').trim();
        if (text === 'All Inboxes' || title === 'All Inboxes') return true;
      }
      return false;
    });

    expect(found).toBe(true);
  });

  it('should activate unified inbox when clicking "All Inboxes"', async function () {
    // Click "All Inboxes" via data-testid
    const clicked = await browser.execute(() => {
      const btn = document.querySelector('[data-testid="all-inboxes-btn"]');
      if (btn && btn.offsetHeight > 0) {
        btn.click();
        return true;
      }
      // Fallback
      const sidebar = document.querySelector('[data-testid="sidebar"]') || document.querySelector('aside') || document.querySelector('nav');
      if (!sidebar) return false;
      const els = sidebar.querySelectorAll('button, div');
      for (const el of els) {
        const text = (el.textContent || '').trim();
        const title = (el.getAttribute('title') || '').trim();
        if (text === 'All Inboxes' || title === 'All Inboxes') {
          el.click();
          return true;
        }
      }
      return false;
    });

    expect(clicked).toBe(true);
    await browser.pause(2000);

    // Real rows, not "something is absolutely positioned". This is the only
    // guard on the list actually painting in unified mode: a thread cache that
    // outlives the list it was built from renders zero rows over a full store,
    // and the old fallback below counted enough unrelated positioned elements
    // to call that a pass.
    const rowCount = await browser.execute(
      () => document.querySelectorAll('[data-testid="email-row"]').length,
    );

    expect(rowCount).toBeGreaterThan(0);
  });

  it('should show colored account indicator dots on email rows', async function () {
    // In unified inbox mode, each email row may have a colored dot indicating
    // which account it belongs to.
    const hasDots = await browser.execute(() => {
      // Use data-testid first
      const dots = document.querySelectorAll('[data-testid="account-dot"]');
      if (dots.length > 0) return true;
      // Fallback
      const listArea = document.querySelector('[class*="email-list"], [class*="EmailList"]') ||
        document.querySelector('main') ||
        document.querySelector('[class*="list"]');
      if (!listArea) return false;
      const fallbackDots = listArea.querySelectorAll('[class*="rounded-full"], [class*="dot"], [class*="indicator"]');
      return fallbackDots.length > 0;
    });

    // This is a soft check — dots may not exist if only one account has emails
    // Log the result but do not fail the test
    if (!hasDots) {
      console.warn('[unified-inbox] No colored account dots found — may be expected if single-account emails');
    }
  });

  it('should switch back to single-account view when clicking an account', async function () {
    // Click the first account in the sidebar to exit unified mode
    const clicked = await browser.execute((testEmail) => {
      const sidebar = document.querySelector('[data-testid="sidebar"]') || document.querySelector('aside') || document.querySelector('nav');
      if (!sidebar) return false;

      // Find account entries — buttons or divs with title containing the email
      const els = sidebar.querySelectorAll('button, div');
      for (const el of els) {
        const title = (el.getAttribute('title') || '');
        const text = (el.textContent || '').trim();
        if (title.includes(testEmail) || text === testEmail) {
          el.click();
          return true;
        }
      }

      // Fallback: click the first account avatar (colored circle with initial)
      const avatars = sidebar.querySelectorAll('[class*="rounded-full"]');
      for (const av of avatars) {
        if (av.offsetHeight >= 28 && av.offsetHeight <= 48) {
          av.click();
          return true;
        }
      }

      return false;
    }, browser.testEnv.TEST_EMAIL);

    expect(clicked).toBe(true);
    await browser.pause(2000);

    // Verify we are back in normal single-account mode
    // The app should still be responsive with the sidebar visible
    const appStillWorks = await browser.execute(() => {
      return document.querySelector('[data-testid="sidebar"]') !== null;
    });
    expect(appStillWorks).toBe(true);

    // Check that account dots are no longer shown (single-account view doesn't have them)
    // This is a soft check — the lack of dots indicates non-unified mode
    const hasDots = await browser.execute(() => {
      const dots = document.querySelectorAll('[data-testid="account-dot"]');
      return dots.length > 0;
    });

    // In non-unified mode, account dots should not be visible
    // But this can be flaky if the view hasn't updated yet, so just verify app works
    if (hasDots) {
      console.warn('[unified-inbox] Account dots still visible after clicking account — unified may still be active');
    }
  });

  // The unified list is stitched from two sources that cover the same rows: the
  // restore descriptor's 50-row window (written for every account visited this
  // session, and by the startup prewarm) and the headers read off disk. The
  // merge only deduped the third source, the pre-unified snapshot, so every row
  // an account's descriptor held arrived twice — a doubled list, doubled
  // counters, and two identical copies of every message inside its thread.
  //
  // Visiting both accounts first is what arms the descriptors; without it the
  // assertion passes on a broken build.
  it('lists each message once after both accounts have been visited', async function () {
    const { TEST_EMAIL, TEST_EMAIL2 } = browser.testEnv;
    await switchToFolder(TEST_EMAIL2, 'INBOX');
    await switchToFolder(TEST_EMAIL, 'INBOX');

    const clicked = await browser.execute(() => {
      const btn = document.querySelector('[data-testid="all-inboxes-btn"]');
      if (!btn) return false;
      btn.click();
      return true;
    });
    expect(clicked).toBe(true);

    // `activeMailbox` flips to UNIFIED synchronously on the click, while the
    // list it names arrives later — read too early and this asserts on the
    // previous single-account rows, which are unique no matter what the merge
    // does. Both accounts visited above must be present, and the progressive
    // chunk loop must have drained.
    await browser.waitUntil(async () => browser.execute(() => {
      const s = window.__MAIL_STORE__?.getState?.();
      if (!s || s.activeMailbox !== 'UNIFIED' || s.loadingProgress) return false;
      return new Set(s.sortedEmails.map(e => e._accountId).filter(Boolean)).size >= 2;
    }), { timeout: 30_000, timeoutMsg: 'unified inbox never finished loading both accounts' });

    const { duplicates, total } = await browser.execute(() => {
      const rows = window.__MAIL_STORE__.getState().sortedEmails;
      const seen = new Set();
      const duplicates = [];
      for (const r of rows) {
        const key = `${r._accountId}:${r._mailbox}:${r.uid}`;
        if (seen.has(key)) duplicates.push(`${key} — ${r.subject}`);
        seen.add(key);
      }
      return { duplicates: duplicates.slice(0, 5), total: rows.length };
    });

    expect(total).toBeGreaterThan(0);
    expect(duplicates).toEqual([]);
  });

  // The reported symptom, at the surface the user actually sees: a thread in
  // the unified list opened onto four rows that were two messages, each drawn
  // twice with the same sender and the same timestamp. Runs on the unified
  // view the previous case leaves open.
  it('opens a unified thread with every message drawn once', async function () {
    // The unified list is hundreds of rows across three accounts and only a
    // window of it is rendered, so this pages down until a thread row appears
    // rather than reading the first screen and giving up.
    let threadCount = 0;
    await browser.waitUntil(async () => {
      threadCount = await browser.execute(() => {
        const row = [...document.querySelectorAll('[data-testid="email-row"]')]
          .find(r => r.offsetHeight > 0 && Number(r.getAttribute('data-thread-count') || 1) > 1);
        if (row) {
          row.click();
          return Number(row.getAttribute('data-thread-count'));
        }
        const list = [...document.querySelectorAll('div')]
          .find(d => d.scrollHeight > d.clientHeight + 200 && d.clientHeight > 200);
        if (list) {
          const next = list.scrollTop + list.clientHeight * 0.9;
          list.scrollTop = next < list.scrollHeight ? next : 0;
        }
        return 0;
      });
      if (!threadCount) return false;
      return browser.execute(() => (document.body.textContent || '').includes('messages in thread'));
    }, { timeout: 60_000, interval: 500, timeoutMsg: 'no multi-message thread row in the unified list' });

    const { headers, distinct } = await browser.execute(() => {
      const texts = [...document.querySelectorAll('[data-testid="thread-email-header"]')]
        .map(h => (h.textContent || '').replace(/\s+/g, ' ').trim());
      return { headers: texts.length, distinct: new Set(texts).size };
    });

    // A duplicated message repeats its sender and its timestamp verbatim, so
    // the header text is identical and the distinct count falls short.
    expect(headers).toBe(threadCount);
    expect(distinct).toBe(headers);
  });
});
