/**
 * E2E: a delete that is still on the wire must not close the message the user
 * opened while it ran.
 *
 * Reported as "after delete and select another email quickly, while delete has
 * not completed in server probably - the email selected closes". The workflows
 * snapshot `selectedEmailId` BEFORE their round trip and decide the reader's
 * fate from that snapshot when the server finally answers — so the delete's
 * completion closed a message it never owned. The unit specs alongside
 * (selectionActions.test.js) pin the store; this one pins what the user sees,
 * through the real IMAP round trip.
 *
 * ── What makes the race deterministic ─────────────────────────────────────
 * No timing tricks here. yoda's mock server already stalls MOVE and EXPUNGE by
 * 4s each (wdio.conf.js `slowCommand`), which is what the in-flight delete
 * coverage in connected-storage-matrix is built on, and a delete-from-server is
 * a MOVE to Trash. Nothing else on that account is slowed — the second
 * message's body fetch answers at loopback speed — so the window is wide, and
 * it is the server that holds it open rather than the spec.
 *
 * The window is then PROVEN rather than assumed: the poll that opens the second
 * message reads the reader's subject and the undo toast in the SAME round trip,
 * and the toast is filled only after `applyServerRemoval` has run. A toast
 * already present at the moment the second message appears means the delete had
 * finished first and the case would be green for the wrong reason, so that is a
 * failure here, not a pass.
 *
 * ── Why 901 and 902 ───────────────────────────────────────────────────────
 * Every other uid in yoda's INBOX is spoken for: 903 (connected-delete-undo),
 * 904 and 905 (connected-storage-matrix), 906 (compose identities and reply
 * account), 907/908/909 (the body-fetch faults), 910 (the attachments message).
 * 901 and 902 are claimed by nothing.
 *
 * ── What this leaves behind ───────────────────────────────────────────────
 * 901 really is deleted, so a hook moves it back out of Trash before each case
 * and after the last one. One mock server serves the whole run: a message this
 * spec strands is a message every later spec file is missing. 902 is only read.
 */

import { ImapFlow } from 'imapflow';
import { MOCK_PASSWORD } from './mockImap.js';
import { waitForApp, waitForEmails } from './helpers.js';

const YODA = 'yoda@mock.test';
const YODA_SERVER = 2;              // MOCK_ACCOUNTS order: luke, vader, yoda
const DELETED = 'Yoda message 901'; // the one the user deletes
const KEPT = 'Yoda message 902';    // the one they open while it is in flight

describe('A finished delete and the message opened while it ran', function () {
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

  const uidsIn = (mailbox, subject) => withYoda(async (client) => {
    const lock = await client.getMailboxLock(mailbox);
    try {
      return await client.search({ subject }, { uid: true });
    } finally {
      lock.release();
    }
  });

  /** Put 901 back in INBOX if a case left it in Trash. */
  async function restoreStranded() {
    try {
      if ((await uidsIn('INBOX', DELETED)).length > 0) return;
      const stranded = await uidsIn('Trash', DELETED);
      if (!stranded.length) return;
      console.warn(`[delete-reader-race] restoring "${DELETED}" from Trash by hand`);
      await withYoda(async (client) => {
        const lock = await client.getMailboxLock('Trash');
        try {
          await client.messageMove(stranded, 'INBOX', { uid: true });
        } finally {
          lock.release();
        }
      });
    } catch (e) {
      console.warn('[delete-reader-race] restore failed:', e.message);
    }
  }

  // ── The UI ─────────────────────────────────────────────────────────────

  const activate = (id) => browser.execute((accountId) => {
    window.__MAIL_STORE__.getState().activateAccount(accountId, 'INBOX');
  }, id);

  const rowIsOnScreen = (needle) => browser.execute((s) =>
    [...document.querySelectorAll('[data-testid="email-row"]')]
      .some((r) => (r.textContent || '').includes(s)), needle);

  /** Whatever the reading pane is headed with — '' when nothing is open.
   *  Two layouts, one question: a single message and a thread each carry the
   *  subject in their own h1. */
  const readerSubject = () => browser.execute(() =>
    (document.querySelector('.email-reader h1, .thread-reader h1')?.innerText || '').trim());

  /**
   * Open a row and wait for the reading pane to actually be showing it.
   *
   * Ask for the end state, not the click: the body is a server fetch, so the
   * pane spends a beat on its spinner, and a second click during that beat
   * restarts the fetch instead of hurrying it.
   */
  const openStep = (needle) => browser.execute((s) => {
    const subject = (document.querySelector('.email-reader h1, .thread-reader h1')?.innerText || '').trim();
    const loading = !!document.querySelector('[data-testid="email-viewer-loading"]');
    if (!subject.includes(s) && !loading) {
      const row = [...document.querySelectorAll('[data-testid="email-row"]')]
        .find((r) => (r.textContent || '').includes(s));
      if (row && row.offsetHeight > 0) row.click();
    }
    // Read in the SAME round trip as the click above: the toast is the delete's
    // completion marker, and a reading taken one call later cannot say whether
    // the delete was still running when this message appeared.
    return { subject, deleteFinished: !!document.querySelector('[data-testid="undo-toast"]') };
  }, needle);

  async function openAndWait(needle, timeoutMsg, timeout = 60_000) {
    let last = null;
    await browser.waitUntil(async () => {
      last = await openStep(needle);
      return last.subject.includes(needle);
    }, { timeout, interval: 300, timeoutMsg });
    return last;
  }

  const menuIsOpen = () => browser.execute(() => !!document.querySelector('[role="menu"]'));

  /**
   * Open the row's 3-dot menu, whatever state it is in.
   *
   * The trigger is `invisible` until hover — a real pointer satisfies that, a
   * `.click()` does not — and it TOGGLES, so one more click on an already-open
   * menu shuts it. Ask for the end state, not the click.
   */
  async function openRowMenu(needle) {
    await browser.waitUntil(async () => {
      if (await menuIsOpen()) return true;
      await browser.execute((s) => {
        const row = [...document.querySelectorAll('[data-testid="email-row"]')]
          .find((r) => (r.textContent || '').includes(s));
        row?.querySelector('button[aria-label="Row actions"]')?.click();
      }, needle);
      await browser.pause(200);
      return menuIsOpen();
    }, { timeout: 30_000, interval: 300, timeoutMsg: `"${needle}"'s action menu did not open` });
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

  const deleteFinished = () => browser.execute(() =>
    !!document.querySelector('[data-testid="undo-toast"]'));

  before(async function () {
    await waitForApp();
    await waitForEmails();
    yodaId = (browser.mockAccounts || []).find((a) => a.email === YODA)?.id;
    expect(yodaId).toBeTruthy();
  });

  beforeEach(restoreStranded);
  after(restoreStranded);

  it('keeps the second message open when the first one\'s delete lands', async function () {
    await activate(yodaId);
    await browser.waitUntil(async () => (await rowIsOnScreen(DELETED)) && (await rowIsOnScreen(KEPT)), {
      timeout: 120_000, interval: 400,
      timeoutMsg: `yoda's INBOX never rendered both "${DELETED}" and "${KEPT}"`,
    });

    // 1. The user is reading 901.
    await openAndWait(DELETED, `the reading pane never opened "${DELETED}"`);

    // 2. …and deletes it. The row menu is the same workflow the reading pane's
    //    own Delete reaches, and it is the one this harness can drive.
    await openRowMenu(DELETED);
    expect(await clickMenuItem('Delete from server')).toBe(true);
    await browser.waitUntil(async () => !!(await clickDialogButton('Delete from server')), {
      timeout: 30_000, interval: 300, timeoutMsg: 'Delete confirmation never offered its button',
    });

    // The reader closes right there, synchronously with the click — that half
    // is correct and is what makes the assertion at the end mean something: a
    // pane still showing 902 later cannot be a pane that was never cleared.
    await browser.waitUntil(async () => (await readerSubject()) === '', {
      timeout: 30_000, interval: 200,
      timeoutMsg: 'the reading pane never closed on the delete the user asked for',
    });

    // 3. Still inside the 4s MOVE stall, the user opens 902.
    const landed = await openAndWait(
      KEPT, `"${KEPT}" never opened while the delete was in flight`, 20_000,
    );
    // Read in the same round trip as the subject above. If the delete had
    // already finished, this case would assert nothing at all.
    expect(landed.deleteFinished).toBe(false);

    // 4. The delete lands. The undo slot is filled after applyServerRemoval, so
    //    the toast is the marker for "the completion path has run".
    await browser.waitUntil(deleteFinished, {
      timeout: 120_000, interval: 200,
      timeoutMsg: `"${DELETED}"'s delete never finished (no undo toast)`,
    });
    // applyServerRemoval's loadEmails() is not awaited; give the repaint it
    // triggers a chance to close the pane too, if it is going to.
    await browser.pause(2000);

    // 5. The bug, in one line: 902 is still open.
    expect(await readerSubject()).toContain(KEPT);
    expect(await browser.execute(() =>
      (window.__MAIL_STORE__.getState().selectedEmail?.subject || ''))).toContain(KEPT);

    // …and the delete it was racing really did happen.
    await browser.waitUntil(async () => (await uidsIn('INBOX', DELETED)).length === 0, {
      timeout: 60_000, interval: 1000,
      timeoutMsg: `"${DELETED}" never left yoda's INBOX on the server`,
    });
    expect(await rowIsOnScreen(DELETED)).toBe(false);
  });
});
