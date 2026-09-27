/**
 * E2E: the thread reader honours the mark-as-read delay, per expanded message.
 *
 * The single-message reader marks what it opens after markAsReadDelay; the
 * thread reader used to mark nothing at all, whatever the setting said. Now
 * each expanded unread message runs its own countdown, folding it first
 * cancels it, and opening another thread cancels every countdown of the last.
 * Unit matrix: src/services/workflows/__tests__/threadReadState.test.js; this
 * is cases 1, 3, 4 and 6 against the real app and the mock IMAP server.
 *
 * Fixtures: LONG_SUBJECT (two INBOX messages) and FRAGMENTED_SUBJECT (three
 * INBOX messages plus two Sent replies, the newest an INBOX one). Both ship
 * \Seen, so each test marks them unread first through the app's own bulk
 * path, which reaches the server; `after` puts them back read for the specs
 * that share this mock server.
 */

import { waitForApp, waitForEmails } from './helpers.js';
import { LONG_SUBJECT, FRAGMENTED_SUBJECT } from './mockImap.js';

const DELAY_MS = 3000;

describe('Thread reader mark-as-read delay', function () {
  this.timeout(240_000);

  /** INBOX rows of one conversation, oldest first, with their read state. */
  const members = (subject) => browser.execute((subj) => {
    const state = window.__MAIL_STORE__.getState();
    return (state.emails || [])
      .filter(e => (e.subject || '').includes(subj))
      .sort((a, b) => new Date(a.date) - new Date(b.date))
      .map(e => ({ uid: e.uid, seen: !!e.flags?.includes('\\Seen') }));
  }, subject);

  const setRead = async (subject, read) => {
    const outcome = await browser.executeAsync((subj, on, done) => {
      const state = window.__MAIL_STORE__.getState();
      const rows = (state.emails || []).filter(e => (e.subject || '').includes(subj));
      if (!rows.length) { done(`no rows for ${subj}`); return; }
      state.setEmailsSelected(rows, true);
      const run = on ? state.markSelectedAsRead() : state.markSelectedAsUnread();
      Promise.resolve(run).then(() => done('ok'), (error) => done(String(error?.message || error)));
    }, subject, read);
    expect(outcome).toBe('ok');
    await browser.waitUntil(async () => (await members(subject)).every(m => m.seen === read), {
      timeout: 20_000, interval: 300, timeoutMsg: `"${subject}" never became ${read ? 'read' : 'unread'}`,
    });
  };

  const closeReader = () => browser.execute(() => window.__MAIL_STORE__.getState().closeEmail());

  const openThread = async (subject) => {
    await browser.waitUntil(async () => browser.execute((subj) => {
      const row = [...document.querySelectorAll('[data-testid="email-row"]')]
        .find(node => node.offsetHeight && Number(node.dataset.threadCount) > 1 && node.textContent.includes(subj));
      if (!row) return false;
      row.click();
      return true;
    }, subject), { timeout: 45_000, interval: 500, timeoutMsg: `no thread row for "${subject}"` });
    await browser.waitUntil(async () => browser.execute((subj) =>
      window.__MAIL_STORE__.getState().selectedThread?.subject?.includes(subj), subject),
    { timeout: 15_000, timeoutMsg: `"${subject}" never opened as a thread` });
    await $('.thread-reader [data-testid="thread-email-header"]').waitForExist({ timeout: 15_000 });
  };

  /** Click the header of the thread's index-th message, oldest first. */
  const toggle = (index) => browser.execute((i) => {
    const header = document.querySelectorAll('.thread-reader [data-testid="thread-email-header"]')[i];
    if (!header) return false;
    header.click();
    return true;
  }, index);

  const waitSeen = (subject, index, msg) => browser.waitUntil(
    async () => (await members(subject))[index]?.seen === true,
    { timeout: 15_000, interval: 250, timeoutMsg: msg },
  );

  before(async function () {
    await waitForApp();
    await waitForEmails();
    // The page callback cannot see this file's constants: the delay goes in as an argument.
    await browser.execute((seconds) => window.__SETTINGS_STORE__.setState({
      threadMode: 'grouped', threadReaderLayout: 'timeline', threadSortOrder: 'oldest-first',
      markAsReadMode: 'delay', markAsReadDelay: seconds,
    }), DELAY_MS / 1000);
  });

  beforeEach(async () => {
    await closeReader();
  });

  after(async () => {
    await closeReader();
    await setRead(LONG_SUBJECT, true);
    await setRead(FRAGMENTED_SUBJECT, true);
  });

  it('marks the open newest message after the delay, and no folded one', async () => {
    await setRead(LONG_SUBJECT, false);
    await openThread(LONG_SUBJECT);

    // Not straight away: that is the delay.
    await browser.pause(1000);
    expect((await members(LONG_SUBJECT)).map(m => m.seen)).toEqual([false, false]);

    await waitSeen(LONG_SUBJECT, 1, 'the open newest message was never marked read');
    await browser.pause(DELAY_MS);
    expect((await members(LONG_SUBJECT))[0].seen).toBe(false);
  });

  it('marks an older message the user expands after its own delay', async () => {
    await setRead(LONG_SUBJECT, false);
    await openThread(LONG_SUBJECT);

    expect(await toggle(0)).toBe(true);
    await waitSeen(LONG_SUBJECT, 0, 'the expanded older message was never marked read');
    await waitSeen(LONG_SUBJECT, 1, 'the open newest message was never marked read');
  });

  it('folding a message before its delay ends keeps it unread', async () => {
    await setRead(LONG_SUBJECT, false);
    await openThread(LONG_SUBJECT);

    expect(await toggle(0)).toBe(true);
    await browser.pause(1000);
    expect(await toggle(0)).toBe(true);

    await waitSeen(LONG_SUBJECT, 1, 'the open newest message was never marked read');
    await browser.pause(DELAY_MS);
    expect((await members(LONG_SUBJECT))[0].seen).toBe(false);
  });

  it('opening another thread before the delay cancels the first thread\'s countdowns', async () => {
    await setRead(LONG_SUBJECT, false);
    await setRead(FRAGMENTED_SUBJECT, false);
    await openThread(LONG_SUBJECT);
    expect(await toggle(0)).toBe(true);

    await browser.pause(1000);
    await openThread(FRAGMENTED_SUBJECT);

    // The second thread's newest message runs its own countdown...
    const fragNewest = (await members(FRAGMENTED_SUBJECT)).length - 1;
    await waitSeen(FRAGMENTED_SUBJECT, fragNewest, 'the second thread\'s open message was never marked read');
    // ...and the first thread's never finished theirs.
    await browser.pause(DELAY_MS);
    expect((await members(LONG_SUBJECT)).map(m => m.seen)).toEqual([false, false]);
  });
});
