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
// Diagnostics for headless CI: what is the webview actually showing?
async function dumpAppState(label) {
  try {
    const dom = await browser.execute(() => ({
      readyState: document.readyState,
      href: location.href,
      title: document.title,
      rootPresent: document.querySelector('#root') !== null,
      sidebar: (() => {
        const s = document.querySelector('[data-testid="sidebar"]');
        return s ? { offsetHeight: s.offsetHeight, rect: s.getBoundingClientRect() } : null;
      })(),
      bodyText: (document.body?.textContent || '').slice(0, 500),
      bodyLength: document.body?.innerHTML?.length ?? -1,
      bodyHead: (document.body?.innerHTML || '').slice(0, 1500),
    }));
    console.log(`[waitForApp] DOM at ${label}:`, JSON.stringify(dom));
  } catch (e) {
    console.log(`[waitForApp] DOM dump failed (${label}):`, e.message);
  }
  try {
    if (browser.testDataDir) {
      await browser.saveScreenshot(`${browser.testDataDir}/waitforapp-${label}-${Date.now()}.png`);
    }
  } catch (e) {
    console.log(`[waitForApp] screenshot failed (${label}):`, e.message);
  }
}

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
    await dumpAppState('no-content');
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
  let state;
  try {
    state = await browser.waitUntil(
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
  } catch (err) {
    await dumpAppState('stuck-after-onboarding');
    throw err;
  }

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
/**
 * Click a settings navigation button by its exact visible label. Works for
 * top-level tabs ('Templates', 'Storage', 'Accounts', 'General') and the
 * General tab's sub-tabs ('Appearance', 'Behavior', 'Notifications',
 * 'Keyboard Shortcuts') — the settings restructure moved sections off the
 * old flat General page onto these.
 */
export async function clickSettingsNav(label) {
  const clicked = await browser.execute((wanted) => {
    for (const btn of document.querySelectorAll('button')) {
      if (btn.offsetHeight > 0 && btn.textContent.trim() === wanted) {
        btn.click();
        return true;
      }
    }
    return false;
  }, label);
  await browser.pause(400);
  return clicked;
}

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

// ---------------------------------------------------------------------------
// Sidebar / account switching
// ---------------------------------------------------------------------------

/**
 * Click a leaf element in the sidebar whose trimmed text is exactly `text` —
 * an account row or a folder row.
 *
 * Scoped to the sidebar on purpose: the list toolbar and the bulk modal both
 * carry their own "All" control, and an unscoped text search hits one of those
 * first and clicks it silently.
 */
export function clickSidebarItem(text) {
  return browser.execute((needle) => {
    const sidebar = document.querySelector('[data-testid="sidebar"]');
    if (!sidebar) return false;
    for (const el of sidebar.querySelectorAll('*')) {
      if (el.children.length === 0 && (el.textContent || '').trim() === needle) {
        el.click();
        return true;
      }
    }
    return false;
  }, text);
}

/** True when the sidebar's text contains `name` — a folder row or an account row. */
export const sidebarHasFolder = (name) => browser.execute((needle) =>
  (document.querySelector('[data-testid="sidebar"]')?.innerText || '').includes(needle), name);

/** The list header — the only thing that names the folder actually on screen. */
export const folderHeaderText = () => browser.execute(() =>
  document.querySelector('h2')?.textContent?.trim() || '');

/**
 * Text of each row currently rendered. A virtualized list renders a window, so
 * this is "what is on screen", not "what the mailbox holds".
 *
 * The whole innerText, not its first line: a row starts with an empty line and
 * puts the subject third (`"\nSender 3\nLuke archive 3\nJan 4\n"`), so anything
 * that reads line 0 gets `""` for every row and silently compares blanks.
 */
export const visibleRowSubjects = () => browser.execute(() =>
  [...document.querySelectorAll('[data-testid="email-row"]')]
    .map((row) => (row.innerText || '').replace(/\s*\n\s*/g, ' | ').trim()));

/**
 * Switch to `email`'s `folderName` and wait until the view is really there.
 *
 * Every wait here is load-bearing:
 *   - the first folder fetch of a session races credential loading, so the
 *     account click is retried once before giving up on the folder listing;
 *   - `waitForEmails()` only asks "is some row rendered", which a virtualized
 *     list satisfies with the PREVIOUS folder's rows for a beat after the
 *     click — the header check is what makes the switch observable;
 *   - `waitForEmails()` also succeeds on the empty-state element, so a folder
 *     the caller knows is non-empty is re-clicked once if it lands empty.
 *
 * The whole sequence is retried once: a cold switch can time out with nothing
 * rendered at all, and a bare failure there says nothing about why.
 */
export async function switchToFolder(email, folderName, opts = {}) {
  try {
    await switchToFolderOnce(email, folderName, opts);
  } catch (e) {
    console.warn(`[switchToFolder] ${email} → ${folderName} failed once (${e.message}) — retrying`);
    await switchToFolderOnce(email, folderName, opts);
  }
}

/**
 * The store's own idea of where it is, when the E2E build exposes it.
 *
 * The list header is not enough to prove an account switch landed: every
 * account has a folder called INBOX, so `h2 === 'INBOX'` is equally true of the
 * account we just left. A switch that silently didn't happen then reads as a
 * mailbox with the wrong contents — which is exactly how a spec ends up
 * asserting against another account's mail and reporting it as missing.
 */
const activePair = () => browser.execute(() => {
  const s = window.__MAIL_STORE__?.getState?.();
  return s ? { accountId: s.activeAccountId, mailbox: s.activeMailbox } : null;
});

async function switchToFolderOnce(email, folderName, { requireRows = true } = {}) {
  const wantAccountId = (browser.mockAccounts || []).find((a) => a.email === email)?.id || null;

  // The account rows are populated after the first list paint, so a spec whose
  // `before` hook only waited for rows can start clicking before the sidebar
  // knows about every account. Wait for the entry instead of failing on a
  // missing one — this shows up only in a full-suite run, where the app is
  // warm and the spec reaches this line seconds earlier than it does alone.
  await browser.waitUntil(() => sidebarHasFolder(email), {
    timeout: 30_000, interval: 300,
    timeoutMsg: `Sidebar never listed account "${email}" (accounts seeded: ${
      (browser.mockAccounts || []).map((a) => a.email).join(', ')})`,
  });

  if (!(await clickSidebarItem(email))) throw new Error(`No sidebar entry for account "${email}"`);
  try {
    await browser.waitUntil(() => sidebarHasFolder(folderName), { timeout: 8_000, interval: 300 });
  } catch {
    if (!(await clickSidebarItem(email))) throw new Error(`No sidebar entry for account "${email}" on retry`);
    await browser.waitUntil(() => sidebarHasFolder(folderName), {
      timeout: 15_000, interval: 300, timeoutMsg: `${email} never listed a "${folderName}" folder`,
    });
  }

  if (wantAccountId) {
    await browser.waitUntil(async () => (await activePair())?.accountId === wantAccountId, {
      timeout: 15_000, interval: 300,
      timeoutMsg: `Clicking "${email}" never made it the active account (store says ${
        JSON.stringify(await activePair())}) — the click landed somewhere else, or the switch never completed`,
    });
  }

  if (!(await clickSidebarItem(folderName))) throw new Error(`No sidebar entry for folder "${folderName}" (${email})`);
  await browser.waitUntil(async () => (await folderHeaderText()) === folderName, {
    timeout: 10_000, interval: 300, timeoutMsg: `Folder header never showed "${folderName}" after switching (${email})`,
  });
  if (wantAccountId) {
    // Re-check after the folder click: clicking a folder can re-enter
    // activateAccount, and a switch that races can land the folder on the
    // PREVIOUS account.
    await browser.waitUntil(async () => {
      const p = await activePair();
      return p?.accountId === wantAccountId && p?.mailbox === folderName;
    }, {
      timeout: 15_000, interval: 300,
      timeoutMsg: `Store never settled on ${email}/${folderName} (it says ${JSON.stringify(await activePair())})`,
    });
  }
  await waitForEmails();
  if (requireRows && (await visibleRowSubjects()).length === 0) {
    await clickSidebarItem(folderName);
    await browser.waitUntil(async () => (await visibleRowSubjects()).length > 0, {
      timeout: 20_000, interval: 500,
      timeoutMsg: `"${folderName}" (${email}) still empty on retry — cold-start folder fetch never produced rows`,
    });
  }
  // The store flips its active pair before the list repaints, so a snapshot
  // taken the instant the store settles can still be the PREVIOUS account's
  // rows. Wait for two consecutive identical reads before calling the switch
  // done — otherwise a caller compares one account's mail against another's
  // and reports it as missing.
  let previous = null;
  await browser.waitUntil(async () => {
    const current = JSON.stringify(await visibleRowSubjects());
    const settled = current === previous;
    previous = current;
    return settled;
  }, { timeout: 15_000, interval: 400, timeoutMsg: `Row list never settled after switching to ${email}/${folderName}` });
}

/**
 * Walk a list of `{ email, folder }` stops in order, then report what each one
 * rendered.
 *
 * This exists because a single switch away and back is not what breaks: state
 * that leaks across accounts (a tombstone, a selection, a cache write keyed to
 * the view that happens to be on screen) needs the view to move several times
 * before the wrong pair lines up. Run this after every mutating action, not
 * only at the end of a test.
 *
 * Returns `[{ email, folder, subjects }]` so a caller can assert on any stop,
 * including the ones it only passed through.
 */
export async function churnAccounts(stops) {
  const seen = [];
  for (const { email, folder, requireRows = true } of stops) {
    await switchToFolder(email, folder, { requireRows });
    seen.push({ email, folder, subjects: await visibleRowSubjects() });
  }
  return seen;
}
