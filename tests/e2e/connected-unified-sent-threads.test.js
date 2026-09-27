/**
 * E2E: All inboxes threads show the replies you sent, from every account.
 *
 * Reported 2026-09-27: "All inboxes in threads view does not display sent
 * replies; a specific account's mailbox does." The INBOX+Sent merge was gated
 * on the literal `activeMailbox === 'INBOX'` (All inboxes is 'UNIFIED'), the
 * unified load never read any account's Sent, and everything that filled
 * `sentEmails` did it for the ACTIVE account only. A reply sent from another
 * account in All inboxes showed as its staged copy and then vanished when the
 * Sent APPEND reconciled it.
 *
 * The mirror of two single-account specs, in All inboxes with a DIFFERENT
 * account active than the one the conversation belongs to:
 *   - connected-thread-bodies: the cross-folder conversation (INBOX message,
 *     Sent reply on a uid INBOX also holds) reads as one thread with both
 *     bodies from their own folders;
 *   - connected-thread-reply: a reply sent from inside the thread joins it and
 *     is still there after the server copy replaces the staged one.
 *
 * Harness facts this leans on:
 *  - Only luke carries the thread fixtures (vader and yoda set
 *    `crossFolderThread: false`), so every conversation named here is luke's.
 *    yoda is made the active account: its 9 messages are cheap to open, and
 *    it makes luke the NON-active account the report is about.
 *  - vader's 700 messages are newer than luke's thread fixtures, so in the
 *    unified list those threads sit hundreds of rows down a virtualized list:
 *    every lookup walks the list rather than reading the first screen.
 *  - A delivered reply is APPENDed to luke's Sent on the mock server, which
 *    outlives this file; `trackMailbox` puts it back afterwards, and counts are
 *    read before the send and asserted as +1.
 *  - `expect(value, 'message')` throws in this runner: one argument only.
 */

import { waitForApp, waitForEmails, switchToFolder } from './helpers.js';
import {
  CROSS_FOLDER_SUBJECT, CROSS_FOLDER_INBOX_BODY, CROSS_FOLDER_SENT_BODY,
  FRAGMENTED_SUBJECT, FRAGMENTED_COUNT, trackMailbox,
} from './mockImap.js';
import { modalOpen, fieldValue, closeComposeHard, settingsCall } from './composeHelpers.js';

const LUKE = 'luke@mock.test';
const YODA = 'yoda@mock.test';

const accountIdOf = (email) => (browser.mockAccounts || []).find((a) => a.email === email)?.id || null;

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

/** Where the store is, and what it has merged — for failure messages worth reading. */
const storeView = () => browser.execute(() => {
  const s = window.__MAIL_STORE__?.getState?.();
  if (!s) return null;
  return {
    accountId: s.activeAccountId,
    mailbox: s.activeMailbox,
    unifiedFolder: s.unifiedFolder,
    sentByAccount: (s.sentEmails || []).reduce((acc, e) => {
      acc[e._accountId || '?'] = (acc[e._accountId || '?'] || 0) + 1;
      return acc;
    }, {}),
  };
});

/** The thread count of every visible row carrying `subject`. */
const rowsFor = (subject) => browser.execute((subj) =>
  [...document.querySelectorAll('[data-testid="email-row"]')]
    .filter(r => r.offsetHeight > 0 && (r.textContent || '').includes(subj))
    .map(r => Number(r.getAttribute('data-thread-count') || 1)), subject);

/**
 * Scroll the message list by most of a screen, wrapping at the bottom.
 *
 * Anchored on a row rather than picked by size: with a thread open the reading
 * pane is also a tall scroller, and the sidebar scrolls too. Walking forward
 * (not toggling between the top and one screen down) is what reaches a row
 * hundreds of rows down.
 */
const scrollListStep = () => browser.execute(() => {
  let el = document.querySelector('[data-testid="email-row"]')?.parentElement || null;
  while (el && el.scrollHeight <= el.clientHeight + 4) el = el.parentElement;
  if (!el) return;
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
  el.scrollTop = atBottom ? 0 : el.scrollTop + Math.round(el.clientHeight * 0.8);
});

/** `rowsFor`, walking the list until the subject shows up. */
async function rowsForScrolling(subject) {
  const rows = await rowsFor(subject);
  if (!rows.length) await scrollListStep();
  return { rows, store: rows.length ? null : await storeView() };
}

/** Walk the list to the one thread row for `subject` holding at least `min` messages. */
const findThreadRow = (subject, min, timeout = 120_000) => waitFor(
  () => rowsForScrolling(subject),
  (seen) => seen.rows.length === 1 && seen.rows[0] >= min,
  `All inboxes never showed "${subject}" as one thread of ${min}+ messages`,
  timeout,
  400,
);

/** The "N messages in thread" line, or null. */
const threadCountLine = () => browser.execute(() => {
  const m = (document.body.textContent || '').match(/(\d+) messages? in thread/);
  return m ? Number(m[1]) : null;
});

/** Click the (already on screen) thread row for `subject` and wait for the thread view. */
async function openThread(subject) {
  await waitFor(
    async () => {
      await browser.execute((subj) => {
        const row = [...document.querySelectorAll('[data-testid="email-row"]')]
          .find(r => r.offsetHeight > 0
            && Number(r.getAttribute('data-thread-count') || 1) > 1
            && (r.textContent || '').includes(subj));
        row?.click();
      }, subject);
      return threadCountLine();
    },
    (line) => line !== null,
    `clicking the "${subject}" thread row opened no thread view`,
    30_000,
    1000,
  );
}

/**
 * Expand every message in the open thread and return their rendered bodies.
 * Clicks only the ones showing neither a body nor a spinner: the newest starts
 * expanded, and clicking it blindly would fold it.
 */
async function readThreadBodies() {
  const expandAll = () => browser.execute(() => {
    for (const header of document.querySelectorAll('[data-testid="thread-email-header"]')) {
      const item = header.parentElement;
      const busy = item.querySelector('.email-content, iframe, .animate-spin');
      if (!busy && header.offsetHeight > 0) header.querySelector('[data-testid="header-toggle"]')?.click();
    }
  });
  const bodies = () => browser.execute(() => ({
    headers: document.querySelectorAll('[data-testid="thread-email-header"]').length,
    texts: [...document.querySelectorAll('.email-content')]
      .map(b => (b.textContent || '').trim())
      .filter(Boolean),
  }));

  const seen = await waitFor(
    async () => { await expandAll(); return bodies(); },
    ({ headers, texts }) => headers > 0 && texts.length >= headers,
    'not every thread message rendered a body',
    45_000,
    1500,
  );
  return seen.texts;
}

/**
 * The open thread as the STORE holds it, with where each message lives. A
 * delivered reply starts as the staged copy and is REPLACED by the server's,
 * so nothing here filters on the staged flag.
 */
const openThreadState = () => browser.execute(() => {
  const t = window.__MAIL_STORE__?.getState?.().selectedThread;
  if (!t) return null;
  return {
    count: t.emails.length,
    emails: t.emails.map(e => ({
      uid: e.uid,
      account: e._accountId || null,
      mailbox: e._mailbox || null,
      inReplyTo: e.inReplyTo || null,
      optimistic: !!e._optimistic,
    })),
  };
});

/** Every Sent row the store holds, with its account. */
const sentRows = () => browser.execute(() => (window.__MAIL_STORE__?.getState?.().sentEmails || [])
  .map(e => ({ uid: e.uid, account: e._accountId || null, inReplyTo: e.inReplyTo || null, optimistic: !!e._optimistic })));

/** The Message-ID of the newest message in the open thread. */
const newestMessageId = () => browser.execute(() => {
  const t = window.__MAIL_STORE__?.getState?.().selectedThread;
  return t?.emails?.[t.emails.length - 1]?.messageId || null;
});

describe('All inboxes threads show the replies you sent', function () {
  this.timeout(360_000);

  let restoreSent;

  before(async function () {
    await waitForApp();
    await waitForEmails();
    // Send now: the undo window would only delay what these cases read.
    await settingsCall('setSendDelay', 0);
    // Watermark luke's Sent folder before anything is sent into it.
    restoreSent = await trackMailbox(browser.mockImap[0], 'Sent');

    // luke is the account the conversations belong to; make it NOT the
    // active one. Visiting yoda also leaves its headers cached for the list.
    await switchToFolder(YODA, 'INBOX');

    // The sidebar's All inboxes entry, the way a person gets there.
    expect(await browser.execute(() => {
      const btn = document.querySelector('[data-testid="all-inboxes-btn"]');
      if (!btn || btn.offsetHeight === 0) return false;
      btn.click();
      return true;
    })).toBe(true);
    await waitFor(
      storeView,
      (s) => s?.mailbox === 'UNIFIED' && (s.unifiedFolder || 'INBOX') === 'INBOX',
      'never entered All inboxes',
      30_000,
      300,
    );
    await waitForEmails();
    // Precondition: luke is not the active account, or this proves nothing
    // the single-account specs do not already.
    expect((await storeView()).accountId).toBe(accountIdOf(YODA));
  });

  afterEach(async function () {
    await closeComposeHard();
  });

  after(async function () {
    await restoreSent?.();
    // Leave single-account INBOX behind for the specs that follow.
    try { await switchToFolder(LUKE, 'INBOX'); } catch { /* next spec resets anyway */ }
  });

  it('threads another account\'s Sent reply in, each body from its own folder', async function () {
    await findThreadRow(CROSS_FOLDER_SUBJECT, 2);
    await openThread(CROSS_FOLDER_SUBJECT);

    // The reply is luke's, from luke's Sent — not the active account's.
    const thread = await waitFor(openThreadState, (t) => !!t && t.count >= 2, 'the thread holds no reply');
    expect(thread.emails.some(e => e.account === accountIdOf(LUKE) && e.mailbox === 'Sent')).toBe(true);

    const joined = (await readThreadBodies()).join('\n');
    expect(joined).toContain(CROSS_FOLDER_INBOX_BODY);
    expect(joined).toContain(CROSS_FOLDER_SENT_BODY);
    // The Sent reply sits on a uid luke's INBOX also holds; that message's
    // body must not appear anywhere in this thread.
    expect(joined).not.toContain('Body of mock message');
  });

  it('keeps a reply sent from a non-active account in its thread after the server copy lands', async function () {
    const { rows: [startCount] } = await findThreadRow(FRAGMENTED_SUBJECT, FRAGMENTED_COUNT);
    await openThread(FRAGMENTED_SUBJECT);
    expect(await threadCountLine()).toBe(startCount);

    const answering = await newestMessageId();
    expect(answering).toBeTruthy();

    // Reply from the newest message's sender address: a click on the header
    // row itself folds it (see connected-reply-entry-points).
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
      'the sender address opened no prefilled reply',
      30_000,
      300,
    );
    expect(await browser.execute(() => {
      const btn = document.querySelector('[data-testid="compose-send"]');
      if (!btn) return false;
      btn.click();
      return true;
    })).toBe(true);

    // The staged copy joins at once.
    await waitFor(
      openThreadState,
      (t) => !!t && t.count === startCount + 1,
      'the reply never joined the open thread',
      60_000,
    );

    // The server round trip: luke's Sent APPEND lands, the staged row is taken
    // out and luke's Sent headers are reloaded. This is where the reply used to
    // vanish: the reload refused any account but the active one.
    const sent = await waitFor(
      sentRows,
      (rows) => rows.some(e => e.inReplyTo === answering && !e.optimistic),
      'luke\'s server copy of the reply never reached the store',
      90_000,
      1000,
    );
    const mine = sent.filter(e => e.inReplyTo === answering);
    expect(mine).toHaveLength(1);
    expect(mine[0].account).toBe(accountIdOf(LUKE));

    // Hold across the later refreshes too (the delayed Sent reload, the
    // pipeline's Sent sync, the unified list's own reload).
    await browser.pause(12_000);

    const thread = await waitFor(
      openThreadState,
      (t) => !!t && t.count === startCount + 1 && t.emails.some(e => e.inReplyTo === answering && !e.optimistic),
      'the reply left the open thread once its server copy replaced the staged one',
      30_000,
    );
    expect(thread.emails.filter(e => e.inReplyTo === answering)).toHaveLength(1);
    expect(await threadCountLine()).toBe(startCount + 1);

    // And the list: one row for the conversation, one message heavier.
    const { rows } = await findThreadRow(FRAGMENTED_SUBJECT, startCount + 1, 60_000);
    expect(rows).toEqual([startCount + 1]);
  });
});
