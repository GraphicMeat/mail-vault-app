/**
 * E2E Test: opening a folder that has folders under it lists the whole branch.
 *
 * luke's fixture (wdio.conf.js) is bson73's shape — Kunden > Company XY >
 * Project A > Invoices > erledigt, plus a second erledigt under a Project B
 * the server never LISTs — one message in each real folder.
 *
 * Six real mailboxes under Kunden, so a branch load must show six messages
 * drawn from six different folders, and say so.
 */

import { waitForApp, waitForEmails } from './helpers.js';

describe('Folder subtree listing', function () {
  this.timeout(180_000);

  before(async function () {
    await waitForApp();
    await waitForEmails();
  });

  const clickFolder = (path) => browser.execute((p) => {
    const row = [...document.querySelectorAll('[data-testid="folder-row"]')]
      .find(r => r.getAttribute('data-path') === p);
    if (!row) return false;
    row.click();
    return true;
  }, path);

  const subjects = () => browser.execute(() =>
    [...document.querySelectorAll('[data-testid="email-row"]')]
      .map(r => (r.textContent || '').trim()));

  const title = () => browser.execute(() =>
    document.querySelector('[data-testid="mailbox-title"]')?.innerText || '');

  // The folder list arrives after the first messages do, so a click issued the
  // moment the app is up lands on nothing.
  const waitForFolder = (path) => browser.waitUntil(
    async () => browser.execute((p) => [...document.querySelectorAll('[data-testid="folder-row"]')]
      .some(r => r.getAttribute('data-path') === p), path),
    { timeout: 45_000, interval: 500, timeoutMsg: `folder row never appeared: ${path}` },
  );

  const openBranch = async () => {
    await waitForFolder('Kunden');
    expect(await clickFolder('Kunden')).toBe(true);
    await browser.waitUntil(
      async () => (await subjects()).filter(s => s.includes('Nested')).length >= 6,
      { timeout: 60_000, interval: 500, timeoutMsg: 'branch never listed all six folders' },
    );
  };

  it('lists every message filed anywhere under the folder', async function () {
    // Six real mailboxes in the branch, one message each. The two synthesized
    // parents are not mailboxes and hold nothing.
    await openBranch();
  });

  it('draws them from more than one folder, which is the point', async function () {
    const seen = await subjects();
    const nested = seen.filter(s => s.includes('Nested'));
    // The subject carries the folder the mock filed it in.
    const deep = nested.filter(s => s.includes('erledigt'));
    expect(deep.length).toBe(2);
    expect(nested.some(s => s.includes('Company XY') && !s.includes('Project'))).toBe(true);
  });

  it('says the count covers a branch, not one folder', async function () {
    // The heading itself, not the whole page — "6" appears all over a mail app.
    const heading = await title();
    expect(heading).toContain('Kunden');
    expect(heading).toMatch(/6/);
  });

  it('goes back to one folder when a leaf is opened', async function () {
    // Prove the branch really is on screen first, or this passes on an empty
    // list that never loaded.
    expect((await subjects()).filter(s => s.includes('Nested')).length).toBeGreaterThanOrEqual(6);

    await waitForFolder('INBOX');
    expect(await clickFolder('INBOX')).toBe(true);
    await browser.waitUntil(
      async () => !(await subjects()).some(s => s.includes('Nested')),
      { timeout: 45_000, interval: 500, timeoutMsg: 'branch rows survived opening INBOX' },
    );
  });
});
