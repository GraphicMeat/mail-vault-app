/**
 * E2E Test: Connected Account Setup (Task 7)
 *
 * Sets up two test IMAP accounts (luke@ and i-am-your-father@).
 * Must run BEFORE other connected-* tests.
 *
 * Flow:
 *   1. Hide non-test accounts
 *   2. Remove existing test accounts if present
 *   3. Add first test account via the AccountModal
 *   4. Add second test account
 *   5. Verify both appear in the sidebar
 */

import {
  waitForApp,
  waitForElement,
  openSettings,
  closeSettings,
  hideNonTestAccounts,
  restoreHiddenAccounts,
  pressKey,
} from './helpers.js';

describe('Connected Account Setup', function () {
  this.timeout(120_000);

  before(async function () {
    await waitForApp();
    await hideNonTestAccounts();
  });

  after(async function () {
    await restoreHiddenAccounts();
  });

  // ---------------------------------------------------------------------------
  // Helper: remove an account by email via Settings > Accounts
  // ---------------------------------------------------------------------------
  async function removeAccountIfExists(email) {
    await openSettings();
    await browser.pause(500);

    // Click Accounts tab
    await browser.execute(() => {
      const tabs = document.querySelectorAll('button, a, [role="tab"]');
      for (const tab of tabs) {
        if ((tab.textContent || '').trim().toLowerCase() === 'accounts') {
          tab.click();
          return;
        }
      }
    });
    await browser.pause(500);

    // Check if the account exists in the account list
    const found = await browser.execute((targetEmail) => {
      const els = document.querySelectorAll('span, p, div');
      for (const el of els) {
        if ((el.textContent || '').trim() === targetEmail) return true;
      }
      return false;
    }, email);

    if (!found) {
      await closeSettings();
      return;
    }

    // Click the account entry to select it
    const selected = await browser.execute((targetEmail) => {
      const els = document.querySelectorAll('div, span, button');
      for (const el of els) {
        const text = (el.textContent || '').trim();
        if (text === targetEmail) {
          // Find the clickable account row — walk up to button or clickable container
          const clickable = el.closest('button') || el.closest('[class*="cursor"]') || el.parentElement;
          if (clickable) {
            clickable.click();
            return true;
          }
        }
      }
      return false;
    }, email);

    if (!selected) {
      await closeSettings();
      return;
    }

    await browser.pause(500);

    // Click "Remove This Account" button
    const clickedRemove = await browser.execute(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if ((btn.textContent || '').includes('Remove This Account') && btn.offsetHeight > 0) {
          btn.click();
          return true;
        }
      }
      return false;
    });

    if (!clickedRemove) {
      await closeSettings();
      return;
    }

    await browser.pause(500);

    // Confirm removal — click the "Remove" button in the confirmation dialog
    await browser.execute(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        const text = (btn.textContent || '').trim();
        if (text === 'Remove' && btn.offsetHeight > 0) {
          btn.click();
          return true;
        }
      }
      return false;
    });

    await browser.pause(1000);
    await closeSettings();
  }

  // ---------------------------------------------------------------------------
  // Helper: add a test account via the AccountModal
  // ---------------------------------------------------------------------------
  async function addTestAccount({ email, password, imapHost, imapPort, smtpHost, smtpPort }) {
    // Click "Add Account" button in the sidebar
    const clickedAdd = await browser.execute(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        const text = (btn.textContent || '').trim();
        const title = (btn.getAttribute('title') || '').trim();
        if (text.includes('Add Account') || title === 'Add Account') {
          btn.click();
          return true;
        }
      }
      return false;
    });

    expect(clickedAdd).toBe(true);
    await browser.pause(500);

    // Select "Other / Custom" provider
    const clickedCustom = await browser.execute(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if ((btn.textContent || '').includes('Other / Custom') && btn.offsetHeight > 0) {
          btn.click();
          return true;
        }
      }
      return false;
    });

    expect(clickedCustom).toBe(true);
    await browser.pause(500);

    // Fill email
    await browser.execute((val) => {
      const input = document.querySelector('input[type="email"], input[name="email"]');
      if (input) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, val);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, email);
    await browser.pause(300);

    // Fill password
    await browser.execute((val) => {
      const input = document.querySelector('input[type="password"], input[name="password"]');
      if (input) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, val);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, password);
    await browser.pause(300);

    // Click "Auto-detect Server Settings" to trigger detection and show manual fields
    const clickedAutoDetect = await browser.execute(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if ((btn.textContent || '').includes('Auto-detect') && btn.offsetHeight > 0) {
          btn.click();
          return true;
        }
      }
      return false;
    });

    // Wait for auto-detect to finish or for manual config fields to appear
    await browser.pause(3000);

    // If auto-detect worked the fields may already be populated; overwrite with our values
    // Fill IMAP host
    await browser.execute((val) => {
      const input = document.querySelector('input[name="imapHost"]');
      if (input) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, val);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, imapHost);
    await browser.pause(200);

    // Fill IMAP port
    await browser.execute((val) => {
      const input = document.querySelector('input[name="imapPort"]');
      if (input) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, String(val));
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, imapPort);
    await browser.pause(200);

    // Fill SMTP host
    await browser.execute((val) => {
      const input = document.querySelector('input[name="smtpHost"]');
      if (input) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, val);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, smtpHost);
    await browser.pause(200);

    // Fill SMTP port
    await browser.execute((val) => {
      const input = document.querySelector('input[name="smtpPort"]');
      if (input) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, String(val));
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, smtpPort);
    await browser.pause(300);

    // Click "Add Account" submit button
    const clickedSubmit = await browser.execute(() => {
      const buttons = document.querySelectorAll('button[type="submit"], button');
      for (const btn of buttons) {
        const text = (btn.textContent || '').trim();
        if (text === 'Add Account' && btn.offsetHeight > 0 && !btn.disabled) {
          btn.click();
          return true;
        }
      }
      return false;
    });

    expect(clickedSubmit).toBe(true);

    // Wait for connection test and success
    await browser.waitUntil(
      async () => {
        const result = await browser.execute(() => {
          const text = document.body.innerText;
          return text.includes('Connected!') || text.includes('Account added successfully');
        });
        return result;
      },
      {
        timeout: 30_000,
        timeoutMsg: `Account add did not succeed within 30s for ${email}`,
        interval: 1000,
      },
    );

    // Wait for modal to close
    await browser.pause(2000);
  }

  // ---------------------------------------------------------------------------
  // Tests
  // ---------------------------------------------------------------------------

  describe('Remove existing test accounts', function () {
    it('should remove luke@forceunwrap.com if present', async function () {
      await removeAccountIfExists(browser.testEnv.TEST_EMAIL);
    });

    it('should remove i-am-your-father@forceunwrap.com if present', async function () {
      await removeAccountIfExists(browser.testEnv.TEST_EMAIL2);
    });
  });

  describe('Add first test account', function () {
    it('should add the first test account', async function () {
      await addTestAccount({
        email: browser.testEnv.TEST_EMAIL,
        password: browser.testEnv.TEST_PASSWORD,
        imapHost: browser.testEnv.IMAP_HOST,
        imapPort: browser.testEnv.IMAP_PORT || 993,
        smtpHost: browser.testEnv.SMTP_HOST,
        smtpPort: browser.testEnv.SMTP_PORT || 587,
      });
    });
  });

  describe('Add second test account', function () {
    it('should add the second test account', async function () {
      await addTestAccount({
        email: browser.testEnv.TEST_EMAIL2,
        password: browser.testEnv.TEST_PASSWORD2,
        imapHost: browser.testEnv.IMAP_HOST,
        imapPort: browser.testEnv.IMAP_PORT || 993,
        smtpHost: browser.testEnv.SMTP_HOST,
        smtpPort: browser.testEnv.SMTP_PORT || 587,
      });
    });
  });

  describe('Verify accounts in sidebar', function () {
    it('should show both test accounts in the sidebar', async function () {
      await browser.pause(2000);

      const accountsVisible = await browser.execute((email1, email2) => {
        const sidebar = document.querySelector('aside') || document.querySelector('nav');
        if (!sidebar) return { email1: false, email2: false };

        const text = sidebar.innerText || '';
        // Accounts may show as email or as initials; look for email text or
        // title attributes containing the email
        const allEls = sidebar.querySelectorAll('[title], span, div');
        let found1 = false;
        let found2 = false;
        for (const el of allEls) {
          const t = (el.getAttribute('title') || '') + ' ' + (el.textContent || '');
          if (t.includes(email1)) found1 = true;
          if (t.includes(email2)) found2 = true;
        }
        return { email1: found1, email2: found2 };
      }, browser.testEnv.TEST_EMAIL, browser.testEnv.TEST_EMAIL2);

      expect(accountsVisible.email1).toBe(true);
      expect(accountsVisible.email2).toBe(true);
    });
  });
});
