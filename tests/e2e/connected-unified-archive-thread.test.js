/**
 * E2E: "Archive All" on a thread opened from All Inboxes.
 *
 * The all-inboxes list mixes every account under the placeholder mailbox
 * 'UNIFIED'. Archive All used to read that placeholder — and whichever account
 * was activated last — off the view and hand both to `archive_emails`, so every
 * message in the thread failed: "Archived with 3 error(s)". The rows know their
 * own account and folder, and the archive has to land in THAT account's vault.
 *
 * The thread is luke's fragmented conversation (three incoming messages in his
 * INBOX), opened while vader is the active account, so the view and the rows
 * disagree on both the account and the mailbox — the shape of the report.
 */

import { waitForApp, waitForEmails, switchToFolder } from './helpers.js';
import { FRAGMENTED_SUBJECT } from './mockImap.js';

describe('All inboxes — Archive All on a thread from another account', function () {
  this.timeout(240_000);

  const LUKE = 'luke@mock.test';
  const VADER = 'vader@mock.test';
  const accountIdOf = (email) => (browser.mockAccounts || []).find((a) => a.email === email)?.id || null;

  /** Everything the archive depends on and everything it writes, in one read. */
  const storeView = () => browser.execute(() => {
    const s = window.__MAIL_STORE__?.getState?.();
    if (!s) return null;
    const pick = (e) => ({ uid: e.uid, acct: e._accountId, box: e._mailbox, subject: e.subject });
    return {
      unified: s.activeMailbox === 'UNIFIED' || s.unifiedInbox === true,
      accountId: s.activeAccountId,
      mailbox: s.activeMailbox,
      progress: s.bulkSaveProgress,
      error: s.error,
      thread: s.selectedThread ? s.selectedThread.emails.map(pick) : null,
      archived: [...(s.archivedEmailIds || [])],
      local: (s.localEmails || []).map(pick),
    };
  });

  const clickAllInboxes = () => browser.execute(() => {
    const btn = document.querySelector('[data-testid="all-inboxes-btn"]');
    if (!btn || btn.offsetHeight === 0) return false;
    btn.click();
    return true;
  });

  /**
   * Click the `skip`-th rendered thread row carrying `subject`, paging the
   * virtualized list when none is in the render window. The rows do not say
   * whose they are, so the caller checks the opened thread and asks for the
   * next one if it belongs to another account.
   */
  const clickThreadRow = (subject, skip) => browser.execute((subj, n) => {
    const rows = [...document.querySelectorAll('[data-testid="email-row"]')]
      .filter((r) => r.offsetHeight > 0
        && Number(r.getAttribute('data-thread-count') || 1) > 1
        && (r.textContent || '').includes(subj));
    if (rows[n]) { rows[n].click(); return true; }
    const list = [...document.querySelectorAll('div')]
      .find((d) => d.scrollHeight > d.clientHeight + 200 && d.clientHeight > 200);
    if (list) {
      const next = list.scrollTop + list.clientHeight;
      list.scrollTop = next >= list.scrollHeight - list.clientHeight ? 0 : next;
    }
    return false;
  }, subject, skip);

  const archiveAllButton = () => browser.execute(() => {
    const btn = [...document.querySelectorAll('button')]
      .find((b) => b.offsetHeight > 0 && (b.textContent || '').trim() === 'Archive All');
    return btn ? true : false;
  });

  const clickArchiveAll = () => browser.execute(() => {
    const btn = [...document.querySelectorAll('button')]
      .find((b) => b.offsetHeight > 0 && (b.textContent || '').trim() === 'Archive All');
    if (!btn) return false;
    btn.click();
    return true;
  });

  const rowIcon = (subject) => browser.execute((needle) => {
    const row = [...document.querySelectorAll('[data-testid="email-row"]')]
      .find((r) => r.offsetHeight > 0 && (r.innerText || '').includes(needle));
    return row ? (row.querySelector('[data-testid="msg-state-icon"]')?.getAttribute('data-state') || null) : null;
  }, subject);

  let lukeId = null;
  let threadUids = [];

  before(async function () {
    await waitForApp();
    await waitForEmails();
    lukeId = accountIdOf(LUKE);
    expect(lukeId).not.toBeNull();
  });

  it("opens luke's thread from All Inboxes while vader is the active account", async function () {
    // The unified list is built from each account's header cache, so luke has
    // to have been opened once — and vader last, so the view's account is the
    // wrong one for this thread.
    await switchToFolder(LUKE, 'INBOX');
    await switchToFolder(VADER, 'INBOX');

    expect(await clickAllInboxes()).toBe(true);
    await browser.waitUntil(async () => (await storeView())?.unified === true, {
      timeout: 30_000, interval: 300, timeoutMsg: 'never entered the unified list',
    });
    await waitForEmails();
    // Wait for the DATA, not the mode: the rows carry `_accountId` only once
    // the per-account merge has landed.
    await browser.waitUntil(async () => browser.execute((subj, acct) => {
      const s = window.__MAIL_STORE__?.getState?.();
      return (s?.emails || []).filter((e) => (e.subject || '').includes(subj) && e._accountId === acct).length >= 3;
    }, FRAGMENTED_SUBJECT, lukeId), {
      timeout: 60_000, interval: 400,
      timeoutMsg: `the unified list never merged luke's "${FRAGMENTED_SUBJECT}" messages in`,
    });

    const view = await storeView();
    expect(view.accountId).not.toBe(lukeId);

    // The row carries no account, so open matching thread rows in turn until
    // the reader shows luke's.
    let skip = 0;
    let opened = null;
    await browser.waitUntil(async () => {
      if (!(await clickThreadRow(FRAGMENTED_SUBJECT, skip))) return false;
      await browser.waitUntil(async () => (await storeView())?.thread?.length > 0, {
        timeout: 10_000, interval: 200,
      });
      const { thread } = await storeView();
      if (thread.every((e) => e.acct === lukeId)) { opened = thread; return true; }
      skip += 1;
      return false;
    }, {
      timeout: 90_000, interval: 500,
      timeoutMsg: `never opened luke's "${FRAGMENTED_SUBJECT}" thread from the unified list`,
    });

    expect(opened.length).toBe(3);
    expect(opened.every((e) => e.box === 'INBOX')).toBe(true);
    threadUids = opened.map((e) => e.uid);
    await browser.waitUntil(archiveAllButton, {
      timeout: 15_000, interval: 200, timeoutMsg: 'the thread reader shows no Archive All button',
    });
  });

  it("archives every message into luke's vault, with no error", async function () {
    expect(threadUids.length).toBe(3);
    expect(await clickArchiveAll()).toBe(true);

    await browser.waitUntil(async () => {
      const p = (await storeView())?.progress;
      return p && p.active === false;
    }, {
      timeout: 60_000, interval: 300,
      timeoutMsg: `the archive never finished (store says ${JSON.stringify((await storeView())?.progress)})`,
    });

    const after = await storeView();
    expect(after.progress).toEqual(expect.objectContaining({ total: 3, completed: 3, errors: 0 }));
    expect(after.error).toBeNull();
    for (const uid of threadUids) expect(after.archived).toContain(uid);
    // The vault rows are luke's, in his INBOX — not the active account's.
    const vaultRows = after.local.filter((e) => threadUids.includes(e.uid) && e.acct === lukeId && e.box === 'INBOX');
    expect(vaultRows.length).toBe(3);

    // Nothing left to archive in this thread.
    await browser.waitUntil(async () => !(await archiveAllButton()), {
      timeout: 15_000, interval: 200, timeoutMsg: 'Archive All is still offered after the whole thread was archived',
    });
  });

  it("shows the thread as archived in luke's own INBOX", async function () {
    await switchToFolder(LUKE, 'INBOX');
    await browser.waitUntil(async () => (await rowIcon(FRAGMENTED_SUBJECT) || '').startsWith('archived'), {
      timeout: 60_000, interval: 500,
      timeoutMsg: `luke's "${FRAGMENTED_SUBJECT}" row never read as archived (icon: ${await rowIcon(FRAGMENTED_SUBJECT)})`,
    });
  });
});
