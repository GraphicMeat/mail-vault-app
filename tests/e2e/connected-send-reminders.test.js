/**
 * E2E: the two send reminders, end to end on the mock servers.
 *
 *  1. Attachment reminder (ComposeModal `missingAttachment`): a message that
 *     says "attached" and carries no file stops at Send; Send anyway sends it.
 *  2. "Remind me if no reply" recorded: the armed reminder reaches the daemon
 *     (`follow_up.create`) keyed on the Message-ID the server's Sent copy
 *     carries, three days out, with luke among its own addresses.
 *  3. Resurface and safety: a past-due reminder the worker finds unanswered
 *     is pinned above the INBOX list (FollowUpPinnedRows). A bulk "All" delete
 *     of that INBOX must not reach the Sent copy behind the pin: that was the
 *     defect of the first design, where the reminder was a list row under the
 *     Sent copy's identity. Its x then dismisses it.
 *  4. Replied: a reminder whose Sent message has a reply in INBOX ends at the
 *     worker's check and is never pinned.
 *
 * Cases 1 and 2 send from luke, the default account; `after` takes what they
 * added off luke's Sent (`trackMailbox`, the scheduled-send pattern) and
 * dismisses the waiting reminder case 2 leaves.
 *
 * Cases 3 and 4 run on an account of their own, on a server of their own
 * (the connected-snooze-local pattern), not on luke: case 3 deletes a whole
 * INBOX, and luke's and vader's INBOX fixtures are read verbatim by other
 * specs (connected-bulk-delete-everywhere explains which). The account is
 * removed and its server stopped in `after`.
 *
 * The worker is driven the way snooze's is: rows are written over
 * `daemon_rpc` (`follow_up.create`, already past due), and the create's own
 * wake runs the daemon's check on the real IMAP wire. No clock is faked.
 */

import { ImapFlow } from 'imapflow';
import { waitForApp, waitForEmails, switchToFolder } from './helpers.js';
import { setPremium } from './mockBilling.js';
import { startMockImap, mailbox, mockAccount, trackMailbox, MOCK_PASSWORD } from './mockImap.js';
import { openComposeFresh, closeComposeHard, setField, typeInBody, modalCount, invoke } from './composeHelpers.js';

const LUKE = 'luke@mock.test';
const LUKE_SERVER = 0; // MOCK_ACCOUNTS order: luke, vader, yoda
const DAY = 24 * 60 * 60 * 1000;
const RUN = Date.now();

// The account cases 3 and 4 own. Ids must be 36-char UUIDs (db/emails.js).
const OWNER = 'reminders@mock.test';
const ACCOUNT_ID = '66666666-6666-4666-8666-666666666666';
const UNANSWERED_ID = `<reminder-unanswered-${RUN}@mock.test>`;
const UNANSWERED_SUBJECT = `Quote for the roof ${RUN}`;
const ANSWERED_ID = `<reminder-answered-${RUN}@mock.test>`;
const ANSWERED_SUBJECT = `Invoice question ${RUN}`;

const REMINDER_STATE = {
  mailboxes: [
    mailbox('INBOX', 3, { owner: OWNER, attrs: ['\\HasNoChildren'], subjectPrefix: 'Reminder inbox' }),
    mailbox('Sent', 0, { owner: OWNER, attrs: ['\\HasNoChildren', '\\Sent'] }),
    mailbox('Trash', 0, { owner: OWNER, attrs: ['\\HasNoChildren', '\\Trash'] }),
  ],
};

/** A message as a mail client writes it. */
const eml = ({ messageId, from, to, subject, extra = [] }) => [
  `Message-ID: ${messageId}`,
  `From: ${from}`,
  `To: ${to}`,
  `Subject: ${subject}`,
  `Date: ${new Date().toUTCString()}`,
  ...extra,
  '',
  'Body text.',
  '',
].join('\r\n');

describe('Send reminders on the mock server', function () {
  this.timeout(300_000);

  let lukeId;
  let restoreLukeSent;
  let server;
  let accountAdded = false;
  const createdReminders = [];

  // ── The servers, behind the app's back ──────────────────────────────────

  async function withImap({ host, port }, user, fn) {
    const client = new ImapFlow({ host, port, secure: false, auth: { user, pass: MOCK_PASSWORD }, logger: false });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.logout();
    }
  }
  const withLuke = (fn) => withImap(browser.mockImap[LUKE_SERVER], LUKE, fn);
  const withOwner = (fn) => withImap(server, OWNER, fn);

  /** Every `{uid, messageId, subject}` in `mailbox`. */
  const listing = (withClient, mailboxName) => withClient(async (client) => {
    const lock = await client.getMailboxLock(mailboxName);
    try {
      const out = [];
      if (!client.mailbox.exists) return out;
      for await (const msg of client.fetch('1:*', { uid: true, envelope: true })) {
        out.push({ uid: msg.uid, messageId: msg.envelope?.messageId || null, subject: msg.envelope?.subject || '' });
      }
      return out;
    } finally {
      lock.release();
    }
  });

  // ── The daemon and the app ─────────────────────────────────────────────

  const rpc = async (method, params) => {
    const r = await invoke('daemon_rpc', { method, params });
    if (!r.ok) throw new Error(`${method}: ${r.error}`);
    return r.value;
  };
  const reminders = () => rpc('follow_up.list', {});

  /** The `follow-up` events the daemon sent since the listener went in. */
  const followUpEvents = () => browser.execute(() => window.__FOLLOW_UP_EVENTS__ || []);

  /**
   * Run a store action that returns a promise and wait for its outcome
   * (browser.execute never awaits an async callback).
   */
  async function runInStore(action, args, what) {
    await browser.execute((name, a) => {
      window.__REMINDER_SPEC_RESULT__ = null;
      Promise.resolve(window.__MAIL_STORE__.getState()[name](...a)).then(
        (value) => { window.__REMINDER_SPEC_RESULT__ = { ok: true, value: (value && value.id) || null }; },
        (e) => { window.__REMINDER_SPEC_RESULT__ = { ok: false, error: String((e && e.message) || e) }; },
      );
    }, action, args);
    const outcome = await browser.waitUntil(
      async () => browser.execute(() => window.__REMINDER_SPEC_RESULT__),
      { timeout: 60_000, interval: 500, timeoutMsg: `${what} never settled` },
    );
    if (!outcome.ok) throw new Error(`${what} failed: ${outcome.error}`);
    return outcome.value;
  }

  const click = (selector) => browser.execute((sel) => {
    const el = document.querySelector(sel);
    if (!el || el.offsetHeight === 0 || el.disabled) return false;
    el.click();
    return true;
  }, selector);

  const visible = (selector) => browser.execute((sel) => {
    const el = document.querySelector(sel);
    return !!el && el.offsetHeight > 0;
  }, selector);

  /** The pinned reminder rows' text. */
  const pinnedRows = () => browser.execute(() =>
    [...document.querySelectorAll('[data-testid="follow-up-pinned-row"]')].map((r) => r.innerText || ''));

  /** A visible button outside the sidebar whose text starts with `text` (bulk-delete-everywhere's). */
  const clickByText = (text) => browser.execute((needle) => {
    const sidebar = document.querySelector('[data-testid="sidebar"]');
    for (const el of document.querySelectorAll('button')) {
      if (sidebar && sidebar.contains(el)) continue;
      if (el.offsetHeight > 0 && !el.disabled && (el.textContent || '').trim().startsWith(needle)) {
        el.click();
        return true;
      }
    }
    return false;
  }, text);

  const waitClick = (fn, msg) => browser.waitUntil(fn, { timeout: 15_000, interval: 300, timeoutMsg: msg });

  async function composeTo(subject, body) {
    await openComposeFresh();
    expect(await setField('compose-to', 'partner@example.com')).toBe(true);
    expect(await setField('compose-subject', subject)).toBe(true);
    await typeInBody(body);
  }

  const waitClosed = (what) => browser.waitUntil(async () => (await modalCount()) === 0, {
    timeout: 20_000, interval: 200, timeoutMsg: `Compose stayed open: ${what}`,
  });

  /** luke's Sent copy titled `subject`, once the server has it. */
  async function lukeSentCopy(subject) {
    let copy = null;
    await browser.waitUntil(async () => {
      copy = (await listing(withLuke, 'Sent')).find((m) => m.subject === subject) || null;
      return !!copy;
    }, { timeout: 60_000, interval: 1_000, timeoutMsg: `"${subject}" never reached luke's Sent folder on the server` });
    return copy;
  }

  before(async function () {
    await waitForApp();
    await waitForEmails();
    lukeId = (browser.mockAccounts || []).find((a) => a.email === LUKE)?.id;
    expect(lukeId).toBeTruthy();
    await switchToFolder(LUKE, 'INBOX');
    // Both reminders are Premium.
    await setPremium(true);
    restoreLukeSent = await trackMailbox(browser.mockImap[LUKE_SERVER], 'Sent');
    await browser.execute(() => {
      window.__FOLLOW_UP_EVENTS__ = [];
      window.__TAURI__.event.listen('follow-up', (e) => window.__FOLLOW_UP_EVENTS__.push(e.payload));
    });
  });

  afterEach(async function () {
    await closeComposeHard();
  });

  after(async function () {
    // Never let cleanup throw over the failure a case already reported.
    for (const row of await reminders().catch(() => [])) {
      if (row.accountId === lukeId || row.accountId === ACCOUNT_ID || createdReminders.includes(row.id)) {
        await rpc('follow_up.dismiss', { id: row.id }).catch(() => {});
      }
    }
    await restoreLukeSent?.().catch((e) => console.warn('[send-reminders] luke Sent restore:', e.message));
    if (accountAdded) {
      try {
        await switchToFolder(LUKE, 'INBOX');
        await runInStore('removeAccount', [ACCOUNT_ID], 'removeAccount');
      } catch (e) { console.warn('[send-reminders] account removal:', e.message); }
    }
    server?.stop();
    await setPremium(false).catch(() => {});
  });

  it('asks before sending a message that mentions an attachment it does not carry, and Send anyway sends it', async function () {
    const subject = `Monthly report ${RUN}`;
    const before = (await listing(withLuke, 'Sent')).length;
    await composeTo(subject, 'Hi, the report is attached.');

    expect(await click('[data-testid="compose-send"]')).toBe(true);
    await browser.waitUntil(() => visible('[data-testid="compose-attachment-reminder"]'), {
      timeout: 10_000, interval: 200, timeoutMsg: 'Send did not stop at the attachment reminder',
    });
    expect(await modalCount()).toBe(1);

    expect(await click('[data-testid="compose-attachment-reminder-send"]')).toBe(true);
    await waitClosed('Send anyway never sent');
    await lukeSentCopy(subject);
    expect((await listing(withLuke, 'Sent')).length).toBe(before + 1);
  });

  it('records an armed "remind me if no reply" under the Message-ID that went out', async function () {
    const subject = `Waiting on an answer ${RUN}`;
    await composeTo(subject, 'Can you confirm by Friday?');

    expect(await click('[data-testid="compose-remind-toggle"]')).toBe(true);
    await waitClick(() => click('[data-testid="compose-remind-option-3"]'), 'The remind menu offered no 3 days option');
    await browser.waitUntil(() => visible('[data-testid="compose-remind-armed"]'), {
      timeout: 5_000, interval: 200, timeoutMsg: 'Choosing 3 days never armed the reminder',
    });
    const sentAt = Date.now();
    expect(await click('[data-testid="compose-send"]')).toBe(true);
    await waitClosed('the armed send never left');

    const copy = await lukeSentCopy(subject);
    expect(copy.messageId).toBeTruthy();
    let row = null;
    await browser.waitUntil(async () => {
      row = (await reminders()).find((r) => r.messageId === copy.messageId) || null;
      return !!row;
    }, { timeout: 20_000, interval: 500, timeoutMsg: `follow_up.list never held a row for ${copy.messageId}` });
    createdReminders.push(row.id);

    expect(row.accountId).toBe(lukeId);
    expect(row.state).toBe('waiting');
    expect(row.subject).toBe(subject);
    expect(Math.abs(row.remindAt - (sentAt + 3 * DAY))).toBeLessThan(5 * 60 * 1000);
    expect(row.ownAddresses.map((a) => a.toLowerCase())).toContain(LUKE);
  });

  describe('on an account of its own', function () {
    before(async function () {
      server = await startMockImap({ state: REMINDER_STATE, faults: [] });
      await withOwner(async (client) => {
        for (const [messageId, subject] of [[UNANSWERED_ID, UNANSWERED_SUBJECT], [ANSWERED_ID, ANSWERED_SUBJECT]]) {
          await client.append('Sent', eml({ messageId, from: OWNER, to: 'client@example.com', subject }), ['\\Seen']);
        }
      });
      const account = mockAccount({ id: ACCOUNT_ID, email: OWNER, port: server.port, smtpPort: server.smtpPort });
      await runInStore('addAccount', [account], 'addAccount');
      accountAdded = true;
      await runInStore('activateAccount', [ACCOUNT_ID, 'INBOX'], 'activateAccount');
      await browser.waitUntil(() => browser.execute(() => {
        const s = window.__MAIL_STORE__.getState();
        return s.activeMailbox === 'INBOX' && (s.sortedEmails || []).some((e) => /^Reminder inbox \d+$/.test(e.subject || ''));
      }), { timeout: 60_000, interval: 500, timeoutMsg: 'The reminder account\'s INBOX never listed its messages' });
    });

    /** A reminder already past due, as compose would have written it. */
    async function pastDueReminder(messageId, subject) {
      const now = Date.now();
      const row = await rpc('follow_up.create', {
        accountId: ACCOUNT_ID, messageId, subject, recipients: 'client@example.com', sentMailbox: 'Sent',
        ownAddresses: [OWNER], sentAt: now - 4 * DAY, remindAt: now - 1_000,
      });
      createdReminders.push(row.id);
      return row;
    }

    it('pins an unanswered reminder, and a bulk "All" delete of the inbox never reaches its Sent copy', async function () {
      const row = await pastDueReminder(UNANSWERED_ID, UNANSWERED_SUBJECT);
      await browser.waitUntil(async () => (await pinnedRows()).some((t) => t.includes(UNANSWERED_SUBJECT)), {
        timeout: 60_000, interval: 500,
        timeoutMsg: `The worker's "due" never pinned "${UNANSWERED_SUBJECT}" above the INBOX list`,
      });
      const due = (await reminders()).find((r) => r.id === row.id);
      expect(due?.state).toBe('due');
      expect(due?.sentMailbox).toBe('Sent');

      const sentBefore = await listing(withOwner, 'Sent');
      expect(sentBefore.some((m) => m.messageId === UNANSWERED_ID)).toBe(true);
      expect((await listing(withOwner, 'INBOX')).length).toBe(3);

      // The bulk modal's own flow (connected-bulk-delete-everywhere): the
      // toolbar's select button, the "All" range, Delete, its confirmation.
      expect(await click('.mail-list-toolbar button[aria-label="Select messages…"]')).toBe(true);
      await browser.waitUntil(() => browser.execute(() => document.body.innerText.includes('Bulk Email Operations')), {
        timeout: 15_000, interval: 300, timeoutMsg: 'The bulk modal never opened',
      });
      await waitClick(() => clickByText('All'), 'The "All" range never became clickable');
      await browser.waitUntil(() => browser.execute(() => (window.__MAIL_STORE__.getState().selectedEmailIds?.size || 0) > 0), {
        timeout: 15_000, interval: 300, timeoutMsg: 'The "All" range selected nothing',
      });
      const ticked = await browser.execute(() => [...window.__MAIL_STORE__.getState().selectedEmailIds].map(String));
      // The pin is no row: nothing the range ticked names the Sent folder.
      expect(ticked.filter((k) => k.includes(':Sent:'))).toEqual([]);
      await waitClick(() => clickByText('Next'), 'Could not advance to the action step');
      await waitClick(() => click('[data-testid="bulk-action-delete"]'), 'Could not choose Delete');
      await waitClick(() => click('[data-testid="bulk-step2-confirm"]'), 'The action step\'s confirm never became clickable');
      await waitClick(() => click('[data-testid="bulk-delete-confirm"]'), 'The delete confirmation never appeared');

      await browser.waitUntil(async () => (await listing(withOwner, 'INBOX')).length === 0, {
        timeout: 60_000, interval: 1_000, timeoutMsg: 'The bulk delete never emptied the INBOX on the server',
      });
      const sentAfter = await listing(withOwner, 'Sent');
      expect(sentAfter.map((m) => m.uid)).toEqual(sentBefore.map((m) => m.uid));
      expect(sentAfter.some((m) => m.messageId === UNANSWERED_ID)).toBe(true);
      expect((await pinnedRows()).some((t) => t.includes(UNANSWERED_SUBJECT))).toBe(true);
      expect((await reminders()).find((r) => r.id === row.id)?.state).toBe('due');

      expect(await click('[data-testid="follow-up-dismiss"]')).toBe(true);
      await browser.waitUntil(async () => !(await pinnedRows()).some((t) => t.includes(UNANSWERED_SUBJECT)), {
        timeout: 10_000, interval: 300, timeoutMsg: 'The dismissed reminder stayed pinned',
      });
      await browser.waitUntil(async () => !(await reminders()).some((r) => r.id === row.id), {
        timeout: 10_000, interval: 300, timeoutMsg: 'follow_up.list still held the dismissed reminder',
      });
      expect((await listing(withOwner, 'Sent')).some((m) => m.messageId === UNANSWERED_ID)).toBe(true);
    });

    it('ends a reminder whose message was answered, and never pins it', async function () {
      let replyUid = null;
      try {
        await withOwner(async (client) => {
          const appended = await client.append('INBOX', eml({
            messageId: `<reply-${RUN}@example.com>`, from: 'Client <client@example.com>', to: OWNER,
            subject: `Re: ${ANSWERED_SUBJECT}`, extra: [`In-Reply-To: ${ANSWERED_ID}`, `References: ${ANSWERED_ID}`],
          }));
          replyUid = appended?.uid ?? null;
        });

        const row = await pastDueReminder(ANSWERED_ID, ANSWERED_SUBJECT);
        await browser.waitUntil(async () => !(await reminders()).some((r) => r.id === row.id), {
          timeout: 60_000, interval: 500, timeoutMsg: 'The worker never ended the answered reminder',
        });
        await browser.waitUntil(async () => (await followUpEvents()).some((e) => e.id === row.id), {
          timeout: 10_000, interval: 300, timeoutMsg: 'No follow-up event for the answered reminder',
        });
        const states = (await followUpEvents()).filter((e) => e.id === row.id).map((e) => e.state);
        expect(states).toEqual(['replied']);
        expect((await pinnedRows()).some((t) => t.includes(ANSWERED_SUBJECT))).toBe(false);
      } finally {
        if (replyUid) {
          await withOwner(async (client) => {
            const lock = await client.getMailboxLock('INBOX');
            try { await client.messageDelete(String(replyUid), { uid: true }); } finally { lock.release(); }
          }).catch((e) => console.warn('[send-reminders] reply cleanup:', e.message));
        }
      }
    });
  });
});
