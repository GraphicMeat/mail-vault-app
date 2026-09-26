/**
 * E2E: new mail is on screen within seconds, and stays that way across a
 * dropped connection.
 *
 * The report: "it takes a while to download a new message. I want the
 * messages to be downloaded instantly, the moment they are received. I had to
 * close app and to reopen to see an email."
 *
 * The daemon log behind it: the IDLE connection dropped (a watcher replaced on
 * every OAuth token refresh, a DNS blip), and the new session never synced on
 * reconnect. Its IDLE baseline already counted the message that arrived while
 * it was gone, so no EXISTS ever came, and the message waited for the
 * 5-minute refresh or an app restart.
 *
 * Nothing is clicked here: no Refresh (it routes to activateAccount, so a spec
 * that clicks it tests nothing), no folder or account switch. The mock drops
 * the IDLE connection itself (`DropIdlers`, matched on the delivery's Subject),
 * so the second message really lands while the daemon is not listening.
 *
 * Yoda, dated 2020, cleaned up in `after`: the same reasons as
 * connected-idle-repaint.test.js, which this extends.
 */

import { ImapFlow } from 'imapflow';
import { MOCK_PASSWORD, DROP_IDLERS_MARKER } from './mockImap.js';
import { waitForApp, waitForEmails, switchToFolder, visibleRowSubjects } from './helpers.js';

const YODA = 'yoda@mock.test';
const YODA_SERVER = 2;          // MOCK_ACCOUNTS order: luke, vader, yoda

const INSTANT = 'Instant arrival into the open folder';
const AFTER_DROP = `${DROP_IDLERS_MARKER}, delivered on reconnect`;

const OLD_HEADER_DATE = 'Wed, 01 Jan 2020 12:00:00 +0000';
const OLD_INTERNAL_DATE = new Date('2020-01-01T12:00:00Z');

const rfc822 = (subject) => Buffer.from([
  'From: Postman <postman@mock.test>',
  `To: ${YODA}`,
  `Subject: ${subject}`,
  `Date: ${OLD_HEADER_DATE}`,
  `Message-ID: <${subject.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}@mock.test>`,
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  '',
  `${subject} - body`,
  '',
].join('\r\n'));

describe('New mail lands on its own, even across a dropped connection', function () {
  this.timeout(300_000);

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

  const activePair = () => browser.execute(() => {
    const s = window.__MAIL_STORE__?.getState?.();
    return s ? { accountId: s.activeAccountId, mailbox: s.activeMailbox, error: s.error || s.connectionError || null } : null;
  });

  let yodaId;

  before(async function () {
    await waitForApp();
    await waitForEmails();
    yodaId = (browser.mockAccounts || []).find((a) => a.email === YODA)?.id;
    expect(yodaId).toBeTruthy();
    // No daemon, no IDLE: nothing below would mean anything.
    await browser.waitUntil(async () =>
      (await browser.execute(() => window.__DB_PROBE__?.daemonHealth?.().alive)) === true, {
      timeout: 180_000, interval: 1_000, timeoutMsg: 'the daemon never came up',
    });
    // Local copies of ALL mail, not the default last 3 months: these messages
    // are dated 2020 (see above), and the daemon keeps an arrival's body under
    // the same window the app's own caching uses, read from the settings file
    // the app writes 500 ms after a change (safeStorage's debounce).
    await browser.execute(() => window.__SETTINGS_STORE__.getState().setLocalCacheDurationMonths(0));
    await browser.pause(1_500);
    // Settled: switchToFolder waits for two identical row reads, so anything
    // that appears after this is a push and not a load still in flight.
    await switchToFolder(YODA, 'INBOX');
  });

  after(async function () {
    for (const subject of [INSTANT, AFTER_DROP]) {
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
          console.warn(`[instant-arrival] could not purge "${subject}" from ${mailbox}:`, e.message);
        }
      }
    }
  });

  it('shows a new message within ten seconds, and keeps its body', async function () {
    expect((await visibleRowSubjects()).some((r) => r.includes(INSTANT))).toBe(false);
    const appended = await deliver(INSTANT);
    const uid = appended?.uid ?? (await uidsIn('INBOX', INSTANT))[0];
    expect(uid).toBeGreaterThan(0);

    await browser.waitUntil(async () => (await visibleRowSubjects()).some((r) => r.includes(INSTANT)), {
      timeout: 10_000, interval: 250,
      timeoutMsg: `"${INSTANT}" was not on screen within 10 s of arriving`,
    });

    // Downloaded, not only listed: the body is in the vault without the row
    // ever being opened.
    // executeAsync: `execute` does not await the probe's Promise.
    const saved = () => browser.executeAsync((id, u, done) => {
      window.__DB_PROBE__.isEmailSaved(id, 'INBOX', u).then(done, () => done(false));
    }, yodaId, uid);
    await browser.waitUntil(async () => (await saved()) === true, {
      timeout: 20_000, interval: 500,
      timeoutMsg: `the body of "${INSTANT}" never reached the vault`,
    });

    const pair = await activePair();
    expect(pair.accountId).toBe(yodaId);
    expect(pair.mailbox).toBe('INBOX');
    expect(pair.error).toBeNull();
  });

  it('shows a message that arrived while the IDLE connection was down', async function () {
    expect((await visibleRowSubjects()).some((r) => r.includes(AFTER_DROP))).toBe(false);
    // The mock drops the daemon's IDLE session first, then files this one:
    // the reconnected session's baseline already counts it, so no push is
    // ever sent for it.
    await deliver(AFTER_DROP);
    expect((await uidsIn('INBOX', AFTER_DROP)).length).toBe(1);

    // The watcher's first reconnect waits out a 30 s backoff; well under the
    // 5-minute scheduled refresh that used to be the only way back.
    await browser.waitUntil(async () => (await visibleRowSubjects()).some((r) => r.includes(AFTER_DROP)), {
      timeout: 90_000, interval: 1_000,
      timeoutMsg: `"${AFTER_DROP}" never appeared: the reconnected watcher did not catch up`,
    });

    const pair = await activePair();
    expect(pair.accountId).toBe(yodaId);
    expect(pair.mailbox).toBe('INBOX');
    expect(pair.error).toBeNull();
  });
});
