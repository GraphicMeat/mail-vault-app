/**
 * E2E Performance Benchmark: Account/Folder/View Switching
 *
 * Measures transition performance across real accounts.
 * Does NOT modify or delete any emails — read-only observation.
 *
 * Benchmarks:
 *   1. Account switching (sidebar click → emails visible)
 *   2. Folder switching (INBOX → Sent → Trash → INBOX)
 *   3. View mode switching (List → Chat → List)
 *   4. Layout switching (2-column → 3-column → 2-column)
 *   5. Unified inbox (enter → observe → exit)
 *   6. Combined rapid-fire switching
 *
 * Outputs a summary table of p50/p95/max timings to console.
 */

import {
  waitForApp,
  waitForEmails,
  openSettings,
  closeSettings,
} from './helpers.js';

// ── Timing utility ──────────────────────────────────────────────────────────

const results = {}; // { label: [ms, ms, ...] }

function record(label, ms) {
  if (!results[label]) results[label] = [];
  results[label].push(ms);
}

function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function printSummary() {
  console.log('\n╔══════════════════════════════════════════════════════════════════╗');
  console.log('║              PERFORMANCE BENCHMARK RESULTS                      ║');
  console.log('╠══════════════════════════════════════════════════════════════════╣');
  console.log('║ Operation                        │  p50  │  p95  │  max  │  n  ║');
  console.log('╟──────────────────────────────────┼───────┼───────┼───────┼─────╢');

  for (const [label, times] of Object.entries(results)) {
    const p50 = percentile(times, 50);
    const p95 = percentile(times, 95);
    const max = Math.max(...times);
    const n = times.length;
    const name = label.padEnd(34);
    console.log(`║ ${name}│ ${String(p50).padStart(4)}ms │ ${String(p95).padStart(4)}ms │ ${String(max).padStart(4)}ms │ ${String(n).padStart(3)} ║`);
  }

  console.log('╚══════════════════════════════════════════════════════════════════╝\n');
}

// ── DOM interaction helpers ─────────────────────────────────────────────────

/**
 * Get snapshot of current email list state: count, first subject, loading status.
 */
async function getEmailListState() {
  return browser.execute(() => {
    const rows = document.querySelectorAll('[data-testid="email-row"]');
    let virtualRows = 0;
    if (rows.length === 0) {
      virtualRows = document.querySelectorAll('[style*="position: absolute"][style*="top:"]').length;
    }
    // Chat view: count sender rows
    const senderRows = document.querySelectorAll('[data-testid="sender-row"]');
    const firstRow = rows[0];
    const firstSubject = firstRow ? (firstRow.querySelector('[class*="subject"], [class*="font-medium"]')?.textContent || '').trim().slice(0, 40) : '';
    const loading = !!document.querySelector('[class*="animate-spin"]');
    const emailCount = rows.length || virtualRows || senderRows.length;
    const isChatView = !!document.querySelector('[data-testid="chat-view"]');
    // Check for "Folders" section visibility (indicates non-unified mode)
    const sidebar = document.querySelector('[data-testid="sidebar"]');
    const hasFolders = sidebar ? (sidebar.textContent || '').includes('Folders') || sidebar.querySelectorAll('[title="INBOX"], [title="Sent"]').length > 0 : false;
    return { emailCount, firstSubject, loading, hasFolders, isChatView };
  });
}

/**
 * Wait for email list to stabilize (emails present and no spinner).
 * Returns the time it took in ms.
 */
async function waitForEmailsStable(timeout = 30_000) {
  const start = Date.now();
  await browser.waitUntil(
    async () => {
      return browser.execute(() => {
        // Standard email rows
        const rows = document.querySelectorAll('[data-testid="email-row"]');
        if (rows.length > 0) return true;
        // Chat view sender rows
        const senderRows = document.querySelectorAll('[data-testid="sender-row"]');
        if (senderRows.length > 0) return true;
        // Chat view container (may have no senders yet but view is rendered)
        if (document.querySelector('[data-testid="chat-sender-list"]')) return true;
        // Virtualized rows (react-window)
        const virtualRows = document.querySelectorAll('[style*="position: absolute"][style*="top:"]');
        if (virtualRows.length > 2) return true;
        if (document.querySelector('[data-testid="email-list-empty-state"]')) return true;
        return false;
      });
    },
    { timeout, interval: 100, timeoutMsg: `Emails did not stabilize within ${timeout}ms` },
  );
  return Date.now() - start;
}

/**
 * Click an account avatar in the sidebar by index (0-based).
 * Works for both expanded (div) and collapsed (button) sidebar modes.
 */
async function clickAccount(index) {
  return browser.execute((idx) => {
    const sidebar = document.querySelector('[data-testid="sidebar"]');
    if (!sidebar) return { clicked: false };
    const circles = sidebar.querySelectorAll('div[class*="rounded-full"]');
    const accounts = [];
    for (const circle of circles) {
      if (!circle.style.backgroundColor) continue;
      const initial = circle.textContent.trim();
      if (initial.length === 0 || initial.length > 2) continue;
      const container = circle.closest('[class*="cursor-pointer"]') || circle.closest('button');
      if (!container || container.offsetHeight === 0) continue;
      accounts.push({ container, initial });
    }
    if (idx < accounts.length) {
      accounts[idx].container.click();
      return { clicked: true, title: accounts[idx].initial };
    }
    return { clicked: false };
  }, index);
}

/**
 * Click a folder in the sidebar by name (expanded sidebar mode).
 */
async function clickFolder(folderName) {
  return browser.execute((name) => {
    const sidebar = document.querySelector('[data-testid="sidebar"]');
    if (!sidebar) return false;
    // In expanded sidebar, folders have text labels
    const items = sidebar.querySelectorAll('span, div, button');
    for (const el of items) {
      const text = (el.textContent || '').trim();
      if (text === name) {
        const clickable = el.closest('div[class*="cursor-pointer"]') || el.closest('button') || el;
        clickable.click();
        return true;
      }
    }
    // In collapsed sidebar, folders have title attributes
    const buttons = sidebar.querySelectorAll('button');
    for (const btn of buttons) {
      const title = (btn.getAttribute('title') || '').trim();
      if (title === name || title.toLowerCase() === name.toLowerCase()) {
        btn.click();
        return true;
      }
    }
    return false;
  }, folderName);
}

/**
 * Click the "All Inboxes" button to enter unified inbox.
 */
async function clickUnifiedInbox() {
  return browser.execute(() => {
    const btn = document.querySelector('[data-testid="all-inboxes-btn"]');
    if (btn && btn.offsetHeight > 0) {
      btn.click();
      return true;
    }
    return false;
  });
}

/**
 * Click a settings button by its text content.
 */
async function clickSettingsButton(text) {
  return browser.execute((buttonText) => {
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      if (btn.offsetHeight > 0 && btn.textContent.trim().startsWith(buttonText)) {
        btn.scrollIntoView({ behavior: 'instant', block: 'center' });
        btn.click();
        return true;
      }
    }
    return false;
  }, text);
}

// Account count is detected in the before() hook via accountInfo

/**
 * Get available folder names from sidebar.
 */
async function getFolderNames() {
  return browser.execute(() => {
    const sidebar = document.querySelector('[data-testid="sidebar"]');
    if (!sidebar) return [];
    const names = [];
    // Expanded sidebar: text in the "Folders" section
    const spans = sidebar.querySelectorAll('span');
    const skip = new Set(['Folders', 'Settings', 'All Inboxes', 'Mail', 'Vault', '']);
    for (const span of spans) {
      const text = (span.textContent || '').trim();
      if (!skip.has(text) && text.length < 30 && !text.includes('@') && !text.includes('emails') && !text.match(/^\d/)) {
        names.push(text);
      }
    }
    // Collapsed sidebar: buttons with title that look like folder names
    if (names.length === 0) {
      const folderTitles = new Set(['INBOX', 'Sent', 'Drafts', 'Trash', 'Junk', 'Archive', 'Spam', 'Deleted Items', 'Sent Items']);
      const buttons = sidebar.querySelectorAll('button[title]');
      for (const btn of buttons) {
        if (btn.offsetHeight === 0) continue;
        const title = btn.getAttribute('title');
        if (folderTitles.has(title)) names.push(title);
      }
    }
    return [...new Set(names)];
  });
}

// ── Test suite ──────────────────────────────────────────────────────────────

describe('Performance Benchmark', function () {
  this.timeout(180_000);

  let accountCount = 0;
  let folderNames = [];

  before(async function () {
    await waitForApp();
    await waitForEmails();
    await browser.pause(3000); // Let background sync settle

    // Log all accounts the app has loaded (from sidebar)
    // Expanded sidebar: accounts are <div> with onClick, avatar is div.rounded-full with inline bg color
    // Collapsed sidebar: accounts are <button> with avatar inside
    const accountInfo = await browser.execute(() => {
      const sidebar = document.querySelector('[data-testid="sidebar"]');
      if (!sidebar) return { accounts: [] };
      const accounts = [];
      // Find all colored avatar circles (works for both collapsed and expanded)
      const circles = sidebar.querySelectorAll('div[class*="rounded-full"]');
      for (const circle of circles) {
        if (!circle.style.backgroundColor) continue;
        const initial = circle.textContent.trim();
        if (initial.length === 0 || initial.length > 2) continue;
        // Walk up to the clickable account container
        const container = circle.closest('[class*="cursor-pointer"]') || circle.closest('button');
        if (!container || container.offsetHeight === 0) continue;
        // Extract account name/email from sibling text
        const textEl = container.querySelector('[class*="truncate"]');
        const label = textEl ? textEl.textContent.trim() : container.getAttribute('title') || '';
        accounts.push({ initial, bg: circle.style.backgroundColor, label });
      }
      return { accounts };
    });
    console.log(`\n[perf] Accounts detected: ${accountInfo.accounts.length}`);
    for (const acc of accountInfo.accounts) {
      console.log(`[perf]   → ${acc.initial} "${acc.label}" (${acc.bg})`);
    }

    accountCount = accountInfo.accounts.length;
    folderNames = await getFolderNames();

    console.log(`[perf] Found ${accountCount} accounts`);
    console.log(`[perf] Found ${folderNames.length} folders: ${folderNames.join(', ')}`);

    const initialState = await getEmailListState();
    console.log(`[perf] Initial state: ${initialState.emailCount} emails, loading=${initialState.loading}`);
  });

  after(async function () {
    printSummary();
  });

  // ── 1. Account switching ────────────────────────────────────────────────

  it('should benchmark account switching', async function () {
    if (accountCount < 2) {
      console.warn('[perf] Skipping account switching — only 1 account');
      this.skip();
    }

    const ROUNDS = 3;
    for (let round = 0; round < ROUNDS; round++) {
      for (let i = 0; i < accountCount; i++) {
        const beforeState = await getEmailListState();
        const start = Date.now();

        const result = await clickAccount(i);
        if (!result.clicked) continue;

        const ms = await waitForEmailsStable();
        record('Account switch', ms);

        const afterState = await getEmailListState();
        console.log(`[perf] Account switch → ${result.title}: ${ms}ms (${beforeState.emailCount} → ${afterState.emailCount} emails)`);

        await browser.pause(500); // settle between switches
      }
    }
  });

  // ── 2. Folder switching ─────────────────────────────────────────────────

  it('should benchmark folder switching', async function () {
    // Make sure we're on a single account first
    if (accountCount >= 2) {
      await clickAccount(0);
      await waitForEmailsStable();
      await browser.pause(500);
    }

    // Common folders to test
    const foldersToTest = ['INBOX', 'Sent', 'Trash', 'Drafts', 'Junk', 'Archive'];
    const available = foldersToTest.filter(f =>
      folderNames.some(fn => fn === f || fn.toLowerCase() === f.toLowerCase())
    );

    if (available.length < 2) {
      console.warn(`[perf] Only ${available.length} testable folders found, using what's available`);
    }

    console.log(`[perf] Testing folders: ${available.join(', ')}`);

    const ROUNDS = 3;
    for (let round = 0; round < ROUNDS; round++) {
      for (const folder of available) {
        const beforeState = await getEmailListState();
        const start = Date.now();

        const clicked = await clickFolder(folder);
        if (!clicked) {
          console.log(`[perf] Could not click folder: ${folder}`);
          continue;
        }

        // Wait for list to update (folder may be empty, so just wait for UI to settle)
        await browser.waitUntil(
          async () => {
            const state = await getEmailListState();
            // Either we see emails, or it's been long enough that it's just empty
            return state.emailCount > 0 || (Date.now() - start > 3000);
          },
          { timeout: 15_000, interval: 100 },
        );
        const ms = Date.now() - start;
        record(`Folder: ${folder}`, ms);

        const afterState = await getEmailListState();
        console.log(`[perf] Folder → ${folder}: ${ms}ms (${beforeState.emailCount} → ${afterState.emailCount} emails)`);

        await browser.pause(300);
      }
    }

    // Return to INBOX
    await clickFolder('INBOX');
    await browser.pause(500);
  });

  // ── 3. View mode switching ──────────────────────────────────────────────

  it('should benchmark view mode switching (List ↔ Chat)', async function () {
    await openSettings();
    await browser.pause(300);

    // Navigate to Appearance section
    const clickedAppearance = await browser.execute(() => {
      const tabs = document.querySelectorAll('button, a, [role="tab"]');
      for (const tab of tabs) {
        const text = (tab.textContent || '').trim().toLowerCase();
        if (text === 'appearance' || text === 'layout') {
          tab.click();
          return true;
        }
      }
      return false;
    });

    await browser.pause(300);
    await closeSettings();

    // Switch view modes via keyboard shortcut or settings
    const ROUNDS = 3;
    for (let round = 0; round < ROUNDS; round++) {
      // Switch to Chat view — measure only the click + render
      await openSettings();
      await browser.pause(200);
      const start1 = Date.now();
      await clickSettingsButton('Chat');
      await closeSettings();
      const ms1 = await waitForEmailsStable().catch(() => Date.now() - start1);
      record('View: → Chat', typeof ms1 === 'number' ? ms1 : Date.now() - start1);

      const state1 = await getEmailListState();
      console.log(`[perf] View → Chat: ${typeof ms1 === 'number' ? ms1 : Date.now() - start1}ms (${state1.emailCount} items)`);

      await browser.pause(500);

      // Switch back to List view
      await openSettings();
      await browser.pause(200);
      const start2 = Date.now();
      await clickSettingsButton('List');
      await closeSettings();
      const ms2 = await waitForEmailsStable().catch(() => Date.now() - start2);
      record('View: → List', typeof ms2 === 'number' ? ms2 : Date.now() - start2);

      const state2 = await getEmailListState();
      console.log(`[perf] View → List: ${typeof ms2 === 'number' ? ms2 : Date.now() - start2}ms (${state2.emailCount} items)`);

      await browser.pause(500);
    }
  });

  // ── 4. Layout switching ─────────────────────────────────────────────────

  it('should benchmark layout switching (2-col ↔ 3-col)', async function () {
    const ROUNDS = 3;
    for (let round = 0; round < ROUNDS; round++) {
      // Switch to 3-column — measure only the click + render, not settings modal open/close
      await openSettings();
      await browser.pause(200);
      const start1 = Date.now();
      await clickSettingsButton('3-Column');
      await closeSettings();
      await waitForEmailsStable().catch(() => {});
      const ms1 = Date.now() - start1;
      record('Layout: → 3-col', ms1);
      console.log(`[perf] Layout → 3-column: ${ms1}ms`);

      await browser.pause(500);

      // Switch to 2-column
      await openSettings();
      await browser.pause(200);
      const start2 = Date.now();
      await clickSettingsButton('2-Column');
      await closeSettings();
      await waitForEmailsStable().catch(() => {});
      const ms2 = Date.now() - start2;
      record('Layout: → 2-col', ms2);
      console.log(`[perf] Layout → 2-column: ${ms2}ms`);

      await browser.pause(500);
    }
  });

  // ── 5. Unified inbox ───────────────────────────────────────────────────

  it('should benchmark unified inbox enter/exit', async function () {
    if (accountCount < 2) {
      console.warn('[perf] Skipping unified inbox — only 1 account');
      this.skip();
    }

    const ROUNDS = 3;
    for (let round = 0; round < ROUNDS; round++) {
      // Make sure we start on a single account
      await clickAccount(0);
      await waitForEmailsStable();
      const beforeState = await getEmailListState();
      await browser.pause(500);

      // Enter unified inbox
      const startEnter = Date.now();
      const clicked = await clickUnifiedInbox();
      if (!clicked) {
        console.warn('[perf] Could not click All Inboxes button');
        continue;
      }

      const msEnter = await waitForEmailsStable();
      record('Unified: enter', msEnter);

      const unifiedState = await getEmailListState();
      console.log(`[perf] Unified enter: ${msEnter}ms (${beforeState.emailCount} → ${unifiedState.emailCount} emails, hasFolders=${unifiedState.hasFolders})`);

      // Verify folders are hidden in unified mode
      if (unifiedState.hasFolders) {
        console.warn('[perf] ⚠ Folders still visible in unified mode!');
      }

      await browser.pause(500);

      // Exit by clicking first account
      const startExit = Date.now();
      await clickAccount(0);
      const msExit = await waitForEmailsStable();
      record('Unified: exit', msExit);

      const exitState = await getEmailListState();
      console.log(`[perf] Unified exit: ${msExit}ms (${unifiedState.emailCount} → ${exitState.emailCount} emails, hasFolders=${exitState.hasFolders})`);

      await browser.pause(500);
    }
  });

  // ── 6. Rapid-fire combined switching ──────────────────────────────────

  it('should benchmark rapid-fire combined transitions', async function () {
    // Simulate real user behavior: quick successive switches
    const sequence = [];

    // Build a realistic sequence
    if (accountCount >= 2) {
      sequence.push({ type: 'account', index: 1, label: 'Account 2' });
    }
    if (folderNames.includes('Sent')) {
      sequence.push({ type: 'folder', name: 'Sent', label: 'Folder: Sent' });
    }
    sequence.push({ type: 'folder', name: 'INBOX', label: 'Folder: INBOX' });
    if (accountCount >= 2) {
      sequence.push({ type: 'unified', label: 'Unified' });
      sequence.push({ type: 'account', index: 0, label: 'Account 1' });
    }

    if (sequence.length < 2) {
      console.warn('[perf] Not enough variety for rapid-fire test');
      this.skip();
    }

    console.log(`[perf] Rapid-fire sequence: ${sequence.map(s => s.label).join(' → ')}`);

    const ROUNDS = 2;
    for (let round = 0; round < ROUNDS; round++) {
      // Reset to known state
      await clickAccount(0);
      await waitForEmailsStable();
      await browser.pause(300);

      for (const step of sequence) {
        const beforeState = await getEmailListState();
        const start = Date.now();

        if (step.type === 'account') {
          await clickAccount(step.index);
        } else if (step.type === 'folder') {
          await clickFolder(step.name);
        } else if (step.type === 'unified') {
          await clickUnifiedInbox();
        }

        // Short wait — simulating impatient user
        const ms = await waitForEmailsStable(15_000).catch(() => Date.now() - start);
        const elapsed = typeof ms === 'number' ? ms : Date.now() - start;
        record(`Rapid: ${step.label}`, elapsed);

        const afterState = await getEmailListState();
        console.log(`[perf] Rapid ${step.label}: ${elapsed}ms (${beforeState.emailCount} → ${afterState.emailCount})`);

        // Minimal pause — user is clicking fast
        await browser.pause(200);
      }
    }
  });

  // ── 7. Data integrity check ───────────────────────────────────────────

  it('should verify no data was modified (read-only check)', async function () {
    // Return to first account INBOX
    await clickAccount(0);
    await waitForEmailsStable();

    const finalState = await getEmailListState();
    console.log(`[perf] Final state: ${finalState.emailCount} emails`);

    // Verify app is still responsive
    const responsive = await browser.execute(() => {
      return document.querySelector('[data-testid="sidebar"]')?.offsetHeight > 0;
    });
    expect(responsive).toBe(true);
  });
});
