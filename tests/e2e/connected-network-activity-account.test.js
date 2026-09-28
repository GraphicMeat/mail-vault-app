/**
 * E2E: Network Activity names the account behind each connection.
 *
 * The report: rows labelled "Open message" with no account. A sender logo
 * lookup is one of them: a message whose sender passed DMARC makes the daemon
 * look up the domain's BIMI policy, an "open message" DNS event. The app now
 * tells the daemon whose message asked (`accountEmail`), so the row names that
 * account and the page's account filter keeps it. Unit tests mock the daemon
 * or the app; only this run proves the address crosses from the list row,
 * through the daemon's RPC scope, into app.db and back onto the page.
 *
 * The fixture's domain is this spec's own and never resolves (`.test`): the
 * lookup fails and is recorded either way. Nothing is seeded into the logo
 * cache, so the lookup really happens.
 *
 * Fixture: one message appended to yoda's INBOX (dated 2020, removed in `after`).
 */

import { ImapFlow } from 'imapflow';
import { MOCK_PASSWORD } from './mockImap.js';
import { waitForApp, waitForEmails, switchToFolder, openSettings, closeSettings, clickSettingsNav } from './helpers.js';

const YODA = 'yoda@mock.test';
const YODA_SERVER = 2; // MOCK_ACCOUNTS order: luke, vader, yoda

const DOMAIN = 'net-activity-account.test';
const LOOKUP = `_dmarc.${DOMAIN}`;
const SUBJECT = 'Network Activity account fixture';
const MESSAGE_ID = 'net-activity-account-fixture';
const AUTH = `mx.mock.test; spf=pass smtp.mailfrom=${DOMAIN}; dkim=pass header.d=${DOMAIN}; dmarc=pass header.from=${DOMAIN}`;
const NO_ACCOUNT = 'Not tied to an account';

const fixture = () => Buffer.from([
  `Authentication-Results: ${AUTH}`,
  `From: Net Activity <news@${DOMAIN}>`,
  `To: ${YODA}`,
  `Subject: ${SUBJECT}`,
  'Date: Wed, 01 Jan 2020 12:00:00 +0000',
  `Message-ID: <${MESSAGE_ID}@mock.test>`,
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Which account asked for this logo?',
  '',
].join('\r\n'));

/** Every row the table shows: its host, purpose cell and account cell. */
const tableRows = () => browser.execute(() =>
  [...document.querySelectorAll('[data-testid="net-row"]')].map((row) => ({
    host: row.getAttribute('data-host'),
    purpose: row.children[5]?.innerText.trim() || '',
    account: row.querySelector('[data-testid="net-account"]')?.innerText.trim() || '',
  })));

/** Pick `value` in the page's select labelled `label`, as a user would. */
const choose = (label, value) => browser.execute((name, wanted) => {
  const select = document.querySelector(`[data-testid="network-activity"] select[aria-label="${name}"]`);
  if (!select || ![...select.options].some((o) => o.value === wanted)) return false;
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, wanted);
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}, label, value);

describe('Network Activity: the account behind each connection', function () {
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
    await inInbox((client) => client.append('INBOX', fixture(), ['\\Seen'], new Date('2020-01-01T12:00:00Z')));
    await switchToFolder(YODA, 'INBOX');
    // Open it: the row and the reader both draw the sender's logo.
    await browser.waitUntil(() => browser.execute((needle) => {
      const row = [...document.querySelectorAll('[data-testid="email-row"]')]
        .find((r) => r.offsetHeight > 0 && (r.innerText || '').includes(needle));
      row?.click();
      return !!row;
    }, SUBJECT), { timeout: 30_000, interval: 500, timeoutMsg: `no row for "${SUBJECT}" in ${YODA}'s INBOX` });
    await openSettings();
    await clickSettingsNav('Privacy & security');
    await clickSettingsNav('Network Activity');
  });

  after(async function () {
    // The page keeps its query for the next visit: leave it unfiltered.
    try { await choose('Account', ''); await choose('Purpose', ''); } catch { /* page already gone */ }
    await closeSettings();
    try {
      await inInbox(async (client) => {
        const uids = await client.search({ header: { 'message-id': `<${MESSAGE_ID}@mock.test>` } }, { uid: true });
        if (uids.length) await client.messageDelete(uids, { uid: true });
      });
    } catch (e) {
      console.warn('[network-activity-account] could not purge the fixture:', e.message);
    }
  });

  it('names the account whose message made the logo lookup', async function () {
    let row = null;
    await browser.waitUntil(async () => (row = (await tableRows()).find((r) => r.host === LOOKUP)), {
      timeout: 60_000, interval: 1000,
      timeoutMsg: `no Network Activity row for the ${LOOKUP} lookup`,
    });
    expect(row.purpose).toBe('Open message');
    expect(row.account).toBe(YODA);
  });

  it('shows no "Open message" row without its account', async function () {
    expect(await choose('Purpose', 'open message')).toBe(true);
    const rows = await tableRows();
    expect(rows.some((r) => r.host === LOOKUP)).toBe(true);
    expect(rows.filter((r) => r.account === NO_ACCOUNT || r.account === '')).toEqual([]);
    expect(await choose('Purpose', '')).toBe(true);
  });

  it('the account filter keeps the lookup under its account, and only that account\'s rows', async function () {
    expect(await choose('Account', YODA)).toBe(true);
    let rows = [];
    await browser.waitUntil(async () => {
      rows = await tableRows();
      return rows.some((r) => r.host === LOOKUP) && rows.every((r) => r.account === YODA);
    }, {
      timeout: 15_000, interval: 500,
      timeoutMsg: `filtered to ${YODA}, the table still shows ${JSON.stringify(rows.slice(0, 10))}`,
    });
  });
});
