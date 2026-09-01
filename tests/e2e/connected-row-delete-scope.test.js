/**
 * E2E Test: the row menu's purge item is offered only where a copy of our own
 * exists, and it names the places it will clear.
 *
 * The menu used to end with "Delete everywhere" on every row, including one
 * the vault had never held — on a server-only message that item did exactly
 * what "Delete from server" one line above it does, under a name that claims
 * far more. Worse, the confirmation it opened promised to clear "the server,
 * your vault, and your backup drive" for a message that was only ever on the
 * server.
 *
 * So the gate and the copy come from one table (utils/custodyCopy's
 * describePurge): no local copy, no item; a vault copy, and the item says
 * vault. This spec drives the state change that flips it — archiving a
 * message is what puts it in the vault — and reads the menu on both sides.
 *
 * Runs on account 1's INBOX and restores what it changed. The archive it takes
 * is local only (a vault `.eml`; the server copy is untouched), and every
 * spec file gets a wiped app data dir anyway (wdio.conf.js's beforeSession),
 * so nothing here can reach another spec's fixtures. Nothing is deleted: the
 * confirmation is opened, read, and cancelled.
 */

import { waitForApp, waitForEmails } from './helpers.js';

describe('Row menu delete scope', function () {
  this.timeout(120_000);

  // ── DOM helpers ───────────────────────────────────────────────────────────

  const menuIsOpen = () => browser.execute(() => !!document.querySelector('[role="menu"]'));

  const clickMenuTrigger = (index) => browser.execute((i) => {
    const row = document.querySelectorAll('[data-testid="email-row"]')[i];
    const btn = row?.querySelector('button[aria-label="Row actions"]');
    if (!btn) return false;
    btn.click();
    return true;
  }, index);

  /**
   * Open the nth row's 3-dot menu, whatever state it is in.
   *
   * The trigger is `invisible` until the row is hovered — a real pointer would
   * have to satisfy that, a `.click()` does not. And it TOGGLES: an action
   * that closes the menu on its own (Archive closes only after its network
   * write resolves) leaves a window in which one more click shuts the menu
   * instead of opening it. So this asks for the end state, not the click.
   */
  const openRowMenu = async (index = 0) => {
    await browser.waitUntil(async () => {
      if (await menuIsOpen()) return true;
      await clickMenuTrigger(index);
      await browser.pause(200);
      return menuIsOpen();
    }, { timeout: 15_000, interval: 300, timeoutMsg: `Row ${index}'s action menu did not open` });
    return true;
  };

  /** Every item in the open menu, by label. The panel is portalled to body. */
  const menuItems = () => browser.execute(() =>
    [...document.querySelectorAll('[role="menu"] [role="menuitem"]')]
      .map(el => (el.textContent || '').trim()));

  const clickMenuItem = (label) => browser.execute((needle) => {
    for (const el of document.querySelectorAll('[role="menu"] [role="menuitem"]')) {
      if ((el.textContent || '').trim() === needle) { el.click(); return true; }
    }
    return false;
  }, label);

  /** The state glyph's verdict for the nth row — 'archived*' once it is in
   *  the vault, 'server-only*' while it is not. */
  const rowState = (index = 0) => browser.execute((i) => {
    const row = document.querySelectorAll('[data-testid="email-row"]')[i];
    return row?.querySelector('[data-testid="msg-state-icon"]')?.getAttribute('data-state') || null;
  }, index);

  const waitForRowState = (prefix, index = 0) => browser.waitUntil(
    async () => (await rowState(index) || '').startsWith(prefix),
    { timeout: 30_000, interval: 500, timeoutMsg: `Row ${index} never reached state "${prefix}*"` },
  );

  const confirmDialog = () => browser.execute(() => {
    const heading = [...document.querySelectorAll('h3')]
      .find(h => h.offsetHeight > 0 && /\?$/.test((h.textContent || '').trim()));
    if (!heading) return null;
    const panel = heading.closest('[role="alertdialog"]') || heading.parentElement.parentElement;
    return {
      title: (heading.textContent || '').trim(),
      body: (panel.innerText || '').trim(),
      buttons: [...panel.querySelectorAll('button')].map(b => (b.textContent || '').trim()),
    };
  });

  const clickDialogButton = (label) => browser.execute((needle) => {
    for (const btn of document.querySelectorAll('[role="alertdialog"] button')) {
      if ((btn.textContent || '').trim() === needle) { btn.click(); return true; }
    }
    return false;
  }, label);

  const PURGE_ITEM = /^Delete from (vault|backup|server and|server,)/;

  before(async function () {
    await waitForApp();
    await waitForEmails();
    await waitForRowState('server-only');
  });

  it('offers no purge on a message only the server holds', async function () {
    expect(await openRowMenu()).toBe(true);
    const items = await menuItems();

    // The server delete is still there — this is about the second one.
    expect(items).toContain('Delete from server');
    expect(items.some(i => PURGE_ITEM.test(i))).toBe(false);
    // The name the item used to carry, on a row with nothing local to purge.
    expect(items).not.toContain('Delete everywhere');
  });

  it('offers "Delete from server and vault" once the vault holds it too', async function () {
    // Archive from the menu that is already open — the same gesture a user
    // makes, and the only thing that changes the answer.
    expect(await clickMenuItem('Archive')).toBe(true);
    await waitForRowState('archived');

    expect(await openRowMenu()).toBe(true);
    const items = await menuItems();

    expect(items).toContain('Delete from server');
    expect(items).toContain('Delete from server and vault');
    expect(items).not.toContain('Delete everywhere');
    // It must not claim the backup drive: no backup location is configured in
    // this harness, so there is no mirrored copy to promise to remove.
    expect(items).not.toContain('Delete from server, vault and backup');
  });

  it('confirms with the same words the item used, and cancels clean', async function () {
    expect(await clickMenuItem('Delete from server and vault')).toBe(true);

    await browser.waitUntil(async () => (await confirmDialog()) !== null,
      { timeout: 10_000, interval: 200, timeoutMsg: 'Delete confirmation never opened' });

    const dialog = await confirmDialog();
    expect(dialog.title).toBe('Delete permanently?');
    // The confirm button repeats the scope, so the last thing read before the
    // click names the places — and the body warns nothing survives.
    expect(dialog.buttons).toContain('Delete from server and vault');
    // Singular or plural depending on what this row covers — the first row is
    // a thread in these fixtures, so it speaks for every message in it. Which
    // form goes with which count is pinned in custodyCopy's unit tests; what
    // matters here is that the dialog is about the whole row and says nothing
    // survives.
    expect(dialog.body).toMatch(/^(This email|These \d+ emails) will be gone\./m);
    expect(dialog.body).toContain('cannot be undone');

    expect(await clickDialogButton('Cancel')).toBe(true);
    await browser.waitUntil(async () => (await confirmDialog()) === null,
      { timeout: 10_000, interval: 200, timeoutMsg: 'Cancel did not close the confirmation' });

    // Cancelled means untouched: the row is still there, still in the vault.
    await waitForRowState('archived');
  });

  it('withdraws the purge again when the vault copy goes', async function () {
    expect(await openRowMenu()).toBe(true);
    expect(await clickMenuItem('Unarchive')).toBe(true);
    await waitForRowState('server-only');

    expect(await openRowMenu()).toBe(true);
    const items = await menuItems();

    expect(items).toContain('Delete from server');
    expect(items.some(i => PURGE_ITEM.test(i))).toBe(false);

    // Leave the menu shut for whatever runs next.
    await browser.execute(() => document.body.click());
  });
});
