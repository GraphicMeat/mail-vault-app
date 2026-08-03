/**
 * Shared E2E test helpers for MailVault WebdriverIO tests.
 *
 * Provides wait utilities, keyboard helpers, and navigation helpers.
 * Accounts are seeded mock-IMAP accounts in an isolated HOME (see wdio.conf.js),
 * so nothing here has to protect real accounts from the suite.
 */

// ---------------------------------------------------------------------------
// Wait helpers
// ---------------------------------------------------------------------------

/**
 * Wait for the app to fully load.
 *
 * Handles three startup screens automatically:
 * 1. Onboarding — auto-dismisses by clicking "Get Started"
 * 2. Welcome (no accounts) — returns 'welcome' so tests can branch
 * 3. Main UI (sidebar visible) — returns 'ready'
 *
 * @returns {'ready' | 'welcome'}
 */
export async function waitForApp(timeout = 30_000) {
  // First, wait for *any* content to render (onboarding, welcome, or sidebar)
  try {
    await browser.waitUntil(
      async () => {
        return browser.execute(() => {
          return document.querySelector('[data-testid="sidebar"]') !== null ||
            (document.body?.textContent || '').includes('Get Started') ||
            (document.body?.textContent || '').includes('Add Your First Account');
        });
      },
      {
        timeout,
        timeoutMsg: `App did not render any content within ${timeout}ms`,
        interval: 500,
      },
    );
  } catch (err) {
    // Diagnostics for headless CI: what is the webview actually showing?
    try {
      const dom = await browser.execute(() => ({
        readyState: document.readyState,
        href: location.href,
        title: document.title,
        rootPresent: document.querySelector('#root') !== null,
        bodyLength: document.body?.innerHTML?.length ?? -1,
        bodyHead: (document.body?.innerHTML || '').slice(0, 1500),
      }));
      console.log('[waitForApp] DOM at timeout:', JSON.stringify(dom));
    } catch (e) {
      console.log('[waitForApp] DOM dump failed:', e.message);
    }
    try {
      if (browser.testDataDir) {
        await browser.saveScreenshot(`${browser.testDataDir}/waitforapp-${Date.now()}.png`);
      }
    } catch (e) {
      console.log('[waitForApp] screenshot failed:', e.message);
    }
    throw err;
  }

  // Auto-dismiss onboarding if present
  const dismissedOnboarding = await browser.execute(() => {
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      if ((btn.textContent || '').trim().includes('Get Started')) {
        btn.click();
        return true;
      }
    }
    return false;
  });

  if (dismissedOnboarding) {
    // Wait for onboarding to transition out
    await browser.pause(500);
  }

  // Now check if we land on sidebar (has accounts) or welcome screen (no accounts)
  const state = await browser.waitUntil(
    async () => {
      return browser.execute(() => {
        const sidebar = document.querySelector('[data-testid="sidebar"]');
        if (sidebar && sidebar.offsetHeight > 0) return 'ready';
        if (document.body.textContent.includes('Add Your First Account')) return 'welcome';
        // Still loading (keychain prompt, etc.)
        return null;
      });
    },
    {
      timeout: timeout - 5000,
      timeoutMsg: `App stuck after onboarding — neither sidebar nor welcome screen appeared`,
      interval: 500,
    },
  );

  return state;
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
        if (virtualRows.length > 2) return true; // at least a couple of real rows
        return document.querySelector('[data-testid="email-list-empty-state"]') !== null;
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
 * Open the Settings page and wait for it.
 *
 * Tries Meta+, (macOS shortcut) first, then clicks the sidebar gear. Presence is
 * decided by `[data-testid="settings-page"]` alone — a `[class*="settings"]`
 * match hits ordinary sidebar chrome, so it reports "open" over the mail view and
 * every later click lands on the wrong element.
 */
export async function openSettings() {
  const isOpen = () => browser.execute(() => {
    const el = document.querySelector('[data-testid="settings-page"]');
    return el !== null && el.offsetHeight > 0;
  });

  await browser.keys(['Meta', ',']);
  await browser.pause(300);

  if (!(await isOpen())) {
    const settingsBtn = await browser.execute(() => {
      // The sidebar renders both collapsed and expanded button sets — only the
      // visible one may be clicked.
      for (const btn of document.querySelectorAll('button, a')) {
        if (btn.offsetHeight === 0) continue;
        const label = [
          btn.textContent || '',
          btn.getAttribute('aria-label') || '',
          btn.getAttribute('title') || '',
        ].join(' ').toLowerCase();
        if (label.includes('settings')) {
          btn.click();
          return true;
        }
      }
      return false;
    });

    if (!settingsBtn) {
      throw new Error('Could not open Settings: neither keyboard shortcut nor click worked');
    }
  }

  await browser.waitUntil(isOpen, {
    timeout: 10_000,
    interval: 250,
    timeoutMsg: 'Settings page did not open',
  });
}

/**
 * Close the Settings page by pressing Escape.
 * Includes a dispatch fallback for WKWebView reliability.
 */
export async function closeSettings() {
  const isOpen = () => browser.execute(() => {
    const el = document.querySelector('[data-testid="settings-page"]');
    return el !== null && el.offsetHeight > 0;
  });

  await pressKey('Escape');
  await browser.pause(300);

  if (await isOpen()) {
    await browser.execute(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true,
      }));
    });
    await browser.pause(300);
  }
}

/**
 * Open the email-list search bar.
 *
 * The bar is collapsed behind the toolbar's magnifier — nothing in the list view
 * shows a search input until it is clicked.
 */
export async function openSearch() {
  const inputVisible = () => browser.execute(() => {
    const input = document.querySelector('input[placeholder*="Search"], input[placeholder*="search"]');
    return input !== null && input.offsetHeight > 0;
  });

  if (await inputVisible()) return;

  const clicked = await browser.execute(() => {
    const btn = document.querySelector('button[title="Search emails"]');
    if (!btn || btn.offsetHeight === 0) return false;
    btn.click();
    return true;
  });

  if (!clicked) throw new Error('Could not find the search toggle in the list toolbar');

  await browser.waitUntil(inputVisible, {
    timeout: 5000,
    interval: 200,
    timeoutMsg: 'Search input did not appear after opening search',
  });
}

/**
 * Open the Compose modal by pressing 'c'.
 */
export async function openCompose() {
  await pressKey('c');
  await browser.pause(300);
}
