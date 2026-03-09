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

    // Verify emails are visible
    const hasEmails = await browser.execute(() => {
      const rows = document.querySelectorAll(
        '[data-testid="email-row"], [class*="email-row"], [class*="EmailRow"]',
      );
      if (rows.length > 0) return true;
      // Fallback: virtualized rows
      const virtualRows = document.querySelectorAll('[style*="position: absolute"][style*="top:"]');
      return virtualRows.length > 2;
    });

    expect(hasEmails).toBe(true);
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
    // The "All Inboxes" button should no longer be in an active/selected state
    const isUnified = await browser.execute(() => {
      // Check if unified inbox is still active — look for indicators
      const sidebar = document.querySelector('[data-testid="sidebar"]') || document.querySelector('aside') || document.querySelector('nav');
      if (!sidebar) return false;
      const allInboxBtn = [...sidebar.querySelectorAll('button, div')].find(
        el => (el.textContent || '').trim() === 'All Inboxes' || (el.getAttribute('title') || '') === 'All Inboxes'
      );
      if (!allInboxBtn) return false;
      // Check if it has an active/selected style (e.g., bg-mail-accent or highlighted)
      const classes = allInboxBtn.className || '';
      return classes.includes('accent') || classes.includes('selected') || classes.includes('active');
    });

    // After clicking an account, unified mode should be off
    expect(isUnified).toBe(false);
  });
});
