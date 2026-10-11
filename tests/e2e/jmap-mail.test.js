/**
 * E2E (JMAP conf): everyday mail on a JMAP account, beside an IMAP account.
 *
 * The JMAP account is seeded before launch (wdio.jmap.conf.js, the shape the
 * AccountModal saves; jmap-account covers the modal itself). Every action is
 * checked twice: on screen, and on the server through the JMAP API
 * (mockJmap.js `serverEmail`), because a row that moves in the list while the
 * server never changed is exactly the defect a UI-only check would pass.
 *
 * - All Inboxes merges the two accounts.
 * - e1 opens and its body renders.
 * - Flagging e1 sets `$flagged` on the server.
 * - Moving e1 to Work leaves it in Work only.
 * - Deleting e2 from INBOX lands it in Trash. Not e1: a delete from any folder
 *   but INBOX is permanent (`api.deleteEmail`), and on JMAP a permanent delete
 *   from the only mailbox destroys the email (ruling R5).
 * - Mail delivered on the server shows up without Refresh, through the
 *   EventSource push, within 10 s.
 * - A send goes out once through EmailSubmission, and the server's own copy
 *   is in Sent.
 *
 * One mock serves the run and this spec changes it for good (e1 flagged and
 * in Work, e2 in Trash, one push arrival, one submission). jmap-account reads
 * none of those. `expect(value, 'message')` throws in this runner.
 */
import { waitForApp, waitForEmails, switchToFolder, visibleRowSubjects } from './helpers.js';
import { openRowMenu, clickRowAction } from './rowMenu.js';
import { openComposeFresh, setField, typeInBody, closeComposeHard, settingsCall } from './composeHelpers.js';
import {
  JMAP_ACCOUNT_ID, JMAP_EMAIL, MB, SUBJECT, E1_BODY,
  serverEmail, serverSubjects, submitted, mockRequests, deliver, rawMessage, daemonLogHits, openJmapFolder,
} from './mockJmap.js';

const LUKE = 'luke@mock.test';
const PUSH_SUBJECT = 'JMAP push arrival';
const SEND_MARKER = 'jmap-send-check';

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

const origin = () => browser.mockJmap.origin;
const mailboxesOf = (e) => Object.keys(e?.mailboxIds || {}).sort();
const rowsInclude = (subject) => async () => (await visibleRowSubjects()).some((r) => r.includes(subject));

const clickRow = (subject) => browser.execute((needle) => {
  const row = [...document.querySelectorAll('[data-testid="email-row"]')]
    .find((r) => r.offsetHeight > 0 && !r.closest('[data-quick-actions-preview]') && (r.innerText || '').includes(needle));
  if (!row) return false;
  row.click();
  return true;
}, subject);

/** The open message's body: a plain-text body renders in place, HTML in the sandboxed frame. */
const bodyText = () => browser.execute(() => {
  const plain = document.querySelector('.email-plain-body');
  if (plain && plain.offsetHeight > 0) return (plain.innerText || '').trim();
  const iframe = document.querySelector('iframe[sandbox]');
  try { return (iframe?.contentDocument?.body?.innerText || '').trim(); } catch { return ''; }
});

const clickDialogButton = (label) => browser.execute((needle) => {
  for (const btn of document.querySelectorAll('[role="alertdialog"] button')) {
    if ((btn.textContent || '').trim() === needle) { btn.click(); return true; }
  }
  return false;
}, label);

const outboxErrors = () => browser.execute(() =>
  [...document.querySelectorAll('[data-testid="outbox-bubble-error"]')].map((b) => b.textContent.trim()));

describe('Mail on a JMAP account', function () {
  this.timeout(300_000);

  before(async function () {
    await waitForApp();
    await waitForEmails();
    // Send now: the undo window would only delay what this spec reads.
    await settingsCall('setSendDelay', 0);
    // The mock is fresh for this spec: nothing flagged, moved or sent yet.
    expect(mailboxesOf(await serverEmail(origin(), 'e1'))).toEqual([MB.inbox]);
    expect(mailboxesOf(await serverEmail(origin(), 'e2'))).toEqual([MB.inbox]);
    expect(await submitted(origin())).toEqual([]);
  });

  after(async function () {
    await closeComposeHard();
  });

  // A red case says what the app was showing, and what the daemon said about JMAP.
  afterEach(async function () {
    if (this.currentTest?.state !== 'failed') return;
    const view = await browser.execute(() => {
      const s = window.__MAIL_STORE__?.getState?.() || {};
      return {
        active: { accountId: s.activeAccountId, mailbox: s.activeMailbox },
        connection: { status: s.connectionStatus, error: s.connectionError || null },
        folders: (s.mailboxes || []).map((m) => m.path),
        sidebar: (document.querySelector('[data-testid="sidebar"]')?.innerText || '').slice(0, 800),
      };
    });
    console.log(`[jmap-mail] after "${this.currentTest.title}": ${JSON.stringify(view)}`);
    try {
      const jmapLines = daemonLogHits(browser.testDataDir, 'jmap').concat(daemonLogHits(browser.testDataDir, 'JMAP'));
      console.log(`[jmap-mail] daemon.log JMAP lines (last 60):\n${jmapLines.slice(-60).join('\n')}`);
    } catch (e) {
      console.log(`[jmap-mail] daemon.log unreadable: ${e.message}`);
    }
  });

  it('All Inboxes merges the JMAP and the IMAP account', async function () {
    // Both accounts opened once, so each has a cached INBOX to merge.
    await switchToFolder(LUKE, 'INBOX');
    await openJmapFolder(JMAP_ACCOUNT_ID, 'INBOX');
    expect(await browser.execute(() => {
      const btn = document.querySelector('[data-testid="all-inboxes-btn"]');
      if (!btn || btn.offsetHeight === 0) return false;
      btn.click();
      return true;
    })).toBe(true);
    // Wait for the merged DATA, never the mode flag: activeMailbox flips to
    // UNIFIED on the click while the list arrives later.
    await waitFor(
      () => browser.execute((jmapId, subject) => {
        const s = window.__MAIL_STORE__.getState();
        if (s.activeMailbox !== 'UNIFIED' || s.loadingProgress) return null;
        const rows = s.sortedEmails || [];
        return {
          jmap: rows.some((e) => e._accountId === jmapId && e.subject === subject),
          imap: rows.some((e) => e._accountId && e._accountId !== jmapId && (e.subject || '').startsWith('Luke message')),
        };
      }, JMAP_ACCOUNT_ID, SUBJECT.e3),
      (m) => m?.jmap === true && m?.imap === true,
      'All Inboxes never held both the JMAP and the IMAP INBOX',
      90_000,
    );
    await openJmapFolder(JMAP_ACCOUNT_ID, 'INBOX');
  });

  it('opens e1 and renders its body', async function () {
    await waitFor(rowsInclude(SUBJECT.e1), (x) => x, `the JMAP INBOX never listed "${SUBJECT.e1}"`);
    expect(await clickRow(SUBJECT.e1)).toBe(true);
    await waitFor(
      () => browser.execute(() => window.__MAIL_STORE__.getState().selectedEmail?.subject || null),
      (s) => s === SUBJECT.e1,
      `"${SUBJECT.e1}" never opened in the reader`,
    );
    await waitFor(bodyText, (t) => t.includes(E1_BODY), `the body of "${SUBJECT.e1}" never rendered`, 60_000);
  });

  it('flags e1, and the server holds $flagged', async function () {
    expect(await browser.execute((needle) => {
      const row = [...document.querySelectorAll('[data-testid="email-row"]')]
        .find((r) => r.offsetHeight > 0 && (r.innerText || '').includes(needle));
      const star = row?.querySelector('[data-testid="star-toggle"]');
      if (!star) return false;
      star.click();
      return true;
    }, SUBJECT.e1)).toBe(true);

    await waitFor(() => serverEmail(origin(), 'e1'), (e) => e?.keywords?.$flagged === true,
      'the server never got $flagged on e1');
    await waitFor(
      () => browser.execute((needle) => {
        const row = [...document.querySelectorAll('[data-testid="email-row"]')]
          .find((r) => r.offsetHeight > 0 && (r.innerText || '').includes(needle));
        return row?.querySelector('[data-testid="star-toggle"]')?.getAttribute('aria-pressed') || null;
      }, SUBJECT.e1),
      (pressed) => pressed === 'true',
      'the row never showed e1 as flagged',
      15_000,
    );
  });

  it('moves e1 to Work: the server files it in Work only', async function () {
    await openRowMenu({ text: SUBJECT.e1 }, `"${SUBJECT.e1}"'s row menu never opened`);
    expect(await clickRowAction('move')).toBe(true);
    await waitFor(
      () => browser.execute(() => {
        const option = document.querySelector('[data-testid="move-to-folder-dropdown"] [data-testid="move-folder-option"][data-path="Work"]');
        if (!option || option.disabled) return false;
        option.click();
        return true;
      }),
      (clicked) => clicked === true,
      'the folder list never offered Work',
      20_000,
      300,
    );

    await waitFor(async () => mailboxesOf(await serverEmail(origin(), 'e1')), (m) => m.length === 1 && m[0] === MB.work,
      'the server never moved e1 to Work only');
    await waitFor(async () => !(await rowsInclude(SUBJECT.e1)()), (gone) => gone,
      `"${SUBJECT.e1}" stayed in the INBOX list after the move`, 30_000);

    await openJmapFolder(JMAP_ACCOUNT_ID, 'Work');
    await waitFor(rowsInclude(SUBJECT.e1), (x) => x, `Work never listed "${SUBJECT.e1}"`, 60_000);
    await openJmapFolder(JMAP_ACCOUNT_ID, 'INBOX');
  });

  it('deletes e2 from INBOX: it lands in Trash', async function () {
    await waitFor(rowsInclude(SUBJECT.e2), (x) => x, `the JMAP INBOX never listed "${SUBJECT.e2}"`);
    await openRowMenu({ text: SUBJECT.e2 }, `"${SUBJECT.e2}"'s row menu never opened`);
    expect(await clickRowAction('deleteServer')).toBe(true);

    // The confirmation, when it is shown, is answered in the same poll that
    // watches the server.
    await waitFor(
      async () => {
        await clickDialogButton('Delete from server');
        return mailboxesOf(await serverEmail(origin(), 'e2'));
      },
      (m) => m.length === 1 && m[0] === MB.trash,
      'the server never moved e2 to Trash only',
      60_000,
    );
    await waitFor(async () => !(await rowsInclude(SUBJECT.e2)()), (gone) => gone,
      `"${SUBJECT.e2}" stayed in the INBOX list after the delete`, 30_000);

    await openJmapFolder(JMAP_ACCOUNT_ID, 'Trash');
    await waitFor(rowsInclude(SUBJECT.e2), (x) => x, `Trash never listed "${SUBJECT.e2}"`, 60_000);
    await openJmapFolder(JMAP_ACCOUNT_ID, 'INBOX');
  });

  it('shows mail the server pushes without Refresh, within 10 s', async function () {
    // The daemon's EventSource stream must be open, or the delivery raises no
    // event (the stream's own catch-up sync would then be what shows it).
    await waitFor(
      async () => (await mockRequests(origin())).some((r) => r.path.startsWith('/jmap/eventsource')),
      (open) => open,
      'the daemon never opened the JMAP EventSource stream',
      60_000,
      1000,
    );
    expect(await rowsInclude(PUSH_SUBJECT)()).toBe(false);

    const now = new Date();
    await deliver(origin(), MB.inbox, rawMessage({
      subject: PUSH_SUBJECT,
      body: 'Delivered while the app was watching.',
      date: now.toUTCString().replace('GMT', '+0000'),
      messageId: `push-${now.getTime()}@jmap.test`,
    }));
    await waitFor(rowsInclude(PUSH_SUBJECT), (x) => x,
      `"${PUSH_SUBJECT}" did not appear within 10 s of the delivery`, 10_000, 250);
  });

  it('sends once through EmailSubmission, and Sent shows the server copy', async function () {
    await openComposeFresh();
    expect(await setField('compose-to', 'Leia Organa <leia@rebels.test>')).toBe(true);
    expect(await setField('compose-subject', SEND_MARKER)).toBe(true);
    await typeInBody('Sent over JMAP');

    expect(await browser.execute(() => {
      const btn = document.querySelector('[data-testid="compose-send"]');
      if (!btn) return false;
      btn.click();
      return true;
    })).toBe(true);

    const seen = await waitFor(
      async () => ({ sent: (await submitted(origin())).filter((m) => m.includes(SEND_MARKER)).length, errors: await outboxErrors() }),
      (s) => s.sent >= 1 || s.errors.length > 0,
      'the send never reached EmailSubmission',
      60_000,
    );
    expect(seen.errors).toEqual([]);
    // Once: the server took it, nothing retried it.
    await browser.pause(2000);
    const all = await submitted(origin());
    expect(all).toHaveLength(1);
    expect(all[0]).toContain(SEND_MARKER);
    expect(all[0].split(/\r?\n\r?\n/)[0]).toMatch(new RegExp(`^From:.*${JMAP_EMAIL.replace('.', '\\.')}`, 'mi'));

    await waitFor(() => serverSubjects(origin(), MB.sent), (subjects) => subjects.includes(SEND_MARKER),
      'the server never filed the sent message in Sent', 30_000);
    await openJmapFolder(JMAP_ACCOUNT_ID, 'Sent');
    await waitFor(rowsInclude(SEND_MARKER), (x) => x, `Sent never listed "${SEND_MARKER}"`, 60_000, 1000);
  });

  it('never sent the JMAP account down an IMAP path (daemon log)', async function () {
    // Anti-vacuity: this log is the daemon that spoke JMAP in this spec. It
    // warns once when it reads the loopback override (src-core jmap/base.rs).
    expect(daemonLogHits(browser.testDataDir, 'MAILVAULT_JMAP_BASE').length).toBeGreaterThan(0);
    const hits = daemonLogHits(browser.testDataDir, 'E_JMAP_NOT_IMAP');
    if (hits.length) console.log(`[jmap-mail] E_JMAP_NOT_IMAP in daemon.log:\n${hits.join('\n')}`);
    expect(hits).toEqual([]);
  });
});
