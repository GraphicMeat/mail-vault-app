/**
 * E2E: a thread message whose vault copy is another message.
 *
 * The vault Maildir is keyed (accountId, mailbox, uid) with no per-file
 * generation proof, so after a UIDVALIDITY reissue the file under uid N is
 * whatever the PREVIOUS server called uid N. `useChatBodyLoader` caught that
 * with a Message-ID check — and then treated it as the end of the road
 * (`retryCount = MAX_RETRIES`, "a retry reads the same wrong location"). True
 * of the server; false of the disk. The server still holds the message the row
 * was built from, and it was never asked.
 *
 * What the user saw (rare@graphicmeat.com, 2026-08-26): the thread printed the
 * row's own SUBJECT in italics where its body belongs — "Affiliate program" —
 * which is pixel-identical to a message whose body really is one line.
 *
 * Its own spec file on purpose, the same reason
 * connected-vault-uid-reissue.test.js is: opening this thread anywhere earlier
 * fills the in-memory body cache, the loader never reaches the vault, and the
 * whole thing passes without exercising the guard.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { waitForApp, waitForEmails } from './helpers.js';
import { appDataDir, CROSS_FOLDER_SUBJECT, CROSS_FOLDER_INBOX_BODY } from './mockImap.js';

const LUKE = 'luke@mock.test';

// Nothing the mock server serves, so a hit is unambiguous.
const STALE_MARKER = 'mv-stale-thread-vault-body';

// A Message-ID unlike the row's is the one field that can prove this file is
// not the message the row names.
const staleEml = (to) => [
  'From: Old Host <team@previous-host.test>',
  `To: ${to}`,
  'Subject: Message left behind by the previous server',
  'Message-ID: <archived-under-the-old-uid@previous-host.test>',
  'Date: Thu, 19 Mar 2026 07:56:23 +0000',
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  '',
  `${STALE_MARKER}: body archived under this UID by the previous server.`,
  '',
].join('\r\n');

/** Open the multi-message thread carrying `subject` (same shape as connected-thread-bodies). */
async function openThread(subject) {
  let opened = false;
  await browser.waitUntil(
    async () => {
      opened = await browser.execute((subj) => {
        const rows = [...document.querySelectorAll('[data-testid="email-row"]')];
        const row = rows.find(r => r.offsetHeight > 0
          && Number(r.getAttribute('data-thread-count') || 1) > 1
          && (r.textContent || '').includes(subj));
        if (row) { row.click(); return true; }
        const list = [...document.querySelectorAll('div')]
          .find(d => d.scrollHeight > d.clientHeight + 200 && d.clientHeight > 200);
        if (list) list.scrollTop = list.scrollTop > 0 ? 0 : list.scrollTop + list.clientHeight;
        return false;
      }, subject);
      if (!opened) return false;
      return browser.execute(() => (document.body.textContent || '').includes('messages in thread'));
    },
    { timeout: 45_000, interval: 1000, timeoutMsg: `no thread row for "${subject}"` },
  );
}

/**
 * Expand every collapsed message and report what the thread is showing.
 *
 * The chevron, not the header: a click on the header itself now opens a reply
 * to that message, and would leave every body still folded behind a compose.
 */
async function readThread() {
  await browser.execute(() => {
    for (const header of document.querySelectorAll('[data-testid="thread-email-header"]')) {
      const item = header.parentElement;
      const busy = item.querySelector('.email-content, iframe, .animate-spin');
      if (!busy && header.offsetHeight > 0) header.querySelector('[data-testid="header-toggle"]')?.click();
    }
  });
  return browser.execute(() => ({
    headers: document.querySelectorAll('[data-testid="thread-email-header"]').length,
    // Plain-text bodies render as React text, no iframe.
    texts: [...document.querySelectorAll('.email-content')]
      .map(b => (b.textContent || '').trim())
      .filter(Boolean),
    // The honest failure state — and, before the fix, the state this bug hit.
    errors: [...document.querySelectorAll('[data-testid="thread-body-error"]')]
      .map(e => (e.textContent || '').trim()),
    // Everything on screen, so a fallback that prints the subject is visible
    // to the assertions even though it carries no class of its own.
    text: (document.body.innerText || ''),
  }));
}

describe('Thread body — vault copy under a reissued UID', function () {
  this.timeout(180_000);

  let accountId = null;
  let stalePath = null;

  before(async function () {
    await waitForApp();
    await waitForEmails();

    accountId = browser.mockAccounts.find((a) => a.email === LUKE).id;

    // The INBOX half of the cross-folder thread. Its uid is the one the vault
    // will be seeded under; the Sent half is left alone, so the same thread
    // carries a working message and a poisoned one.
    const target = await browser.execute((needle) => {
      const rows = window.__MAIL_STORE__?.getState()?.sortedEmails || [];
      const row = rows.find((e) => (e.subject || '') === needle);
      return row ? { uid: row.uid, subject: row.subject, messageId: row.messageId } : null;
    }, CROSS_FOLDER_SUBJECT);

    expect(target).not.toBe(null);

    const cur = join(appDataDir(browser.testDataDir), 'Maildir', accountId, 'INBOX', 'cur');
    mkdirSync(cur, { recursive: true });
    // `find_by_uid` (src-core/src/maildir.rs) matches on the `<uid>:` prefix.
    stalePath = join(cur, `${target.uid}:seen:0.eml`);
    writeFileSync(stalePath, staleEml(LUKE));
  });

  it('seeded a vault file under the thread message own uid', function () {
    // Positive control: every assertion below is about what does NOT render,
    // and an absence proves nothing until the container is proven populated.
    expect(existsSync(stalePath)).toBe(true);
  });

  it('renders the server body instead of falling back to the subject', async function () {
    await openThread(CROSS_FOLDER_SUBJECT);

    await browser.waitUntil(
      async () => {
        const t = await readThread();
        return t.headers > 0 && t.texts.join('\n').includes(CROSS_FOLDER_INBOX_BODY);
      },
      {
        timeout: 60_000,
        interval: 1500,
        timeoutMsg: `the poisoned message never rendered its real body: ${JSON.stringify(await readThread())}`,
      },
    );

    const thread = await readThread();
    const joined = thread.texts.join('\n');

    expect(joined).toContain(CROSS_FOLDER_INBOX_BODY);
    // The vault's message must not reach the screen under this row.
    expect(thread.text).not.toContain(STALE_MARKER);
    expect(thread.text).not.toContain('previous server');
    // And the load must not have failed — the italic-subject fallback and the
    // honest error are the two ways this ends badly.
    expect(thread.errors).toEqual([]);
  });
});
