/**
 * E2E Test: SelectionActionBar — every action changes the list
 *
 * connected-email-list.test.js proves the bar and its buttons render. This spec
 * proves each button's *effect* lands on the rendered rows: mark read/unread
 * repaint the row, archive flips its source icon, move and delete remove it.
 *
 * The regression it exists for: marking a selection as read updated the store's
 * `emails` but not the memoized `sortedEmails`/thread objects the rows render,
 * so the row kept its unread styling until something else forced a re-derive.
 *
 * Runs against the mock IMAP server in an isolated HOME, so the destructive
 * paths (move, delete) really run.
 */

import { waitForApp, waitForEmails } from './helpers.js';

describe('Selection Action Bar effects', function () {
  this.timeout(120_000);

  before(async function () {
    await waitForApp();
    await waitForEmails();
  });

  /**
   * Move needs a folder to move into. The account that activates first does so
   * before its credentials finish loading, its one folder fetch fails ("Password
   * missing"), and nothing retries it — that account then knows only INBOX for
   * the rest of the session, even across re-activation. Switch to whichever
   * account did get a folder list.
   */
  async function ensureMoveTargets() {
    const hasFolders = () => browser.execute(() =>
      (document.querySelector('[data-testid="sidebar"]')?.innerText || '').includes('Archive'));
    if (await hasFolders()) return;

    const clickAccount = (email) => browser.execute((needle) => {
      const sidebar = document.querySelector('[data-testid="sidebar"]');
      for (const el of sidebar.querySelectorAll('*')) {
        if (el.children.length === 0 && (el.textContent || '').trim() === needle) {
          el.click();
          return true;
        }
      }
      return false;
    }, email);

    for (const { email } of browser.mockAccounts) {
      if (!(await clickAccount(email))) continue;
      await browser.pause(4000);
      if (await hasFolders()) {
        await waitForEmails();
        return;
      }
    }
    throw new Error('No account ever listed a folder to move into');
  }

  // ── row helpers ──────────────────────────────────────────────────────────
  // Rows are virtualized and recycled, so nothing may be held across a render.
  // The mock subject ("Luke message 7") is the stable handle — matched whole,
  // since "Luke message 1" is a prefix of "Luke message 19". The unread marker
  // is the `bg-mail-surface` class EmailRow/ThreadRow put on the row root.

  const SUBJECT_RE = String.raw`(?:Luke|Vader|Mock|Archived|Sent) message \d+`;

  const rows = () => browser.execute((re) => {
    const pattern = new RegExp(re);
    return [...document.querySelectorAll('[data-testid="email-row"]')].map(row => {
      // Derived from the state icon's `data-state`, not from the row's old
      // title="Archived" / title^="Local only" badges: the message-state-icon
      // rollout (commit 8c2fe9f) removed those attributes, so selecting on them
      // silently found nothing forever and every wait on these booleans timed
      // out. Same derivation connected-storage-matrix already uses — the old
      // "Archived" badge showed whenever `isArchived && source !== 'local-only'`,
      // which is exactly every `archived*` id (the `-server-unknown` variant
      // included: it means "archived, server copy unproven", which the old badge
      // had no concept of and rendered identically), and the old "Local only"
      // badge showed whenever `source === 'local-only'`, exactly every
      // `local-only*` id.
      const icon = row.querySelector('[data-testid="msg-state-icon"]')?.getAttribute('data-state') || null;
      return {
        subject: ((row.innerText || '').match(pattern) || [null])[0],
        unread: row.classList.contains('bg-mail-surface'),
        archived: !!icon && icon.startsWith('archived'),
        icon,
      };
    }).filter(r => r.subject);
  }, SUBJECT_RE);

  /** Subjects of the first `count` rows matching a predicate. */
  async function pickSubjects(predicate, count = 1) {
    return (await rows()).filter(predicate).map(r => r.subject).slice(0, count);
  }

  const rowFor = async (subject) => (await rows()).find(r => r.subject === subject);

  function toggleRow(subject) {
    return browser.execute((needle, re) => {
      const pattern = new RegExp(re);
      for (const row of document.querySelectorAll('[data-testid="email-row"]')) {
        const found = ((row.innerText || '').match(pattern) || [null])[0];
        if (found !== needle) continue;
        const box = row.querySelector('input[type="checkbox"]');
        if (!box) return false;
        box.click();
        return true;
      }
      return false;
    }, subject, SUBJECT_RE);
  }

  function clickBarButton(title) {
    return browser.execute((btnTitle) => {
      const btn = document.querySelector(`button[title="${btnTitle}"]`);
      if (!btn || btn.offsetHeight === 0) return false;
      btn.click();
      return true;
    }, title);
  }

  const waitForRow = (subject, predicate, msg) => browser.waitUntil(
    async () => {
      const row = await rowFor(subject);
      return row ? predicate(row) : false;
    },
    { timeout: 20_000, interval: 300, timeoutMsg: msg },
  );

  const waitForRowGone = (subject, msg) => browser.waitUntil(
    async () => (await rowFor(subject)) === undefined,
    { timeout: 20_000, interval: 500, timeoutMsg: msg },
  );

  /**
   * Checked boxes, not the bar's presence: the bar leaves through a framer-motion
   * exit animation, and on a runner whose window is occluded the rAF that drives
   * it never fires, so the node lingers with stale text. The checkboxes are plain
   * React state and tell the truth about the selection either way.
   */
  const waitForNothingSelected = () => browser.waitUntil(
    async () => browser.execute(() =>
      [...document.querySelectorAll('[data-testid="email-row"] input[type="checkbox"]')]
        .every(c => !c.checked)),
    {
      timeout: 10_000,
      interval: 200,
      timeoutMsg: 'Rows still checked — the action did not clear the selection',
    },
  );

  const waitForText = (needle, msg) => browser.waitUntil(
    async () => browser.execute((t) => document.body.innerText.includes(t), needle),
    { timeout: 30_000, interval: 300, timeoutMsg: msg },
  );

  // ── mark as read / unread ────────────────────────────────────────────────

  it('marks a selected row as read and repaints it', async function () {
    const [subject] = await pickSubjects(r => r.unread && !r.archived);
    expect(subject).toBeDefined();

    expect(await toggleRow(subject)).toBe(true);
    expect(await clickBarButton('Mark as read')).toBe(true);

    await waitForRow(subject, r => !r.unread, `Row "${subject}" still styled unread after Mark as read`);
    await waitForNothingSelected();
  });

  it('marks a row back as unread', async function () {
    const [subject] = await pickSubjects(r => !r.unread && !r.archived);
    expect(subject).toBeDefined();

    expect(await toggleRow(subject)).toBe(true);
    expect(await clickBarButton('Mark as unread')).toBe(true);

    await waitForRow(subject, r => r.unread, `Row "${subject}" never returned to unread styling`);
    await waitForNothingSelected();
  });

  it('marks several selected rows as read in one action', async function () {
    const subjects = await pickSubjects(r => r.unread && !r.archived, 2);
    expect(subjects.length).toBe(2);

    for (const s of subjects) expect(await toggleRow(s)).toBe(true);
    expect(await clickBarButton('Mark as read')).toBe(true);

    for (const s of subjects) {
      await waitForRow(s, r => !r.unread, `Row "${s}" still styled unread after bulk Mark as read`);
    }
    await waitForNothingSelected();
  });

  // ── archive / unarchive ──────────────────────────────────────────────────

  it('archives a selected row and flips its source icon to local', async function () {
    const [subject] = await pickSubjects(r => !r.archived);
    expect(subject).toBeDefined();

    expect(await toggleRow(subject)).toBe(true);
    expect(await clickBarButton('Archive selected')).toBe(true);

    await waitForRow(subject, r => r.archived, `Row "${subject}" never showed the archived icon`);
    // The icon flips on the first progress event, before the download finishes.
    // Unarchiving mid-flight would race the archive's own completion write.
    await waitForText('Archived Successfully', 'Archive never reported completion');
  });

  it('unarchives it again', async function () {
    const [subject] = await pickSubjects(r => r.archived);
    expect(subject).toBeDefined();

    expect(await toggleRow(subject)).toBe(true);
    expect(await clickBarButton('Unarchive selected')).toBe(true);

    await waitForRow(subject, r => !r.archived, `Row "${subject}" still shows as archived after Unarchive`);
  });

  // ── move ─────────────────────────────────────────────────────────────────

  it('moves a selected row to another folder and drops it from the list', async function () {
    await ensureMoveTargets();

    const [subject] = await pickSubjects(r => !r.archived);
    expect(subject).toBeDefined();

    expect(await toggleRow(subject)).toBe(true);
    expect(await clickBarButton('Move to folder')).toBe(true);
    await browser.waitUntil(
      async () => browser.execute(() =>
        document.querySelector('[data-testid="move-to-folder-dropdown"]')?.offsetHeight > 0),
      { timeout: 10_000, interval: 200, timeoutMsg: 'Move-to-folder dropdown never opened' },
    );

    const picked = await browser.execute(() => {
      const dropdown = document.querySelector('[data-testid="move-to-folder-dropdown"]');
      for (const btn of dropdown.querySelectorAll('button')) {
        if ((btn.textContent || '').trim() === 'Archive') { btn.click(); return 'Archive'; }
      }
      return [...dropdown.querySelectorAll('button')].map(b => b.textContent.trim()).join('|');
    });
    expect(picked).toBe('Archive');

    await waitForRowGone(subject, `Row "${subject}" is still in the list after being moved`);
  });

  // ── delete ───────────────────────────────────────────────────────────────

  it('deletes a selected row from the server and drops it from the list', async function () {
    const [subject] = await pickSubjects(r => !r.archived);
    expect(subject).toBeDefined();

    expect(await toggleRow(subject)).toBe(true);
    expect(await clickBarButton('Delete from server')).toBe(true);
    await waitForText('cannot be undone', 'Delete confirmation never appeared');

    // The bar's own trigger carries a title; the popover's confirm button does not.
    const confirmed = await browser.execute(() => {
      for (const btn of document.querySelectorAll('button')) {
        if ((btn.textContent || '').trim() === 'Delete' && btn.offsetHeight > 0 &&
            !btn.getAttribute('title')) {
          btn.click();
          return true;
        }
      }
      return false;
    });
    expect(confirmed).toBe(true);

    await waitForRowGone(subject, `Row "${subject}" is still in the list after being deleted`);
  });
});
