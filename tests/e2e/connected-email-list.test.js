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

  it('should select an email by clicking its checkbox', async function () {
    const selected = await browser.execute(() => {
      const row = document.querySelector('[data-testid="email-row"]');
      if (!row) return false;
      // Find checkbox inside the row
      const checkbox = row.querySelector('input[type="checkbox"], .custom-checkbox');
      if (checkbox) {
        checkbox.click();
        return true;
      }
      return false;
    });

    expect(selected).toBe(true);
    await browser.pause(300);

    // Verify the checkbox is now checked
    const isChecked = await browser.execute(() => {
      const row = document.querySelector('[data-testid="email-row"]');
      if (!row) return false;
      const checkbox = row.querySelector('input[type="checkbox"]');
      if (checkbox) return checkbox.checked;
      // For custom checkbox, check for a checked/active class
      const custom = row.querySelector('.custom-checkbox');
      if (custom) {
        return custom.classList.contains('checked') ||
               custom.classList.contains('active') ||
               custom.querySelector('svg') !== null;
      }
      return false;
    });

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
    const hasButton = await browser.execute(() => {
      return document.querySelector('button[title="Archive selected"]') !== null;
    });

    expect(hasButton).toBe(true);
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
    await browser.pause(300);

    // Verify action bar is gone (no "selected" text visible from the action bar)
    const actionBarGone = await browser.execute(() => {
      // Check that the selection action bar buttons are gone
      return document.querySelector('button[title="Clear selection"]') === null &&
             document.querySelector('button[title="Archive selected"]') === null;
    });

    expect(actionBarGone).toBe(true);
  });
});
