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
 *  - The mock server has an SMTP listener, so these cases drive the real
 *    compose window end to end. A reply addressed at the message's own sender
 *    is DELIVERED; the failure case re-addresses itself at `SEND_REFUSED_TO`,
 *    which the mock answers 550.
 *  - A delivered message is then APPENDed to the mock's Sent folder by the app
 *    itself, and that copy OUTLIVES this spec file: one mock server serves the
 *    whole run, and `resetAppState` wipes the app's data dir, never the
 *    server's mailboxes. Two consequences, both handled here:
 *    `after` puts the Sent folder back (`trackMailbox`), or the next spec to
 *    open this conversation sees a message it did not expect —
 *    `connected-unified-archive-thread` went red exactly that way, because an
 *    unarchived reply left the row reading "server-only". And every count is
 *    read BEFORE its send and asserted as +1, so a case still holds on the
 *    spec-file retry CI does, where the cleanup has not run yet.
 *  - framer-motion exits never finish under the occluded runner window, so
 *    every case asserts the state it moved to.
 *  - `expect(value, 'message')` throws in this runner: one argument only.
 */

import { waitForApp, waitForEmails } from './helpers.js';
import { FRAGMENTED_SUBJECT, FRAGMENTED_COUNT, SEND_REFUSED_TO, trackMailbox } from './mockImap.js';
import { modalOpen, fieldValue, setField, closeComposeHard, settingsCall } from './composeHelpers.js';

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

/**
 * The open thread as the STORE holds it — the snapshot the reader draws from.
 *
 * Every message is reported, not just the app's own rows: a delivered reply
 * starts as the optimistic copy and is REPLACED by the server's once the
 * background APPEND lands, so a filter on `_localStaged` would stop matching
 * the very message it was watching.
 */
const openThreadState = () => browser.execute(() => {
  const t = window.__MAIL_STORE__?.getState?.().selectedThread;
  if (!t) return null;
  return {
    count: t.emails.length,
    messageCount: t.messageCount,
    emails: t.emails.map(e => ({
      uid: e.uid,
      inReplyTo: e.inReplyTo || null,
      optimistic: !!e._optimistic,
      fromSent: !!e._fromSentFolder,
    })),
  };
});

/**
 * The account's Sent list as the store holds it — where the server's copy of a
 * delivered message lands once the background APPEND completes.
 */
const sentRows = () => browser.execute(() => (window.__MAIL_STORE__?.getState?.().sentEmails || [])
  .map(e => ({ uid: e.uid, inReplyTo: e.inReplyTo || null, optimistic: !!e._optimistic })));

/** Rows the app made for its own outgoing mail, across the whole store. */
const stagedRows = () => browser.execute(() => {
  const s = window.__MAIL_STORE__.getState();
  const pick = (list) => (list || []).filter(e => e._optimistic || e._localStaged)
    .map(e => ({ uid: e.uid, subject: e.subject }));
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

/**
 * Scroll the message list by one screen, wrapping at the bottom.
 *
 * The list is virtualised, so a row that is not on screen is not in the DOM at
 * all. Anything looking for a row by subject has to walk the list.
 */
const scrollListStep = () => browser.execute(() => {
  // Anchored on a row rather than picked by size: with a thread open, the
  // reading pane is also a tall scroller, and scrolling THAT never brings a
  // list row into view.
  let el = document.querySelector('[data-testid="email-row"]')?.parentElement || null;
  while (el && el.scrollHeight <= el.clientHeight + 4) el = el.parentElement;
  if (!el) {
    el = [...document.querySelectorAll('div')]
      .find(d => d.scrollHeight > d.clientHeight + 200 && d.clientHeight > 200);
  }
  if (!el) return;
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
  el.scrollTop = atBottom ? 0 : el.scrollTop + Math.round(el.clientHeight * 0.8);
});

/**
 * `rowsFor`, walking the list until the subject shows up, and reporting what
 * WAS on screen when it did not.
 */
async function rowsForScrolling(subject) {
  const rows = await rowsFor(subject);
  if (!rows.length) await scrollListStep();
  return { rows, onScreen: rows.length ? null : await visibleRows() };
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

  let restoreSent;

  before(async function () {
    await waitForApp();
    await waitForEmails();
    // Send now — the undo window would only delay what these cases read.
    await settingsCall('setSendDelay', 0);
    // Watermark luke's Sent folder before anything is sent into it.
    restoreSent = await trackMailbox(browser.mockImap[0], 'Sent');
  });

  after(async function () {
    await restoreSent?.();
  });

  afterEach(async function () {
    await closeComposeHard();
  });

  /** The Message-ID of the newest message in the open thread — what a reply to it answers. */
  const newestMessageId = () => browser.execute(() => {
    const t = window.__MAIL_STORE__?.getState?.().selectedThread;
    return t?.emails?.[t.emails.length - 1]?.messageId || null;
  });

  /**
   * Open a reply to the newest message in the thread pane.
   *
   * The entry point is the sender's ADDRESS on that message's header — a click
   * on the header row itself folds it (see connected-reply-entry-points).
   */
  async function replyToNewest() {
    const clicked = await browser.execute(() => {
      const headers = [...document.querySelectorAll('[data-testid="thread-email-header"]')];
      const addr = headers[headers.length - 1]?.querySelector('[data-testid="sender-address"]');
      if (!addr || addr.offsetHeight === 0) return false;
      addr.click();
      return true;
    });
    expect(clicked).toBe(true);
    await prefilledReply('clicking the newest thread message opened no prefilled reply');
  }

  /** Wait for a compose window that is not merely mounted but PREFILLED. */
  const prefilledReply = (what) => waitFor(
    async () => ({ open: await modalOpen(), to: await fieldValue('compose-to'), subject: await fieldValue('compose-subject') }),
    (s) => s.open && !!s.to && s.subject.startsWith('Re:'),
    what,
    30_000,
    300,
  );

  /**
   * Wait for the list to finish merging this account's Sent copies in.
   *
   * Until it has, a conversation still reads as ONE message and a case looking
   * for a lone message picks it by mistake. The multi-message fixture reaching
   * its full count is the signal; it is what the reply case needs anyway.
   */
  const awaitSentMerged = () => waitFor(
    () => rowsForScrolling(FRAGMENTED_SUBJECT),
    (seen) => seen.rows.length === 1 && seen.rows[0] >= FRAGMENTED_COUNT,
    `the list never merged Sent into "${FRAGMENTED_SUBJECT}"`,
    60_000,
    1000,
  );

  /**
   * Open a single-message row the list is actually showing, and name it.
   *
   * Candidates are tried in order until one has a subject of its own: the
   * fixtures include a deliberate same-sender same-subject pair, and a subject
   * that draws two rows cannot answer "did the reply fold into ONE row".
   */
  async function openALoneMessage() {
    for (let index = 0; index < 6; index += 1) {
      await browser.execute(() => window.__MAIL_STORE__.setState({ selectedEmail: null, selectedThread: null }));
      const clicked = await browser.execute((i) => {
        const rows = [...document.querySelectorAll('[data-testid="email-row"]')]
          .filter(r => r.offsetHeight > 0 && Number(r.getAttribute('data-thread-count') || 1) === 1);
        if (!rows[i]) return false;
        rows[i].click();
        return true;
      }, index);
      if (!clicked) break;

      const subject = await waitFor(
        () => browser.execute(() => window.__MAIL_STORE__.getState().selectedEmail?.subject || null),
        (s) => !!s,
        'clicking a single-message row opened no message',
        20_000,
        300,
      );
      const rows = await rowsFor(subject);
      if (rows.length === 1 && rows[0] === 1) return subject;
    }
    throw new Error(`no single-message row with a subject of its own: ${JSON.stringify(await visibleRows())}`);
  }

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

  // First on purpose: it reads the list, and this is the only point in the file
  // where no conversation is open over it.
  it('folds a reply to a lone message into that message\'s row, not a second one', async function () {
    // Whichever lone message the list is showing, not a named one: earlier
    // specs archive, move and delete against the same mock server, so the
    // fixture a constant names may be gone by the time this file runs. (It
    // was: "Luke message 40" is missing from the list in a full-suite run.)
    await awaitSentMerged();
    const subject = await openALoneMessage();

    // Same entry point in the single viewer: the sender's address, not the row.
    await browser.execute(() => document.querySelector('[data-testid="sender-address"]')?.click());
    await prefilledReply('the sender address opened no prefilled reply');
    await clickSend();

    // Without In-Reply-To the copy threaded by subject alone, and the subject
    // fallback is scoped per account — which the INBOX row (unstamped) and the
    // Sent copy (stamped) answer differently, so the list grew a second row.
    const { rows } = await waitFor(
      () => rowsForScrolling(subject),
      (seen) => seen.rows.length === 1 && seen.rows[0] === 2,
      `the reply did not join "${subject}", the message it answered`,
      60_000,
      500,
    );
    expect(rows).toEqual([2]);
  });

  it('joins the open thread and its list row the moment it is sent', async function () {
    // At least FRAGMENTED_COUNT, not exactly: a previous run of this case left
    // its own reply on the server.
    const { rows: [startCount] } = await awaitSentMerged();
    await openThread(FRAGMENTED_SUBJECT);
    expect(await threadCountLine()).toBe(startCount);
    expect(await threadHeaderCount()).toBe(startCount);

    const answering = await newestMessageId();
    expect(answering).toBeTruthy();

    await replyToNewest();
    await clickSend();

    // The reader: the thread the user is looking at grows by one. Nothing
    // re-derived this snapshot before, so it stayed at five for ever.
    const thread = await waitFor(
      openThreadState,
      (t) => !!t && t.count === startCount + 1,
      'the reply never joined the open thread',
      60_000,
      500,
    );
    expect(thread.messageCount).toBe(startCount + 1);
    // It is there because it THREADS — one message answering the one that was
    // replied to — not because something appended it blindly.
    const answers = thread.emails.filter(e => e.inReplyTo === answering);
    expect(answers).toHaveLength(1);

    // The pane drew it, not just the store.
    await waitFor(
      threadHeaderCount,
      (n) => n === startCount + 1,
      'the thread pane never drew the extra message',
      30_000,
      500,
    );
    expect(await threadCountLine()).toBe(startCount + 1);

    // And the list: one row for the conversation, one message heavier — not a
    // second "Re: …" row beside it.
    const { rows } = await waitFor(
      () => rowsForScrolling(FRAGMENTED_SUBJECT),
      (seen) => seen.rows.length === 1 && seen.rows[0] === startCount + 1,
      'the list did not fold the reply into the conversation row',
      30_000,
      500,
    );
    expect(rows).toEqual([startCount + 1]);

    // The server round trip, which only became observable once the harness grew
    // an SMTP listener: Rust APPENDs the message to the account's Sent folder,
    // emits `send-server-append-complete`, and the frontend then drops its own
    // row and reloads the Sent headers — so what is left is the SERVER's copy.
    // Nothing verified this path before.
    const sent = await waitFor(
      sentRows,
      (rows) => rows.some(e => e.inReplyTo === answering && !e.optimistic),
      'the reply never came back from the server — the Sent APPEND or its header refresh did not land',
      90_000,
      1000,
    );
    // One copy, not two: the optimistic row is taken out, not left beside the
    // server's.
    expect(sent.filter(e => e.inReplyTo === answering)).toHaveLength(1);
  });

  it('claims nothing in Sent when the send fails', async function () {
    // The same real compose path, re-addressed at the one recipient the mock
    // SMTP server refuses: the message is archived to the vault, the send
    // fails, and the Sent list must stay out of it. Before this, the staged
    // copy sat in the conversation for the rest of the session,
    // indistinguishable from a message that had actually gone.
    await openThread(FRAGMENTED_SUBJECT);
    const startCount = await threadCountLine();
    expect(startCount).toBeGreaterThan(1);
    // What the earlier, delivered sends left behind — this case is about what
    // the FAILED one adds, which is nothing.
    const stagedBefore = await stagedRows();

    await replyToNewest();
    // Overwrite the prefilled recipient — a reply to the sender would go
    // through, and this case needs the send to fail.
    expect(await setField('compose-to', SEND_REFUSED_TO)).toBe(true);
    await clickSend();

    // The send is over once the outbox says so.
    await waitFor(
      () => browser.execute((sel) => !!document.querySelector(sel), ERROR_BUBBLE),
      (present) => present === true,
      'the failed send never produced an outbox error bubble',
      90_000,
      1000,
    );

    // Nothing was added: not to the store, not to the thread, not to the row.
    expect(await stagedRows()).toEqual(stagedBefore);
    expect(await threadCountLine()).toBe(startCount);
    expect(await threadHeaderCount()).toBe(startCount);
    expect(await fragmentRows()).toEqual([startCount]);
  });
});
