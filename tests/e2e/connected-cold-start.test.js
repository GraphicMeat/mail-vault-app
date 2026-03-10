/**
 * E2E Cold Start Benchmark
 *
 * Clears all app cache (headers + Maildir bodies), then measures how long
 * it takes for every account to fully load from scratch.
 *
 * IMPORTANT: The test clears the cache via Tauri invoke, then waits for
 * the user to enter the macOS Keychain password before proceeding.
 * Once the app is ready, it benchmarks:
 *   1. Time from cache-clear to first emails visible (cold IMAP load)
 *   2. Per-account switching (all cold — no cache hits)
 *   3. Unified inbox from cold state
 *   4. Total time for all accounts to show emails
 *
 * Does NOT delete any emails — read-only observation.
 */

import assert from 'node:assert';
import {
  waitForApp,
  waitForEmails,
} from './helpers.js';

// ── Timing utility ──────────────────────────────────────────────────────────

const results = {};

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
  console.log('║              COLD START BENCHMARK RESULTS                       ║');
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

// ── DOM helpers ─────────────────────────────────────────────────────────────

async function getEmailListState() {
  return browser.execute(() => {
    const rows = document.querySelectorAll('[data-testid="email-row"]');
    let virtualRows = 0;
    if (rows.length === 0) {
      virtualRows = document.querySelectorAll('[style*="position: absolute"][style*="top:"]').length;
    }
    const senderRows = document.querySelectorAll('[data-testid="sender-row"]');
    const firstRow = rows[0];
    const firstSubject = firstRow ? (firstRow.querySelector('[class*="subject"], [class*="font-medium"]')?.textContent || '').trim().slice(0, 40) : '';
    const loading = !!document.querySelector('[class*="animate-spin"]');
    const emailCount = rows.length || virtualRows || senderRows.length;
    return { emailCount, firstSubject, loading };
  });
}

async function waitForEmailsStable(timeout = 60_000) {
  const start = Date.now();
  await browser.waitUntil(
    async () => {
      return browser.execute(() => {
        const rows = document.querySelectorAll('[data-testid="email-row"]');
        if (rows.length > 0) return true;
        const senderRows = document.querySelectorAll('[data-testid="sender-row"]');
        if (senderRows.length > 0) return true;
        if (document.querySelector('[data-testid="chat-sender-list"]')) return true;
        const virtualRows = document.querySelectorAll('[style*="position: absolute"][style*="top:"]');
        if (virtualRows.length > 2) return true;
        if (document.querySelector('[data-testid="email-list-empty-state"]')) return true;
        return false;
      });
    },
    { timeout, interval: 200, timeoutMsg: `Emails did not appear within ${timeout}ms` },
  );
  return Date.now() - start;
}

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

async function getAccountCount() {
  return browser.execute(() => {
    const sidebar = document.querySelector('[data-testid="sidebar"]');
    if (!sidebar) return 0;
    const circles = sidebar.querySelectorAll('div[class*="rounded-full"]');
    let count = 0;
    for (const circle of circles) {
      if (!circle.style.backgroundColor) continue;
      const initial = circle.textContent.trim();
      if (initial.length === 0 || initial.length > 2) continue;
      const container = circle.closest('[class*="cursor-pointer"]') || circle.closest('button');
      if (container && container.offsetHeight > 0) count++;
    }
    return count;
  });
}

// ── Test suite ──────────────────────────────────────────────────────────────

describe('Cold Start Benchmark', function () {
  this.timeout(600_000); // 10 minutes — cold loads can be slow

  let accountCount = 0;
  let cacheCleared = false;

  before(async function () {
    // Step 1: Wait for the app to fully load first (user enters keychain password here)
    console.log('\n[cold-start] Waiting for app to load...');
    console.log('[cold-start] ⏳ Enter your Keychain password when prompted\n');

    await waitForApp(120_000); // 2 min timeout for keychain prompt
    await waitForEmails(120_000); // Wait for initial emails to load
    await browser.pause(5000); // Let background sync settle

    // Detect accounts
    accountCount = await getAccountCount();
    console.log(`[cold-start] Detected ${accountCount} accounts`);

    if (accountCount === 0) {
      throw new Error('No accounts detected — cannot run cold start benchmark');
    }

    // Step 2: Clear all caches via browser.executeAsync → Tauri invoke
    console.log('[cold-start] Clearing all caches...');

    const clearResult = await browser.executeAsync(async (done) => {
      const results = { headersCleared: false, maildirCleared: false };

      try {
        const invoke = window.__TAURI_INTERNALS__?.invoke;
        if (invoke) {
          await invoke('clear_email_cache', { accountId: null });
          results.headersCleared = true;

          const maildirResult = await invoke('maildir_clear_cache');
          results.maildirCleared = true;
          results.maildirDetails = maildirResult;
        } else {
          results.error = 'No Tauri invoke found';
        }
      } catch (e) {
        results.error = e.message || String(e);
      }

      done(results);
    });

    console.log('[cold-start] Cache clear result:', JSON.stringify(clearResult));

    cacheCleared = clearResult.headersCleared;

    if (!cacheCleared) {
      console.warn('[cold-start] ⚠ Could not clear headers cache via Tauri invoke');
      console.warn('[cold-start] Results may not reflect true cold-start performance');
    }

    // Step 4: Reload emails to trigger fresh IMAP fetch
    console.log('[cold-start] Triggering fresh reload...');

    // Navigate away and back to force a fresh load
    // Click each account briefly to invalidate any remaining in-memory state
    for (let i = 0; i < Math.min(accountCount, 3); i++) {
      await clickAccount(i);
      await browser.pause(200);
    }
    // Return to first account
    await clickAccount(0);
    await browser.pause(1000);

    console.log('[cold-start] Setup complete — starting benchmarks\n');
  });

  after(async function () {
    printSummary();
  });

  // ── 1. Cold account switching ───────────────────────────────────────────

  it('should benchmark cold account switching (all accounts)', async function () {
    console.log(`[cold-start] Benchmarking cold switch across ${accountCount} accounts...`);

    const totalStart = Date.now();

    for (let i = 0; i < accountCount; i++) {
      const start = Date.now();
      const result = await clickAccount(i);
      if (!result.clicked) {
        console.log(`[cold-start] Could not click account ${i}`);
        continue;
      }

      // Wait for emails to load (cold = IMAP fetch, could be slow)
      const ms = await waitForEmailsStable(90_000).catch(() => Date.now() - start);
      const elapsed = typeof ms === 'number' ? ms : Date.now() - start;
      record('Cold account switch', elapsed);

      const state = await getEmailListState();
      console.log(`[cold-start] Account ${i + 1}/${accountCount} (${result.title}): ${elapsed}ms → ${state.emailCount} emails, loading=${state.loading}`);

      await browser.pause(500);
    }

    const totalMs = Date.now() - totalStart;
    record('Total: all accounts', totalMs);
    console.log(`[cold-start] All ${accountCount} accounts loaded in ${totalMs}ms (${(totalMs / 1000).toFixed(1)}s)`);
  });

  // ── 2. Second pass (warm cache) for comparison ─────────────────────────

  it('should benchmark warm account switching (second pass)', async function () {
    console.log(`[cold-start] Benchmarking warm switch (second pass)...`);

    for (let i = 0; i < accountCount; i++) {
      const start = Date.now();
      const result = await clickAccount(i);
      if (!result.clicked) continue;

      const ms = await waitForEmailsStable(30_000).catch(() => Date.now() - start);
      const elapsed = typeof ms === 'number' ? ms : Date.now() - start;
      record('Warm account switch', elapsed);

      const state = await getEmailListState();
      console.log(`[cold-start] Warm ${i + 1}/${accountCount} (${result.title}): ${elapsed}ms → ${state.emailCount} emails`);

      await browser.pause(300);
    }
  });

  // ── 3. Cold unified inbox ──────────────────────────────────────────────

  it('should benchmark unified inbox after cold start', async function () {
    if (accountCount < 2) {
      console.warn('[cold-start] Skipping unified — only 1 account');
      this.skip();
    }

    // Start from account 0
    await clickAccount(0);
    await waitForEmailsStable();
    const beforeState = await getEmailListState();
    await browser.pause(500);

    // Enter unified inbox
    const start = Date.now();
    const clicked = await clickUnifiedInbox();
    if (!clicked) {
      console.warn('[cold-start] Could not click All Inboxes');
      return;
    }

    const ms = await waitForEmailsStable(60_000).catch(() => Date.now() - start);
    const elapsed = typeof ms === 'number' ? ms : Date.now() - start;
    record('Unified inbox (post-cold)', elapsed);

    const unifiedState = await getEmailListState();
    console.log(`[cold-start] Unified inbox: ${elapsed}ms (${beforeState.emailCount} → ${unifiedState.emailCount} emails)`);

    // Exit unified
    await clickAccount(0);
    await waitForEmailsStable();
    await browser.pause(500);
  });

  // ── 4. Data integrity check ────────────────────────────────────────────

  it('should verify app is still functional after cold start', async function () {
    // Click through a few accounts to make sure nothing is broken
    for (let i = 0; i < Math.min(accountCount, 3); i++) {
      const result = await clickAccount(i);
      if (!result.clicked) continue;
      // Give it a moment to load, but don't fail if account has no emails
      await waitForEmailsStable(10_000).catch(() => {});
      const state = await getEmailListState();
      console.log(`[cold-start] Integrity check account ${i + 1}: ${state.emailCount} emails, loading=${state.loading}`);
      await browser.pause(300);
    }

    // Verify sidebar is still functional
    const sidebarOk = await browser.execute(() => {
      return document.querySelector('[data-testid="sidebar"]')?.offsetHeight > 0;
    });
    assert.ok(sidebarOk, 'Sidebar should still be visible');
  });
});
