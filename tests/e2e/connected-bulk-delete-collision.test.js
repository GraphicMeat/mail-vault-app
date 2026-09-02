/**
 * E2E: deleting a ticked message from the INBOX list deletes THAT message when
 * the account's Sent folder holds a different message under the same uid.
 *
 * The INBOX list merges the account's Sent copies in so a conversation reads
 * whole, and a uid names a message only inside one folder: luke's INBOX 6
 * ("Luke message 6") and Sent 6 (the root of "Sent folder thread check") are
 * different messages. The bulk delete resolved each ticked row through a map
 * keyed by bare uid whose LAST entry won — the Sent copy — so ticking "Luke
 * message 6" and pressing Delete from server deleted Sent 6 instead: the row
 * left the list and came back at the next sync, and the Sent conversation
 * lost its root.
 *
 * The row is ticked the way its checkbox ticks it — `toggleEmailSelection(uid,
 * _accountId, _mailbox)`, EmailRow's own handler with the store row's
 * provenance — because the row sits below the virtualized window. The delete
 * itself is the selection bar's own button and its confirmation; the server's
 * answer is read on the wire (rawImap.js): after the delete INBOX no longer
 * answers for uid 6, and Sent still does.
 *
 * This spec consumes luke's INBOX 6 for the rest of the run. Nothing else
 * reads it (grep "Luke message 6" in tests/e2e).
 */

import { waitForApp, waitForEmails, switchToFolder } from './helpers.js';
import { serverFlags } from './rawImap.js';

const LUKE = 'luke@mock.test';
const UID = 6;
const SUBJECT = `Luke message ${UID}`;

/** The store's rows for this uid: the INBOX row and the Sent copy merged in. */
const rowsFor = (uid) => browser.execute((n) => {
  const s = window.__MAIL_STORE__?.getState?.();
  const inbox = (s?.emails || []).find((e) => e.uid === n);
  const sent = (s?.sentEmails || []).find((e) => e.uid === n);
  return {
    inbox: inbox ? { subject: inbox.subject, mailbox: inbox._mailbox || null } : null,
    sent: sent ? { subject: sent.subject, fromSent: !!sent._fromSentFolder } : null,
    listed: (s?.sortedEmails || []).some((e) => e.uid === n),
  };
}, uid);

/** Tick the INBOX row as its checkbox would — EmailRow's own handler. */
const tickInboxRow = (uid) => browser.execute((n) => {
  const s = window.__MAIL_STORE__?.getState?.();
  const row = (s?.emails || []).find((e) => e.uid === n);
  if (!row) return false;
  s.toggleEmailSelection(row.uid, row._accountId, row._mailbox);
  return true;
}, uid);

const selectionSize = () => browser.execute(() => window.__MAIL_STORE__?.getState?.().selectedEmailIds?.size ?? 0);

const clickBarButton = (title) => browser.execute((t) => {
  const btn = document.querySelector(`button[title="${t}"]`);
  if (!btn || btn.offsetHeight === 0) return false;
  btn.click();
  return true;
}, title);

/** The confirmation's own button: same words as the bar button, no title, rendered after it. */
const confirmDelete = (label) => browser.execute((needle) => {
  const btns = [...document.querySelectorAll('button')]
    .filter((b) => !b.title && b.offsetHeight > 0 && (b.textContent || '').trim() === needle);
  if (!btns.length) return false;
  btns[btns.length - 1].click();
  return true;
}, label);

const waitFor = (pred, msg, timeout = 30_000) =>
  browser.waitUntil(async () => pred(), { timeout, interval: 300, timeoutMsg: msg });

describe('Bulk delete — a ticked INBOX row, not the Sent copy sharing its uid', function () {
  this.timeout(180_000);

  let port = null;

  before(async function () {
    await waitForApp();
    await waitForEmails();
    await switchToFolder(LUKE, 'INBOX');
    port = browser.mockAccounts.find((a) => a.email === LUKE).imapPort;

    // Both rows in the store, the Sent one merged in with its provenance — the
    // collision this spec is about has to exist before the delete.
    await waitFor(async () => {
      const r = await rowsFor(UID);
      return r.inbox?.subject === SUBJECT && r.sent?.fromSent === true && r.listed;
    }, `luke's INBOX ${UID} and its merged Sent ${UID} never both reached the list`);
  });

  it('starts from the fixture: both folders hold a message under that uid', async function () {
    expect(await serverFlags(port, 'INBOX', UID)).not.toBeNull();
    expect(await serverFlags(port, 'Sent', UID)).not.toBeNull();
  });

  it('deletes INBOX\'s message from INBOX and leaves the Sent message alone', async function () {
    expect(await tickInboxRow(UID)).toBe(true);
    await waitFor(async () => (await selectionSize()) === 1, 'the tick never reached the selection');

    expect(await clickBarButton('Delete from server')).toBe(true);
    await waitFor(() => confirmDelete('Delete from server'), 'the delete confirmation never offered its button', 10_000);

    await waitFor(async () => (await serverFlags(port, 'INBOX', UID)) === null,
      `INBOX ${UID} is still on the server — the delete went to Sent ${UID}`);
    expect(await serverFlags(port, 'Sent', UID)).not.toBeNull();

    // And the list agrees: the INBOX row is gone, the merged Sent copy stays.
    await waitFor(async () => {
      const r = await rowsFor(UID);
      return !r.listed && r.sent !== null;
    }, `the list did not settle on "${SUBJECT}" gone and the Sent copy kept`);
  });
});
