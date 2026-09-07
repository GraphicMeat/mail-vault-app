/**
 * E2E: what a reply does to the thread it was sent from — and what a reply that
 * never left does NOT do.
 *
 * The reported bug: "I'm replying in a thread, I send the email and the email
 * does not appear in the thread view." Two causes, both fixed:
 *   - the Sent copy the app makes for itself carried no In-Reply-To /
 *     References, so it threaded as its own "Re: …" conversation; and
 *   - the open thread is a SNAPSHOT of one buildThreads entry, and nothing
 *     re-derived it when a message was added (only when one was deleted), so
 *     the reader kept showing the thread as it was when the row was clicked.
 *
 * Harness facts this leans on:
 *  - There is NO SMTP server: the mock account's smtpHost/smtpPort point at its
 *    IMAP mock, so every real send here ends in an outbox error. The Sent row
 *    is only inserted once SMTP has succeeded, so a successful send is not
 *    reachable in this harness at all — the two cases that need one seed the
 *    row into the store exactly as the compose window does (its field shape is
 *    pinned by src/components/__tests__/composeReplyThreading.test.jsx). The
 *    third case needs a FAILING send and drives the real compose window.
 *  - framer-motion exits never finish under the occluded runner window, so
 *    every case asserts the state it moved to.
 *  - `expect(value, 'message')` throws in this runner: one argument only.
 */

import { waitForApp, waitForEmails } from './helpers.js';
import { FRAGMENTED_SUBJECT, FRAGMENTED_COUNT } from './mockImap.js';
import { modalOpen, fieldValue, closeComposeHard, settingsCall } from './composeHelpers.js';

// A message with no conversation around it — a reply to it is what turns its
// row into a thread of two.
const SINGLE_SUBJECT = 'Luke message 40';
const ERROR_BUBBLE = '[data-testid="outbox-bubble-error"]';

/** The thread count of every visible row carrying `subject`. */
const rowsFor = (subject) => browser.execute((subj) =>
  [...document.querySelectorAll('[data-testid="email-row"]')]
    .filter(r => r.offsetHeight > 0 && (r.textContent || '').includes(subj))
    .map(r => Number(r.getAttribute('data-thread-count') || 1)), subject);

const fragmentRows = () => rowsFor(FRAGMENTED_SUBJECT);

/** What the list is showing — for a failure message worth reading. */
const visibleRows = () => browser.execute(() =>
  [...document.querySelectorAll('[data-testid="email-row"]')]
    .filter(r => r.offsetHeight > 0)
    .slice(0, 12)
    .map(r => `${r.getAttribute('data-thread-count') || '1'}× ${(r.textContent || '').trim().slice(0, 50)}`));

/** The open thread as the STORE holds it — the snapshot the reader draws from. */
const openThreadState = () => browser.execute(() => {
  const t = window.__MAIL_STORE__?.getState?.().selectedThread;
  if (!t) return null;
  return {
    count: t.emails.length,
    messageCount: t.messageCount,
    replies: t.emails.filter(e => e._localStaged).map(e => ({
      uid: e.uid, inReplyTo: e.inReplyTo || null, fromSent: !!e._fromSentFolder,
    })),
  };
});

/** Rows the app made for its own outgoing mail, across the whole store. */
const stagedRows = () => browser.execute(() => {
  const s = window.__MAIL_STORE__.getState();
  const pick = (list) => (list || []).filter(e => e._optimistic || e._localStaged)
    .map(e => ({ uid: e.uid, subject: e.subject, seeded: !!e._seeded }));
  return { sent: pick(s.sentEmails), emails: pick(s.emails) };
});

/** How many message headers the thread pane is drawing. */
const threadHeaderCount = () => browser.execute(() =>
  document.querySelectorAll('[data-testid="thread-email-header"]').length);

/** The "N messages in thread" line, or null. */
const threadCountLine = () => browser.execute(() => {
  const m = (document.body.textContent || '').match(/(\d+) messages? in thread/);
  return m ? Number(m[1]) : null;
});

/**
 * Insert the Sent copy of a reply the way the compose window does once SMTP has
 * succeeded — same fields, same flags, answering whatever the reader has open.
 * The harness cannot produce a successful send (no SMTP), and this is the state
 * such a send would leave behind.
 */
const seedSentReply = () => browser.execute(() => {
  const store = window.__MAIL_STORE__;
  const st = store.getState();
  const parent = st.selectedThread
    ? st.selectedThread.emails[st.selectedThread.emails.length - 1]
    : st.selectedEmail;
  if (!parent) return { ok: false, why: 'nothing open in the reader' };
  const stamp = Date.now();
  const row = {
    uid: Math.floor(stamp / 1000),
    subject: `Re: ${(parent.subject || '').replace(/^Re:\s*/i, '')}`,
    from: { address: st.accounts.find(a => a.id === st.activeAccountId)?.email || '', name: '' },
    to: [parent.from].filter(Boolean),
    date: new Date().toISOString(),
    internalDate: new Date().toISOString(),
    messageId: `<seeded-${stamp}@mock.test>`,
    inReplyTo: parent.messageId,
    references: [parent.messageId],
    flags: ['\\Seen'],
    read: true,
    _accountId: st.activeAccountId,
    _optimistic: true,
    _localStaged: true,
    _seeded: true,
  };
  store.setState(s => ({ sentEmails: [row, ...(s.sentEmails || [])] }));
  store.getState().updateSortedEmails?.();
  return { ok: true, uid: row.uid, inReplyTo: row.inReplyTo };
});

/** Take the seeded rows back out, so a later case starts from the fixture. */
const clearSeeded = () => browser.execute(() => {
  const store = window.__MAIL_STORE__;
  store.setState(s => ({
    sentEmails: (s.sentEmails || []).filter(e => !e._seeded),
    emails: (s.emails || []).filter(e => !e._seeded),
  }));
  store.getState().updateSortedEmails?.();
  return true;
});

/**
 * `browser.waitUntil` whose failure names what never happened AND what the page
 * said on the last poll.
 */
async function waitFor(probe, ok, what, timeout = 45_000, interval = 500) {
  let last = null;
  try {
    await browser.waitUntil(async () => { last = await probe(); return ok(last); }, { timeout, interval, timeoutMsg: what });
  } catch (err) {
    throw new Error(`${what} — last seen: ${JSON.stringify(last)} (${err.message})`);
  }
  return last;
}

/** Open the multi-message thread carrying `subject` (it forms once Sent lands). */
async function openThread(subject) {
  await waitFor(
    async () => {
      await browser.execute((subj) => {
        const row = [...document.querySelectorAll('[data-testid="email-row"]')]
          .find(r => r.offsetHeight > 0
            && Number(r.getAttribute('data-thread-count') || 1) > 1
            && (r.textContent || '').includes(subj));
        if (row) { row.click(); return; }
        const list = [...document.querySelectorAll('div')]
          .find(d => d.scrollHeight > d.clientHeight + 200 && d.clientHeight > 200);
        if (list) list.scrollTop = list.scrollTop > 0 ? 0 : list.scrollTop + list.clientHeight;
      }, subject);
      return { line: await threadCountLine(), rows: await visibleRows() };
    },
    (s) => s.line !== null,
    `no thread row for "${subject}" opened the thread view`,
    60_000,
    1000,
  );
}

describe('A reply and the thread it was sent from', function () {
  this.timeout(240_000);

  before(async function () {
    await waitForApp();
    await waitForEmails();
    // Send now — the undo window would only delay what these cases read.
    await settingsCall('setSendDelay', 0);
  });

  afterEach(async function () {
    await closeComposeHard();
  });

  it('joins the open thread and its list row the moment it reaches the pool', async function () {
    // The Sent half merges into the INBOX list asynchronously, so wait for the
    // whole conversation before touching it.
    await waitFor(
      fragmentRows,
      (rows) => rows.includes(FRAGMENTED_COUNT),
      `no ${FRAGMENTED_COUNT}-message row for "${FRAGMENTED_SUBJECT}"`,
      60_000,
      1000,
    );
    await openThread(FRAGMENTED_SUBJECT);
    expect(await threadCountLine()).toBe(FRAGMENTED_COUNT);
    expect(await threadHeaderCount()).toBe(FRAGMENTED_COUNT);

    const seeded = await seedSentReply();
    expect(seeded.ok).toBe(true);
    expect(seeded.inReplyTo).toBeTruthy();

    // The reader: the thread the user is looking at grows by one. Nothing
    // re-derived this snapshot before, so it stayed at five for ever.
    const thread = await waitFor(
      openThreadState,
      (t) => !!t && t.count === FRAGMENTED_COUNT + 1,
      'the reply never joined the open thread',
      60_000,
      500,
    );
    expect(thread.messageCount).toBe(FRAGMENTED_COUNT + 1);
    expect(thread.replies).toHaveLength(1);
    expect(thread.replies[0].fromSent).toBe(true);

    // The pane drew it, not just the store.
    await waitFor(
      threadHeaderCount,
      (n) => n === FRAGMENTED_COUNT + 1,
      'the thread pane never drew the extra message',
      30_000,
      500,
    );
    expect(await threadCountLine()).toBe(FRAGMENTED_COUNT + 1);

    // And the list: one row for the conversation, one message heavier — not a
    // second "Re: …" row beside it.
    const rows = await waitFor(
      fragmentRows,
      (r) => r.length === 1 && r[0] === FRAGMENTED_COUNT + 1,
      'the list did not fold the reply into the conversation row',
      30_000,
      500,
    );
    expect(rows).toEqual([FRAGMENTED_COUNT + 1]);
  });

  it('folds a reply to a lone message into that message\'s row, not a second one', async function () {
    await clearSeeded();
    await waitFor(
      () => rowsFor(SINGLE_SUBJECT),
      (rows) => rows.length === 1 && rows[0] === 1,
      `no single-message row for "${SINGLE_SUBJECT}"`,
      45_000,
      1000,
    );
    const opened = await browser.execute((subj) => {
      const row = [...document.querySelectorAll('[data-testid="email-row"]')]
        .find(r => r.offsetHeight > 0 && (r.textContent || '').includes(subj));
      if (!row) return false;
      row.click();
      return true;
    }, SINGLE_SUBJECT);
    expect(opened).toBe(true);

    await waitFor(
      () => browser.execute((subj) => window.__MAIL_STORE__.getState().selectedEmail?.subject === subj, SINGLE_SUBJECT),
      (open) => open === true,
      'the viewer never opened the lone message',
      20_000,
      300,
    );

    // Without In-Reply-To the copy threaded by subject alone, and the subject
    // fallback is scoped per account — which the INBOX row (unstamped) and the
    // Sent copy (stamped) answer differently, so the list grew a second row.
    expect((await seedSentReply()).ok).toBe(true);

    const rows = await waitFor(
      () => rowsFor(SINGLE_SUBJECT),
      (r) => r.length === 1 && r[0] === 2,
      'the reply did not join the message it answered',
      60_000,
      500,
    );
    expect(rows).toEqual([2]);
  });

  it('claims nothing in Sent when the send fails', async function () {
    // The real compose path against a mock with no SMTP: the message is
    // archived to the vault, the send fails, and the Sent list must stay out of
    // it. Before this, the staged copy sat in the conversation for the rest of
    // the session, indistinguishable from a message that had actually gone.
    await clearSeeded();
    await openThread(FRAGMENTED_SUBJECT);
    expect(await threadCountLine()).toBe(FRAGMENTED_COUNT);

    const clicked = await browser.execute(() => {
      const headers = [...document.querySelectorAll('[data-testid="thread-email-header"]')];
      const addr = headers[headers.length - 1]?.querySelector('[data-testid="sender-address"]');
      if (!addr || addr.offsetHeight === 0) return false;
      addr.click();
      return true;
    });
    expect(clicked).toBe(true);

    await waitFor(
      async () => ({ open: await modalOpen(), to: await fieldValue('compose-to'), subject: await fieldValue('compose-subject') }),
      (s) => s.open && !!s.to && s.subject.startsWith('Re:'),
      'clicking the newest thread message opened no prefilled reply',
      30_000,
      300,
    );
    const sent = await browser.execute(() => {
      const btn = document.querySelector('[data-testid="compose-send"]');
      if (!btn) return false;
      btn.click();
      return true;
    });
    expect(sent).toBe(true);

    // The send is over once the outbox says so.
    await waitFor(
      () => browser.execute((sel) => !!document.querySelector(sel), ERROR_BUBBLE),
      (present) => present === true,
      'the failed send never produced an outbox error bubble',
      90_000,
      1000,
    );

    // Nothing was added: not to the store, not to the thread, not to the row.
    expect(await stagedRows()).toEqual({ sent: [], emails: [] });
    expect(await threadCountLine()).toBe(FRAGMENTED_COUNT);
    expect(await threadHeaderCount()).toBe(FRAGMENTED_COUNT);
    expect(await fragmentRows()).toEqual([FRAGMENTED_COUNT]);
  });
});
