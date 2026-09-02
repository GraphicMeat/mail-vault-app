/**
 * E2E: "Mark unread" on a Sent copy the INBOX list merged in lands on the Sent
 * message, not on INBOX's message with the same uid.
 *
 * The INBOX list threads INBOX + Sent so a conversation reads whole, and the
 * Sent copies it merges in keep their own folder: luke's "HTML uid collision
 * check" sits in Sent on the same uid as INBOX's HTML message (mockImap.js,
 * HTML_COLLISION_SUBJECT). A uid names a message only inside one folder, and
 * the viewer's toggle resolved the folder from the view: it issued
 * `UID STORE <uid> -FLAGS (\Seen)` against INBOX — a no-op on INBOX's unread
 * message there, and nothing at all on the Sent copy in the viewer, whose
 * list row kept its read state as well. (The vault write for such a row was
 * already refused; the server write was not.)
 *
 * The copy is opened the way its row opens it — `selectEmail(uid, source,
 * _mailbox)`, EmailRow's click handler, with the provenance the store stamped
 * on the row — rather than by clicking: the INBOX list draws a merged Sent
 * copy only inside a thread that has an INBOX member (EmailList's
 * threadedDisplay), and this one answers nothing in INBOX. Everything after
 * that is the viewer's own button and the server's own answer: a raw IMAP
 * session to the mock (rawImap.js) reads each folder's flags after the click.
 * The reopen at the end is the open path marking the copy read again under
 * its own folder — which also puts the fixture back for the specs after
 * this one.
 */

import { waitForApp, waitForEmails, switchToFolder } from './helpers.js';
import { HTML_COLLISION_SUBJECT } from './mockImap.js';
import { serverFlags, storeFlag } from './rawImap.js';

const LUKE = 'luke@mock.test';
const SUBJECT = HTML_COLLISION_SUBJECT;

/** Open the merged Sent copy as its row would — EmailRow's own click handler. */
const openSentCopy = (subject) => browser.execute((needle) => {
  const s = window.__MAIL_STORE__?.getState?.();
  const row = (s?.sentEmails || []).find((e) => e.subject === needle);
  if (!row) return false;
  s.selectEmail(row.uid, row.source, row._mailbox);
  return true;
}, subject);

const hasButton = (title) => browser.execute((t) => {
  const btn = document.querySelector(`button[title="${t}"]`);
  return btn !== null && btn.offsetHeight > 0;
}, title);

const clickButton = (title) => browser.execute((t) => {
  const btn = document.querySelector(`button[title="${t}"]`);
  if (!btn || btn.offsetHeight === 0) return false;
  btn.click();
  return true;
}, title);

/** The store's row for the Sent copy — the provenance the list stamps on it, and its read state. */
const sentRow = (subject) => browser.execute((needle) => {
  const s = window.__MAIL_STORE__?.getState?.();
  const row = (s?.sentEmails || []).find((e) => e.subject === needle);
  return row ? { uid: row.uid, fromSent: !!row._fromSentFolder, seen: !!row.flags?.includes('\\Seen') } : null;
}, subject);

const waitFor = (pred, msg, timeout = 30_000) =>
  browser.waitUntil(async () => pred(), { timeout, interval: 300, timeoutMsg: msg });

describe('Read state — a Sent copy in the INBOX list is marked under Sent', function () {
  this.timeout(180_000);

  let port = null;
  let uid = null;
  let restore = false;
  // INBOX's own message under that uid, as the server holds it when this spec
  // starts — unread in the fixture, read once an earlier spec has opened it.
  // What matters is that it does not CHANGE.
  let inboxFlags = null;

  before(async function () {
    await waitForApp();
    await waitForEmails();
    await switchToFolder(LUKE, 'INBOX');
    port = browser.mockAccounts.find((a) => a.email === LUKE).imapPort;

    // The Sent headers arrive after the INBOX paint, and the merge (which
    // stamps the provenance) runs when the list threads them in.
    await waitFor(async () => (await sentRow(SUBJECT))?.fromSent === true,
      `"${SUBJECT}" never reached the INBOX list as a merged Sent copy`);
    ({ uid } = await sentRow(SUBJECT));
    inboxFlags = await serverFlags(port, 'INBOX', uid);
  });

  after(async function () {
    // The specs after this one expect the fixture's read Sent copy.
    if (restore) {
      try { await storeFlag(port, 'Sent', uid, '+FLAGS'); } catch (e) { console.warn('[sent-row] restore failed:', e.message); }
    }
  });

  it('starts from the fixture: the Sent copy read, and INBOX holding its own message under that uid', async function () {
    expect(await serverFlags(port, 'Sent', uid)).toContain('\\Seen');
    expect(inboxFlags).not.toBeNull();
    expect((await sentRow(SUBJECT)).seen).toBe(true);
  });

  it('marks the open Sent copy unread on the Sent message, and on its row', async function () {
    expect(await openSentCopy(SUBJECT)).toBe(true);
    await waitFor(() => hasButton('Mark unread'), `"${SUBJECT}" opened without a Mark unread button`, 20_000);
    expect(await clickButton('Mark unread')).toBe(true);
    restore = true;

    await waitFor(async () => !(await serverFlags(port, 'Sent', uid))?.includes('\\Seen'),
      `Sent uid ${uid} kept \\Seen on the server — the STORE went to INBOX's uid ${uid}`);
    // INBOX's own message under that number is untouched — whatever state it
    // was in (the wrong STORE was a no-op on an unread one; the Sent side is
    // the tell either way).
    expect(await serverFlags(port, 'INBOX', uid)).toEqual(inboxFlags);
    // The viewer closes on mark-unread, and the row that changes is the Sent
    // copy's — the one a thread would render from.
    await waitFor(async () => (await sentRow(SUBJECT))?.seen === false,
      `"${SUBJECT}" kept its read state in the list — the Sent copy on screen never changed`);
  });

  it('reopening it marks it read again under its own folder', async function () {
    expect(await openSentCopy(SUBJECT)).toBe(true);
    // Default markAsReadMode is 'delay' (3s).
    await waitFor(async () => (await serverFlags(port, 'Sent', uid))?.includes('\\Seen'),
      `Sent uid ${uid} never got \\Seen back on reopen`);
    restore = false;
    expect(await serverFlags(port, 'INBOX', uid)).toEqual(inboxFlags);
    await waitFor(async () => (await sentRow(SUBJECT))?.seen === true,
      `"${SUBJECT}" stayed unread in the list after reopening`);
  });
});
