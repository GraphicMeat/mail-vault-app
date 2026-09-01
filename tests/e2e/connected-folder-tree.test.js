/**
 * E2E Test: the sidebar draws folders the way the server files them
 *
 * bson73 (discussion #1): five levels deep, and the folder at the bottom of
 * every branch is called the same thing — "Done", or on his German server
 * "erledigt". Listed flat and alphabetically that is ten identical rows with
 * nothing to say which project each one belongs to.
 *
 * luke carries the fixture (wdio.conf.js): Kunden > Company XY > Project A >
 * Invoices > erledigt, plus a second erledigt under a Project B whose own
 * parents the server never LISTs.
 */

import { waitForApp, waitForEmails } from './helpers.js';

describe('Folder tree', function () {
  this.timeout(180_000);

  before(async function () {
    await waitForApp();
    await waitForEmails();
  });

  /** Every folder row currently drawn, with the depth it is drawn at. */
  const rows = () => browser.execute(() =>
    [...document.querySelectorAll('[data-testid="folder-row"]')].map(r => ({
      path: r.getAttribute('data-path'),
      depth: Number(r.getAttribute('data-depth')),
    })));

  const pathsNow = async () => (await rows()).map(r => r.path);

  const clickToggle = (path) => browser.execute((p) => {
    const b = [...document.querySelectorAll('[data-testid="folder-toggle"]')]
      .find(x => x.getAttribute('data-path') === p);
    if (!b) return false;
    b.click();
    return true;
  }, path);

  const waitForRow = (path) => browser.waitUntil(
    async () => (await pathsNow()).includes(path),
    { timeout: 20_000, interval: 300, timeoutMsg: `folder row never appeared: ${path}` },
  );

  /**
   * Open every folder above `path`, outermost first.
   *
   * Ensure-open, not toggle: the chevron is a toggle, so a helper that clicks
   * it unconditionally closes whatever the previous test left open.
   */
  async function expandTo(path) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('/');
      const child = parts.slice(0, i + 1).join('/');
      await waitForRow(parent);
      if (!(await pathsNow()).includes(child)) await clickToggle(parent);
      await waitForRow(child);
    }
  }

  it('draws the account folders as a tree, five levels deep', async function () {
    await waitForRow('Kunden');
    const kunden = (await rows()).find(r => r.path === 'Kunden');
    expect(kunden.depth).toBe(0);

    const leaf = 'Kunden/Company XY/Project A/Invoices/erledigt';
    await expandTo(leaf);

    const drawn = await rows();
    expect(drawn.find(r => r.path === 'Kunden/Company XY').depth).toBe(1);
    expect(drawn.find(r => r.path === 'Kunden/Company XY/Project A').depth).toBe(2);
    expect(drawn.find(r => r.path === 'Kunden/Company XY/Project A/Invoices').depth).toBe(3);
    expect(drawn.find(r => r.path === leaf).depth).toBe(4);
  });

  it('keeps two folders called erledigt apart by the branch they sit in', async function () {
    await expandTo('Kunden/Company XY/Project B/Invoices/erledigt');

    const erledigt = (await rows()).filter(r => r.path.endsWith('/erledigt'));
    expect(erledigt).toHaveLength(2);
    expect(new Set(erledigt.map(r => r.path)).size).toBe(2);
    // Same name, same depth, different branch — which is the whole complaint.
    expect(erledigt.every(r => r.depth === 4)).toBe(true);
  });

  it('draws a parent the server never listed, so its subtree stays reachable', async function () {
    // LIST names Project B's erledigt but neither Project B nor its Invoices.
    await waitForRow('Kunden/Company XY/Project B');
    const stand_in = (await rows()).find(r => r.path === 'Kunden/Company XY/Project B');
    expect(stand_in.depth).toBe(2);
  });

  it('hides the whole subtree when the folder above it is collapsed', async function () {
    await expandTo('Kunden/Company XY');
    expect(await clickToggle('Kunden')).toBe(true);

    await browser.waitUntil(
      async () => !(await pathsNow()).some(p => p.startsWith('Kunden/')),
      { timeout: 15_000, interval: 300, timeoutMsg: 'collapsing Kunden left its descendants drawn' },
    );
    // The folder itself stays, of course.
    expect(await pathsNow()).toContain('Kunden');
  });

  it('remembers which folders were open after switching accounts and back', async function () {
    const leaf = 'Kunden/Company XY/Project A/Invoices/erledigt';
    await expandTo(leaf);

    const switchTo = (needle) => browser.execute((email) => {
      const sidebar = document.querySelector('[data-testid="sidebar"]');
      for (const el of sidebar.querySelectorAll('*')) {
        if (el.children.length === 0 && (el.textContent || '').trim() === email) {
          el.click();
          return true;
        }
      }
      return false;
    }, needle);

    expect(await switchTo('vader@mock.test')).toBe(true);
    await browser.waitUntil(
      async () => !(await pathsNow()).includes('Kunden'),
      { timeout: 30_000, interval: 500, timeoutMsg: 'never left luke folder list' },
    );

    expect(await switchTo('luke@mock.test')).toBe(true);
    // Expansion used to be component state, so the switch threw it away and a
    // five-level folder needed four clicks to get back to.
    await browser.waitUntil(
      async () => (await pathsNow()).includes(leaf),
      { timeout: 30_000, interval: 500, timeoutMsg: 'expansion was lost across the account switch' },
    );
  });
});
