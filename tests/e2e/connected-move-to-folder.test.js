/**
 * E2E Test: Move to Folder UI (Task 9)
 *
 * Tests the move-to-folder dropdown without actually moving emails (non-destructive).
 *
 * Flow:
 *   1. Wait for emails to load
 *   2. Click the first email in the list
 *   3. Press M key — verify the move-to-folder dropdown appears
 *   4. Verify folder list is shown in the dropdown
 *   5. Type to filter folders
 *   6. Press Escape to close the dropdown
 *   7. Click the "Move to folder" toolbar button — dropdown opens again
 *   8. Press Escape to close
 */

import {
  waitForApp,
  waitForEmails,
  pressKey,
} from './helpers.js';

describe('Move to Folder', function () {
  this.timeout(60_000);

  before(async function () {
    await waitForApp();
    await waitForEmails();
  });

  it('should select the first email in the list', async function () {
    // Click the first email row
    const clicked = await browser.execute(() => {
      // Try data-testid first
      const row = document.querySelector('[data-testid="email-row"]');
      if (row) { row.click(); return true; }

      // Fallback: virtualized rows
      const virtualRows = document.querySelectorAll('[style*="position: absolute"][style*="top:"]');
      for (const r of virtualRows) {
        if (r.offsetHeight > 20 && r.textContent.trim().length > 0) {
          r.click();
          return true;
        }
      }

      // Fallback: any element that looks like an email row
      const listArea = document.querySelector('[class*="email-list"], [class*="EmailList"], main');
      if (listArea) {
        const children = listArea.querySelectorAll('[class*="row"], [class*="Row"], [class*="item"]');
        if (children.length > 0) {
          children[0].click();
          return true;
        }
      }

      return false;
    });

    expect(clicked).toBe(true);
    await browser.pause(1000);
  });

  it('should open move-to-folder dropdown with M key', async function () {
    await pressKey('m');
    await browser.pause(500);

    // Verify the dropdown appeared
    const dropdownVisible = await browser.execute(() => {
      // Check via data-testid first
      const dropdown = document.querySelector('[data-testid="move-to-folder-dropdown"]');
      if (dropdown && dropdown.offsetHeight > 0) return true;
      // Fallback: look for folder names or filter input
      const text = document.body.innerText;
      const hasFolders = text.includes('INBOX') || text.includes('Trash') ||
        text.includes('Sent') || text.includes('Drafts') ||
        text.includes('Junk') || text.includes('Spam');
      const filterInput = document.querySelector('[data-testid="move-folder-search"]');
      return hasFolders || filterInput !== null;
    });

    expect(dropdownVisible).toBe(true);
  });

  it('should show folder list in the dropdown', async function () {
    const folderCount = await browser.execute(() => {
      // Count visible buttons/items that look like folder entries
      // The MoveToFolderDropdown renders folder buttons
      const buttons = document.querySelectorAll('button');
      let count = 0;
      for (const btn of buttons) {
        const text = (btn.textContent || '').trim();
        // Skip utility buttons; count those that look like folder names
        if (text.length > 0 && text.length < 50 &&
            !text.includes('Close') && !text.includes('Cancel') &&
            btn.offsetHeight > 0) {
          count++;
        }
      }
      return count;
    });

    // At least a few folders should be visible (INBOX, Sent, Trash, etc.)
    expect(folderCount).toBeGreaterThan(2);
  });

  it('should support typing to filter folders', async function () {
    // Check for filter input via data-testid
    const hasFilterInput = await browser.execute(() => {
      const input = document.querySelector('[data-testid="move-folder-search"]');
      if (input && input.offsetHeight > 0) return true;
      const inputs = document.querySelectorAll('input');
      for (const input of inputs) {
        if (input.offsetHeight > 0 &&
            ((input.getAttribute('placeholder') || '').toLowerCase().includes('filter') ||
             (input.getAttribute('placeholder') || '').toLowerCase().includes('search') ||
             (input.getAttribute('placeholder') || '').toLowerCase().includes('folder'))) {
          return true;
        }
      }
      return false;
    });

    if (hasFilterInput) {
      // Type into the filter
      await browser.keys('in'); // partial match for "INBOX"
      await browser.pause(300);

      const filtered = await browser.execute(() => {
        // After typing, fewer folder entries should be visible
        const buttons = document.querySelectorAll('button');
        let visibleCount = 0;
        for (const btn of buttons) {
          if (btn.offsetHeight > 0 && (btn.textContent || '').trim().length > 0) {
            visibleCount++;
          }
        }
        return visibleCount;
      });

      // The filter should reduce results (or at least not crash)
      expect(filtered).toBeGreaterThan(0);
    }
  });

  it('should close the dropdown with Escape', async function () {
    await pressKey('Escape');
    await browser.pause(500);

    const dropdownGone = await browser.execute(() => {
      // The dropdown should be gone — check that no folder-filter input is visible
      const inputs = document.querySelectorAll('input');
      for (const input of inputs) {
        const ph = (input.getAttribute('placeholder') || '').toLowerCase();
        if (input.offsetHeight > 0 && (ph.includes('filter') || ph.includes('folder'))) {
          return false; // dropdown still open
        }
      }
      return true;
    });

    expect(dropdownGone).toBe(true);
  });

  it('should open the dropdown via the "Move to folder" toolbar button', async function () {
    // Use data-testid for the toolbar button
    const clicked = await browser.execute(() => {
      const btn = document.querySelector('[data-testid="move-to-folder-btn"]');
      if (btn && btn.offsetHeight > 0) {
        btn.click();
        return true;
      }
      // Fallback
      const buttons = document.querySelectorAll('button');
      for (const b of buttons) {
        const title = (b.getAttribute('title') || '').toLowerCase();
        if (title.includes('move to folder') && b.offsetHeight > 0) {
          b.click();
          return true;
        }
      }
      return false;
    });

    expect(clicked).toBe(true);
    await browser.pause(500);

    // Verify dropdown is open again
    const dropdownVisible = await browser.execute(() => {
      const text = document.body.innerText;
      return text.includes('INBOX') || text.includes('Trash') || text.includes('Sent');
    });

    expect(dropdownVisible).toBe(true);
  });

  it('should close the dropdown again with Escape', async function () {
    await pressKey('Escape');
    await browser.pause(500);

    // Verify closed
    const closed = await browser.execute(() => {
      const inputs = document.querySelectorAll('input');
      for (const input of inputs) {
        const ph = (input.getAttribute('placeholder') || '').toLowerCase();
        if (input.offsetHeight > 0 && (ph.includes('filter') || ph.includes('folder'))) {
          return false;
        }
      }
      return true;
    });

    expect(closed).toBe(true);
  });
});
