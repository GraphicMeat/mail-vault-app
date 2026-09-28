/**
 * E2E: Snooze on a server that will not host a Snoozed folder.
 *
 * The contract (src/services/workflows/snooze.js, `ensure_snoozed_mailbox` in
 * src-core/src/imap/mod.rs, src-daemon/src/snooze_worker.rs): when the server
 * refuses both CREATEs, `snooze.ensure_folder` fails with
 * `E_SNOOZE_FOLDER_REFUSED:` and the app snoozes on this computer. Nothing
 * moves, the daemon row's `snoozedMailbox` is empty, and the list holds the
 * message out of INBOX until the row wakes. The wake clears `\Seen` where the
 * message already is.
 *
 * The server's personal namespace is `Mail/` while its delimiter is '.', so
 * the root `Snoozed` and the retry `INBOX.Snoozed` both fall outside it: both
 * are refused and nothing is created. That fixture needs its own server, and
 * a fourth account for this file only, the way
 * connected-folder-dovecot-inbox.test.js does it: a refusal on a shared
 * account would reach every other spec that snoozes.
 *
 * The wake is forced the way connected-snooze.test.js forces it: the row is
 * rescheduled over `daemon_rpc` to a few seconds out and the worker's own
 * timer does the rest.
 */

import { ImapFlow } from 'imapflow';
import { waitForApp, waitForEmails, pressKey } from './helpers.js';
import { invoke } from './composeHelpers.js';
import { startMockImap, mailbox, mockAccount, MOCK_PASSWORD } from './mockImap.js';

const OWNER = 'local-snooze@mock.test';
// Ids must be 36-char UUIDs: db/emails.js parses local ids with a 36-char prefix.
const ACCOUNT_ID = '55555555-5555-4555-8555-555555555555';
const MESSAGE_ID = `<snooze-local-e2e-${Date.now()}@mock.test>`;
const SUBJECT = `Snooze me here ${Date.now()}`;

const LOCAL_SNOOZE_STATE = {
  delimiter: '.',
  personal_namespace: 'Mail/',
  mailboxes: [
    mailbox('INBOX', 2, { owner: OWNER, attrs: ['\\HasNoChildren'], subjectPrefix: 'Local snooze inbox' }),
    mailbox('Sent', 0, { owner: OWNER, attrs: ['\\HasNoChildren', '\\Sent'] }),
    mailbox('Trash', 0, { owner: OWNER, attrs: ['\\HasNoChildren', '\\Trash'] }),
  ],
};

describe('Snooze on a server with no room for a Snoozed folder', function () {
  this.timeout(180_000);

  let server;
  let accountId;

  async function withOwner(fn) {
    const client = new ImapFlow({ host: server.host, port: server.port, secure: false, auth: { user: OWNER, pass: MOCK_PASSWORD }, logger: false });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.logout();
    }
  }

  /** `{uid, seen}` of our message in `mailbox`, or null. */
  const locate = (mailboxName) => withOwner(async (client) => {
    const lock = await client.getMailboxLock(mailboxName);
    try {
      const uids = await client.search({ header: { 'message-id': MESSAGE_ID } }, { uid: true });
      if (!uids?.length) return null;
      const msg = await client.fetchOne(String(uids[0]), { flags: true }, { uid: true });
      return { uid: uids[0], seen: msg.flags.has('\\Seen') };
    } finally {
      lock.release();
    }
  });

  const rpc = async (method, params) => {
    const r = await invoke('daemon_rpc', { method, params });
    if (!r.ok) throw new Error(`${method}: ${r.error}`);
    return r.value;
  };
  const ourRow = async () => (await rpc('snooze.list', {})).find((row) => row.messageId === MESSAGE_ID) || null;

  const listed = () => browser.execute((s) =>
    [...document.querySelectorAll('[data-testid="email-row"]')].some((r) => (r.textContent || '').includes(s)), SUBJECT);

  /**
   * Run a store action that returns a promise and wait for its outcome.
   * browser.execute never awaits an async callback, so the page parks the
   * result where this side can poll it.
   */
  async function runInStore(action, args, what) {
    await browser.execute((name, a) => {
      window.__LOCAL_SNOOZE_RESULT__ = null;
      Promise.resolve(window.__MAIL_STORE__.getState()[name](...a)).then(
        (value) => { window.__LOCAL_SNOOZE_RESULT__ = { ok: true, value: (value && value.id) || null }; },
        (e) => { window.__LOCAL_SNOOZE_RESULT__ = { ok: false, error: String((e && e.message) || e) }; },
      );
    }, action, args);
    const outcome = await browser.waitUntil(
      async () => browser.execute(() => window.__LOCAL_SNOOZE_RESULT__),
      { timeout: 60_000, interval: 500, timeoutMsg: `${what} never settled` },
    );
    if (!outcome.ok) throw new Error(`${what} failed: ${outcome.error}`);
    return outcome.value;
  }

  before(async function () {
    await waitForApp();
    await waitForEmails();

    server = await startMockImap({ state: LOCAL_SNOOZE_STATE, faults: [] });
    // A read message, so "back unread" is something the wake did.
    const raw = [
      `Message-ID: ${MESSAGE_ID}`,
      'From: Partner <partner@example.com>',
      `To: ${OWNER}`,
      `Subject: ${SUBJECT}`,
      `Date: ${new Date().toUTCString()}`,
      '',
      'Snooze this, but keep it on the server.',
      '',
    ].join('\r\n');
    await withOwner((client) => client.append('INBOX', raw, ['\\Seen']));

    const account = mockAccount({ id: ACCOUNT_ID, email: OWNER, port: server.port, smtpPort: server.smtpPort });
    accountId = await runInStore('addAccount', [account], 'addAccount');
    await runInStore('activateAccount', [accountId, 'INBOX'], 'activateAccount');
    await browser.waitUntil(listed, { timeout: 60_000, interval: 500, timeoutMsg: 'The appended message never showed up in the INBOX list' });
  });

  after(async function () {
    // A row a failed run left behind: end it before the account goes.
    const row = await ourRow().catch(() => null);
    if (row) await rpc('snooze.cancel', { id: row.id }).catch(() => {});
    if (accountId) {
      try { await runInStore('removeAccount', [accountId], 'removeAccount'); }
      catch (e) { console.log('[snooze-local] account removal:', e.message); }
    }
    server?.stop();
  });

  it('B snoozes the message on this computer: hidden here, left in INBOX on the server', async () => {
    await browser.execute((s) => {
      const row = [...document.querySelectorAll('[data-testid="email-row"]')].find((r) => (r.textContent || '').includes(s));
      row?.click();
    }, SUBJECT);
    await browser.waitUntil(() => browser.execute(() => !!window.__MAIL_STORE__.getState().selectedEmailId), {
      timeout: 10_000, interval: 200, timeoutMsg: 'Clicking the row selected nothing',
    });
    await pressKey('b');
    await browser.waitUntil(() => browser.execute(() => !!document.querySelector('[data-testid="snooze-preset-nextWeek"]')), {
      timeout: 10_000, interval: 200, timeoutMsg: 'B never opened the snooze picker',
    });
    await browser.execute(() => document.querySelector('[data-testid="snooze-preset-nextWeek"]').click());

    let row = null;
    await browser.waitUntil(async () => { row = await ourRow(); return !!row; }, {
      timeout: 30_000, interval: 500, timeoutMsg: 'snooze.create never recorded a row for the message',
    });
    expect(row.state).toBe('snoozed');
    expect(row.snoozedMailbox).toBe('');
    expect(row.fromMailbox).toBe('INBOX');
    expect(row.wakeAt).toBeGreaterThan(Date.now() + 60 * 60 * 1000);

    await browser.waitUntil(async () => !(await listed()), {
      timeout: 10_000, interval: 250, timeoutMsg: 'The snoozed message is still in the INBOX list',
    });
    expect(await browser.execute(() => window.__MAIL_STORE__.getState().selectedEmailId)).toBe(null);

    // Nothing moved and nothing was made: the server still has it in INBOX, read.
    const onServer = await locate('INBOX');
    expect(onServer).not.toBeNull();
    expect(onServer.seen).toBe(true);
    const folders = await withOwner((client) => client.list());
    expect(folders.map((f) => f.path).filter((p) => /snoozed/i.test(p))).toEqual([]);
  });

  it('comes back unread when the wake time passes', async () => {
    const row = await ourRow();
    expect(row).not.toBeNull();
    const before = await locate('INBOX');
    await rpc('snooze.reschedule', { id: row.id, wakeAt: Date.now() + 3_000 });

    await browser.waitUntil(async () => (await locate('INBOX'))?.seen === false, {
      timeout: 60_000, interval: 1_000, timeoutMsg: 'The daemon never marked the local snooze unread',
    });
    expect((await locate('INBOX')).uid).toBe(before.uid);
    await browser.waitUntil(async () => !(await ourRow()), {
      timeout: 10_000, interval: 500, timeoutMsg: 'The woken row is still listed as snoozed',
    });

    await browser.waitUntil(listed, { timeout: 30_000, interval: 500, timeoutMsg: 'The woken message never came back to the INBOX list' });
    await browser.waitUntil(() => browser.execute((s) => {
      const e = window.__MAIL_STORE__.getState().emails.find((m) => m.subject === s);
      return !!e && !(e.flags || []).includes('\\Seen');
    }, SUBJECT), { timeout: 30_000, interval: 500, timeoutMsg: 'The woken message is back but not unread in the list' });
  });
});
