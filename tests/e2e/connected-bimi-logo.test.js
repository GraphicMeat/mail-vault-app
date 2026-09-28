/**
 * E2E: the sender's BIMI logo on a list row and in the reader.
 *
 * The logo needs three things to line up in the real app: the header sync
 * carries Authentication-Results onto the row, the row asks the daemon
 * (`bimi_logo`), and the daemon answers only for a DMARC pass for exactly the
 * From domain. Unit tests mock the daemon, so only this run proves a synced
 * row draws it.
 *
 * The daemon's DNS and HTTPS fetch cannot reach a `.test` domain, so the logo
 * is seeded into its cache (`bimi_cache` in app.db) BEFORE the fixture is
 * appended: a row that asked first would have the daemon store a "no logo"
 * answer, and the component keeps that for the session.
 *
 * Fixtures (appended to yoda's INBOX, dated 2020, removed in `after`): the
 * same sender twice, once with `dmarc=pass` and once with `dmarc=fail`. The
 * fail is the control: a row that drew the logo for any message from a domain
 * with one cached would pass the positive case for the wrong reason.
 */

import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ImapFlow } from 'imapflow';
import { MOCK_PASSWORD, appDataDir } from './mockImap.js';
import { waitForApp, waitForEmails, switchToFolder } from './helpers.js';

const YODA = 'yoda@mock.test';
const YODA_SERVER = 2; // MOCK_ACCOUNTS order: luke, vader, yoda

const DOMAIN = 'bimi-brand.test';
const SENDER = `news@${DOMAIN}`;
const SENDER_NAME = 'Bimi Brand';
const PASS_SUBJECT = 'BIMI fixture passed DMARC';
const FAIL_SUBJECT = 'BIMI fixture failed DMARC';
const PASS_AUTH = `mx.mock.test; spf=pass smtp.mailfrom=${DOMAIN}; dkim=pass header.d=${DOMAIN}; dmarc=pass header.from=${DOMAIN}`;
const FAIL_AUTH = `mx.mock.test; spf=fail smtp.mailfrom=${DOMAIN}; dkim=fail header.d=${DOMAIN}; dmarc=fail header.from=${DOMAIN}`;
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#c00"/></svg>';
const LOGO_PREFIX = 'data:image/svg+xml;base64,';

const fixture = (subject, auth, id) => Buffer.from([
  `Authentication-Results: ${auth}`,
  `From: ${SENDER_NAME} <${SENDER}>`,
  `To: ${YODA}`,
  `Subject: ${subject}`,
  'Date: Wed, 01 Jan 2020 12:00:00 +0000',
  `Message-ID: <${id}@mock.test>`,
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'This week at the brand.',
  '',
].join('\r\n'));

const FIXTURES = [
  { subject: PASS_SUBJECT, auth: PASS_AUTH, id: 'bimi-pass-fixture' },
  { subject: FAIL_SUBJECT, auth: FAIL_AUTH, id: 'bimi-fail-fixture' },
];

const appDb = () => {
  const db = new DatabaseSync(join(appDataDir(browser.testDataDir), 'app.db'));
  // app.db is shared with the daemon (WAL, no exclusive lock); wait, don't fail.
  db.exec('PRAGMA busy_timeout=5000');
  return db;
};

/** The row naming `subject`, as the list draws it. */
const rowState = (subject) => browser.execute((needle) => {
  const row = [...document.querySelectorAll('[data-testid="email-row"]')]
    .find((r) => r.offsetHeight > 0 && (r.innerText || '').includes(needle));
  if (!row) return null;
  const logo = row.querySelector('[data-testid="bimi-logo"]');
  const sender = row.querySelector('[data-testid="row-sender"]');
  return {
    sender: sender?.innerText || '',
    src: logo?.getAttribute('src') || null,
    alt: logo?.getAttribute('alt') || null,
    // The image decoded: a data URI the webview cannot render draws nothing.
    painted: !!logo && logo.complete && logo.naturalWidth > 0,
    afterSender: !!logo && !!sender && !!(sender.compareDocumentPosition(logo) & Node.DOCUMENT_POSITION_FOLLOWING),
  };
}, subject);

describe('BIMI logo', function () {
  this.timeout(180_000);

  async function inInbox(fn) {
    const { host, port } = browser.mockImap[YODA_SERVER];
    const client = new ImapFlow({ host, port, secure: false, auth: { user: YODA, pass: MOCK_PASSWORD }, logger: false });
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      return await fn(client);
    } finally {
      lock.release();
      await client.logout();
    }
  }

  before(async function () {
    await waitForApp();
    await waitForEmails();

    const db = appDb();
    try {
      db.prepare('INSERT OR REPLACE INTO bimi_cache(domain, svg, expires_at) VALUES (?, ?, ?)')
        .run(DOMAIN, Buffer.from(SVG), Date.now() + 24 * 3600_000);
    } finally {
      db.close();
    }
    // The daemon reads the seed back: a schema or unit mismatch would fail
    // every case below as "no logo", which looks like the bug under test.
    const answer = await browser.executeAsync((domain, auth, done) => {
      window.__TAURI_INTERNALS__.invoke('daemon_rpc', { method: 'bimi_logo', params: { domain, authenticationResults: auth } })
        .then((r) => done(r?.logo || null), (e) => done(`error: ${e}`));
    }, DOMAIN, PASS_AUTH);
    expect(answer).toBe(LOGO_PREFIX + Buffer.from(SVG).toString('base64'));

    await inInbox(async (client) => {
      for (const f of FIXTURES) await client.append('INBOX', fixture(f.subject, f.auth, f.id), ['\\Seen'], new Date('2020-01-01T12:00:00Z'));
    });
    await switchToFolder(YODA, 'INBOX');
  });

  after(async function () {
    try {
      await inInbox(async (client) => {
        for (const f of FIXTURES) {
          const uids = await client.search({ header: { 'message-id': `<${f.id}@mock.test>` } }, { uid: true });
          if (uids.length) await client.messageDelete(uids, { uid: true });
        }
      });
    } catch (e) {
      console.warn('[bimi] could not purge the fixtures:', e.message);
    }
    try {
      const db = appDb();
      try { db.prepare('DELETE FROM bimi_cache WHERE domain = ?').run(DOMAIN); } finally { db.close(); }
    } catch (e) {
      console.warn('[bimi] could not drop the seeded logo:', e.message);
    }
  });

  it('draws the logo right after the sender on a row that passed DMARC', async function () {
    let state = null;
    await browser.waitUntil(async () => (state = await rowState(PASS_SUBJECT))?.painted, {
      timeout: 60_000, interval: 1000,
      timeoutMsg: `no painted BIMI logo on "${PASS_SUBJECT}": last row state ${JSON.stringify(state)}`,
    });
    expect(state.src.startsWith(LOGO_PREFIX)).toBe(true);
    expect(state.sender).toContain(SENDER_NAME);
    expect(state.afterSender).toBe(true);
    expect(state.alt).toContain(DOMAIN);
  });

  it('draws none on the same sender\'s row that failed DMARC', async function () {
    // The pass row above is already painted, so every lookup has settled.
    const state = await rowState(FAIL_SUBJECT);
    expect(state).not.toBe(null);
    expect(state.sender).toContain(SENDER_NAME);
    expect(state.src).toBe(null);
  });

  it('shows the logo beside the sender in the reader', async function () {
    await browser.execute((needle) => {
      [...document.querySelectorAll('[data-testid="email-row"]')]
        .find((r) => r.offsetHeight > 0 && (r.innerText || '').includes(needle))?.click();
    }, PASS_SUBJECT);
    let src = null;
    await browser.waitUntil(async () => {
      src = await browser.execute((name) => {
        const header = document.querySelector('[data-testid="sender-header"]');
        if (!header || !(header.innerText || '').includes(name)) return null;
        const logo = header.querySelector('[data-testid="bimi-logo"]');
        return logo && logo.complete && logo.naturalWidth > 0 ? logo.getAttribute('src') : null;
      }, SENDER_NAME);
      return !!src;
    }, { timeout: 30_000, interval: 500, timeoutMsg: 'the reader never drew the BIMI logo for the passed message' });
    expect(src.startsWith(LOGO_PREFIX)).toBe(true);
  });
});
