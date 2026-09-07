/**
 * E2E: a reply sent from inside a thread joins that thread — at once, in the
 * reading pane and in the list row.
 *
 * The reported bug: "I'm replying in a thread, I send the email and the email
 * does not appear in the thread view." Two things were wrong at once:
 *   - the copy the compose window stages for the UI carried no In-Reply-To /
 *     References, so it threaded as its own "Re: …" conversation; and
 *   - the open thread is a SNAPSHOT of one buildThreads entry, and nothing
 *     re-derived it when a message was added (only when one was deleted), so
 *     the reader kept showing the thread as it was when the row was clicked.
 *
 * Harness facts this leans on:
 *  - There is no SMTP server: the mock account's smtpHost/smtpPort point at its
 *    IMAP mock, so the send always ends in an outbox error. That is AFTER the
 *    staged copy is inserted (compose stage 1 precedes the SMTP call), which is
 *    exactly the window under test — what the user sees the instant they hit
 *    Send, before any server round trip could have healed it.
 *  - framer-motion exits never finish under the occluded runner window, so
 *    every case asserts the state it moved to.
 *  - `expect(value, 'message')` throws in this runner: one argument only.
 */

import { waitForApp, waitForEmails } from './helpers.js';
import { FRAGMENTED_SUBJECT, FRAGMENTED_COUNT } from './mockImap.js';
import { modalOpen, fieldValue, closeComposeHard, settingsCall } from './composeHelpers.js';

// A message with no conversation around it — replying to it is what turns its
// row into a thread of two.
const SINGLE_SUBJECT = 'Luke message 40';

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
    staged: t.emails.filter(e => e._optimistic).map(e => ({
      uid: e.uid, subject: e.subject, inReplyTo: e.inReplyTo || null,
      references: e.references || null, fromSent: !!e._fromSentFolder,
    })),
  };
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

describe('A reply sent inside a thread', function () {
  this.timeout(240_000);

  before(async function () {
    await waitForApp();
    await waitForEmails();
    // Send now — the staged copy is what this spec reads, and the undo window
    // would only delay it.
    await settingsCall('setSendDelay', 0);
  });

  afterEach(async function () {
    await closeComposeHard();
  });

  /** Send the reply the compose window is currently holding. */
  async function clickSend() {
    const sent = await browser.execute(() => {
      const btn = document.querySelector('[data-testid="compose-send"]');
      if (!btn) return false;
      btn.click();
      return true;
    });
    expect(sent).toBe(true);
  }

  /** Wait for a compose window that is not merely mounted but PREFILLED. */
  const prefilledReply = (what) => waitFor(
    async () => ({ open: await modalOpen(), to: await fieldValue('compose-to'), subject: await fieldValue('compose-subject') }),
    (s) => s.open && !!s.to && s.subject.startsWith('Re:'),
    what,
    30_000,
    300,
  );

  it('appears in the open thread and in its list row, without a server round trip', async function () {
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

    // Reply to the newest message in the thread. The reply entry point is the
    // sender's ADDRESS on that message's header — a click on the header row
    // itself folds it (see connected-reply-entry-points.test.js).
    const clicked = await browser.execute(() => {
      const headers = [...document.querySelectorAll('[data-testid="thread-email-header"]')];
      const addr = headers[headers.length - 1]?.querySelector('[data-testid="sender-address"]');
      if (!addr || addr.offsetHeight === 0) return false;
      addr.click();
      return true;
    });
    expect(clicked).toBe(true);

    // ComposeModal fills its fields from an effect: a modal that merely exists
    // is not yet the reply.
    await prefilledReply('clicking the newest thread message opened no prefilled reply');
    await clickSend();

    // The reader: the thread the user is looking at grows by one, without any
    // server having accepted the message.
    const thread = await waitFor(
      openThreadState,
      (t) => !!t && t.count === FRAGMENTED_COUNT + 1,
      'the reply never joined the open thread',
      60_000,
      500,
    );
    expect(thread.messageCount).toBe(FRAGMENTED_COUNT + 1);
    // It is there because it threads, not because something appended it blindly.
    expect(thread.staged).toHaveLength(1);
    expect(thread.staged[0].inReplyTo).toBeTruthy();
    expect(thread.staged[0].fromSent).toBe(true);

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
    // The other half of the same defect: with no In-Reply-To on the staged
    // copy, a reply to a single message threaded by subject alone — and the
    // subject fallback is scoped per account, which the INBOX row (unstamped)
    // and the Sent copy (stamped) answer differently. The list grew a second
    // "Re: …" row instead of a conversation.
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
      () => browser.execute(() => {
        const addr = document.querySelector('[data-testid="sender-address"]');
        return !!addr && addr.offsetHeight > 0;
      }),
      (visible) => visible === true,
      'the viewer never opened the lone message',
      20_000,
      300,
    );
    // Same entry point in the single viewer: the sender's address, not the row.
    await browser.execute(() => document.querySelector('[data-testid="sender-address"]')?.click());
    await prefilledReply('the sender address opened no prefilled reply');
    await clickSend();

    const rows = await waitFor(
      () => rowsFor(SINGLE_SUBJECT),
      (r) => r.length === 1 && r[0] === 2,
      'the reply did not join the message it answered',
      60_000,
      500,
    );
    expect(rows).toEqual([2]);
  });
});
