/**
 * E2E: delete a message from the server, then undo it — in both list shapes.
 *
 * The undo slot had unit coverage from the day it shipped and it was all of
 * one shape: `api.deleteEmail` and `api.moveEmails` mocked, every case in a
 * single-folder INBOX view. That is exactly the half that worked. In All
 * Inboxes the restore reached the server and the row never came back, because
 * the repaint went through `loadEmails()`, which reloads one (account,
 * mailbox) and in that view `activeMailbox` is the literal 'UNIFIED' — not a
 * mailbox any account can SELECT.
 *
 * So this spec asserts the loop end to end, twice, against the real mock IMAP
 * server: the row leaves the list, the toast offers the undo, the button
 * restores the message to the mailbox it was deleted from, and the row comes
 * BACK on screen. The server check is what makes the UI check mean something
 * (a row that reappears from a stale cache would pass a UI-only assertion);
 * the UI check is what makes the server check mean something (the whole
 * reported bug was a correct server restore nobody could see).
 *
 * ── Why yoda, and why 903 ─────────────────────────────────────────────────
 * yoda's UIDs start at 901, and dates are derived from the UID (mockImap.js
 * `stamp`), so its mail is the newest in the suite and its rows head the
 * unified list without scrolling a virtualized 700-row list. Its INBOX count
 * is asserted nowhere (see MOCK_ACCOUNTS in wdio.conf.js). 903 avoids every
 * uid another spec speaks for: 906 (compose-from-identities), 907/908/909
 * (the body-fetch faults), 910 (the attachments message).
 *
 * ── What this leaves behind ───────────────────────────────────────────────
 * A restored message is the same message with a NEW uid — UID MOVE back out
 * of Trash assigns one. Nothing keys on 903's number and its headers (subject,
 * date) travel with it, so its position in every list is unchanged. A hook puts
 * it back by hand, before EACH case and after the last one, if a failure left
 * it in Trash: one mock server serves the whole run, so a message this spec
 * strands is a message every later spec file is missing — and, between the two
 * cases here, one this spec would then blame on the wrong view.
 *
 * yoda's MOVE and EXPUNGE stall 4s by design (a fault that buys in-flight
 * delete coverage elsewhere), so every wait here is sized for a delete that
 * takes seconds, on a mini that is loaded during a full-suite run.
 */

import { ImapFlow } from 'imapflow';
import { MOCK_PASSWORD } from './mockImap.js';
import { waitForApp, waitForEmails } from './helpers.js';

const YODA = 'yoda@mock.test';
const YODA_SERVER = 2;          // MOCK_ACCOUNTS order: luke, vader, yoda
const SUBJECT = 'Yoda message 903';

describe('Delete from server, then undo', function () {
  this.timeout(240_000);

  let yodaId;

  // ── The server, behind the app's back ──────────────────────────────────

  async function withYoda(fn) {
    const { host, port } = browser.mockImap[YODA_SERVER];
    const client = new ImapFlow({
      host, port, secure: false, auth: { user: YODA, pass: MOCK_PASSWORD }, logger: false,
    });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.logout();
    }
  }

  /** UIDs of `SUBJECT` in `mailbox`, straight from the server. */
  const uidsIn = (mailbox) => withYoda(async (client) => {
    const lock = await client.getMailboxLock(mailbox);
    try {
      return await client.search({ subject: SUBJECT }, { uid: true });
    } finally {
      lock.release();
    }
  });

  // ── The list, in whichever shape it is in ──────────────────────────────

  const activate = (id) => browser.execute((accountId) => {
    window.__MAIL_STORE__.getState().activateAccount(accountId, 'INBOX');
  }, id);

  const rowIsOnScreen = () => browser.execute((needle) =>
    [...document.querySelectorAll('[data-testid="email-row"]')]
      .some((r) => (r.textContent || '').includes(needle)), SUBJECT);

  const waitForRow = (present, msg) => browser.waitUntil(
    async () => (await rowIsOnScreen()) === present,
    { timeout: 120_000, interval: 400, timeoutMsg: msg },
  );

  /**
   * Open the row's 3-dot menu, whatever state it is in.
   *
   * The trigger is `invisible` until hover — a real pointer satisfies that, a
   * `.click()` does not — and it TOGGLES, so one more click on an already-open
   * menu shuts it. Ask for the end state, not the click.
   */
  const menuIsOpen = () => browser.execute(() => !!document.querySelector('[role="menu"]'));

  async function openRowMenu() {
    await browser.waitUntil(async () => {
      if (await menuIsOpen()) return true;
      await browser.execute((needle) => {
        const row = [...document.querySelectorAll('[data-testid="email-row"]')]
          .find((r) => (r.textContent || '').includes(needle));
        row?.querySelector('button[aria-label="Row actions"]')?.click();
      }, SUBJECT);
      await browser.pause(200);
      return menuIsOpen();
    }, { timeout: 30_000, interval: 300, timeoutMsg: `"${SUBJECT}"'s action menu did not open` });
  }

  const clickMenuItem = (label) => browser.execute((needle) => {
    for (const el of document.querySelectorAll('[role="menu"] [role="menuitem"]')) {
      if ((el.textContent || '').trim() === needle) { el.click(); return true; }
    }
    return false;
  }, label);

  const clickDialogButton = (label) => browser.execute((needle) => {
    for (const btn of document.querySelectorAll('[role="alertdialog"] button')) {
      if ((btn.textContent || '').trim() === needle) { btn.click(); return true; }
    }
    return false;
  }, label);

  const undoToast = () => browser.execute(() => {
    const toast = document.querySelector('[data-testid="undo-toast"]');
    if (!toast) return null;
    return {
      text: (toast.innerText || '').trim(),
      hasButton: !!toast.querySelector('[data-testid="undo-toast-button"]'),
    };
  });

  /**
   * Delete the row through the menu the user uses, then take the undo the
   * toast offers.
   *
   * The toast lives for 8s from the moment the slot is filled, and the slot is
   * filled after the server round trip — which on yoda includes a 4s MOVE
   * stall. So the poll for the toast is tight, and the click happens in the
   * same step that finds it rather than in a later one.
   */
  async function deleteThenUndo() {
    await openRowMenu();
    expect(await clickMenuItem('Delete from server')).toBe(true);
    await browser.waitUntil(async () => !!(await clickDialogButton('Delete from server')), {
      timeout: 30_000, interval: 300, timeoutMsg: 'Delete confirmation never offered its button',
    });

    await waitForRow(false, `"${SUBJECT}" never left the list after the delete`);

    let toast = null;
    await browser.waitUntil(async () => {
      toast = await undoToast();
      return !!toast;
    }, { timeout: 60_000, interval: 200, timeoutMsg: 'The undo toast never appeared after the delete' });

    // The label is the claim the button has to be able to keep. A permanent
    // delete says so and offers nothing — that would be a different bug here,
    // and a silent one if this only checked for a button.
    expect(toast.text).toMatch(/Trash/i);
    expect(toast.hasButton).toBe(true);

    expect(await browser.execute(() =>
      !!document.querySelector('[data-testid="undo-toast-button"]')
      && (document.querySelector('[data-testid="undo-toast-button"]').click(), true))).toBe(true);
  }

  /**
   * Put 903 back in INBOX if a previous case left it in Trash.
   *
   * One mock server serves every spec file in the run, so a stranded message
   * is every LATER spec's problem too. It is also what keeps these two cases
   * independent: without it, a failure in the single-folder case leaves the
   * unified case asserting on a message that is not there, and the second red
   * says "All Inboxes never rendered it" — true, and nothing to do with the
   * view under test.
   */
  async function restoreStranded() {
    try {
      if ((await uidsIn('INBOX')).length > 0) return;
      const stranded = await uidsIn('Trash');
      if (!stranded.length) return;
      console.warn(`[delete-undo] restoring "${SUBJECT}" from Trash by hand`);
      await withYoda(async (client) => {
        const lock = await client.getMailboxLock('Trash');
        try {
          await client.messageMove(stranded, 'INBOX', { uid: true });
        } finally {
          lock.release();
        }
      });
    } catch (e) {
      console.warn('[delete-undo] restore failed:', e.message);
    }
  }

  before(async function () {
    await waitForApp();
    await waitForEmails();
    yodaId = (browser.mockAccounts || []).find((a) => a.email === YODA)?.id;
    expect(yodaId).toBeTruthy();
  });

  beforeEach(restoreStranded);
  after(restoreStranded);

  it('restores the message from Trash in a single-folder view', async function () {
    await activate(yodaId);
    await waitForRow(true, `yoda's INBOX never rendered "${SUBJECT}"`);

    const before = await uidsIn('INBOX');
    expect(before.length).toBe(1);

    await deleteThenUndo();

    await browser.waitUntil(async () => (await uidsIn('INBOX')).length === 1, {
      timeout: 120_000, interval: 1000,
      timeoutMsg: `"${SUBJECT}" never came back to yoda's INBOX on the server`,
    });
    // A new uid, because UID MOVE back out of Trash assigns one — proof this
    // is the restore and not a delete that never happened.
    expect(await uidsIn('Trash')).toEqual([]);

    await waitForRow(true, `"${SUBJECT}" never came back to the list after the undo`);
  });

  it('restores the message and repaints the list in All Inboxes', async function () {
    // The unified list is a merge of each account's HEADER CACHE, so yoda has
    // to be opened in this run for its mail to reach it — and opened HERE, not
    // left to the case above. `applyServerRemoval` prunes the sidecar on the
    // delete, so a case-above that failed to repaint also leaves 903 out of the
    // cache this case reads, and this case then fails saying All Inboxes never
    // rendered it. True, and nothing to do with the view under test.
    await activate(yodaId);
    // …and force the fetch. `activateAccount` short-circuits when the account
    // is already active (it is — the case above left us on yoda/INBOX), so it
    // is not a refetch on its own, and the header cache is exactly what may be
    // stale here.
    await browser.execute(() => window.__MAIL_STORE__.getState().loadEmails());
    await waitForRow(true, `yoda's INBOX never re-listed "${SUBJECT}"`);

    // Then leave for another account: a unified view whose active account is
    // the one under test gets the right answer for the wrong reason.
    const luke = (browser.mockAccounts || []).find((a) => a.email === 'luke@mock.test');
    await activate(luke.id);
    await browser.waitUntil(
      async () => (await browser.execute(() => window.__MAIL_STORE__.getState().activeAccountId)) === luke.id,
      { timeout: 60_000, interval: 500, timeoutMsg: 'never switched to luke' },
    );

    expect(await browser.execute(() => {
      const btn = document.querySelector('[data-testid="all-inboxes-btn"]');
      if (!btn || btn.offsetHeight === 0) return false;
      btn.click();
      return true;
    })).toBe(true);

    // Wait for the DATA the mode implies, never the mode flag: `activeMailbox`
    // flips to 'UNIFIED' synchronously on the click while the merged list
    // arrives later, so a wait on the flag asserts against luke's rows.
    await browser.waitUntil(async () => browser.execute(() => {
      const s = window.__MAIL_STORE__.getState();
      if (!s || s.activeMailbox !== 'UNIFIED' || s.loadingProgress) return false;
      return new Set((s.sortedEmails || []).map((e) => e._accountId).filter(Boolean)).size >= 2;
    }), { timeout: 90_000, interval: 500, timeoutMsg: 'the unified list never merged two accounts' });

    await waitForRow(true, `All Inboxes never rendered "${SUBJECT}"`);
    expect(await uidsIn('INBOX')).toHaveLength(1);

    await deleteThenUndo();

    await browser.waitUntil(async () => (await uidsIn('INBOX')).length === 1, {
      timeout: 120_000, interval: 1000,
      timeoutMsg: `"${SUBJECT}" never came back to yoda's INBOX on the server`,
    });

    // The reported bug in one line: the server restore above always worked.
    // This is the half that did not.
    await waitForRow(true,
      `"${SUBJECT}" is back on the server but never repainted in All Inboxes`);
    expect(await browser.execute(() =>
      window.__MAIL_STORE__.getState().activeMailbox)).toBe('UNIFIED');
  });
});
