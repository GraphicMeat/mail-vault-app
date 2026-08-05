/**
 * E2E Test: Email List Bulk Selection & SelectionActionBar
 *
 * Tests checkbox selection of emails and the action bar that appears
 * with Mark as read, Archive, Delete, and Clear selection buttons.
 * All tests are non-destructive (delete confirmation is cancelled).
 */

import { waitForApp, waitForEmails } from './helpers.js';

describe('Email List Selection & Action Bar', function () {
  this.timeout(60_000);

  before(async function () {
    await waitForApp();
    await waitForEmails();
  });

/**
 * Select the first row that is still unarchived. SelectionActionBar renders
 * Archive only when the selection holds an unarchived message, and background
 * sync archives rows as a run warms up — picking "the first row" made the
 * Archive assertion a race. A row's own hover Archive button is the marker:
 * EmailRow renders it only while `!email.isArchived`.
 */
  async function selectUnarchivedRow() {
    return browser.execute(() => {
      for (const row of document.querySelectorAll('[data-testid="email-row"]')) {
        if (!row.querySelector('button[title="Archive"]')) continue;
        const checkbox = row.querySelector('input[type="checkbox"], .custom-checkbox');
        if (!checkbox) continue;
        checkbox.click();
        return true;
      }
      return false;
    });
  }

  it('should select an unarchived email by clicking its checkbox', async function () {
    expect(await selectUnarchivedRow()).toBe(true);
    await browser.pause(300);

    // Verify a checkbox is now checked
    const isChecked = await browser.execute(() =>
      [...document.querySelectorAll('[data-testid="email-row"] input[type="checkbox"]')]
        .some(cb => cb.checked));

    expect(isChecked).toBe(true);
  });

  it('should show the SelectionActionBar with selection count', async function () {
    const hasActionBar = await browser.execute(() => {
      const text = document.body.innerText;
      return text.toLowerCase().includes('selected');
    });

    expect(hasActionBar).toBe(true);
  });

  it('should have mark as read button in action bar', async function () {
    const hasButton = await browser.execute(() => {
      return document.querySelector('button[title="Mark as read"]') !== null ||
             document.querySelector('button[title="Mark as unread"]') !== null;
    });

    expect(hasButton).toBe(true);
  });

  it('should have archive button in action bar', async function () {
    // Background sync can archive the selected message mid-run, which drops the
    // Archive button. Re-select another unarchived row instead of failing.
    await browser.waitUntil(async () => {
      const present = await browser.execute(() =>
        document.querySelector('button[title="Archive selected"]') !== null);
      if (present) return true;
      await selectUnarchivedRow();
      return false;
    }, {
      timeout: 15_000,
      interval: 500,
      timeoutMsg: 'Archive button never appeared for a selection holding an unarchived email',
    });
  });

  it('should have delete button in action bar', async function () {
    const hasButton = await browser.execute(() => {
      return document.querySelector('button[title="Delete from server"]') !== null;
    });

    expect(hasButton).toBe(true);
  });

  it('should show delete confirmation when clicking delete, then cancel', async function () {
    // Click the delete button
    const clicked = await browser.execute(() => {
      const btn = document.querySelector('button[title="Delete from server"]');
      if (btn && btn.offsetHeight > 0) {
        btn.click();
        return true;
      }
      return false;
    });

    expect(clicked).toBe(true);
    await browser.pause(500);

    // Verify confirmation dialog with "cannot be undone" text
    const hasConfirmation = await browser.execute(() => {
      return document.body.innerText.toLowerCase().includes('cannot be undone');
    });

    expect(hasConfirmation).toBe(true);

    // Click Cancel to dismiss
    const cancelled = await browser.execute(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if ((btn.textContent || '').trim() === 'Cancel' && btn.offsetHeight > 0) {
          btn.click();
          return true;
        }
      }
      return false;
    });

    expect(cancelled).toBe(true);
    await browser.pause(300);
  });

  it('should clear selection when clicking X button', async function () {
    // Click the clear selection button
    const clicked = await browser.execute(() => {
      const btn = document.querySelector('button[title="Clear selection"]');
      if (btn && btn.offsetHeight > 0) {
        btn.click();
        return true;
      }
      return false;
    });

    expect(clicked).toBe(true);

    // The bar animates out (AnimatePresence), so its nodes outlive the click —
    // wait for them to leave the DOM instead of guessing at the duration.
    await browser.waitUntil(
      async () => browser.execute(() => (
        document.querySelector('button[title="Clear selection"]') === null &&
        document.querySelector('button[title="Archive selected"]') === null
      )),
      { timeout: 5000, interval: 200, timeoutMsg: 'Selection action bar still present after clearing selection' },
    );
  });
});
