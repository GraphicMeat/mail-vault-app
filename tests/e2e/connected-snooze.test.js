/**
 * E2E: Snooze — out of the inbox into Snoozed, and back unread at wake time.
 *
 * The contract (src/services/workflows/snooze.js, src-daemon/src/handlers/
 * snooze.rs, src-daemon/src/snooze_worker.rs): the app moves the message into
 * the server folder `snooze.ensure_folder` resolves (created on first use)
 * through its own move workflow, then records a daemon row keyed by the
 * Message-ID. The daemon's worker moves it back to where it came from with
 * `\Seen` cleared once the wake time passes.
 *
 * The snooze itself is driven through the UI (select the row, press B, pick
 * "Next week"). The wake is not a week away: the row is then rescheduled over
 * `daemon_rpc` to a few seconds out, which is the same `snooze.reschedule` the
 * app would send, and the worker's own timer does the rest. The mock server
 * speaks MOVE + UIDPLUS, so the stored uid is the COPYUID.
 *
 * Everything is checked over raw IMAP (ImapFlow), not the list: the point of
 * a server-side snooze is that every other client sees it too.
 */

import { ImapFlow } from 'imapflow';
import { MOCK_PASSWORD } from './mockImap.js';
import { waitForApp, waitForEmails, pressKey, switchToFolder } from './helpers.js';
import { invoke } from './composeHelpers.js';

const LUKE = 'luke@mock.test';
const LUKE_SERVER = 0; // MOCK_ACCOUNTS order: luke, vader
const MESSAGE_ID = `<snooze-e2e-${Date.now()}@mock.test>`;
const SUBJECT = `Snooze me ${Date.now()}`;

describe('Snooze', function () {
  this.timeout(180_000);
  let snoozedFolder = null;

  async function withLuke(fn) {
    const { host, port } = browser.mockImap[LUKE_SERVER];
    const client = new ImapFlow({ host, port, secure: false, auth: { user: LUKE, pass: MOCK_PASSWORD }, logger: false });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.logout();
    }
  }

  /** `{uid, seen}` of our message in `mailbox`, or null. */
  const locate = (mailbox) => withLuke(async (client) => {
    const lock = await client.getMailboxLock(mailbox);
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

  before(async function () {
    await waitForApp();
    await waitForEmails();
    // A fresh, read message, so "back unread" is something the wake did.
    const raw = [
      `Message-ID: ${MESSAGE_ID}`,
      'From: Partner <partner@example.com>',
      `To: ${LUKE}`,
      `Subject: ${SUBJECT}`,
      `Date: ${new Date().toUTCString()}`,
      '',
      'Snooze this until later.',
      '',
    ].join('\r\n');
    await withLuke((client) => client.append('INBOX', raw, ['\\Seen']));
    await switchToFolder(LUKE, 'INBOX');
    // Load it once more after the append, so the new row is there.
    await browser.execute(() => { window.__MAIL_STORE__.getState().loadEmails(); });
    await browser.waitUntil(() => browser.execute((s) =>
      [...document.querySelectorAll('[data-testid="email-row"]')].some((r) => (r.textContent || '').includes(s)), SUBJECT), {
      timeout: 30_000, interval: 500, timeoutMsg: 'The appended message never showed up in the INBOX list',
    });
  });

  after(async function () {
    // A row a failed run left behind: bring the message back before deleting it.
    const row = await ourRow().catch(() => null);
    if (row) await rpc('snooze.cancel', { id: row.id }).catch(() => {});
    await withLuke(async (client) => {
      for (const mailbox of ['INBOX', snoozedFolder].filter(Boolean)) {
        const lock = await client.getMailboxLock(mailbox).catch(() => null);
        if (!lock) continue;
        try {
          const uids = await client.search({ header: { 'message-id': MESSAGE_ID } }, { uid: true });
          if (uids?.length) await client.messageDelete(uids.join(','), { uid: true });
        } finally {
          lock.release();
        }
      }
      if (snoozedFolder) await client.mailboxDelete(snoozedFolder).catch(() => {});
    }).catch(() => {});
  });

  it('B snoozes the selected message into a Snoozed folder on the server', async () => {
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
    snoozedFolder = row.snoozedMailbox;
    expect(row.state).toBe('snoozed');
    expect(row.fromMailbox).toBe('INBOX');
    expect(row.wakeAt).toBeGreaterThan(Date.now() + 60 * 60 * 1000);
    expect(await locate('INBOX')).toBeNull();
    const inSnoozed = await locate(snoozedFolder);
    expect(inSnoozed).not.toBeNull();
    expect(row.uidInSnoozed).toBe(inSnoozed.uid);
  });

  it('comes back to the INBOX unread when the wake time passes', async () => {
    const row = await ourRow();
    expect(row).not.toBeNull();
    await rpc('snooze.reschedule', { id: row.id, wakeAt: Date.now() + 3_000 });

    let back = null;
    await browser.waitUntil(async () => { back = await locate('INBOX'); return !!back; }, {
      timeout: 60_000, interval: 1_000, timeoutMsg: 'The daemon never moved the snoozed message back to INBOX',
    });
    expect(back.seen).toBe(false);
    expect(await locate(snoozedFolder)).toBeNull();
    await browser.waitUntil(async () => !(await ourRow()), {
      timeout: 10_000, interval: 500, timeoutMsg: 'The woken row is still listed as snoozed',
    });
  });
});
