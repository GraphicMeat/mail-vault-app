/**
 * E2E (Graph conf): an Outlook.com account signed in with Microsoft sends mail.
 *
 * The report (discussion #22): sync worked, every send failed with
 * "Authentication failed for smtp.office365.com:587". The account's token
 * carries Graph scopes only and the send went to SMTP. It now goes to Graph's
 * `POST /me/sendMail`, MIME base64-encoded. Graph has no envelope, so the Bcc
 * has to be in that MIME, or the Bcc recipient gets nothing.
 *
 * Graph files its own copy in Sent Items, and there is no IMAP to APPEND
 * over, so the daemon reports the Sent copy saved right after the 202 and
 * compose drops the copy it staged in the vault. Without that report the
 * staged copy stayed in the vault's Sent beside the server's for good. The
 * Sent LIST alone cannot show it here (the mock keeps the Message-ID, and
 * the list folds the two together), so the spec watches the staged copy
 * itself: its uid (the optimistic row compose inserts) and its `.eml`.
 *
 * The mock (tests/e2e/mockGraph.js) records each sendMail's decoded MIME
 * (GET /__mock/sent) and files the message in its `sentitems` folder. `after`
 * puts the scenario mailbox back: one mock serves the whole run.
 * `expect(value, 'message')` throws in this runner.
 */
import { existsSync, readdirSync } from 'node:fs';
import { waitForApp, waitForEmails, switchToFolder } from './helpers.js';
import { openComposeFresh, setField, fieldValue, typeInBody, closeComposeHard, settingsCall, sentDir } from './composeHelpers.js';
import { GRAPH_EMAIL, GRAPH_ACCOUNT_ID, graphScenarioFolders } from './mockGraph.js';

const MARKER = 'graph-send-bcc-check';
const TO = 'partner@outlook-mock.test';
const BCC = 'hidden@outlook-mock.test';

const mockGraph = (path, init) => fetch(`${browser.mockGraph.origin}${path}`, init);

/** `browser.waitUntil` whose failure names what never happened AND the last value seen. */
async function waitFor(probe, ok, what, timeout = 45_000, interval = 500) {
  let last = null;
  try {
    await browser.waitUntil(async () => { last = await probe(); return ok(last); }, { timeout, interval, timeoutMsg: what });
  } catch (err) {
    throw new Error(`${what}; last seen: ${JSON.stringify(last)} (${err.message})`);
  }
  return last;
}

/** The sendMail requests the mock received for this spec's message. */
const sendMails = async () => (await (await mockGraph('/__mock/sent')).json()).filter((s) => s.mime.includes(MARKER));

/** Unfolded header lines named `name` in `mime`'s header block. */
const headerLines = (mime, name) => mime.split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, ' ')
  .split(/\r?\n/).filter((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`));

/**
 * Remember the uid of the optimistic Sent row compose inserts for the marker:
 * the uid its vault copy was staged under. A store subscription, not a poll:
 * once the Sent copy is reported saved the row is gone within milliseconds.
 */
const watchStagedUid = () => browser.execute((m) => {
  window.__graphStagedUid = null;
  const grab = (s) => {
    for (const e of s.sentEmails || []) {
      if (e._optimistic && (e.subject || '').includes(m)) window.__graphStagedUid = e.uid;
    }
  };
  grab(window.__MAIL_STORE__.getState());
  window.__MAIL_STORE__.subscribe(grab);
  return true;
}, MARKER);

const stagedUid = () => browser.execute(() => window.__graphStagedUid ?? null);

/** The vault's Sent files carrying `uid` (Maildir names start `<uid>:`). */
const stagedFiles = (uid) => {
  const dir = sentDir(GRAPH_ACCOUNT_ID);
  return existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith(`${uid}:`)) : [];
};

/** What the store holds for the marker: Sent list rows and the conversation's Sent rows. */
const copies = () => browser.execute((m) => {
  const s = window.__MAIL_STORE__.getState();
  const mine = (e) => (e.subject || '').includes(m);
  const row = (e) => ({ uid: e.uid, source: e.source || null, origin: e._origin || null, staged: !!e._localStaged, optimistic: !!e._optimistic });
  return { list: (s.sortedEmails || []).filter(mine).map(row), sent: (s.sentEmails || []).filter(mine).map(row) };
}, MARKER);

const outboxErrors = () => browser.execute(() =>
  [...document.querySelectorAll('[data-testid="outbox-bubble-error"]')].map((b) => b.textContent.trim()));

describe('Sending from an Outlook.com account through Graph', function () {
  this.timeout(240_000);

  before(async function () {
    await waitForApp();
    await waitForEmails();
    // Send now: the undo window would only delay what this spec reads.
    await settingsCall('setSendDelay', 0);
    await mockGraph('/__mock/sent', { method: 'DELETE' });
  });

  after(async function () {
    await closeComposeHard();
    await mockGraph('/__mock/folders', { method: 'PUT', body: JSON.stringify(graphScenarioFolders()) });
    await mockGraph('/__mock/sent', { method: 'DELETE' });
  });

  it('sends To and Bcc through sendMail, and Sent keeps only the copy Graph filed', async function () {
    await switchToFolder(GRAPH_EMAIL, 'INBOX');
    await openComposeFresh();
    expect(await setField('compose-to', `Partner <${TO}>`)).toBe(true);
    expect(await setField('compose-bcc', BCC)).toBe(true);
    expect(await setField('compose-subject', MARKER)).toBe(true);
    await typeInBody('Sent through Microsoft Graph');
    expect(await fieldValue('compose-bcc')).toBe(BCC);
    await watchStagedUid();

    const clicked = await browser.execute(() => {
      const btn = document.querySelector('[data-testid="compose-send"]');
      if (!btn) return false;
      btn.click();
      return true;
    });
    expect(clicked).toBe(true);

    const mails = await waitFor(
      async () => ({ mails: await sendMails(), errors: await outboxErrors() }),
      (s) => s.mails.length >= 1 || s.errors.length > 0,
      'the send never reached Graph\'s sendMail',
      60_000,
      500,
    );
    expect(mails.errors).toEqual([]);
    // Once: Graph took it, nothing retried it.
    await browser.pause(2000);
    const all = await sendMails();
    expect(all).toHaveLength(1);
    expect(all[0].contentType.startsWith('text/plain')).toBe(true);

    const mime = all[0].mime;
    const to = headerLines(mime, 'To');
    expect(to).toHaveLength(1);
    expect(to[0]).toContain(TO);
    const bcc = headerLines(mime, 'Bcc');
    expect(bcc).toHaveLength(1);
    expect(bcc[0]).toContain(BCC);
    expect(headerLines(mime, 'Subject')[0]).toContain(MARKER);

    // The staged copy goes: its optimistic row, and its .eml in the vault.
    const uid = await waitFor(stagedUid, (u) => u != null, 'compose never staged a local Sent copy', 20_000, 200);
    await waitFor(
      async () => ({ files: stagedFiles(uid), copies: await copies() }),
      (s) => s.files.length === 0 && !s.copies.sent.some((e) => e.uid === uid),
      `the staged copy (uid ${uid}) stayed after Graph filed the Sent copy`,
      30_000,
      500,
    );

    // Sent, after the folder loads from the server: the copy Graph filed,
    // and nothing staged beside it.
    await switchToFolder(GRAPH_EMAIL, 'Sent');
    await waitFor(
      copies,
      (c) => c.list.some((r) => r.uid !== uid && !r.staged && !r.optimistic),
      'the copy Graph filed in Sent Items never reached the Sent folder',
      60_000,
      1000,
    );
    // Time for a staged copy the cleanup missed to show up beside it.
    await browser.pause(3000);
    const seen = await copies();
    console.log(`[graph-send-bcc] staged uid ${uid}, store copies ${JSON.stringify(seen)}`);
    expect(seen.list).toHaveLength(1);
    expect(seen.list[0].uid).not.toBe(uid);
    expect(seen.list[0].origin).not.toBe('local_sent');
    expect(stagedFiles(uid)).toEqual([]);
    await switchToFolder(GRAPH_EMAIL, 'INBOX');
  });
});
