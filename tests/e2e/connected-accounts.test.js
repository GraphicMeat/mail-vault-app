/**
 * E2E Test: Connected Account Setup
 *
 * The two mock-IMAP accounts are seeded before the app launches (see
 * wdio.conf.js), so this spec verifies they came up connected, then exercises
 * the add/remove flow end to end against a mock server.
 */

import {
  waitForApp,
  openSettings,
  closeSettings,
} from './helpers.js';

describe('Connected Account Setup', function () {
  this.timeout(120_000);

  before(async function () {
    await waitForApp();
  });

  // Account rows live inside the settings page; the identical-looking sidebar
  // rows behind it must never be clicked by mistake.
  const SETTINGS_ROW_SELECTOR = '[data-testid="settings-page"] [class*="cursor-pointer"]';

  async function openAccountsTab() {
    await openSettings();
    await browser.execute(() => {
      for (const tab of document.querySelectorAll('[data-testid="settings-page"] button, [data-testid="settings-page"] [role="tab"]')) {
        if ((tab.textContent || '').trim().toLowerCase() === 'accounts') {
          tab.click();
          return;
        }
      }
    });
    await browser.waitUntil(
      async () => browser.execute((sel) => document.querySelectorAll(sel).length > 0, SETTINGS_ROW_SELECTOR),
      { timeout: 10_000, interval: 250, timeoutMsg: 'Accounts list did not render in Settings' },
    );
  }

  // ---------------------------------------------------------------------------
  // Helper: remove an account by email via Settings > Accounts
  // ---------------------------------------------------------------------------
  async function removeAccountIfExists(email) {
    await openSettings();
    await browser.pause(500);

    await openAccountsTab();

    // Select the row for this account. Every query here is scoped to the
    // settings page: the sidebar behind it has account rows with the same text,
    // and clicking one of those switches accounts instead of selecting here —
    // leaving the previous account selected, which is how a remove would hit
    // the wrong account.
    const selected = await browser.execute((targetEmail, sel) => {
      for (const row of document.querySelectorAll(sel)) {
        if (!(row.innerText || '').includes(targetEmail)) continue;
        row.click();
        return true;
      }
      return false;
    }, email, SETTINGS_ROW_SELECTOR);

    if (!selected) {
      await closeSettings();
      return false;
    }

    await browser.pause(500);

    const clickedRemove = await browser.execute(() => {
      for (const btn of document.querySelectorAll('[data-testid="settings-page"] button')) {
        if ((btn.textContent || '').includes('Remove This Account') && btn.offsetHeight > 0) {
          btn.click();
          return true;
        }
      }
      return false;
    });

    if (!clickedRemove) throw new Error(`Could not open the remove confirmation for ${email}`);
    await browser.pause(500);

    // The confirmation names the account it is about to delete — check it before
    // confirming, so a mis-targeted row click can never remove a real account.
    const confirmLine = await browser.waitUntil(
      async () => browser.execute(() => {
        const page = document.querySelector('[data-testid="settings-page"]');
        const m = page && page.innerText.match(/Are you sure you want to remove .*/);
        return m ? m[0] : null;
      }),
      { timeout: 5000, interval: 250, timeoutMsg: 'Remove confirmation never appeared' },
    );

    if (!confirmLine.includes(email)) {
      throw new Error(`Remove confirmation says "${confirmLine}" — refusing to confirm for ${email}`);
    }

    const confirmed = await browser.execute(() => {
      for (const btn of document.querySelectorAll('[data-testid="settings-page"] button')) {
        if ((btn.textContent || '').trim().startsWith('Remove') && btn.offsetHeight > 0
            && !(btn.textContent || '').includes('This Account')) {
          btn.click();
          return true;
        }
      }
      return false;
    });

    if (!confirmed) throw new Error(`Could not confirm removal of ${email}`);

    await browser.waitUntil(
      async () => browser.execute((targetEmail) => !document.body.innerText.includes(targetEmail), email),
      { timeout: 15_000, interval: 500, timeoutMsg: `${email} still listed after removal` },
    );

    await closeSettings();
    return true;
  }

  // ---------------------------------------------------------------------------
  // Helper: add a test account via the AccountModal
  // ---------------------------------------------------------------------------
  async function addTestAccount({ email, password, imapHost, imapPort, smtpHost, smtpPort }) {
    // With accounts already present the sidebar has no Add button — it lives in
    // Settings → Accounts, which closes itself and opens the AccountModal.
    await openAccountsTab();

    const clickedAdd = await browser.execute(() => {
      const buttons = document.querySelectorAll('[data-testid="settings-page"] button');
      for (const btn of buttons) {
        const text = (btn.textContent || '').trim();
        const title = (btn.getAttribute('title') || '').trim();
        if ((text.includes('Add') && text.includes('Account')) || title === 'Add Account') {
          if (btn.offsetHeight > 0) {
            btn.click();
            return true;
          }
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

    // Helper to set input value via React-compatible approach
    async function setInputValue(selector, value) {
      await browser.execute((sel, val) => {
        const input = document.querySelector(sel);
        if (!input) return false;
        const setter = Object.getOwnPropertyDescriptor(
          input.type === 'number' ? window.HTMLInputElement.prototype : window.HTMLInputElement.prototype,
          'value'
        ).set;
        setter.call(input, String(val));
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }, selector, value);
      await browser.pause(200);
    }

    // The custom provider hides the server fields behind "Auto-detect Server
    // Settings" — it reveals them whether or not detection finds anything, but
    // detection probes DNS first, so wait for the fields rather than a fixed pause.
    const hasManualFields = await browser.execute(() => {
      return document.querySelector('input[name="imapHost"]') !== null;
    });

    if (!hasManualFields) {
      await browser.execute(() => {
        for (const btn of document.querySelectorAll('button')) {
          if ((btn.textContent || '').includes('Auto-detect') && btn.offsetHeight > 0) {
            btn.click();
            return true;
          }
        }
        return false;
      });

      await browser.waitUntil(
        async () => browser.execute(() => document.querySelector('input[name="imapHost"]') !== null),
        { timeout: 60_000, interval: 1000, timeoutMsg: 'Server settings fields never appeared' },
      );
    }

    // Fill IMAP/SMTP settings
    await setInputValue('input[name="imapHost"]', imapHost);
    await setInputValue('input[name="imapPort"]', imapPort);
    await setInputValue('input[name="smtpHost"]', smtpHost);
    await setInputValue('input[name="smtpPort"]', smtpPort);

    // Click "Add Account" submit button
    const clickedSubmit = await browser.execute(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        const text = (btn.textContent || '').trim();
        if (text === 'Add Account' && btn.offsetHeight > 0 && !btn.disabled) {
          btn.click();
          return true;
        }
      }
      return false;
    });

    if (!clickedSubmit) {
      // Debug: log visible buttons
      const debugInfo = await browser.execute(() => {
        const buttons = document.querySelectorAll('button');
        return Array.from(buttons).filter(b => b.offsetHeight > 0).map(b => b.textContent.trim()).join(' | ');
      });
      console.log('[addTestAccount] visible buttons:', debugInfo);
    }
    expect(clickedSubmit).toBe(true);

    // Wait for the connection test to resolve either way — a failed add reports
    // its reason in the modal, and that reason is what a failing spec should say.
    const outcome = await browser.waitUntil(
      async () => browser.execute((target) => {
        const text = document.body.innerText;
        if (text.includes('Account added successfully') || text.includes('Connected!')) return 'ok';
        // The modal auto-closes 1.5s after success, so a slow poll can miss the
        // banner entirely — the account landing in the sidebar counts too.
        const sidebar = document.querySelector('[data-testid="sidebar"]');
        if (sidebar && (sidebar.innerText || '').includes(target)) return 'ok';
        // Scope the error read to the modal's form: Settings has its own
        // permanently-rendered danger copy that would otherwise read as a failure.
        const err = document.querySelector('form [class*="mail-danger"]');
        if (err && err.innerText.trim()) return `error: ${err.innerText.trim()}`;
        return null;
      }, email),
      {
        timeout: 60_000,
        timeoutMsg: `Account add neither succeeded nor reported an error within 60s for ${email}`,
        interval: 1000,
      },
    );

    expect(outcome).toBe('ok');

    // Wait for modal to auto-close
    await browser.pause(3000);
  }

  // ---------------------------------------------------------------------------
  // Tests
  // ---------------------------------------------------------------------------

  describe('Verify test accounts exist', function () {
    it('should have both seeded mock accounts available', async function () {
      await browser.pause(2000);

      const accountsPresent = await browser.execute((email1, email2) => {
        const sidebar = document.querySelector('[data-testid="sidebar"]');
        if (!sidebar) return { email1: false, email2: false };
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

      expect(accountsPresent.email1).toBe(true);
      expect(accountsPresent.email2).toBe(true);
    });
  });

  describe('Add and remove an account', function () {
    // A third address on mock server #1 — the mock accepts any LOGIN, so this
    // exercises the real AccountModal flow (connection test included) without
    // disturbing the two seeded accounts.
    const email = 'r2d2@mock.test';

    after(async function () {
      await removeAccountIfExists(email);
    });

    it('should add an account through the AccountModal', async function () {
      const { host, port } = browser.mockImap[0];

      await addTestAccount({
        email,
        password: browser.testEnv.TEST_PASSWORD,
        imapHost: host,
        imapPort: port,
        smtpHost: host,
        smtpPort: port,
      });

      const present = await browser.execute((target) => {
        const sidebar = document.querySelector('[data-testid="sidebar"]');
        if (!sidebar) return false;
        for (const el of sidebar.querySelectorAll('[title], span, div')) {
          const t = (el.getAttribute('title') || '') + ' ' + (el.textContent || '');
          if (t.includes(target)) return true;
        }
        return false;
      }, email);

      expect(present).toBe(true);
    });

    it('should remove the account again', async function () {
      await removeAccountIfExists(email);

      const present = await browser.execute((target) => {
        const sidebar = document.querySelector('[data-testid="sidebar"]');
        if (!sidebar) return false;
        for (const el of sidebar.querySelectorAll('[title], span, div')) {
          const t = (el.getAttribute('title') || '') + ' ' + (el.textContent || '');
          if (t.includes(target)) return true;
        }
        return false;
      }, email);

      expect(present).toBe(false);
    });
  });

  describe('Verify accounts in sidebar', function () {
    it('should show both test accounts in the sidebar', async function () {
      await browser.pause(2000);

      const accountsVisible = await browser.execute((email1, email2) => {
        const sidebar = document.querySelector('[data-testid="sidebar"]') || document.querySelector('aside') || document.querySelector('nav');
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
