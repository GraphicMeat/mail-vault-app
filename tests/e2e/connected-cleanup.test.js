import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { waitForApp, waitForEmails, closeSettings } from './helpers.js';
import { appDataDir } from './mockImap.js';
import { openTab, setPremium } from './mockBilling.js';

// DOM clicks avoid WKWebView's incomplete WebDriver element-handle support.
async function clickText(selector, text) {
  await browser.waitUntil(() => browser.execute((selector, text) =>
    [...document.querySelectorAll(selector)].some(el => el.textContent.trim() === text),
  selector, text), { timeout: 15_000, timeoutMsg: `Missing cleanup control: ${text}` });
  await browser.execute((selector, text) => {
    [...document.querySelectorAll(selector)].find(el => el.textContent.trim() === text).click();
  }, selector, text);
}

// Seed classification metadata in the isolated test HOME. Preview fetching
// and archiving still use the real backend and mock IMAP server.
describe('Email Cleanup account reads', function () {
  this.timeout(120_000);
  before(async () => {
    await waitForApp();
    await waitForEmails();
    await setPremium(true);
    const accountId = browser.mockAccounts[0].id;
    await browser.waitUntil(() => browser.executeAsync(async done => {
      const status = await window.__TAURI_INTERNALS__.invoke('daemon_rpc', { method: 'classification.status', params: {} });
      done(status.status !== 'Running');
    }), { timeout: 30_000 });
    const directory = join(appDataDir(browser.testDataDir), 'classifications');
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `${accountId}.json`);
    let entries = {};
    try { entries = JSON.parse(readFileSync(path, 'utf8')); } catch {}
    entries['cleanup-e2e'] = {
      category: 'newsletter', importance: 'low', action: 'archive', confidence: 0.99,
      classified_at: '2026-01-01T00:00:00Z', model_used: 'test', source: 'UserOverride',
      snapshot: { uid: 39, mailbox: 'INBOX', subject: 'Cleanup E2E result',
        from: 'sender@mock.test', date: '2099-01-01T00:00:00Z' },
    };
    writeFileSync(path, JSON.stringify(entries));
    await browser.execute(id => {
      window.__SETTINGS_STORE__.setState({ threadSortOrder: 'newest-first' });
      window.__MAIL_STORE__.getState().activateAccount(id, 'INBOX');
      const original = window.__TAURI__;
      window.__CLEANUP_TEST__ = { original, calls: [] };
      const invoke = async (command, args) => {
        // Force the uncached path regardless of background caching.
        if (command === 'maildir_read_light' && args?.accountId === id && args?.uid === 39) return null;
        if (['imap_get_email_light', 'archive_emails'].includes(command)) {
          window.__CLEANUP_TEST__.calls.push({ command, args });
        }
        return original.core.invoke(command, args);
      };
      window.__TAURI__ = { ...original, core: { ...original.core, invoke } };
      if (window.__TAURI__.core.invoke !== invoke) throw new Error('Cannot install cleanup preview fixture');
    }, accountId);
  });
  afterEach(async function () {
    if (this.currentTest.state === 'failed') {
      console.log('Cleanup diagnostics', await browser.execute(() => ({
        text: document.querySelector('[data-testid="settings-page"]')?.innerText,
        calls: window.__CLEANUP_TEST__?.calls,
      })));
    }
  });
  after(async () => {
    await closeSettings();
    await browser.execute(() => {
      if (window.__CLEANUP_TEST__) {
        window.__TAURI__ = window.__CLEANUP_TEST__.original;
        delete window.__CLEANUP_TEST__;
      }
    });
    await setPremium(false);
  });

  it('opens an uncached result using the active account', async () => {
    await openTab('Email Cleanup');
    await clickText('p', 'Cleanup E2E result');
    await browser.waitUntil(() => browser.execute(() =>
      window.__CLEANUP_TEST__.calls.some(c => c.command === 'imap_get_email_light' && c.args.uid === 39)
    ), { timeout: 15_000, timeoutMsg: 'Cleanup never fetched the uncached preview through IMAP' });
    const call = await browser.execute(() => window.__CLEANUP_TEST__.calls.find(c => c.command === 'imap_get_email_light'));
    expect(call.args.account.id).toBe(browser.mockAccounts[0].id);
    expect(call.args.mailbox).toBe('INBOX');
    await browser.waitUntil(() => browser.execute(() => {
      const body = document.querySelector('pre');
      return !!body?.textContent?.trim();
    }), { timeout: 15_000, timeoutMsg: 'Cleanup preview did not render the fetched message body' });
  });

  it('archives a selected result after confirmation', async () => {
    await openTab('Email Cleanup');
    await browser.waitUntil(() => browser.execute(() =>
      [...document.querySelectorAll('p')].some(el => el.textContent === 'Cleanup E2E result')
    ), { timeout: 15_000 });
    await browser.execute(() => {
      const subject = [...document.querySelectorAll('p')].find(el => el.textContent === 'Cleanup E2E result');
      subject.parentElement.parentElement.querySelector('input[type="checkbox"]').click();
    });
    await clickText('button', 'Archive (1)');
    await browser.execute(() => {
      const heading = [...document.querySelectorAll('h3')].find(el => el.textContent === 'Archive emails?');
      [...heading.parentElement.querySelectorAll('button')].find(el => el.textContent.trim() === 'Archive').click();
    });
    await browser.waitUntil(() => browser.execute(() =>
      window.__CLEANUP_TEST__.calls.some(c => c.command === 'archive_emails')
    ), { timeout: 15_000, timeoutMsg: 'Cleanup never started archiving after confirmation' });
    const call = await browser.execute(() => window.__CLEANUP_TEST__.calls.find(c => c.command === 'archive_emails'));
    expect(call.args.accountId).toBe(browser.mockAccounts[0].id);
    expect(JSON.parse(call.args.accountJson).id).toBe(browser.mockAccounts[0].id);
    expect(call.args.uids).toEqual([39]);
    expect(call.args.mailbox).toBe('INBOX');
    await browser.waitUntil(() => browser.execute(() =>
      ![...document.querySelectorAll('button')].some(el => el.textContent.trim() === 'Archive (1)')
    ), {
      timeout: 30_000, timeoutMsg: 'Cleanup did not finish the archive operation and clear selection',
    });
    const saved = await browser.executeAsync(async (accountId, done) => {
      try {
        done(await window.__CLEANUP_TEST__.original.core.invoke('maildir_read_light', { accountId, mailbox: 'INBOX', uid: 39 }));
      } catch (error) { done({ error: String(error) }); }
    }, browser.mockAccounts[0].id);
    expect(saved.subject).toBe('Luke message 39');
  });
});
