/**
 * Shared E2E test helpers for MailVault WebdriverIO tests.
 *
 * Provides wait utilities, keyboard helpers, navigation helpers,
 * and account safety helpers to protect non-test accounts.
 */

// ---------------------------------------------------------------------------
// Approved test accounts — only these remain visible during E2E runs
// ---------------------------------------------------------------------------

export const APPROVED_TEST_ACCOUNTS = [
  'luke@forceunwrap.com',
  'i-am-your-father@forceunwrap.com',
];

export const APPROVED_DOMAINS = [
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
];

/**
 * Returns true if the given email address belongs to an approved test account
 * or an approved domain (personal Microsoft accounts used for Graph testing).
 */
export function isApprovedAccount(email) {
  const lower = (email || '').toLowerCase().trim();
  if (APPROVED_TEST_ACCOUNTS.includes(lower)) return true;
  return APPROVED_DOMAINS.some((d) => lower.endsWith('@' + d));
}

// ---------------------------------------------------------------------------
// Wait helpers
// ---------------------------------------------------------------------------

/**
 * Wait for the app to fully load (sidebar visible).
 * Times out after 30 seconds.
 */
export async function waitForApp(timeout = 30_000) {
  // The sidebar is the primary indicator that the app has booted.
  // Try multiple selectors since no data-testid exists yet.
  await browser.waitUntil(
    async () => {
      const ready = await browser.execute(() => {
        // Look for the sidebar element — it contains account avatars and mailbox list
        const sidebar = document.querySelector('aside') ||
          document.querySelector('[class*="sidebar"]') ||
          document.querySelector('nav');
        return sidebar !== null && sidebar.offsetHeight > 0;
      });
      return ready;
    },
    {
      timeout,
      timeoutMsg: `App did not load within ${timeout}ms (sidebar not visible)`,
      interval: 500,
    },
  );
}

/**
 * Wait for at least one email row to appear in the email list.
 * Times out after 60 seconds (emails may need IMAP fetch).
 */
export async function waitForEmails(timeout = 60_000) {
  await browser.waitUntil(
    async () => {
      const found = await browser.execute(() => {
        // Email rows are rendered inside a virtualized list or a plain list
        // Look for elements that represent email rows
        const rows = document.querySelectorAll(
          '[data-testid="email-row"], [class*="email-row"], [class*="EmailRow"]',
        );
        if (rows.length > 0) return true;
        // Fallback: look for elements inside the email list area with subject-like content
        const listArea = document.querySelector('[class*="email-list"], [class*="EmailList"]');
        if (listArea && listArea.children.length > 0) return true;
        // Fallback: virtualized rows from react-window
        const virtualRows = document.querySelectorAll('[style*="position: absolute"][style*="top:"]');
        return virtualRows.length > 2; // at least a couple of real rows
      });
      return found;
    },
    {
      timeout,
      timeoutMsg: `No email rows appeared within ${timeout}ms`,
      interval: 1000,
    },
  );
}

/**
 * Generic wait for an element matching `selector` to be visible in the DOM.
 * @param {string} selector - CSS selector
 * @param {number} timeout - Max wait time in ms (default 10s)
 */
export async function waitForElement(selector, timeout = 10_000) {
  const el = await $(selector);
  await el.waitForDisplayed({
    timeout,
    timeoutMsg: `Element "${selector}" not visible within ${timeout}ms`,
  });
  return el;
}

// ---------------------------------------------------------------------------
// Keyboard helpers
// ---------------------------------------------------------------------------

/**
 * Press a single key.
 * @param {string} key - Key name (e.g. 'c', 'Escape', 'Enter')
 */
export async function pressKey(key) {
  await browser.keys(key);
}

/**
 * Press multiple keys sequentially with a 100ms delay between each.
 * @param {...string} keys - Key names
 */
export async function pressKeys(...keys) {
  for (const key of keys) {
    await browser.keys(key);
    await browser.pause(100);
  }
}

/**
 * Press a two-key sequence with a 200ms gap (e.g. Vim-style 'g' then 'i').
 * @param {string} key1 - First key
 * @param {string} key2 - Second key
 */
export async function pressSequence(key1, key2) {
  await browser.keys(key1);
  await browser.pause(200);
  await browser.keys(key2);
}

// ---------------------------------------------------------------------------
// Navigation helpers
// ---------------------------------------------------------------------------

/**
 * Open the Settings page.
 * Tries Meta+, (macOS shortcut) first, then falls back to clicking the
 * settings gear icon in the sidebar.
 */
export async function openSettings() {
  // Try keyboard shortcut first (Meta+Comma on macOS)
  await browser.keys(['Meta', ',']);
  await browser.pause(300);

  // Check if settings opened
  const opened = await browser.execute(() => {
    const settingsEl = document.querySelector(
      '[class*="settings"], [class*="Settings"], [data-testid="settings-page"]',
    );
    return settingsEl !== null && settingsEl.offsetHeight > 0;
  });

  if (!opened) {
    // Fallback: click the settings icon/button in the sidebar
    const settingsBtn = await browser.execute(() => {
      // Look for a settings button (gear icon) in the sidebar
      const buttons = document.querySelectorAll('button, a');
      for (const btn of buttons) {
        const text = (btn.textContent || '').toLowerCase();
        const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
        const title = (btn.getAttribute('title') || '').toLowerCase();
        if (text.includes('settings') || ariaLabel.includes('settings') || title.includes('settings')) {
          btn.click();
          return true;
        }
      }
      // Look for lucide Settings icon (svg with specific path)
      const svgs = document.querySelectorAll('svg');
      for (const svg of svgs) {
        const parent = svg.closest('button') || svg.parentElement;
        if (parent && (parent.getAttribute('aria-label') || '').toLowerCase().includes('settings')) {
          parent.click();
          return true;
        }
      }
      return false;
    });

    if (!settingsBtn) {
      throw new Error('Could not open Settings: neither keyboard shortcut nor click worked');
    }
  }

  // Wait for the settings page to be visible
  await browser.pause(300);
}

/**
 * Close the Settings page by pressing Escape.
 */
export async function closeSettings() {
  await pressKey('Escape');
  await browser.pause(300);
}

/**
 * Open the Compose modal by pressing 'c'.
 */
export async function openCompose() {
  await pressKey('c');
  await browser.pause(300);
}

// ---------------------------------------------------------------------------
// Account safety helpers
// ---------------------------------------------------------------------------

// Keeps track of accounts hidden by the test harness so we can restore them.
let _hiddenByTests = [];

/**
 * Hide all accounts that are NOT in the approved test account list.
 *
 * Uses browser.execute() to directly manipulate the Zustand settingsStore
 * (more reliable than navigating the UI). Falls back to UI interaction if
 * direct store access is not available.
 */
export async function hideNonTestAccounts() {
  _hiddenByTests = [];

  const result = await browser.execute((approvedAccounts, approvedDomains) => {
    // ---- Attempt 1: direct Zustand store access via module internals ----
    // Zustand stores created with `create()` are plain JS closures. We need
    // to find the store reference. React fiber tree stores component state;
    // we can walk it to find the settingsStore and mailStore references.

    // Helper: walk React fiber tree to find store getState
    function findZustandStores() {
      const rootEl = document.getElementById('root') || document.querySelector('#root');
      if (!rootEl || !rootEl._reactRootContainer && !rootEl.__reactFiber) {
        // Try React 18 createRoot
        const key = Object.keys(rootEl).find((k) => k.startsWith('__reactFiber'));
        if (!key) return null;
      }
      // With Zustand, stores are often accessible via devtools or as module exports.
      // Since the app bundles with Vite, module-scope variables aren't on window.
      // However, Zustand stores expose a getState/setState API on the store itself.
      // We can try to find them through React component state.
      return null; // Not easily accessible without explicit window binding
    }

    findZustandStores(); // attempt but likely null

    // ---- Attempt 2: find stores through React devtools hook ----
    // If __REACT_DEVTOOLS_GLOBAL_HOOK__ is available, we could enumerate stores,
    // but this is fragile. Skip.

    // ---- Attempt 3: dispatch a custom event that the app listens to ----
    // Not implemented in the app. Skip.

    // Since direct store access is not available, return the info needed for
    // UI-based hiding. Return the list of all accounts from the DOM.
    // We'll look at account elements in the sidebar.
    const accountEls = document.querySelectorAll(
      '[data-testid*="account"], [class*="account-item"]',
    );
    const accountsFromDom = [];
    accountEls.forEach((el) => {
      const email = el.getAttribute('data-account-email') || el.textContent;
      accountsFromDom.push(email);
    });

    return { method: 'need-ui', accounts: accountsFromDom };
  }, APPROVED_TEST_ACCOUNTS, APPROVED_DOMAINS);

  // Use UI-based approach: open Settings -> Accounts -> toggle hide on non-test accounts
  await hideNonTestAccountsViaUI();
}

/**
 * Internal: hide non-test accounts by navigating the Settings UI.
 */
async function hideNonTestAccountsViaUI() {
  await openSettings();
  await browser.pause(500);

  // Navigate to the Accounts section/tab in settings
  const clickedTab = await browser.execute(() => {
    // Find and click the Accounts tab/section
    const tabs = document.querySelectorAll(
      'button, a, [role="tab"], [class*="tab"], [class*="nav-item"]',
    );
    for (const tab of tabs) {
      const text = (tab.textContent || '').trim().toLowerCase();
      if (text === 'accounts' || text === 'account') {
        tab.click();
        return true;
      }
    }
    return false;
  });

  if (!clickedTab) {
    console.warn('[helpers] Could not find Accounts tab in Settings');
    await closeSettings();
    return;
  }

  await browser.pause(500);

  // Find all accounts listed in the settings and hide non-approved ones
  const accountsToHide = await browser.execute((approved, domains) => {
    function isApproved(email) {
      const lower = (email || '').toLowerCase().trim();
      if (approved.includes(lower)) return true;
      return domains.some((d) => lower.endsWith('@' + d));
    }

    // Find account entries in the settings page. Each account typically has
    // an email address displayed and a hide toggle button nearby.
    const results = [];
    // Look for elements containing email addresses
    const allText = document.querySelectorAll('span, p, div, label');
    for (const el of allText) {
      const text = (el.textContent || '').trim();
      // Simple email pattern match
      if (text.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/) && !isApproved(text)) {
        results.push(text);
      }
    }
    return [...new Set(results)];
  }, APPROVED_TEST_ACCOUNTS, APPROVED_DOMAINS);

  // For each non-approved account, find and click the hide toggle
  for (const email of accountsToHide) {
    const hidden = await browser.execute((targetEmail) => {
      // Find the account entry containing this email and click its hide button
      const allText = document.querySelectorAll('span, p, div, label');
      for (const el of allText) {
        if ((el.textContent || '').trim() === targetEmail) {
          // Walk up to the account container and look for a hide button/toggle
          let container = el.closest('[class*="account"]') || el.parentElement?.parentElement?.parentElement;
          if (!container) container = el.parentElement?.parentElement;
          if (container) {
            const buttons = container.querySelectorAll('button');
            for (const btn of buttons) {
              const btnText = (btn.textContent || '').toLowerCase();
              const title = (btn.getAttribute('title') || '').toLowerCase();
              if (btnText.includes('hide') || title.includes('hide')) {
                btn.click();
                return true;
              }
            }
            // Try toggle switches
            const toggles = container.querySelectorAll('input[type="checkbox"], [role="switch"]');
            for (const toggle of toggles) {
              const label = toggle.closest('label') || toggle.parentElement;
              if (label && (label.textContent || '').toLowerCase().includes('hide')) {
                toggle.click();
                return true;
              }
            }
          }
        }
      }
      return false;
    }, email);

    if (hidden) {
      _hiddenByTests.push(email);
      await browser.pause(300);
    } else {
      console.warn(`[helpers] Could not find hide toggle for account: ${email}`);
    }
  }

  await closeSettings();
}

/**
 * Restore all accounts that were hidden by hideNonTestAccounts().
 *
 * Re-opens Settings -> Accounts and un-hides each previously hidden account.
 */
export async function restoreHiddenAccounts() {
  if (_hiddenByTests.length === 0) return;

  await openSettings();
  await browser.pause(500);

  // Navigate to Accounts tab
  await browser.execute(() => {
    const tabs = document.querySelectorAll(
      'button, a, [role="tab"], [class*="tab"], [class*="nav-item"]',
    );
    for (const tab of tabs) {
      const text = (tab.textContent || '').trim().toLowerCase();
      if (text === 'accounts' || text === 'account') {
        tab.click();
        return true;
      }
    }
    return false;
  });

  await browser.pause(500);

  // Unhide each account we previously hid
  for (const email of _hiddenByTests) {
    await browser.execute((targetEmail) => {
      // Hidden accounts may be in a separate "Hidden Accounts" section.
      // Look for the email text and an "Unhide" or "Show" button.
      const allText = document.querySelectorAll('span, p, div, label');
      for (const el of allText) {
        if ((el.textContent || '').trim() === targetEmail) {
          let container = el.closest('[class*="account"]') || el.parentElement?.parentElement?.parentElement;
          if (!container) container = el.parentElement?.parentElement;
          if (container) {
            const buttons = container.querySelectorAll('button');
            for (const btn of buttons) {
              const btnText = (btn.textContent || '').toLowerCase();
              const title = (btn.getAttribute('title') || '').toLowerCase();
              if (btnText.includes('unhide') || btnText.includes('show') ||
                  title.includes('unhide') || title.includes('show')) {
                btn.click();
                return true;
              }
            }
            // Try toggle switches (reverse state)
            const toggles = container.querySelectorAll('input[type="checkbox"], [role="switch"]');
            for (const toggle of toggles) {
              const label = toggle.closest('label') || toggle.parentElement;
              if (label && (label.textContent || '').toLowerCase().includes('hid')) {
                toggle.click();
                return true;
              }
            }
          }
        }
      }
      return false;
    }, email);
    await browser.pause(300);
  }

  _hiddenByTests = [];
  await closeSettings();
}
