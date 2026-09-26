/**
 * E2E: unsubscribe (RFC 2369 / RFC 8058). The reader's Unsubscribe action
 * asks first, then the daemon (`unsubscribe` RPC) answers how; the Settings >
 * Unsubscribe page lists the sender under All accounts and under its own
 * account, not under another one, and keeps the history.
 *
 * The one-click POST itself is not driven here: the daemon's SSRF gate
 * (export_fetch.rs) refuses loopback, which is all the mock infrastructure
 * has, and a browser fallback would open a real browser on the runner. So the
 * fixture offers only a `mailto:` (with a List-Unsubscribe-Post header, which
 * one-click ignores without an https link), and this spec follows the
 * fallback into Compose. The POST request and its gating are covered by the
 * daemon's cargo tests (handlers/unsubscribe.rs).
 *
 * Same fixture restraint as connected-quick-replies.test.js: the message is
 * appended to yoda's INBOX over IMAP, dated 2020, and removed in `after`.
 */

import { ImapFlow } from 'imapflow';
import { MOCK_PASSWORD } from './mockImap.js';
import { waitForApp, waitForEmails, switchToFolder, openSettings, closeSettings, clickSettingsNav } from './helpers.js';
import { modalOpen, fieldValue, setField, closeComposeHard } from './composeHelpers.js';

const YODA = 'yoda@mock.test';
const LUKE = 'luke@mock.test';
const YODA_SERVER = 2; // MOCK_ACCOUNTS order: luke, vader, yoda

const SENDER = 'notices@unsub.test';
const SUBJECT = 'Unsubscribe fixture newsletter';
const MESSAGE_ID = '<unsubscribe-fixture@mock.test>';

const newsletterRfc822 = () => Buffer.from([
  `From: Unsub Notices <${SENDER}>`,
  `To: ${YODA}`,
  `Subject: ${SUBJECT}`,
  'Date: Wed, 01 Jan 2020 12:00:00 +0000',
  `Message-ID: ${MESSAGE_ID}`,
  'List-Unsubscribe: <mailto:leave@unsub.test?subject=unsubscribe>',
  'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
  'List-Id: Unsub Notices <notices.unsub.test>',
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'This week in notices.',
  '',
].join('\r\n'));

describe('Unsubscribe', function () {
  this.timeout(240_000);

  let accounts = [];
  let priorQuickActions = null;

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

  const idOf = (email) => accounts.find((a) => a.email === email)?.id;

  const openMessage = async () => {
    await browser.waitUntil(() => browser.execute((needle) => {
      const row = [...document.querySelectorAll('[data-testid="email-row"]')]
        .find((r) => r.offsetHeight > 0 && (r.innerText || '').includes(needle));
      row?.click();
      return !!row;
    }, SUBJECT), { timeout: 60_000, interval: 1000, timeoutMsg: `row "${SUBJECT}" never appeared in yoda's INBOX` });
    await browser.waitUntil(async () => (await browser.execute(() =>
      window.__MAIL_STORE__.getState().selectedEmail?.subject)) === SUBJECT, {
      timeout: 20_000, interval: 300, timeoutMsg: 'the viewer never selected the fixture newsletter',
    });
  };

  const sendersListed = () => browser.execute(() =>
    [...document.querySelectorAll('[data-testid="unsubscribe-senders"] tr[data-sender]')].map((r) => r.getAttribute('data-sender')));

  const settled = () => browser.execute(() => {
    const page = document.querySelector('[data-testid="unsubscribe-settings"]');
    return !!page && !page.querySelector('[aria-busy="true"]');
  });

  before(async function () {
    await waitForApp();
    await waitForEmails();
    accounts = browser.mockAccounts || [];
    expect(idOf(YODA)).toBeTruthy();
    expect(idOf(LUKE)).toBeTruthy();

    await inInbox((client) => client.append('INBOX', newsletterRfc822(), [], new Date('2020-01-01T12:00:00Z')));

    // The reader offers Unsubscribe once it is one of its quick actions.
    priorQuickActions = await browser.execute(() => {
      const state = window.__SETTINGS_STORE__.getState();
      const reader = state.quickActions.defaults.reader;
      const prior = JSON.parse(JSON.stringify(state.quickActions));
      state.setQuickActionSurface('reader', null, { ...reader, entries: [{ id: 'unsubscribe', action: 'unsubscribe' }, ...reader.entries] });
      return prior;
    });

    await switchToFolder(YODA, 'INBOX');
  });

  after(async function () {
    try { await closeComposeHard(); } catch { /* nothing open */ }
    try { await closeSettings(); } catch { /* nothing open */ }
    if (priorQuickActions) {
      await browser.execute((prior) => window.__SETTINGS_STORE__.setState({ quickActions: prior }), priorQuickActions);
    }
    try {
      await inInbox(async (client) => {
        const uids = await client.search({ header: { 'message-id': MESSAGE_ID } }, { uid: true });
        if (uids.length) await client.messageDelete(uids, { uid: true });
      });
    } catch (e) {
      console.warn('[unsubscribe] could not purge the fixture newsletter:', e.message);
    }
  });

  it('carries List-Unsubscribe and List-Unsubscribe-Post onto the opened message', async function () {
    await openMessage();
    await browser.waitUntil(async () => {
      const e = await browser.execute(() => window.__MAIL_STORE__.getState().selectedEmail);
      return e?.listUnsubscribe?.includes('leave@unsub.test') && e?.listUnsubscribePost === 'List-Unsubscribe=One-Click';
    }, {
      timeout: 20_000, interval: 500,
      timeoutMsg: 'the synced message never carried listUnsubscribe + listUnsubscribePost: HEADER_FETCH_SPEC '
        + '(src-core/src/imap/mod.rs) or the selectEmail merge may have dropped them',
    });
  });

  it('asks before acting, then opens a prefilled unsubscribe email for a mailto-only list', async function () {
    await openMessage();
    await browser.waitUntil(() => browser.execute(() => {
      const button = [...document.querySelectorAll('[data-quick-action="unsubscribe"]')].find((b) => b.offsetHeight > 0);
      button?.click();
      return !!button;
    }), { timeout: 15_000, interval: 300, timeoutMsg: 'the reader never offered Unsubscribe for a List-Unsubscribe message' });

    await browser.waitUntil(() => browser.execute(() => !!document.querySelector('[role="alertdialog"]')), {
      timeout: 10_000, interval: 200, timeoutMsg: 'Unsubscribe did not ask for confirmation first',
    });
    expect(await modalOpen()).toBe(false);

    await browser.execute(() => {
      const dialog = document.querySelector('[role="alertdialog"]');
      [...dialog.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Unsubscribe')?.click();
    });

    await browser.waitUntil(modalOpen, { timeout: 20_000, interval: 300, timeoutMsg: 'confirming did not open Compose for the mailto fallback' });
    await browser.waitUntil(async () => (await fieldValue('compose-to')) === 'leave@unsub.test', {
      timeout: 10_000, interval: 300,
      timeoutMsg: `Compose opened with to=${JSON.stringify(await fieldValue('compose-to'))}, not the list's mailto address`,
    });
    expect(await fieldValue('compose-subject')).toBe('unsubscribe');
    await closeComposeHard();
  });

  it('Settings > Unsubscribe lists the sender under All accounts and its own account only, with the history', async function () {
    await openSettings();
    expect(await clickSettingsNav('Unsubscribe')).toBe(true);

    await browser.waitUntil(async () => (await sendersListed()).includes(SENDER), {
      timeout: 60_000, interval: 500, timeoutMsg: `All accounts never listed ${SENDER}`,
    });
    await browser.waitUntil(() => browser.execute((sender) =>
      (document.querySelector('[data-testid="unsubscribe-history"]')?.innerText || '').includes(sender), SENDER), {
      timeout: 10_000, interval: 300, timeoutMsg: 'the history never showed the unsubscribe just made',
    });

    await setField('unsubscribe-scope', idOf(YODA));
    await browser.waitUntil(async () => (await settled()) && (await sendersListed()).includes(SENDER), {
      timeout: 60_000, interval: 500, timeoutMsg: `yoda's scope never listed ${SENDER}`,
    });

    await setField('unsubscribe-scope', idOf(LUKE));
    await browser.waitUntil(settled, { timeout: 60_000, interval: 500, timeoutMsg: "luke's scope never finished loading" });
    expect(await sendersListed()).not.toContain(SENDER);

    await closeSettings();
  });
});
