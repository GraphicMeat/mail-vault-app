/**
 * E2E: "display 1 or 2 or 3 lines of email preview when everything is indexed
 * in email list view".
 *
 * The preview is the start of the body, which the offline search index keeps
 * for every message it has read (`messages.snippet`) and the daemon attaches
 * to the rows the list reads. Nothing on the way is stubbed: the message is
 * delivered to the mock server, the daemon stores its body, the index reads
 * it, and the list shows it under the row once the folder is opened again.
 *
 * Yoda, dated 2020 so it sorts to the bottom of every list, removed in `after`
 * (see connected-idle-repaint.test.js for why).
 */

import { ImapFlow } from 'imapflow';
import { MOCK_PASSWORD } from './mockImap.js';
import { waitForApp, waitForEmails, switchToFolder, visibleRowSubjects } from './helpers.js';

const YODA = 'yoda@mock.test';
const YODA_SERVER = 2;          // MOCK_ACCOUNTS order: luke, vader, yoda

const SUBJECT = 'Preview lines fixture';
const BODY = 'The quarterly figures are attached, and the summary is on page two of the report.';

const rfc822 = () => Buffer.from([
  'From: Postman <postman@mock.test>',
  `To: ${YODA}`,
  `Subject: ${SUBJECT}`,
  'Date: Wed, 01 Jan 2020 12:00:00 +0000',
  'Message-ID: <preview-lines-fixture@mock.test>',
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  '',
  BODY,
  '',
].join('\r\n'));

describe('Preview lines under each message row', function () {
  this.timeout(300_000);

  async function withYoda(fn) {
    const { host, port } = browser.mockImap[YODA_SERVER];
    const client = new ImapFlow({ host, port, secure: false, auth: { user: YODA, pass: MOCK_PASSWORD }, logger: false });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.logout();
    }
  }

  const inInbox = (fn) => withYoda(async (client) => {
    const lock = await client.getMailboxLock('INBOX');
    try {
      return await fn(client);
    } finally {
      lock.release();
    }
  });

  /** The preview under the fixture's row, or null while it has none. */
  const fixturePreview = () => browser.execute((subject) => {
    const row = [...document.querySelectorAll('[data-testid="email-row"]')]
      .find((r) => r.querySelector('[data-testid="row-subject"]')?.textContent.includes(subject));
    const snippet = row?.querySelector('[data-testid="row-snippet"]');
    return snippet ? {
      text: snippet.textContent,
      clamp: snippet.style.webkitLineClamp || snippet.style.WebkitLineClamp,
      rowHeight: row.getBoundingClientRect().height,
    } : null;
  }, SUBJECT);

  let yodaId;

  before(async function () {
    await waitForApp();
    await waitForEmails();
    yodaId = (browser.mockAccounts || []).find((a) => a.email === YODA)?.id;
    expect(yodaId).toBeTruthy();
    await browser.waitUntil(async () =>
      (await browser.execute(() => window.__DB_PROBE__?.daemonHealth?.().alive)) === true, {
      timeout: 180_000, interval: 1_000, timeoutMsg: 'the daemon never came up',
    });
    // All mail kept locally (the fixture is dated 2020), and two preview
    // lines. The settings file the daemon reads is written 500 ms later.
    await browser.execute(() => {
      const s = window.__SETTINGS_STORE__.getState();
      s.setLocalCacheDurationMonths(0);
      s.setListPreviewLines(2);
    });
    await browser.pause(1_500);
    await switchToFolder(YODA, 'INBOX');
  });

  after(async function () {
    try {
      await inInbox(async (client) => {
        const uids = await client.search({ subject: SUBJECT }, { uid: true });
        if (uids.length) await client.messageDelete(uids, { uid: true });
      });
    } catch (e) {
      console.warn('[list-preview-lines] could not purge the fixture:', e.message);
    }
  });

  it('shows the start of an indexed message under its row, two lines tall', async function () {
    await inInbox((client) => client.append('INBOX', rfc822(), [], new Date('2020-01-01T12:00:00Z')));
    await browser.waitUntil(async () => (await visibleRowSubjects()).some((r) => r.includes(SUBJECT)), {
      timeout: 30_000, interval: 500, timeoutMsg: 'the fixture never reached the list',
    });

    // Opening the folder again reads its rows afresh, with whatever the index
    // has read by then: the preview needs the body stored and indexed first.
    let preview = null;
    await browser.waitUntil(async () => {
      await switchToFolder(YODA, 'Sent');
      await switchToFolder(YODA, 'INBOX');
      preview = await fixturePreview();
      return preview !== null;
    }, {
      timeout: 120_000, interval: 3_000,
      timeoutMsg: 'the fixture row never showed a preview line: its body was not stored, not indexed, or not attached to the row',
    });

    expect(preview.text).toBe(BODY);
    expect(preview.clamp).toBe('2');
    // A compact row (the default) plus two 16px preview lines.
    expect(Math.round(preview.rowHeight)).toBe(52 + 2 * 16);
  });

  it('hides the preview again when it is turned off', async function () {
    await browser.execute(() => window.__SETTINGS_STORE__.getState().setListPreviewLines(0));
    await browser.waitUntil(async () => (await fixturePreview()) === null, {
      timeout: 10_000, interval: 250, timeoutMsg: 'the preview stayed after the setting was turned off',
    });
  });
});
