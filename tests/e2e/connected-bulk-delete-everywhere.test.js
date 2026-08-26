/**
 * E2E Test: bulk selection survives the modal, and Delete Everywhere actually
 * removes the local vault copy (not just the server copy)
 *
 * Three regressions in one spec:
 *  - the bulk modal used to compute its selection privately, so closing it
 *    (backdrop/X/Escape all minimize now, not cancel) threw the user's range
 *    away and the rows never showed a checkmark, and a session that survived
 *    a minimize forgot the step/action it was left on;
 *  - "Delete from Server" on an archived message used to look like a no-op:
 *    the server copy went, the local vault copy stayed, and the row came
 *    straight back as "Local only (deleted from server)" — this is the
 *    original bug report Delete Everywhere exists to fix, so this spec pins
 *    it as an explicit intermediate assertion, not just prose;
 *  - Delete Everywhere has to actually remove the vault `.eml` file and the
 *    backup mirror, not just the server copy, or the row reappears after a
 *    reload exactly like the bug above. Proving that needs a REAL local
 *    artifact to fail to remove: `source: 'local-only'` requires both a vault
 *    `.eml` (written by the archive step below) and `archivedEmailIds.has(uid)`
 *    (messageListSlice.js:137,154) — a spec that runs Delete Everywhere on
 *    plain server-only messages would pass identically whether or not the
 *    vault/backup purge phases in `purgeEverywhere` ran at all, since there'd
 *    be no local copy either way for a dropped purge to fail to remove.
 *
 * So this spec archives its fixtures first, deliberately strips one from the
 * server to pin the intermediate "stays behind as local-only" state, and only
 * then runs Delete Everywhere on the rest — reload afterward has to
 * distinguish "purged" from "still local-only" for both groups to pass.
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
 * safe place to run real, permanent deletes against (see the guard comment
 * next to its definition in mockImap.js).
 */

import { waitForApp, waitForEmails, switchToFolder } from './helpers.js';

describe('Bulk delete everywhere', function () {
  this.timeout(180_000);

  const SUBJECT_RE = String.raw`Archived message \d+`;
  let folderName;
  // The one fixture deliberately stripped from the server (but not purged)
  // in the intermediate check — must still be present, still local-only,
  // both before and after the later Delete Everywhere run and the reload.
  let localOnlySubject;
  // The two fixtures actually run through Delete Everywhere — must be gone,
  // and must stay gone after a reload.
  let deletedSubjects;

  /**
   * These tests share state by design: each step builds on the folder state
   * the previous one left. When an earlier step fails, the later ones would
   * otherwise die on `undefined` with a `TypeError` that says nothing about
   * the real problem — three red tests for one defect, and the two noisy ones
   * on top. Fail them with the actual reason instead.
   */
  function requireSubjects(value, name, setBy) {
    if (!value) {
      throw new Error(`"${name}" was never set — the "${setBy}" step did not complete, so this test cannot run. Fix that failure first.`);
    }
    return value;
  }

  // ── DOM helpers ─────────────────────────────────────────────────────────

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
        checked: !!row.querySelector('input[type="checkbox"]')?.checked,
        archived: !!icon && icon.startsWith('archived'),
        localOnly: !!icon && icon.startsWith('local-only'),
        icon,
      };
    }).filter(r => r.subject);
  }, SUBJECT_RE);

  const rowFor = async (subject) => (await rows()).find(r => r.subject === subject);

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

  /**
   * Click a visible, enabled button outside the sidebar whose text starts
   * with `text`. Scoped away from the sidebar because it renders before the
   * modal in the DOM and carries its own "All" button (the server/local/all
   * View Mode toggle) — an unscoped search matches that one first and clicks
   * it silently (setViewMode('all') on an already-'all' view is a no-op, so
   * nothing visibly changes and the real failure only shows up as the range
   * preset never registering).
   */
  const clickByText = (text) => browser.execute((needle) => {
    const sidebar = document.querySelector('[data-testid="sidebar"]');
    for (const el of document.querySelectorAll('button')) {
      if (sidebar && sidebar.contains(el)) continue;
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

  /** SelectionActionBar button — same pattern as connected-selection-actions.test.js. */
  function clickBarButton(title) {
    return browser.execute((btnTitle) => {
      const btn = document.querySelector(`button[title="${btnTitle}"]`);
      if (!btn || btn.offsetHeight === 0) return false;
      btn.click();
      return true;
    }, title);
  }

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

  /**
   * Switch to vader@mock.test's Archive folder — the disposable fixture this
   * spec purges.
   *
   * `expectEmails: false` for the post-reload check: by then this spec has
   * purged two of the three fixtures and server-deleted the third, so the
   * folder holds no server messages at all. The shared `waitForEmails()` helper
   * requires at least one row and would time out on a folder this spec
   * deliberately emptied — which is a pass, not a failure.
   */
  async function switchToVaderArchive({ expectEmails = true } = {}) {
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
    if (expectEmails) {
      await waitForEmails();
    } else {
      // Wait for the folder to actually be the one on screen, then let the list
      // settle — zero rows is a legitimate outcome here.
      await browser.waitUntil(async () => (await folderHeaderText()) === 'Archive', {
        timeout: 15_000, interval: 300, timeoutMsg: 'Never landed on the Archive folder after reload',
      });
      await browser.pause(2000);
    }
  }

  before(async function () {
    await waitForApp();
    await waitForEmails();
    // The shared helper for the opening switch, not the local one: this spec
    // now starts from a genuinely cold app data dir (wdio.conf.js exports
    // E2E_DATA_DIR, so beforeSession's resetAppState finally wipes the
    // directory the app actually uses), and a cold first fetch of vader's
    // Archive can land with zero rows. switchToFolder retries the whole
    // sequence and waits for the store to settle on the pair it asked for;
    // the local switchToVaderArchive only retries the sidebar listing.
    const [, vaderEmail] = browser.mockAccounts.map(a => a.email);
    await switchToFolder(vaderEmail, 'Archive');
    folderName = await folderHeaderText();
    expect(folderName).toBe('Archive');
    expect((await rows()).length).toBeGreaterThan(0);
  });

  /**
   * Put the app back where the next spec expects to find it.
   *
   * The suite is single-tenant: every spec drives one long-lived app instance,
   * so a spec that navigates owns putting it back. This one switches to
   * account 2's Archive folder and, without this hook, strands every later
   * spec on the wrong account and folder — `connected-list-header` and
   * `connected-move-to-folder` both broke that way the first time this spec
   * ran, and neither had changed.
   *
   * Navigating away also ends any live bulk session: it is bound to the
   * (account, mailbox, viewMode) it was created in and `EmailList` tears it
   * down on mismatch, so the bubble and selection cannot leak forward either.
   *
   * Never let cleanup throw — a failure here would mask the real failure that
   * a test above already reported.
   */
  after(async function () {
    try {
      const [lukeEmail] = browser.mockAccounts.map(a => a.email);
      await clickSidebarItem(lukeEmail);
      await browser.waitUntil(
        async () => (await folderHeaderText()) !== 'Archive',
        { timeout: 8_000, interval: 300 },
      ).catch(() => {});
      await clickSidebarItem('INBOX');
      await waitForEmails();
    } catch (e) {
      console.warn('[bulk-delete-everywhere] cleanup could not restore INBOX:', e.message);
    }
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

  it('archives the fixtures so Delete Everywhere has a real local copy to purge', async function () {
    await waitClick(() => clickByText('Next'), 'Could not advance from step 1 to step 2');
    await waitForBodyText('Choose Action for', 'Modal never advanced to the action step');

    await waitClick(() => clickTestId('bulk-action-archive'), 'Could not select the Archive action');
    await waitClick(() => clickTestId('bulk-step2-confirm'), 'Step 2 confirm button (Archive) never became clickable');

    await waitForBodyText('Operation Complete', 'Archive operation never reported completion');
    await browser.waitUntil(
      async () => {
        const list = await rows();
        return list.length === 3 && list.every(r => r.archived);
      },
      { timeout: 30_000, interval: 500, timeoutMsg: 'Not all 3 fixture rows showed the Archived indicator' },
    );
  });

  it('keeps a Local-only row after Delete from Server — the bug this feature exists for', async function () {
    localOnlySubject = (await rows()).find(r => r.archived)?.subject;
    expect(localOnlySubject).toBeTruthy();

    expect(await toggleRow(localOnlySubject)).toBe(true);
    expect(await clickBarButton('Delete from server')).toBe(true);
    await waitForBodyText('cannot be undone', 'Delete-from-server confirmation never appeared');

    const confirmed = await browser.execute(() => {
      for (const btn of document.querySelectorAll('button')) {
        if ((btn.textContent || '').trim() === 'Delete' && btn.offsetHeight > 0 && !btn.getAttribute('title')) {
          btn.click();
          return true;
        }
      }
      return false;
    });
    expect(confirmed).toBe(true);

    // Waits out the real reconcile round-trip: the row is optimistically kept
    // (it's still in `localEmails`/archivedEmailIds) but only flips from the
    // "Archived" indicator to "Local only" once the server no longer lists
    // the uid — i.e. once the delete has actually landed.
    await browser.waitUntil(
      async () => (await rowFor(localOnlySubject))?.localOnly === true,
      {
        timeout: 30_000,
        interval: 500,
        timeoutMsg: `"${localOnlySubject}" never settled into a Local-only row after Delete from Server`,
      },
    );
    // The point of this whole test: it must still be a row, not gone.
    expect(await rowFor(localOnlySubject)).toBeTruthy();
  });

  it('minimizes to a bubble naming the folder and count', async function () {
    expect(await browser.execute(() => {
      const btn = document.querySelector('[data-testid="email-list-header"] button');
      if (!btn) return false;
      btn.click();
      return true;
    })).toBe(true);
    await waitForBodyText('Bulk Email Operations', 'Bulk modal never reopened from the header select-all button');

    await waitClick(() => clickByText('All'), 'The "All" preset button never became clickable');
    await waitForCheckedRows('Rows never showed a checkmark after picking the "All" range');

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

  it('follows a hand-edited checkbox, excluding the message already proven local-only', async function () {
    // Poll rather than read once: this runs immediately after the previous
    // test minimized the modal, and a bare read cannot tell "the count is
    // wrong" from "the count has not painted yet". On failure, report what the
    // bubble and the rows actually said — a bare `Expected 3, Received 0` sent
    // an earlier diagnosis down the wrong path entirely.
    let before;
    try {
      await browser.waitUntil(
        async () => { before = await bubbleCount(); return before === 3; },
        { timeout: 10_000, interval: 300 },
      );
    } catch {
      // Gather the evidence at failure time, not before the wait.
      const t = await bubbleText();
      const r = await rows();
      throw new Error(`Bubble never reported 3 selected (last read: ${before}). bubble="${t}" rows=${JSON.stringify(r)}`);
    }

    // Deselect the fixture the previous test already deleted from the server —
    // it has no server copy left for Delete Everywhere's server phase to act
    // on, and this spec already pinned its local-only behavior on its own.
    // What's left checked is exactly the two still-archived, still-on-server
    // messages Delete Everywhere is about to run against.
    expect(await toggleRow(localOnlySubject)).toBe(true);

    await browser.waitUntil(async () => (await bubbleCount()) === before - 1, {
      timeout: 10_000,
      interval: 300,
      timeoutMsg: `Bubble count did not drop from ${before} after unchecking "${localOnlySubject}"`,
    });

    deletedSubjects = (await rows()).filter(r => r.checked).map(r => r.subject);
    expect(deletedSubjects.length).toBe(2);
    expect(deletedSubjects).not.toContain(localOnlySubject);
  });

  it('reopens the modal at the step it was left on and deletes everywhere', async function () {
    requireSubjects(deletedSubjects, 'deletedSubjects', 'follows a hand-edited checkbox');
    await waitClick(() => clickTestId('bulk-selection-bubble-reopen'), 'Could not reopen the modal from the bubble');
    // Lands back on step 2 with Delete Everywhere still selected — if the
    // session had reset to step 1, or lost the chosen action, the confirm
    // button below would still be disabled and nothing that follows would run.
    await waitForBodyText('Choose Action for', 'Reopened modal did not land back on the action step');

    await waitClick(() => clickTestId('bulk-step2-confirm'), 'Step 2 confirm button never became clickable');
    await waitForBodyText('Delete everywhere?', 'Delete everywhere confirmation dialog never appeared');
    expect(await bodyIncludes('the server, your vault, and your backup drive')).toBe(true);
    expect(await bodyIncludes('No copy will be left anywhere')).toBe(true);

    await waitClick(() => clickTestId('bulk-delete-confirm'), 'Could not confirm Delete Everywhere');

    await browser.waitUntil(
      async () => {
        const list = await rows();
        return deletedSubjects.every(s => !list.some(r => r.subject === s));
      },
      {
        timeout: 60_000,
        interval: 1000,
        timeoutMsg: `Deleted-everywhere rows (${deletedSubjects.join(', ')}) were still present after Delete Everywhere completed`,
      },
    );
    // The message deliberately excluded from this run must be untouched —
    // proof this ran against exactly the selection, not the whole folder.
    expect(await rowFor(localOnlySubject)).toBeTruthy();
  });

  it('does not bring the rows back on reload — the vault and backup purges actually ran', async function () {
    requireSubjects(deletedSubjects, 'deletedSubjects', 'follows a hand-edited checkbox');
    await browser.execute(() => window.location.reload());
    await waitForApp();

    // A fresh boot always lands on account 1's INBOX, not wherever this spec
    // left off — navigate back to the folder that was purged to prove it.
    // Zero server rows is expected here: this spec purged two fixtures and
    // server-deleted the third, so only the local-only survivor can render.
    await switchToVaderArchive({ expectEmails: false });

    // Wait for the survivor BEFORE asserting anything about the deleted rows.
    //
    // Order matters here, and the old order made this test unreliable in both
    // directions. A local-only row is not part of the server fetch: it appears
    // only once loadEmails() has also read the Maildir and the local index, a
    // round-trip that lands after the folder header does — so reading the list
    // straight after the switch caught an empty list that was merely early. In
    // the other direction, "the deleted rows are gone" passes trivially on that
    // same empty list, so checking it first could have gone green while the
    // folder had not loaded at all. Waiting for the row that MUST be there
    // proves the folder is really populated, and everything after it is then
    // asserted against a settled list.
    await browser.waitUntil(
      async () => (await rows()).some(r => r.subject === localOnlySubject),
      { timeout: 30_000, interval: 500, timeoutMsg: 'never-appeared' },
    ).catch(() => { /* fall through to the diagnostic below */ });

    const list = await rows();
    // The message this spec deliberately left local-only must come back that
    // way — this is what confirms the reload reflects real persisted state.
    const survivor = list.find(r => r.subject === localOnlySubject);
    if (!survivor) {
      // A local-only row needs two things to render: the message in
      // `localEmails`, and its uid in `archivedEmailIds` (see
      // messageListSlice's updateSortedEmails). Read both, plus what the
      // Maildir on disk actually says, so the failure names which one is
      // missing instead of just "no row".
      const [, vaderEmail] = browser.mockAccounts.map(a => a.email);
      const vaderId = browser.mockAccounts.find(a => a.email === vaderEmail).id;
      const store = await browser.execute(() => {
        const s = window.__MAIL_STORE__?.getState?.();
        if (!s) return null;
        return {
          activeAccountId: s.activeAccountId, activeMailbox: s.activeMailbox, viewMode: s.viewMode,
          emails: (s.emails || []).map(e => ({ uid: e.uid, subject: e.subject })),
          // sortedEmails is what the list renders — if the row is here but not
          // in the DOM the problem is rendering, not derivation.
          sortedEmails: (s.sortedEmails || []).map(e => ({ uid: e.uid, subject: e.subject, source: e.source })),
          localEmails: (s.localEmails || []).map(e => ({ uid: e.uid, subject: e.subject, source: e.source })),
          archivedEmailIds: [...(s.archivedEmailIds || [])],
          savedEmailIds: [...(s.savedEmailIds || [])],
          serverUidSet: [...(s.serverUids?.uids || [])],
          tombstones: [...(s.deleteTombstones || [])],
        };
      });
      const disk = await browser.executeAsync((accountId, mailbox, done) => {
        const inv = window.__TAURI__.core.invoke;
        Promise.all([
          inv('maildir_list', { accountId, mailbox, requireFlag: null }).catch(e => ({ __error: String(e) })),
          inv('maildir_list', { accountId, mailbox, requireFlag: 'archived' }).catch(e => ({ __error: String(e) })),
          inv('local_index_read', { accountId, mailbox }).catch(e => ({ __error: String(e) })),
        ]).then(([all, archived, index]) => done({ all, archived, index })).catch(e => done({ __error: String(e) }));
      }, vaderId, 'Archive');
      // All the inputs can be right and the row still absent, if the
      // memoization guard decided nothing changed. Clear the fingerprint and
      // re-derive from the very same state: if the row appears, the derivation
      // was never the problem — the guard skipped it.
      const forced = await browser.execute(() => {
        const store = window.__MAIL_STORE__;
        if (!store) return null;
        const before = store.getState().sortedEmails.length;
        const fingerprint = store.getState()._sortedEmailsFingerprint;
        store.setState({ _sortedEmailsFingerprint: '' });
        store.getState().updateSortedEmails();
        return { fingerprint, before, after: store.getState().sortedEmails.length };
      });
      throw new Error(
        `"${localOnlySubject}" did not come back as a Local-only row after the reload, within 30s.\n` +
        `  rendered rows: ${JSON.stringify(list)}\n` +
        `  store: ${JSON.stringify(store)}\n` +
        `  forced re-derive: ${JSON.stringify(forced)}\n` +
        `  disk: ${JSON.stringify(disk)}`,
      );
    }
    expect(survivor.localOnly).toBe(true);

    // Now that the folder is proven populated, the purged rows must be absent
    // from that same settled list. If the vault purge in purgeEverywhere were
    // dropped, these two would still have a `.eml` on disk and archivedEmailIds
    // would still list them — exactly like the survivor — so they would render
    // as Local-only rows instead of staying gone.
    for (const subject of deletedSubjects) {
      expect(list.some(r => r.subject === subject)).toBe(false);
    }
  });
});
