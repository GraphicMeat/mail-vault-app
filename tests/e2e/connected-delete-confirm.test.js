/**
 * E2E: the "confirm before deleting" preference.
 *
 * Asked for 2026-09-21: "settings needs an option, to either display a modal
 * when deleting emails or not. default - option display."
 *
 * The choice is honoured in DeleteConfirmModal — the one component every
 * delete verb already raises its confirmation through — and a pending opts IN
 * with `confirmOptional`. So a delete the app can hand back (the server
 * delete, which journals an undo) skips the modal when the preference is off,
 * and a delete nothing can take back keeps asking: Delete everywhere destroys
 * every copy and clears the undo.
 *
 * Driven through the row's own menu, the way a person deletes one message.
 */

import { openRowMenu as openMenu, clickRowAction, rowMenuItems } from './rowMenu.js';
import { waitForApp, waitForEmails, switchToFolder } from './helpers.js';

const LUKE = 'luke@mock.test';

describe('Confirm before deleting', function () {
  this.timeout(240_000);

  let cancelled = null;   // deleted at the end of the spec, with the confirm on
  let skipped = null;     // deleted with the confirm off
  let archived = null;    // the one Delete everywhere is offered for

  const rows = () => browser.execute(() =>
    [...document.querySelectorAll('[data-testid="email-row"]')].map((row) => ({
      text: (row.innerText || '').replace(/\s*\n\s*/g, ' | ').trim(),
      icon: row.querySelector('[data-testid="msg-state-icon"]')?.getAttribute('data-state') || null,
    })));

  const rowFor = async (needle) => (await rows()).find((r) => r.text.includes(needle));

  const setConfirm = (on) => browser.execute((value) => {
    window.__SETTINGS_STORE__?.getState?.().setConfirmBeforeDelete?.(value);
    return window.__SETTINGS_STORE__?.getState?.().confirmBeforeDelete;
  }, on);

  const dialogOpen = () => browser.execute(() => {
    const dialog = document.querySelector('[role="alertdialog"]');
    return dialog ? (dialog.innerText || '').replace(/\s*\n\s*/g, ' | ').trim() : null;
  });

  /** Open the row's actions menu, whatever state it is in (tests/e2e/rowMenu.js). */
  const openRowMenu = (needle) => openMenu({ text: needle }, `"${needle}"'s action menu did not open`);

  const clickDialogButton = (label) => browser.execute((needle) => {
    for (const btn of document.querySelectorAll('[role="alertdialog"] button')) {
      if ((btn.textContent || '').trim() === needle) { btn.click(); return true; }
    }
    return false;
  }, label);

  /**
   * Archive through the store, not through a control.
   *
   * Deliberate: archiving is this spec's SETUP, not its subject, and every
   * control that archives is currently addressed differently by every spec
   * that uses one — the selection bar's verbs are a QuickActions set with an
   * inline limit (so which of them are buttons at all depends on
   * configuration), and a synthetic click on the row's own `title="Archive"`
   * button does nothing from the harness. The same `saveEmailsLocally` call
   * those controls make does archive: proven on the runner, `archived: 1`,
   * icon `archived`. Driving it directly keeps this file failing only for the
   * behaviour it is about.
   */
  async function archiveRow(needle) {
    const outcome = await browser.executeAsync((want, done) => {
      const state = window.__MAIL_STORE__.getState();
      const row = (state.sortedEmails || []).find((e) => (e.subject || '') === want);
      if (!row) { done(`no row for ${want}`); return; }
      Promise.resolve(state.saveEmailsLocally([row]))
        .then(() => done('ok'), (error) => done(String((error && error.message) || error)));
    }, needle);
    expect(outcome).toBe('ok');
    await browser.waitUntil(async () => !!(await rowFor(needle))?.icon?.startsWith('archived'), {
      timeout: 60_000, interval: 500, timeoutMsg: `"${needle}" never became an archived row`,
    });
  }

  before(async function () {
    await waitForApp();
    await waitForEmails();
    await switchToFolder(LUKE, 'INBOX');

    const fresh = (await rows()).filter((r) =>
      /Luke message \d+/.test(r.text)
      && !r.icon?.startsWith('archived') && !r.icon?.startsWith('local-only'));
    expect(fresh.length).toBeGreaterThan(2);
    const pick = (i) => fresh[fresh.length - i].text.match(/Luke message \d+/)[0];
    cancelled = pick(1);
    skipped = pick(2);
    archived = pick(3);

    // Delete everywhere is offered for a message the vault holds a copy of.
    await archiveRow(archived);
  });

  after(async function () {
    await setConfirm(true);
  });

  it('asks before deleting, by default', async function () {
    expect(await setConfirm(true)).toBe(true);
    await openRowMenu(cancelled);
    expect(await clickRowAction('deleteServer')).toBe(true);

    await browser.waitUntil(async () => !!(await dialogOpen()), {
      timeout: 30_000, interval: 200, timeoutMsg: 'The delete confirmation never appeared',
    });
    // Nothing is gone while the question is on screen.
    expect(await rowFor(cancelled)).toBeTruthy();

    expect(await clickDialogButton('Cancel')).toBe(true);
    await browser.waitUntil(async () => !(await dialogOpen()), {
      timeout: 30_000, interval: 200, timeoutMsg: 'Cancel never closed the confirmation',
    });
    expect(await rowFor(cancelled)).toBeTruthy();
  });

  it('deletes on the click once the preference is off', async function () {
    expect(await setConfirm(false)).toBe(false);
    await openRowMenu(skipped);
    expect(await clickRowAction('deleteServer')).toBe(true);

    // The row has to go, and no question may be asked on the way — polled
    // together, because "the dialog was gone when I looked" proves nothing if
    // the look happens after a confirm was clicked by something else.
    let sawDialog = false;
    await browser.waitUntil(async () => {
      if (await dialogOpen()) sawDialog = true;
      return !(await rowFor(skipped));
    }, { timeout: 60_000, interval: 150, timeoutMsg: `"${skipped}" never left the list` });
    expect(sawDialog).toBe(false);

    // Skipping the question does not skip the undo — that is what makes this
    // delete safe to skip at all.
    await browser.waitUntil(async () => browser.execute(() =>
      !!document.querySelector('[data-testid="undo-toast"]')), {
      timeout: 60_000, interval: 200, timeoutMsg: 'The delete offered no undo',
    });
  });

  it('still asks for a delete nothing can take back', async function () {
    expect(await setConfirm(false)).toBe(false);
    await openRowMenu(archived);
    // Named for the places the message is in ("Delete from server and vault"
    // for an archived one), so it is addressed by action, not by prose.
    expect((await rowMenuItems()).find(item => item.action === 'deleteEverywhere')?.label)
      .toBe('Delete from server and vault');
    expect(await clickRowAction('deleteEverywhere')).toBe(true);

    const text = await browser.waitUntil(async () => (await dialogOpen()) || false, {
      timeout: 30_000, interval: 200,
      timeoutMsg: 'Delete everywhere went ahead without asking, with no undo behind it',
    });
    expect(String(text)).toMatch(/permanently|cannot be undone/i);
    expect(await rowFor(archived)).toBeTruthy();

    expect(await clickDialogButton('Cancel')).toBe(true);
    await browser.waitUntil(async () => !(await dialogOpen()), {
      timeout: 30_000, interval: 200, timeoutMsg: 'Cancel never closed the confirmation',
    });
    expect(await rowFor(archived)).toBeTruthy();
  });
});
