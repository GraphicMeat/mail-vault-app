/**
 * E2E: the sidebar's support footer.
 *
 * "Report a bug" used to open a compose window addressed to one inbox nobody
 * else could read. It now opens a dialog that offers GitHub Discussions first
 * — so what matters here is that the button reaches the dialog, that the two
 * GitHub rows carry the live URLs (a webview cannot follow an external open,
 * so the URL is asserted at the control), and that the email channel still
 * lands in compose with the bug template. "Refer a friend" is the second new
 * button: compose with the pitch and the website link, and no recipient.
 */

import { waitForApp } from './helpers.js';
import { MODAL } from './composeHelpers.js';

const DIALOG = '[data-testid="bug-report-dialog"]';

describe('Sidebar support buttons', function () {
  this.timeout(120_000);

  before(async function () {
    await waitForApp();
  });

  /** Click a footer button by its label — the sidebar renders plain buttons. */
  const clickFooter = (label) => browser.execute((needle) => {
    const sidebar = document.querySelector('[data-testid="sidebar"]');
    const btn = [...sidebar.querySelectorAll('button')]
      .find(b => (b.textContent || '').trim() === needle);
    if (!btn) return false;
    btn.click();
    return true;
  }, label);

  const closeCompose = async () => {
    await browser.execute(() => {
      const discard = [...document.querySelectorAll('button')]
        .find(b => (b.textContent || '').trim() === 'Discard');
      if (discard) discard.click();
    });
    // The discard confirmation is a second dialog; take its Discard too.
    await browser.pause(300);
    await browser.execute(() => {
      const confirm = [...document.querySelectorAll('[role="dialog"] button, [role="alertdialog"] button')]
        .find(b => (b.textContent || '').trim() === 'Discard');
      if (confirm) confirm.click();
    });
    await browser.waitUntil(async () => !(await $(MODAL).isExisting()),
      { timeout: 10_000, timeoutMsg: 'compose stayed open' });
  };

  const composeField = (field) => browser.execute((sel, testid) => {
    const input = document.querySelector(sel)?.querySelector(`[data-testid="${testid}"]`);
    return input ? input.value : null;
  }, MODAL, `compose-${field}`);

  it('offers both support buttons in the sidebar footer', async function () {
    const labels = await browser.execute(() => {
      const sidebar = document.querySelector('[data-testid="sidebar"]');
      return [...sidebar.querySelectorAll('button')].map(b => (b.textContent || '').trim());
    });
    expect(labels).toContain('Report a bug');
    expect(labels).toContain('Refer a friend');
  });

  it('routes a bug report to GitHub Discussions first, email second', async function () {
    expect(await clickFooter('Report a bug')).toBe(true);
    await $(DIALOG).waitForExist({ timeout: 10_000 });

    const urls = await browser.execute((sel) => {
      const dialog = document.querySelector(sel);
      const url = (testid) => dialog
        .querySelector(`[data-testid="${testid}"] button`)?.getAttribute('data-url') || null;
      return {
        report: url('bug-option-github'),
        browse: url('bug-option-discussions'),
        email: url('bug-option-email'),
      };
    }, DIALOG);

    expect(urls.report).toBe('https://github.com/GraphicMeat/mail-vault-app/discussions/new?category=bug-reports');
    expect(urls.browse).toBe('https://github.com/GraphicMeat/mail-vault-app/discussions');
    // The email row is not a link — it hands off to compose in-app.
    expect(urls.email).toBe(null);
  });

  it('still fills the bug template when the email channel is picked', async function () {
    await browser.execute((sel) => {
      document.querySelector(`${sel} [data-testid="bug-option-email"] button`).click();
    }, DIALOG);

    await $(MODAL).waitForExist({ timeout: 10_000 });
    const subject = await composeField('subject');
    expect(subject).toContain('[Bug Report] MailVault');

    const body = await browser.execute((sel) =>
      document.querySelector(`${sel} .ProseMirror`)?.innerText || '', MODAL);
    expect(body).toContain('Steps to reproduce');

    await closeCompose();
  });

  it('opens an unaddressed pitch for Refer a friend', async function () {
    expect(await clickFooter('Refer a friend')).toBe(true);
    await $(MODAL).waitForExist({ timeout: 10_000 });

    expect(await composeField('subject')).toBe('You should try MailVault');
    expect(await composeField('to')).toBe('');

    const body = await browser.execute((sel) =>
      document.querySelector(`${sel} .ProseMirror`)?.innerText || '', MODAL);
    expect(body).toContain('mailvaultapp.com');
    expect(body).toContain('IMAP');

    await closeCompose();
  });
});
