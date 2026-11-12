import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ImapFlow } from 'imapflow';
import { waitForApp, waitForEmails } from './helpers.js';
import { trackMailbox, MOCK_PASSWORD } from './mockImap.js';
import { clickReachable, nativeDaemonInvoke, dismissOnboardingNotice } from './insightsHelpers.js';
import { raiseWindow } from '../../scripts/screenshots/window.js';

const VADER = 1;
const DELETE = { subject: 'Capture: delete me', id: 'capture-notes-delete@mock.test', boxes: ['INBOX', 'Sent'] };
const KEEP = { subject: 'Capture: keep me', id: 'capture-notes-keep@mock.test', boxes: ['INBOX'] };
const account = () => browser.mockAccounts[VADER];
const card = (subject) => `[data-testid="note-card"][aria-label="${subject}"]`;

async function withServer(fn) {
  const { host, port } = browser.mockImap[VADER];
  const client = new ImapFlow({ host, port, secure: false, auth: { user: account().email, pass: MOCK_PASSWORD }, logger: false });
  await client.connect();
  try { return await fn(client); } finally { await client.logout(); }
}

async function serverUids(mailbox, subject) {
  return withServer(async (client) => {
    const lock = await client.getMailboxLock(mailbox);
    try { return await client.search({ subject }, { uid: true }); } finally { lock.release(); }
  });
}

function message(note) {
  return Buffer.from([
    `From: ${account().email}`,
    `To: ${account().email}`,
    `Subject: ${note.subject}`,
    'Date: Sun, 20 Sep 2026 09:00:00 +0000',
    `Message-ID: <${note.id}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    `Body of ${note.subject}.`,
    '',
  ].join('\r\n'));
}

async function seed(note) {
  for (const mailbox of note.boxes) {
    const appended = await withServer((client) => client.append(mailbox, message(note), [], new Date('2026-09-20T09:00:00Z')));
    const uid = appended?.uid ?? (await serverUids(mailbox, note.subject))[0];
    assert.ok(uid > 0, `${note.subject} appended to ${mailbox}`);
    const result = await nativeDaemonInvoke('archive_emails', {
      accountId: account().id, accountJson: JSON.stringify(account()), mailbox, uids: [uid],
    });
    assert.equal(result?.errors || 0, 0, `archive_emails ${note.subject} ${mailbox}: ${JSON.stringify(result)}`);
  }
}

async function waitForCard(subject) {
  await browser.waitUntil(async () => {
    if (await browser.execute((selector) => !!document.querySelector(selector), card(subject))) return true;
    await clickReachable('[data-testid="notes-refresh"]');
    return browser.execute((selector) => !!document.querySelector(selector), card(subject));
  }, { timeout: 90_000, interval: 2000, timeoutMsg: `${subject} never appeared` });
}

describe('Notes delete capture', function () {
  this.timeout(300_000);
  const restores = [];

  before(async () => {
    await waitForApp();
    await waitForEmails();
    for (const mailbox of ['INBOX', 'Sent', 'Trash']) {
      restores.push(await trackMailbox(browser.mockImap[VADER], mailbox));
    }
    await seed(DELETE);
    await seed(KEEP);
    const { mailboxes } = await nativeDaemonInvoke('imap_get_mailboxes', { account: account() });
    await nativeDaemonInvoke('save_mailbox_cache', {
      accountId: account().id, data: JSON.stringify({ mailboxes, fetchedAt: Date.now() }),
    });
  });

  after(async () => {
    for (const restore of restores) await restore();
  });

  it('captures the board after both server copies leave', async () => {
    await dismissOnboardingNotice();
    await clickReachable('[data-testid="open-notes"]');
    await browser.waitUntil(() => browser.execute(() =>
      document.querySelector('[data-testid="notes-board"]')?.dataset.status === 'ready'),
    { timeout: 30_000, interval: 200, timeoutMsg: 'Notes board did not load' });
    await waitForCard(DELETE.subject);
    await waitForCard(KEEP.subject);
    await clickReachable(`${card(DELETE.subject)} [data-testid="note-delete"]`);
    await browser.waitUntil(() => browser.execute(() => !!document.querySelector('[role="alertdialog"]')),
      { timeout: 10_000, interval: 200, timeoutMsg: 'Delete confirmation did not open' });
    const confirmed = await browser.execute(() => {
      const button = [...document.querySelectorAll('[role="alertdialog"] button')].find((b) => b.className.includes('danger'));
      button?.click();
      return !!button;
    });
    assert.equal(confirmed, true);
    await browser.waitUntil(() => browser.execute((selector) => !document.querySelector(selector), card(DELETE.subject)),
      { timeout: 30_000, interval: 200, timeoutMsg: 'Deleted card remained' });
    for (const mailbox of DELETE.boxes) {
      await browser.waitUntil(async () => (await serverUids(mailbox, DELETE.subject)).length === 0,
        { timeout: 30_000, interval: 250, timeoutMsg: `Copy remained in ${mailbox}` });
    }
    assert.equal(await browser.execute((selector) => !!document.querySelector(selector), card(KEEP.subject)), true);
    assert.equal(await browser.execute(() =>
      [...document.querySelectorAll('[role="alert"], [data-testid*="toast"]')].some((el) => el.textContent.includes('Not deleted yet'))), false);

    const out = resolve('.artifacts');
    mkdirSync(out, { recursive: true });
    assert.equal(await raiseWindow(1280, 800), 'ok');
    const layout = await browser.execute(() => {
      const board = document.querySelector('[data-testid="notes-board"]');
      const rect = board.getBoundingClientRect();
      return {
        sheets: [...document.styleSheets].map((sheet) => sheet.href),
        display: getComputedStyle(board).display,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        viewport: { width: innerWidth, height: innerHeight },
      };
    });
    assert.ok(layout.sheets.some((href) => href?.endsWith('.css')), 'App stylesheets must be loaded');
    assert.equal(layout.display, 'flex');
    assert.ok(layout.rect.width > 200 && layout.rect.x < layout.viewport.width, 'Notes board must be visible in the capture');
    process.env.SHOTS_APP_BINARY = resolve('target/debug/mailvault');
    process.env.SHOTS_OUT = out;
    const { capture } = await import('../../scripts/screenshots/capture.js');
    for (const theme of ['light', 'dark']) {
      await browser.execute((value) => document.documentElement.setAttribute('data-theme', value), theme);
      await browser.pause(500);
      capture(`notes-board-after-delete-${theme}`);
    }
  });
});
