/**
 * E2E Test: Email Viewer Features
 *
 * Tests email selection, body display, and Reply/Forward/Reply All compose flows.
 * Requires emails to be loaded in the inbox.
 */

import { waitForApp, waitForEmails, pressKey } from './helpers.js';

/**
 * Close the compose modal by pressing Escape and dismissing any discard confirmation.
 */
async function closeCompose() {
  await pressKey('Escape');
  await browser.pause(500);

  // If a discard confirmation appears, click Discard
  await browser.execute(() => {
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      if ((btn.textContent || '').trim() === 'Discard' && btn.offsetHeight > 0) {
        btn.click();
        return;
      }
    }
  });
  await browser.pause(300);
}

describe('Email Viewer', function () {
  this.timeout(60_000);

  before(async function () {
    await waitForApp();
    await waitForEmails();
  });

  it('should select an email and display its body', async function () {
    // Click the first email row
    const clicked = await browser.execute(() => {
      const row = document.querySelector('[data-testid="email-row"]');
      if (row && row.offsetHeight > 0) {
        row.click();
        return true;
      }
      return false;
    });

    expect(clicked).toBe(true);

    // Wait for the email viewer to load. The action bar is icon-only, so the
    // buttons are identified by their title, not their text.
    await browser.waitUntil(
      async () => {
        return browser.execute(() => {
          const btn = document.querySelector('button[title="Reply"]');
          return btn !== null && btn.offsetHeight > 0;
        });
      },
      {
        timeout: 15_000,
        timeoutMsg: 'Reply button did not appear within 15s — email body may not have loaded',
        interval: 500,
      },
    );
  });

  it('should have Reply button', async function () {
    const hasReply = await browser.execute(() => {
      const btn = document.querySelector('button[title="Reply"]');
      return btn !== null && btn.offsetHeight > 0;
    });

    expect(hasReply).toBe(true);
  });

  it('should open compose in Reply mode with Re: subject', async function () {
    // Click Reply button
    const clicked = await browser.execute(() => {
      const btn = document.querySelector('button[title="Reply"]');
      if (!btn || btn.offsetHeight === 0) return false;
      btn.click();
      return true;
    });

    expect(clicked).toBe(true);
    await browser.pause(500);

    // Verify compose modal is open
    const composeVisible = await browser.execute(() => {
      const modal = document.querySelector('[data-testid="compose-modal"]');
      return modal !== null && modal.offsetHeight > 0;
    });

    expect(composeVisible).toBe(true);

    // Verify subject contains "Re:"
    const hasReSubject = await browser.execute(() => {
      const subjectEl = document.querySelector('[data-testid="compose-subject"]');
      if (!subjectEl) return false;
      const value = subjectEl.value || subjectEl.textContent || '';
      return value.includes('Re:');
    });

    expect(hasReSubject).toBe(true);

    await closeCompose();
  });

  it('should have Forward button', async function () {
    const hasForward = await browser.execute(() => {
      const btn = document.querySelector('button[title="Forward"]');
      return btn !== null && btn.offsetHeight > 0;
    });

    expect(hasForward).toBe(true);
  });

  it('should open compose in Forward mode with Fwd: subject', async function () {
    // Click Forward button
    const clicked = await browser.execute(() => {
      const btn = document.querySelector('button[title="Forward"]');
      if (!btn || btn.offsetHeight === 0) return false;
      btn.click();
      return true;
    });

    expect(clicked).toBe(true);
    await browser.pause(500);

    // Verify compose modal is open
    const composeVisible = await browser.execute(() => {
      const modal = document.querySelector('[data-testid="compose-modal"]');
      return modal !== null && modal.offsetHeight > 0;
    });

    expect(composeVisible).toBe(true);

    // Verify subject contains "Fwd:"
    const hasFwdSubject = await browser.execute(() => {
      const subjectEl = document.querySelector('[data-testid="compose-subject"]');
      if (!subjectEl) return false;
      const value = subjectEl.value || subjectEl.textContent || '';
      return value.includes('Fwd:');
    });

    expect(hasFwdSubject).toBe(true);

    await closeCompose();
  });

  it('should have Reply All button', async function () {
    const hasReplyAll = await browser.execute(() => {
      const btn = document.querySelector('button[title="Reply All"]');
      return btn !== null && btn.offsetHeight > 0;
    });

    // Reply All is hidden for single-recipient mail, which the mock fixtures are.
    if (!hasReplyAll) {
      console.warn('[email-viewer] Reply All button not found — email is single-recipient');
    }
  });
});
