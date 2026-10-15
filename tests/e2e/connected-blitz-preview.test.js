/**
 * E2E: with emailRenderer 'blitz', the Email Cleanup (and Time Capsule)
 * preview draws through Blitz: no iframe, capped height, scrolling inside.
 * The fixture is the Blitz folder's first message (uid BLITZ_UID_START) on
 * luke, classified into Cleanup through a seeded app.db row. Every value is
 * logged as one `[blitzsurf]` line.
 *
 * Out of connected-ci; run with
 *   npm run build:e2e && npx wdio run wdio.blitz.conf.js --spec tests/e2e/connected-blitz-preview.test.js
 * on the Mac mini only.
 */
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { waitForApp, waitForEmails, closeSettings } from './helpers.js';
import { appDataDir, BLITZ_UID_START, BLITZ_FOLDER } from './mockImap.js';
import { openTab, setPremium } from './mockBilling.js';
import { raise, shootModes } from './blitzSurfaceShots.js';

const log = (tag, v) => console.log(`[blitzsurf] ${tag} ${JSON.stringify(v)}`);

// DOM clicks avoid WKWebView's incomplete WebDriver element-handle support.
async function clickText(selector, text) {
  await browser.waitUntil(() => browser.execute((selector, text) =>
    [...document.querySelectorAll(selector)].some(el => el.textContent.trim() === text),
  selector, text), { timeout: 15_000, timeoutMsg: `Missing cleanup control: ${text}` });
  await browser.execute((selector, text) => {
    [...document.querySelectorAll(selector)].find(el => el.textContent.trim() === text).click();
  }, selector, text);
}

const previewState = () => browser.execute(() => {
  const b = document.querySelector('[data-blitz-surface="preview"]');
  const t = b?.querySelector('[data-testid="blitz-tile"]');
  return {
    present: !!b,
    busy: b?.getAttribute('aria-busy') === 'true',
    painted: !!(t && t.complete && t.naturalWidth > 0),
    iframes: document.querySelector('[data-testid="settings-page"]')?.querySelectorAll('iframe').length ?? -1,
    height: b ? Math.round(b.getBoundingClientRect().height) : 0,
    scrollHeight: b ? b.scrollHeight : 0,
    overflowY: b ? getComputedStyle(b).overflowY : null,
  };
});

describe('Blitz Cleanup preview', function () {
  this.timeout(180_000);
  before(async () => {
    await waitForApp();
    await waitForEmails();
    await setPremium(true);
    const accountId = browser.mockAccounts[0].id;
    await browser.waitUntil(() => browser.executeAsync(async done => {
      const status = await window.__TAURI_INTERNALS__.invoke('daemon_rpc', { method: 'classification.status', params: {} });
      done(status.status !== 'Running');
    }), { timeout: 30_000 });
    // Classifications live in app.db now; the old per-account JSON file is
    // imported once per data dir and never read again. app.db is shared by
    // two processes (WAL, no exclusive lock), so a third writer just waits.
    const entry = {
      category: 'newsletter', importance: 'low', action: 'archive', confidence: 0.99,
      classified_at: '2026-01-01T00:00:00Z', model_used: 'test', source: 'UserOverride',
      snapshot: { uid: BLITZ_UID_START, mailbox: BLITZ_FOLDER, subject: 'Blitz preview result',
        from: 'sender@mock.test', date: '2099-01-01T00:00:00Z' },
    };
    const db = new DatabaseSync(join(appDataDir(browser.testDataDir), 'app.db'));
    try {
      db.exec('PRAGMA busy_timeout=5000');
      db.prepare('INSERT OR REPLACE INTO classifications(account_id, email_key, entry_json) VALUES (?, ?, ?)')
        .run(accountId, 'blitz-preview', JSON.stringify(entry));
    } finally {
      db.close();
    }
    // The daemon drops a row it cannot decode, silently: prove it reads this one
    // back, or a shape mismatch surfaces later as a "Missing cleanup control".
    const seeded = await browser.executeAsync((id, done) => {
      window.__TAURI_INTERNALS__.invoke('daemon_rpc', { method: 'classification.results', params: { accountId: id } })
        .then((rows) => done((rows || []).some(r => r.messageId === 'blitz-preview')), () => done(false));
    }, accountId);
    expect(seeded).toBe(true);
    await browser.execute((id, folder) => {
      window.__SETTINGS_STORE__.setState({ threadSortOrder: 'newest-first', emailRenderer: 'blitz' });
      // The page lists the results of the active folder: the fixture row sits in the Blitz folder.
      window.__MAIL_STORE__.getState().activateAccount(id, folder);
    }, accountId, BLITZ_FOLDER);
    await raise(1280, 900);
  });
  afterEach(async function () {
    if (this.currentTest.state === 'failed') {
      console.log('Cleanup diagnostics', await browser.execute(() => ({
        text: document.querySelector('[data-testid="settings-page"]')?.innerText,
      })));
    }
  });
  after(async () => {
    try {
      await browser.execute(() => {
        window.__SETTINGS_STORE__.setState({ emailRenderer: 'web' });
        window.__TAURI__?.window?.getCurrentWindow?.()?.setAlwaysOnTop(false);
      });
      await closeSettings();
      await setPremium(false);
    } catch { /* app gone */ }
  });

  it('Cleanup preview draws through Blitz, capped and scrolling', async () => {
    await openTab('Email Cleanup');
    await clickText('p', 'Blitz preview result');
    await browser.waitUntil(async () => {
      const s = await previewState();
      return s.present && s.painted && !s.busy;
    }, { timeout: 30_000, interval: 250, timeoutMsg: 'Cleanup preview did not paint through Blitz' });
    const r = await previewState();
    log('preview', r);
    expect(r.iframes).toBe(0);
    expect(r.height).toBeLessThanOrEqual(2000);
    // The fixture body is about 1 200 CSS px: it fits the cap, and the box keeps its own scroll for a body past it.
    expect(r.overflowY === 'auto' || r.overflowY === 'hidden').toBe(true);
    await shootModes('preview', async () => {
      await browser.waitUntil(async () => { const s = await previewState(); return s.present && s.painted && !s.busy; },
        { timeout: 25_000, interval: 250, timeoutMsg: 'preview did not settle after the mode flip' });
    });
  });
});
