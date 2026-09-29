/**
 * E2E: a flag another client changes has to reach the open list by itself.
 *
 * A message read or starred on another device is synced by the daemon: its
 * flag step patches the header cache and writes the mailbox's new modseq
 * BEFORE it announces the change. The app's reload compares that modseq with
 * the server's, finds them equal (condstore-noop) and returned without
 * reading one cached row, and the drain only adds uids the store lacks. So the
 * open folder kept the old flags until the user switched folders.
 *
 * The only question worth asking end to end is the user's: another client
 * flips \Seen, and nothing is clicked. The store's active pair is re-read at
 * the end to prove the view never moved.
 *
 * ── What this depends on ──────────────────────────────────────────────────
 * The whole chain, as in connected-idle-repaint.test.js: mock IMAP holds the
 * daemon's connection in IDLE, another client STOREs, the mock pushes the
 * FETCH, the daemon syncs the flags and notes the change (`updatedFlags`),
 * the app's `sync.events` long poll returns it, and the scheduler reloads.
 * The message is dated 2020 so it sorts to the bottom of yoda's INBOX and
 * displaces no row another spec reads; `after` expunges it.
 */

import { ImapFlow } from 'imapflow';
import { MOCK_PASSWORD } from './mockImap.js';
import { waitForApp, waitForEmails, switchToFolder } from './helpers.js';

const YODA = 'yoda@mock.test';
const YODA_SERVER = 2;          // MOCK_ACCOUNTS order: luke, vader, yoda
const SUBJECT = 'Flag flipped by another client';

const rfc822 = Buffer.from([
  'From: Postman <postman@mock.test>',
  `To: ${YODA}`,
  `Subject: ${SUBJECT}`,
  'Date: Wed, 01 Jan 2020 12:00:00 +0000',
  `Message-ID: <${SUBJECT.replace(/\s+/g, '-').toLowerCase()}@mock.test>`,
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  '',
  `${SUBJECT} - body`,
  '',
].join('\r\n'));

describe('A flag another client changes repaints the open list', function () {
  this.timeout(300_000);

  async function inYodaInbox(fn) {
    const { host, port } = browser.mockImap[YODA_SERVER];
    const client = new ImapFlow({
      host, port, secure: false, auth: { user: YODA, pass: MOCK_PASSWORD }, logger: false,
    });
    await client.connect();
    try {
      const lock = await client.getMailboxLock('INBOX');
      try {
        return await fn(client);
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
  }

  const rowFlags = () => browser.execute((subject) => {
    const s = window.__MAIL_STORE__.getState();
    const row = (s.emails || []).find((e) => (e.subject || '') === subject);
    return row ? row.flags || [] : null;
  }, SUBJECT);

  const activePair = () => browser.execute(() => {
    const s = window.__MAIL_STORE__.getState();
    return { accountId: s.activeAccountId, mailbox: s.activeMailbox, error: s.error || s.connectionError || null };
  });

  /** Wait for the row's \Seen to match `seen`, touching nothing. */
  const waitForSeen = (seen) => browser.waitUntil(async () => {
    const flags = await rowFlags();
    return !!flags && flags.includes('\\Seen') === seen;
  }, {
    // Far below the 5-minute scheduled refresh: only the daemon's push can land it.
    timeout: 150_000,
    interval: 1_000,
    timeoutMsg: `the row never ${seen ? 'became read' : 'went back to unread'} on its own. `
      + 'The daemon synced the flag into its cache and announced it (updatedFlags); '
      + 'the reload compared modseq with the server, found nothing changed and read no cache row.',
  });

  let yodaId;
  let uid;

  before(async function () {
    await waitForApp();
    await waitForEmails();
    yodaId = (browser.mockAccounts || []).find((a) => a.email === YODA)?.id;
    expect(yodaId).toBeTruthy();
  });

  after(async function () {
    try {
      await inYodaInbox(async (client) => {
        const uids = await client.search({ subject: SUBJECT }, { uid: true });
        if (uids.length) await client.messageDelete(uids, { uid: true });
      });
    } catch (e) {
      console.warn('[flag-sync-repaint] could not purge the message:', e.message);
    }
  });

  it('has a daemon in this run, so the cases below mean something', async function () {
    await browser.waitUntil(async () =>
      (await browser.execute(() => window.__DB_PROBE__?.daemonHealth?.().alive)) === true, {
      timeout: 180_000,
      interval: 1_000,
      timeoutMsg: 'the daemon never came up, so no account is held in IDLE and nothing below exercises the push',
    });
  });

  it('lists an unread message in the open folder', async function () {
    await switchToFolder(YODA, 'INBOX');
    uid = (await inYodaInbox((client) => client.append('INBOX', rfc822, [], new Date('2020-01-01T12:00:00Z'))))?.uid;
    expect(uid).toBeGreaterThan(0);

    await browser.waitUntil(async () => (await rowFlags()) !== null, {
      timeout: 150_000, interval: 1_000, timeoutMsg: 'the delivered message never reached the open list',
    });
    expect(await rowFlags()).not.toContain('\\Seen');
  });

  it('shows it read after another client reads it, without a folder switch', async function () {
    await inYodaInbox((client) => client.messageFlagsAdd(uid, ['\\Seen'], { uid: true }));

    await waitForSeen(true);

    const pair = await activePair();
    expect(pair.accountId).toBe(yodaId);
    expect(pair.mailbox).toBe('INBOX');
    expect(pair.error).toBeNull();
  });

  it('shows it unread again after another client marks it unread', async function () {
    await inYodaInbox((client) => client.messageFlagsRemove(uid, ['\\Seen'], { uid: true }));

    await waitForSeen(false);

    expect((await activePair()).mailbox).toBe('INBOX');
  });
});
