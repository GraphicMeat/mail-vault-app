/**
 * E2E Test: the active account's folder list
 *
 * Regression: the first folder fetch of a session races credential loading and
 * fails with "Password missing". Nothing retried it (the background prefetch
 * skips the active account), and the restore descriptor kept the INBOX
 * placeholder it had snapshotted — so switching away and back painted the
 * placeholder over the folder list the prefetch had since cached. The sidebar
 * and the Move-to-folder dropdown showed one folder for the rest of the session.
 *
 * The race is timing-dependent, so these assert the invariant rather than the
 * race: whichever account is active lists its folders, and keeps them across a
 * switch. When the race doesn't fire the folders are simply there from the
 * start and both still hold.
 */

import { waitForApp, waitForEmails } from './helpers.js';

describe('Folder list', function () {
  this.timeout(120_000);

  before(async function () {
    await waitForApp();
    await waitForEmails();
  });

  /** Folder names the sidebar lists under its FOLDERS heading. */
  const folders = () => browser.execute(() => {
    const text = document.querySelector('[data-testid="sidebar"]')?.innerText || '';
    const section = text.match(/FOLDERS\n([\s\S]*?)\n(?:Settings|Report a bug)/);
    return section ? section[1].split('\n').map(s => s.trim()).filter(Boolean) : [];
  });

  const waitForFolders = (msg) => browser.waitUntil(
    async () => (await folders()).length > 1,
    { timeout: 45_000, interval: 500, timeoutMsg: msg },
  );

  function clickAccount(email) {
    return browser.execute((needle) => {
      const sidebar = document.querySelector('[data-testid="sidebar"]');
      for (const el of sidebar.querySelectorAll('*')) {
        if (el.children.length === 0 && (el.textContent || '').trim() === needle) {
          el.click();
          return true;
        }
      }
      return false;
    }, email);
  }

  it('lists the active account folders, not just INBOX', async function () {
    await waitForFolders('Sidebar never listed a folder past INBOX for the account it booted into');

    const listed = await folders();
    expect(listed).toContain('INBOX');
    expect(listed.length).toBeGreaterThan(1);
  });

  it('keeps them after switching to another account and back', async function () {
    const [first, second] = browser.mockAccounts.map(a => a.email);

    expect(await clickAccount(second)).toBe(true);
    await waitForFolders(`Folder list never appeared for ${second}`);
    await waitForEmails();

    expect(await clickAccount(first)).toBe(true);
    await waitForEmails();

    // The restore-descriptor paint happens on this switch — if it wins, the
    // list collapses back to the placeholder and stays there.
    await waitForFolders(`Folder list collapsed to INBOX after switching back to ${first}`);
    await browser.pause(3000);
    expect((await folders()).length).toBeGreaterThan(1);
  });
});
