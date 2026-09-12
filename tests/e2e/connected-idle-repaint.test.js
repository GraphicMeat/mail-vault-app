/**
 * E2E: mail that arrives while the app is open has to land on the list by
 * itself.
 *
 * The report: "i see notification of email received, but the list does not
 * update, have to manually change email accounts. this happened in all
 * inboxes."
 *
 * Both halves of that are real and neither is visible from the unit suite,
 * which mocks the workflow the scheduler calls:
 *
 *  1. The daemon writes the new message's sidecar BEFORE it announces the
 *     change (sync_engine `write_cache_meta_full` then idle_watch
 *     `note_change`). So when the app reacts, the row is already on disk — and
 *     every reconcile exit in loadEmails compares the daemon's own post-sync
 *     uidNext/highestModseq against the server, finds them identical because
 *     the daemon made them so, and returns without reading a single cache ROW.
 *     Switching accounts worked because that empties `emails`, which is the one
 *     state that forces a cache read.
 *  2. In All Inboxes `activeMailbox` is the sentinel 'UNIFIED'. loadEmails has
 *     no reference to it anywhere, so the repaint walked on to SELECT
 *     "UNIFIED", failed, restored the previous rows and set an error.
 *
 * So the only question worth asking end to end is the user's: a message lands
 * out of band, and nothing is clicked. No Refresh, no folder click, no account
 * switch — the store's active pair is re-read at the end of each case to prove
 * the view never moved.
 *
 * ── What this depends on ──────────────────────────────────────────────────
 * The whole chain, with no test seam anywhere in it: mock IMAP holds the
 * daemon's connection in IDLE, another client APPENDs, the mock pushes EXISTS,
 * the daemon syncs and notes the change, the app's parked `sync.events` long
 * poll returns it, and the scheduler repaints. `daemonHealth().alive` is the
 * anti-vacuity guard — without a daemon there is no IDLE and nothing below
 * proves anything.
 *
 * ── Why yoda ──────────────────────────────────────────────────────────────
 * Its INBOX count is asserted nowhere (wdio.conf.js), and its slow MOVE/EXPUNGE
 * only cost this file its cleanup. Both messages carry a 2020 date, far outside
 * the fixture range (mockImap `stamp()` dates fixtures 2026 onward), so they
 * sort to the BOTTOM of every list — a message this file somehow strands
 * displaces no row any other spec reads. `after` expunges them anyway.
 */

import { ImapFlow } from 'imapflow';
import { MOCK_PASSWORD } from './mockImap.js';
import { waitForApp, waitForEmails, switchToFolder, visibleRowSubjects } from './helpers.js';

const YODA = 'yoda@mock.test';
const YODA_SERVER = 2;          // MOCK_ACCOUNTS order: luke, vader, yoda

const PUSHED_SINGLE = 'Daemon push into the open folder';
const PUSHED_UNIFIED = 'Daemon push into All Inboxes';

const OLD_HEADER_DATE = 'Wed, 01 Jan 2020 12:00:00 +0000';
const OLD_INTERNAL_DATE = new Date('2020-01-01T12:00:00Z');

const rfc822 = (subject) => Buffer.from([
  'From: Postman <postman@mock.test>',
  `To: ${YODA}`,
  `Subject: ${subject}`,
  `Date: ${OLD_HEADER_DATE}`,
  `Message-ID: <${subject.replace(/\s+/g, '-').toLowerCase()}@mock.test>`,
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  '',
  `${subject} - body`,
  '',
].join('\r\n'));

describe('New mail repaints the open list without an account switch', function () {
  this.timeout(300_000);

  // ── The server, behind the app's back ──────────────────────────────────

  async function withYoda(fn) {
    const { host, port } = browser.mockImap[YODA_SERVER];
    const client = new ImapFlow({
      host, port, secure: false, auth: { user: YODA, pass: MOCK_PASSWORD }, logger: false,
    });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.logout();
    }
  }

  /** Deliver `subject` to yoda's INBOX as another client would. */
  const deliver = (subject) => withYoda(async (client) => {
    const lock = await client.getMailboxLock('INBOX');
    try {
      return await client.append('INBOX', rfc822(subject), [], OLD_INTERNAL_DATE);
    } finally {
      lock.release();
    }
  });

  const uidsIn = (mailbox, subject) => withYoda(async (client) => {
    const lock = await client.getMailboxLock(mailbox);
    try {
      return await client.search({ subject }, { uid: true });
    } finally {
      lock.release();
    }
  });

  // ── The app ────────────────────────────────────────────────────────────

  const activePair = () => browser.execute(() => {
    const s = window.__MAIL_STORE__?.getState?.();
    return s ? {
      accountId: s.activeAccountId,
      mailbox: s.activeMailbox,
      unified: !!s.unifiedInbox,
      error: s.error || s.connectionError || null,
    } : null;
  });

  /** Subjects of the rows the list is built from, window or no window. */
  const listedSubjects = () => browser.execute(() =>
    (window.__MAIL_STORE__.getState().sortedEmails || []).map((e) => e.subject || ''));

  /**
   * Wait for `subject` to arrive in `read()`, touching nothing.
   *
   * The timeout is far below the 5-minute scheduled refresh, so nothing here
   * can be delivered by the refresh timer instead of by the daemon's push.
   */
  async function waitForPushed(subject, read, label) {
    await browser.waitUntil(async () => (await read()).some((r) => r.includes(subject)), {
      timeout: 150_000,
      interval: 1_000,
      timeoutMsg: `"${subject}" never reached ${label} on its own. `
        + 'The daemon announced the change and the row was already in its cache; '
        + 'the repaint either reconciled against the server and returned "nothing changed" '
        + 'without reading a cache row, or (All Inboxes) tried to SELECT the "UNIFIED" sentinel.',
    });
  }

  let yodaId;

  before(async function () {
    await waitForApp();
    await waitForEmails();
    yodaId = (browser.mockAccounts || []).find((a) => a.email === YODA)?.id;
    expect(yodaId).toBeTruthy();
  });

  after(async function () {
    // The one place in the run allowed to destroy these. Leaving either behind
    // hands the next spec file a mailbox it did not expect.
    for (const subject of [PUSHED_SINGLE, PUSHED_UNIFIED]) {
      for (const mailbox of ['INBOX', 'Trash']) {
        try {
          const uids = await uidsIn(mailbox, subject);
          if (!uids.length) continue;
          await withYoda(async (client) => {
            const lock = await client.getMailboxLock(mailbox);
            try {
              await client.messageDelete(uids, { uid: true });
            } finally {
              lock.release();
            }
          });
        } catch (e) {
          console.warn(`[idle-repaint] could not purge "${subject}" from ${mailbox}:`, e.message);
        }
      }
    }
  });

  it('has a daemon in this run, so the cases below mean something', async function () {
    // The heartbeat spawns the daemon on its first tick and backs off
    // 5s → 10s → 20s → 40s → 60s, so "alive" arrives seconds into the session.
    await browser.waitUntil(async () =>
      (await browser.execute(() => window.__DB_PROBE__?.daemonHealth?.().alive)) === true, {
      timeout: 180_000,
      interval: 1_000,
      timeoutMsg: 'the daemon never came up, so no account is held in IDLE and nothing below '
        + 'exercises the push at all. `npm run test:e2e` builds target/debug/mailvault-daemon; '
        + 'a bare `wdio run` on a tree that never built it will not.',
    });
  });

  it('lands a message that arrives in the open folder', async function () {
    // Settled first: switchToFolder waits for two identical row reads, so
    // anything that appears after this point is the push and not a load that
    // was still in flight.
    await switchToFolder(YODA, 'INBOX');
    const before = await visibleRowSubjects();
    expect(before.some((r) => r.includes(PUSHED_SINGLE))).toBe(false);

    const appended = await deliver(PUSHED_SINGLE);
    expect(appended?.uid ?? (await uidsIn('INBOX', PUSHED_SINGLE))[0]).toBeGreaterThan(0);

    // The DOM, not the store: yoda's INBOX is ten rows, so every one of them is
    // rendered and "it is in the store" and "it is on screen" are the same
    // claim here.
    await waitForPushed(PUSHED_SINGLE, visibleRowSubjects, "yoda's INBOX");

    // Nothing was clicked: the view is exactly where it was, and the repaint
    // did not leave an error behind.
    const pair = await activePair();
    expect(pair.accountId).toBe(yodaId);
    expect(pair.mailbox).toBe('INBOX');
    expect(pair.error).toBeNull();
  });

  it('lands a message that arrives while All Inboxes is open', async function () {
    await browser.execute(() => document.querySelector('[data-testid="all-inboxes-btn"]')?.click());
    await browser.waitUntil(async () => (await activePair())?.unified === true, {
      timeout: 30_000, interval: 300, timeoutMsg: 'All Inboxes never became the active view',
    });
    await waitForEmails();
    // Two identical reads — the unified load merges three accounts' disk caches
    // in chunks, so a single read can catch it mid-fill.
    let previous = null;
    await browser.waitUntil(async () => {
      const current = JSON.stringify(await listedSubjects());
      const settled = current === previous;
      previous = current;
      return settled;
    }, { timeout: 30_000, interval: 500, timeoutMsg: 'All Inboxes never settled' });
    expect((await listedSubjects()).some((r) => r.includes(PUSHED_UNIFIED))).toBe(false);

    const appended = await deliver(PUSHED_UNIFIED);
    expect(appended?.uid ?? (await uidsIn('INBOX', PUSHED_UNIFIED))[0]).toBeGreaterThan(0);

    // The store, not the DOM, and only here: All Inboxes is ~710 rows across
    // three accounts and the list is virtualized, so a message dated 2020 is
    // real, merged and sorted — and outside the rendered window by six hundred
    // rows. Dating it newest instead would put it on screen and at the top of
    // every later spec's All Inboxes if this file's cleanup ever failed, which
    // is a worse trade than reading the array the list renders from.
    await waitForPushed(PUSHED_UNIFIED, listedSubjects, 'All Inboxes');

    // 'UNIFIED' is a sentinel, not a mailbox. A repaint that tried to SELECT it
    // would have failed and restored the previous rows behind an error.
    const pair = await activePair();
    expect(pair.unified).toBe(true);
    expect(pair.error).toBeNull();
  });
});
