/**
 * E2E Test: INBOX on a server that files every folder under INBOX.
 *
 * bson73 (discussion #1) runs Dovecot: '.' delimiter, and an `INBOX.` prefix on
 * all 59 of his paths. mailboxDescendants matched the raw prefix, so clicking
 * INBOX listed the whole account — 26 000 messages instead of the 25 actually
 * filed in INBOX — and every row action from that list then resolved against a
 * branch scope that should never have existed.
 *
 * None of the three seeded accounts can carry the fixture: an INBOX-prefixed
 * server needs EVERY folder of the account under INBOX, and each seeded account
 * is load-bearing elsewhere (luke's nested branch, yoda's and vader's LIST
 * order, the visual baselines' avatar count). So this spec starts its own mock
 * server and adds a fourth account for the length of this file only.
 */

import { waitForApp, waitForEmails } from './helpers.js';
import { startMockImap, mailbox, mockAccount } from './mockImap.js';

const OWNER = 'bson73@mock.test';
// Ids must be 36-char UUIDs — db/emails.js parses local ids with a 36-char prefix.
const ACCOUNT_ID = '44444444-4444-4444-8444-444444444444';

/**
 * The reporter's namespace: INBOX is a sibling of the reader's folders, not
 * their parent. Sent's message carries its own prefix because the INBOX list
 * merges the account's Sent copies in — "Nested" has to mean "filed in a
 * subfolder INBOX must not list".
 */
const DOVECOT_STATE = {
  delimiter: '.',
  mailboxes: [
    mailbox('INBOX', 3, { owner: OWNER, attrs: ['\\HasChildren'], subjectPrefix: 'Dovecot inbox' }),
    mailbox('INBOX.Sent', 1, { owner: OWNER, attrs: ['\\HasNoChildren', '\\Sent'], subjectPrefix: 'Dovecot sent', uidStart: 101 }),
    mailbox('INBOX.Trash', 1, { owner: OWNER, attrs: ['\\HasNoChildren', '\\Trash'], subjectPrefix: 'Nested trash', uidStart: 201 }),
    mailbox('INBOX.Kunden', 1, { owner: OWNER, attrs: ['\\HasChildren'], subjectPrefix: 'Nested kunden', uidStart: 301 }),
    mailbox('INBOX.Kunden.Company XY', 1, { owner: OWNER, attrs: ['\\HasChildren'], subjectPrefix: 'Nested company', uidStart: 401 }),
    mailbox('INBOX.Kunden.Company XY.Project A', 1, { owner: OWNER, subjectPrefix: 'Nested project', uidStart: 501 }),
    mailbox('INBOX.Kunden.Meier', 1, { owner: OWNER, subjectPrefix: 'Nested meier', uidStart: 601 }),
  ],
};

// The branch, and the one row that leaves it.
const BRANCH_ROOT = 'INBOX.Kunden';
const BRANCH_FOLDERS = 4;
const MOVED = 'Nested company 401';
const STAYS = ['Nested kunden 301', 'Nested project 501', 'Nested meier 601'];
const MOVE_TARGET = 'INBOX.Trash';
const MOVE_ITEM = 'Move to folder';

describe('Dovecot INBOX prefix', function () {
  this.timeout(180_000);

  let server;
  let accountId;

  const store = () => browser.execute(() => {
    const s = window.__MAIL_STORE__?.getState?.() || {};
    return { activeMailbox: s.activeMailbox, scope: s.mailboxScope?.root || null, accounts: (s.accounts || []).length };
  });

  const subjects = () => browser.execute(() =>
    [...document.querySelectorAll('[data-testid="email-row"]')].map(r => (r.textContent || '').trim()));

  const title = () => browser.execute(() =>
    document.querySelector('[data-testid="mailbox-title"]')?.innerText || '');

  const clickFolder = (path) => browser.execute((p) => {
    const row = [...document.querySelectorAll('[data-testid="folder-row"]')]
      .find(r => r.getAttribute('data-path') === p);
    if (!row) return false;
    row.click();
    return true;
  }, path);

  const waitForFolder = (path) => browser.waitUntil(
    async () => browser.execute((p) => [...document.querySelectorAll('[data-testid="folder-row"]')]
      .some(r => r.getAttribute('data-path') === p), path),
    { timeout: 60_000, interval: 500, timeoutMsg: `folder row never appeared: ${path}` },
  );

  const waitForBranchList = (why) => browser.waitUntil(
    async () => {
      const seen = await subjects();
      return STAYS.every(want => seen.some(s => s.includes(want)));
    },
    { timeout: 60_000, interval: 500, timeoutMsg: why },
  );

  // ── Driving the row menu's Move to folder ────────────────────────────────
  // Plain data crosses into the page, never a function: the app's CSP has no
  // `unsafe-eval`, so a rebuilt callback is refused.
  const openRowMenu = (subject) => browser.execute((want) => {
    const row = [...document.querySelectorAll('[data-testid="email-row"]')]
      .filter(r => r.offsetHeight > 0)
      .find(r => (r.textContent || '').includes(want));
    const btn = row?.querySelector('button[aria-label="Row actions"]');
    if (!btn) return false;
    btn.click();
    return true;
  }, subject);

  const clickMenuItem = (label) => browser.execute((needle) => {
    for (const el of document.querySelectorAll('[role="menu"] [role="menuitem"]')) {
      if ((el.textContent || '').trim() === needle) { el.click(); return true; }
    }
    return false;
  }, label);

  const dropdownHeight = () => browser.execute(() =>
    document.querySelector('[data-testid="move-to-folder-dropdown"]')?.offsetHeight || 0);

  const pickTarget = (path) => browser.execute((p) => {
    const d = document.querySelector('[data-testid="move-to-folder-dropdown"]');
    for (const b of d?.querySelectorAll('[data-testid="move-folder-option"]') || []) {
      if (b.getAttribute('data-path') === p) { b.click(); return true; }
    }
    return false;
  }, path);

  /**
   * Remember the scope object now, and wait for a DIFFERENT one.
   *
   * A branch re-list publishes a new `mailboxScope`; the single-folder reload
   * this spec is about leaves the old object exactly where it was, so identity
   * is the one signal that says the branch was actually re-listed rather than
   * quietly collapsed — without it these cases would pass on a stale screen.
   */
  const markScope = () => browser.execute(() => {
    window.__DOVECOT_SCOPE__ = window.__MAIL_STORE__.getState().mailboxScope;
  });

  const waitForFreshScope = (why) => browser.waitUntil(
    async () => browser.execute(() => {
      const now = window.__MAIL_STORE__.getState().mailboxScope;
      return !!now && now !== window.__DOVECOT_SCOPE__;
    }),
    { timeout: 90_000, interval: 500, timeoutMsg: why },
  );

  /**
   * Run a store action that returns a promise and wait for its outcome.
   *
   * browser.execute never awaits an async callback, so the page has to park the
   * result somewhere this side can poll.
   */
  async function runInStore(action, args, what) {
    await browser.execute((name, a) => {
      window.__DOVECOT_RESULT__ = null;
      Promise.resolve(window.__MAIL_STORE__.getState()[name](...a)).then(
        (value) => { window.__DOVECOT_RESULT__ = { ok: true, value: (value && value.id) || null }; },
        (e) => { window.__DOVECOT_RESULT__ = { ok: false, error: String((e && e.message) || e) }; },
      );
    }, action, args);
    const outcome = await browser.waitUntil(
      async () => browser.execute(() => window.__DOVECOT_RESULT__),
      { timeout: 60_000, interval: 500, timeoutMsg: `${what} never settled` },
    );
    if (!outcome.ok) throw new Error(`${what} failed: ${outcome.error}`);
    return outcome.value;
  }

  before(async function () {
    await waitForApp();
    await waitForEmails();

    server = await startMockImap({ state: DOVECOT_STATE, faults: [] });
    const account = mockAccount({ id: ACCOUNT_ID, email: OWNER, port: server.port });

    accountId = await runInStore('addAccount', [account], 'addAccount');
    await runInStore('activateAccount', [accountId, 'INBOX'], 'activateAccount');

    // The folder list is a separate round trip from the first messages.
    await waitForFolder('INBOX.Kunden');
  });

  after(async function () {
    // Later spec files re-seed from the three original accounts, but this one's
    // own remaining tests must not see a fourth in the sidebar either.
    if (accountId) {
      try { await runInStore('removeAccount', [accountId], 'removeAccount'); }
      catch (e) { console.log('[dovecot] account removal:', e.message); }
    }
    server?.stop();
  });

  it('lists only what is filed in INBOX, not the whole account', async function () {
    expect(await clickFolder('INBOX')).toBe(true);

    await browser.waitUntil(
      async () => (await subjects()).some(s => s.includes('Dovecot inbox')),
      { timeout: 60_000, interval: 500, timeoutMsg: 'INBOX never listed its own messages' },
    );
    // A branch load is one round trip per folder and merges newest-first, so
    // the wrong rows land AFTER the right ones. Without this settle the
    // assertion below passes on timing alone, whatever mailboxDescendants says.
    await browser.pause(4000);

    const seen = await subjects();
    // The bug's signature: rows drawn from Kunden, Company XY and Trash.
    expect(seen.filter(s => s.includes('Nested'))).toEqual([]);
    expect(seen.filter(s => s.includes('Dovecot inbox')).length).toBe(3);
  });

  it('treats it as one folder, not a branch', async function () {
    // A scope is what tells every row action to read a row's folder off the
    // row, and what puts a branch total in the heading.
    expect((await store()).scope).toBe(null);
    expect(await title()).not.toMatch(/across/i);
  });

  it('still lists a real branch on the same server', async function () {
    // INBOX-specific, not a blanket removal of subtree listing: Kunden has
    // three folders under it and must show every one of them.
    await waitForFolder(BRANCH_ROOT);
    expect(await clickFolder(BRANCH_ROOT)).toBe(true);

    await waitForBranchList('Kunden never listed its branch');
    expect((await store()).scope).toBe(BRANCH_ROOT);
    expect(await title()).toMatch(new RegExp(`across ${BRANCH_FOLDERS} folders`, 'i'));
  });

  // ── A reload from inside the branch ──────────────────────────────────────
  //
  // Flat cases, not a nested describe: mocha runs a suite's own tests before
  // any child suite's, so a nested block would have run AFTER the INBOX case
  // below and found no branch on screen.
  //
  // loadEmails() is single-mailbox by construction, and every reload path ends
  // there: moving one mail out of a subfolder, or pressing Refresh, replaced
  // the branch listing with the root folder alone — while the heading still
  // said "across 4 folders" and the other subfolders' mail had simply gone.
  it('moves one nested message out of the branch through the row menu', async function () {
    await waitForBranchList('the branch list was not on screen to move from');
    await markScope();

    expect(await openRowMenu(MOVED)).toBe(true);
    expect(await clickMenuItem(MOVE_ITEM)).toBe(true);
    await browser.waitUntil(async () => (await dropdownHeight()) > 0,
      { timeout: 20_000, interval: 300, timeoutMsg: 'the folder list never opened' });
    expect(await pickTarget(MOVE_TARGET)).toBe(true);

    // The move ends in a reload. On the branch that reload is loadSubtree,
    // which publishes a NEW scope object — the single-folder reload leaves
    // the old one in place, and that is the collapse this waits out.
    await waitForFreshScope('the move never re-listed the branch');
  });

  it('is still the branch afterwards, not the root folder alone', async function () {
    expect((await store()).scope).toBe(BRANCH_ROOT);
    expect(await title()).toMatch(new RegExp(`across ${BRANCH_FOLDERS} folders`, 'i'));

    const seen = await subjects();
    expect(seen.some(s => s.includes(MOVED))).toBe(false);
    for (const stays of STAYS) {
      expect(seen.some(s => s.includes(stays))).toBe(true);
    }
  });

  it('survives Refresh', async function () {
    await markScope();
    // Exactly what the sidebar's Refresh button calls. It is throttled, so
    // the run can be a trailing one up to the cooldown later.
    await browser.execute(() => window.__MAIL_STORE__.getState().refreshCurrentView());
    await waitForFreshScope('Refresh never re-listed the branch');

    expect((await store()).scope).toBe(BRANCH_ROOT);
    expect(await title()).toMatch(new RegExp(`across ${BRANCH_FOLDERS} folders`, 'i'));

    await waitForBranchList('Refresh lost the other folders of the branch');
    expect((await subjects()).some(s => s.includes(MOVED))).toBe(false);
  });

  // Last, so the account is back on a plain INBOX before `after` removes it.
  it('goes back to a plain folder when INBOX is clicked again', async function () {
    expect(await clickFolder('INBOX')).toBe(true);

    await browser.waitUntil(
      async () => (await store()).scope === null && (await subjects()).some(s => s.includes('Dovecot inbox')),
      { timeout: 60_000, interval: 500, timeoutMsg: 'INBOX never came back as an ordinary folder' },
    );
    expect(await title()).not.toMatch(/across/i);
    expect((await subjects()).filter(s => s.includes('Nested'))).toEqual([]);
  });
});
