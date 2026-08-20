/**
 * E2E Test: a vault copy archived under a UID the server has since reissued.
 *
 * The vault Maildir is keyed (accountId, mailbox, uid) and carries no
 * UIDVALIDITY stamp. When a mailbox's UID space is reissued — a change-server
 * migration, or a reissue the server does on its own — the uid the vault
 * archived a message under now names a different message on the server.
 * selectEmail preferred the vault copy, so the viewer rendered that other
 * message whole: sender, date, subject and body. Nothing errored, because the
 * read landed on a real message; it was just not the one in the row.
 *
 * Found in production, 2026-08-20: rare@graphicmeat.com had moved to
 * Purelymail. Its INBOX held one message, "Welcome to Purelymail!" at uid 1,
 * and the vault's uid 1 was a Hostinger welcome mail from the previous host.
 * Clicking the one row showed the Hostinger message.
 *
 * The fixture is that shape exactly: a stale .eml written straight into the
 * vault under a uid the mock server serves as something else. It is its own
 * spec file on purpose — opening the target row anywhere earlier in a file
 * fills the in-memory body cache, and selectEmail never reaches the vault at
 * all, so the whole thing would pass without exercising the guard.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { waitForApp, waitForEmails, switchToFolder } from './helpers.js';
import { appDataDir, HTML_QUOTED_SUBJECT } from './mockImap.js';

const LUKE = 'luke@mock.test';

// Deliberately unlike anything the mock server serves, so a hit is unambiguous.
const STALE_SUBJECT = 'Message left behind by the previous server';
const STALE_MARKER = 'mv-stale-vault-body';

// A different Message-ID from the row's is the whole point: it is the one field
// that can prove the vault copy is not this message.
const staleEml = [
  'From: Old Host <team@previous-host.test>',
  'To: luke@mock.test',
  `Subject: ${STALE_SUBJECT}`,
  'Message-ID: <archived-under-the-old-uid@previous-host.test>',
  'Date: Thu, 19 Mar 2026 07:56:23 +0000',
  'MIME-Version: 1.0',
  'Content-Type: text/html; charset=utf-8',
  '',
  `<html><body><p id="${STALE_MARKER}">Body archived under this UID by the previous server.</p></body></html>`,
  '',
].join('\r\n');

describe('Email Viewer — vault copy under a reissued UID', function () {
  this.timeout(90_000);

  let target = null;

  const readViewer = () => browser.execute((markerId) => {
    const iframe = document.querySelector('iframe[sandbox]');
    let doc = null;
    try { doc = iframe?.contentDocument || null; } catch { doc = null; }
    return {
      // Not the first h1 on the page — that one is the sidebar's "MailVault".
      subject: [...document.querySelectorAll('h1')]
        .filter((h) => !h.closest('[data-testid="sidebar"]'))
        .map((h) => (h.textContent || '').trim())
        .join(' | '),
      frameText: doc?.body ? (doc.body.innerText || doc.body.textContent || '').trim() : null,
      hasStaleBody: !!doc?.getElementById(markerId),
    };
  }, STALE_MARKER);

  before(async function () {
    await waitForApp();
    await waitForEmails();
    await switchToFolder(LUKE, 'INBOX');

    // The HTML message: a plain-text body never reaches the iframe, and the
    // iframe is where a wrong body is visible.
    target = await browser.execute((needle) => {
      const rows = window.__MAIL_STORE__?.getState()?.sortedEmails || [];
      const row = rows.find((e) => (e.subject || '').includes(needle));
      return row ? { uid: row.uid, subject: row.subject, messageId: row.messageId } : null;
    }, HTML_QUOTED_SUBJECT);

    expect(target).not.toBe(null);

    const accountId = browser.mockAccounts.find((a) => a.email === LUKE).id;
    const cur = join(appDataDir(browser.testDataDir), 'Maildir', accountId, 'INBOX', 'cur');
    mkdirSync(cur, { recursive: true });
    // `find_by_uid` (src-core/src/maildir.rs) matches on the `<uid>:` prefix.
    writeFileSync(join(cur, `${target.uid}:seen:0.eml`), staleEml);
  });

  it('seeded a vault file under the row own uid', async function () {
    const accountId = browser.mockAccounts.find((a) => a.email === LUKE).id;
    const path = join(appDataDir(browser.testDataDir), 'Maildir', accountId, 'INBOX', 'cur', `${target.uid}:seen:0.eml`);
    // Positive control: without this, the assertions below pass on an empty
    // vault — an absence assertion proves nothing until the container is
    // proven populated.
    expect(existsSync(path)).toBe(true);
  });

  it('renders the message the server has at that uid, not the one the vault kept', async function () {
    const clicked = await browser.execute((needle) => {
      const row = [...document.querySelectorAll('[data-testid="email-row"]')]
        .find((r) => (r.innerText || '').includes(needle) && r.offsetHeight > 0);
      if (!row) return false;
      row.click();
      return true;
    }, HTML_QUOTED_SUBJECT);
    expect(clicked).toBe(true);

    await browser.waitUntil(async () => {
      const v = await readViewer();
      return !!v.frameText;
    }, {
      timeout: 30_000,
      interval: 300,
      timeoutMsg: `Viewer never rendered a body; viewer: ${JSON.stringify(await readViewer())}`,
    });
    // The frame reloads when its srcDoc changes; let that land before reading.
    await browser.pause(1500);

    const viewer = await readViewer();
    expect(viewer.hasStaleBody).toBe(false);
    expect(viewer.frameText).not.toContain('previous server');
    expect(viewer.subject).toContain(HTML_QUOTED_SUBJECT);
    expect(viewer.subject).not.toContain(STALE_SUBJECT);
  });
});
