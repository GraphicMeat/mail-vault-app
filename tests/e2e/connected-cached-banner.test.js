/**
 * Cached-data banner regression
 *
 * Field scenario: the headers cache is lost while the Maildir still holds
 * saved copies. The app must rebuild silently — the "Showing cached data"
 * banner ("Email cache was empty but local data exists…") must never appear,
 * and emails must come back after the rebuild + server sync.
 *
 * Before the fix the banner (a) was raised for this normal recovery path and
 * (b) survived every later activation because the fast server-verify paths
 * (probe-unchanged / delta-noop) never cleared suspectEmptyServerData — which
 * also made the banner's reload button look dead.
 *
 * Flow:
 *   1. Let the app load, then seed Maildir copies via the app's own writer.
 *   2. Clear ONLY the headers cache (Maildir untouched).
 *   3. Activate the second account — its first activation has no in-memory
 *      restore descriptor, so it takes the full load path and hits the
 *      "cache empty but Maildir has data" branch. (window refresh is a no-op
 *      under the tauri-wd harness, so a cold frontend boot can't be used.)
 *   4. Watch the whole load: banner must never show, emails must appear.
 */

import assert from 'node:assert';
import { waitForApp, waitForEmails } from './helpers.js';

const BANNER = '[data-testid="cached-data-banner"]';

async function maildirEmailCount() {
  const result = await browser.executeAsync(async (done) => {
    try {
      const invoke = window.__TAURI_INTERNALS__?.invoke;
      if (!invoke) return done({ error: 'No Tauri invoke found' });
      const stats = await invoke('maildir_storage_stats', { accountId: null });
      done({ count: stats?.emailCount ?? 0 });
    } catch (e) {
      done({ error: e.message || String(e) });
    }
  });
  if (result.error) throw new Error(`maildir_storage_stats failed: ${result.error}`);
  return result.count;
}

describe('cached-data banner', function () {
  it('cold boot on an empty headers cache rebuilds silently — no banner, emails return', async function () {
    this.timeout(180_000);

    await waitForApp();
    await waitForEmails();

    // ── 1. Precondition: the Maildir must hold saved copies, or the recovery
    // branch under test never runs. Seed it directly via the app's own Maildir
    // writer — the auto-cache pipeline won't do it here, since the mock
    // messages are dated Jan 2026, older than the 3-month caching cutoff.
    // Seed every account: whichever one is active after the refresh must
    // satisfy "cache empty but Maildir has data".
    const raw = Buffer.from(
      'From: seed@example.com\r\nTo: seed@example.com\r\nSubject: maildir seed\r\n' +
      'Date: Mon, 05 Jan 2026 12:00:00 +0000\r\n\r\nseed body\r\n'
    ).toString('base64');
    const seedResult = await browser.executeAsync(async (accounts, rawB64, done) => {
      try {
        const invoke = window.__TAURI_INTERNALS__?.invoke;
        if (!invoke) return done({ error: 'No Tauri invoke found' });
        for (const account of accounts) {
          for (const uid of [1, 2, 3]) {
            await invoke('maildir_store', {
              accountId: account.id,
              mailbox: 'INBOX',
              uid,
              rawSourceBase64: rawB64,
              flags: ['seen'],
            });
          }
        }
        done({ ok: true });
      } catch (e) {
        done({ error: e.message || String(e) });
      }
    }, browser.mockAccounts, raw);
    assert.ok(seedResult.ok, `maildir_store seeding failed: ${seedResult.error}`);

    const saved = await maildirEmailCount();
    assert.ok(saved >= 3, `Precondition failed: Maildir holds ${saved} emails after seeding`);
    console.log(`[cached-banner] Maildir holds ${saved} saved emails`);

    // ── 2. Clear only the headers cache → "cache empty but local data exists".
    const clearResult = await browser.executeAsync(async (done) => {
      try {
        const invoke = window.__TAURI_INTERNALS__?.invoke;
        if (!invoke) return done({ error: 'No Tauri invoke found' });
        await invoke('clear_email_cache', { accountId: null });
        done({ ok: true });
      } catch (e) {
        done({ error: e.message || String(e) });
      }
    });
    assert.ok(clearResult.ok, `clear_email_cache failed: ${clearResult.error}`);

    // ── 3. First activation of the second account on the cleared cache.
    const target = browser.mockAccounts[1];
    assert.ok(target?.email, 'Need a second mock account for the switch');
    const clicked = await browser.execute((email) => {
      const sidebar = document.querySelector('[data-testid="sidebar"]') || document.querySelector('aside') || document.body;
      for (const el of sidebar.querySelectorAll('button, div')) {
        const title = el.getAttribute('title') || '';
        const text = (el.textContent || '').trim();
        if (title.includes(email) || text === email) {
          el.click();
          return true;
        }
      }
      return false;
    }, target.email);
    assert.ok(clicked, `Could not click account row for ${target.email}`);

    // ── 4. Watch the entire load. The banner must never appear — not even
    // as a flash while the rebuild races the server sync.
    const watchUntil = Date.now() + 30_000;
    let sightings = 0;
    let sightingText = '';
    let sawEmails = false;
    let emailsSeenAt = 0;
    // 50ms sampling: pre-fix the banner could flash for only the gap between
    // the local half raising it and the daemon sync clearing it.
    while (Date.now() < watchUntil) {
      const snap = await browser.execute((sel) => {
        const banner = document.querySelector(sel);
        return {
          banner: !!banner,
          bannerText: banner ? banner.textContent : '',
          emails: document.querySelectorAll('[data-testid="email-row"]').length,
        };
      }, BANNER);
      if (snap.banner) {
        sightings++;
        sightingText = snap.bannerText;
      }
      if (snap.emails > 0) {
        sawEmails = true;
        if (!emailsSeenAt) emailsSeenAt = Date.now();
        // Emails are back — watch an 8s tail for a late (post-clear) banner
        // set, the race that made the old banner stick, then stop.
        if (Date.now() - emailsSeenAt > 8_000) break;
      }
      await browser.pause(50);
    }

    assert.strictEqual(
      sightings, 0,
      `"Showing cached data" banner appeared ${sightings}× during cold rebuild (text: "${sightingText}")`
    );

    // Emails must actually come back — silence via a dead app would be a lie.
    if (!sawEmails) await waitForEmails(60_000);
    const finalEmails = await browser.execute(
      () => document.querySelectorAll('[data-testid="email-row"]').length
    );
    assert.ok(finalEmails > 0, `Expected emails after silent rebuild, saw ${finalEmails}`);

    // ── 5. And it must stay gone once the server has verified the mailbox.
    await browser.pause(2_000);
    const bannerAfterSettle = await browser.execute(
      (sel) => !!document.querySelector(sel), BANNER
    );
    assert.strictEqual(bannerAfterSettle, false, 'Banner present after load settled');
  });
});
