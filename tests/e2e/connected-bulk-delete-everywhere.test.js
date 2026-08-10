/**
 * E2E Test: bulk selection survives the modal, and Delete Everywhere sticks
 *
 * Two regressions in one spec:
 *  - the bulk modal used to compute its selection privately, so closing it
 *    (backdrop/X/Escape all minimize now, not cancel) threw the user's range
 *    away and the rows never showed a checkmark, and a session that survived
 *    a minimize forgot the step/action it was left on;
 *  - Delete Everywhere has to actually reach all three copies (server, local
 *    vault, external backup) or the rows come straight back after a reload.
 *
 * Runs against Account 2's Archive folder (3 seeded messages, "Archived
 * message 1/2/3") rather than either account's INBOX. The mock IMAP
 * server's state persists across spec files in this run (only local app
 * state resets between files — see wdio.conf.js's beforeSession), and both
 * accounts' INBOX contents are fixtures other connected-* specs depend on
 * for the rest of the run (connected-html-render's HTML message and
 * connected-thread-bodies' cross-folder thread live in account 1's INBOX;
 * connected-list-header asserts account 2's INBOX total verbatim). Nothing
 * else in the suite reads account 2's Archive folder, which makes it the one
 * safe place to run a real, permanent delete against.
 */

import { waitForApp, waitForEmails } from './helpers.js';

describe('Bulk delete everywhere', function () {
  this.timeout(180_000);

  const SUBJECT_RE = String.raw`Archived message \d+`;
  let folderName;

  // ── DOM helpers ─────────────────────────────────────────────────────────

  const rows = () => browser.execute((re) => {
    const pattern = new RegExp(re);
    return [...document.querySelectorAll('[data-testid="email-row"]')].map(row => ({
      subject: ((row.innerText || '').match(pattern) || [null])[0],
      checked: !!row.querySelector('input[type="checkbox"]')?.checked,
    })).filter(r => r.subject);
  }, SUBJECT_RE);

  const bodyIncludes = (needle) => browser.execute((t) => document.body.innerText.includes(t), needle);

  const bubbleText = () => browser.execute(() =>
    document.querySelector('[data-testid="bulk-selection-bubble"]')?.innerText || '');

  const bubbleCount = async () => {
    const m = (await bubbleText()).match(/([\d,]+) selected/);
    return m ? parseInt(m[1].replace(/,/g, ''), 10) : NaN;
  };

  const folderHeaderText = () => browser.execute(() => document.querySelector('h2')?.textContent?.trim() || '');

  /** Click the sidebar leaf (account email or folder name) matching exact text. */
  function clickSidebarItem(text) {
    return browser.execute((needle) => {
      const sidebar = document.querySelector('[data-testid="sidebar"]');
      if (!sidebar) return false;
      for (const el of sidebar.querySelectorAll('*')) {
        if (el.children.length === 0 && (el.textContent || '').trim() === needle) {
          el.click();
          return true;
        }
      }
      return false;
    }, text);
  }

  /** True once the sidebar's folder list has rendered past the INBOX placeholder. */
  const sidebarHasArchive = () => browser.execute(() =>
    (document.querySelector('[data-testid="sidebar"]')?.innerText || '').includes('Archive'));

  /** Click a visible, enabled button anywhere in the app whose text starts with `text`. */
  const clickByText = (text) => browser.execute((needle) => {
    for (const el of document.querySelectorAll('button')) {
      if (el.offsetHeight > 0 && !el.disabled && (el.textContent || '').trim().startsWith(needle)) {
        el.click();
        return true;
      }
    }
    return false;
  }, text);

  const clickTestId = (testid) => browser.execute((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    if (!el || el.offsetHeight === 0 || el.disabled) return false;
    el.click();
    return true;
  }, testid);

  function toggleRow(subject) {
    return browser.execute((needle, re) => {
      const pattern = new RegExp(re);
      for (const row of document.querySelectorAll('[data-testid="email-row"]')) {
        if (((row.innerText || '').match(pattern) || [null])[0] !== needle) continue;
        const box = row.querySelector('input[type="checkbox"]');
        if (!box) return false;
        box.click();
        return true;
      }
      return false;
    }, subject, SUBJECT_RE);
  }

  /**
   * BulkOperationsModal minimizes on Escape via its own `window` keydown
   * listener. `browser.keys(['Escape'])` is not reliable in this harness
   * (helpers.js's closeSettings works around the same gap) — dispatch the
   * real event directly instead.
   */
  const dispatchEscape = () => browser.execute(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
  });

  // ── wait helpers ────────────────────────────────────────────────────────

  const waitClick = (fn, msg) => browser.waitUntil(fn, { timeout: 15_000, interval: 300, timeoutMsg: msg });

  const waitForCheckedRows = (msg) => browser.waitUntil(
    async () => (await rows()).some(r => r.checked),
    { timeout: 15_000, interval: 300, timeoutMsg: msg },
  );

  const waitForBodyText = (needle, msg) => browser.waitUntil(
    () => bodyIncludes(needle),
    { timeout: 15_000, interval: 300, timeoutMsg: msg },
  );

  const waitForBubbleVisible = (msg) => browser.waitUntil(
    async () => browser.execute(() =>
      document.querySelector('[data-testid="bulk-selection-bubble"]')?.offsetHeight > 0),
    { timeout: 10_000, interval: 300, timeoutMsg: msg },
  );

  /** Switch to vader@mock.test's Archive folder — the disposable fixture this spec purges. */
  async function switchToVaderArchive() {
    const [, vaderEmail] = browser.mockAccounts.map(a => a.email);

    expect(await clickSidebarItem(vaderEmail)).toBe(true);
    try {
      await browser.waitUntil(sidebarHasArchive, { timeout: 8_000, interval: 300 });
    } catch {
      // The first folder fetch of a session can race credential loading and
      // fail silently (see connected-selection-actions.test.js) — one retry
      // covers it rather than the whole spec flaking on that race.
      expect(await clickSidebarItem(vaderEmail)).toBe(true);
      await browser.waitUntil(sidebarHasArchive, {
        timeout: 15_000, interval: 300, timeoutMsg: `${vaderEmail} never listed an Archive folder`,
      });
    }
    expect(await clickSidebarItem('Archive')).toBe(true);
    await waitForEmails();
  }

  before(async function () {
    await waitForApp();
    await waitForEmails();
    await switchToVaderArchive();
    folderName = await folderHeaderText();
    expect(folderName).toBe('Archive');
    expect((await rows()).length).toBeGreaterThan(0);
  });

  it('checkmarks the rows a range selects', async function () {
    // Header select-all checkbox opens the bulk modal at step 1.
    expect(await browser.execute(() => {
      const btn = document.querySelector('[data-testid="email-list-header"] button');
      if (!btn) return false;
      btn.click();
      return true;
    })).toBe(true);
    await waitForBodyText('Bulk Email Operations', 'Bulk modal never opened from the header select-all button');

    await waitClick(() => clickByText('All'), 'The "All" preset button never became clickable');
    await waitForCheckedRows('Rows never showed a checkmark after picking the "All" range');

    const checked = (await rows()).filter(r => r.checked);
    expect(checked.length).toBeGreaterThan(0);
  });

  it('minimizes to a bubble naming the folder and count', async function () {
    await waitClick(() => clickByText('Next'), 'Could not advance from step 1 to step 2');
    await waitForBodyText('Choose Action for', 'Modal never advanced to the action step');
    // Legend above the action list — proves it reads real counts, not a placeholder.
    expect(await bodyIncludes('on server')).toBe(true);

    await waitClick(() => clickTestId('bulk-action-delete_everywhere'), 'Could not select the Delete Everywhere action');

    // Backdrop/X/Escape all minimize (session + selection survive); only
    // step-1 Cancel ends the session.
    await dispatchEscape();
    await waitForBubbleVisible('Bubble never appeared after minimizing with Escape');

    const text = await bubbleText();
    expect(text).toContain('selected');
    expect(text).toContain('vader@mock.test');
    expect(text).toContain(folderName);
  });

  it('follows a hand-edited checkbox', async function () {
    const before = await bubbleCount();
    expect(before).toBeGreaterThan(0);

    const victim = (await rows()).find(r => r.checked)?.subject;
    expect(victim).toBeTruthy();
    expect(await toggleRow(victim)).toBe(true);

    await browser.waitUntil(async () => (await bubbleCount()) === before - 1, {
      timeout: 10_000,
      interval: 300,
      timeoutMsg: `Bubble count did not drop from ${before} after unchecking "${victim}"`,
    });
  });

  it('reopens the modal at the step it was left on and deletes everywhere', async function () {
    await waitClick(() => clickTestId('bulk-selection-bubble-reopen'), 'Could not reopen the modal from the bubble');
    // Lands back on step 2 with Delete Everywhere still selected — if the
    // session had reset to step 1, or lost the chosen action, the confirm
    // button below would still be disabled and nothing that follows would run.
    await waitForBodyText('Choose Action for', 'Reopened modal did not land back on the action step');

    await waitClick(() => clickTestId('bulk-step2-confirm'), 'Step 2 confirm button never became clickable');
    await waitForBodyText('Delete Everywhere?', 'Delete Everywhere confirmation dialog never appeared');
    expect(await bodyIncludes('the server, this computer, and your external backup')).toBe(true);
    expect(await bodyIncludes('no copy left anywhere')).toBe(true);

    await waitClick(() => clickTestId('bulk-delete-confirm'), 'Could not confirm Delete Everywhere');

    await browser.waitUntil(async () => (await rows()).length === 0, {
      timeout: 60_000,
      interval: 1000,
      timeoutMsg: 'Rows were still present after Delete Everywhere completed',
    });
  });

  it('does not bring the rows back on reload', async function () {
    await browser.execute(() => window.location.reload());
    await waitForApp();

    // A fresh boot always lands on account 1's INBOX, not wherever this spec
    // left off — navigate back to the folder that was purged to prove it.
    await switchToVaderArchive();

    expect((await rows()).length).toBe(0);
  });
});
