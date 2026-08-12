/**
 * E2E Test: storage-matrix diagnostics for "Delete Everywhere"
 *
 * A message can live in three places: the IMAP server, the local vault
 * Maildir, and the external backup mirror. This spec is diagnostic, not a
 * regression pin — it exists to show what actually happens across every
 * combination of those three, across a reload, across two accounts at once,
 * and in unified inbox. It does not change product code.
 *
 * REWORK NOTE (second pass): the first cut added two throwaway accounts
 * (yoda/leia). That broke visual-screens/visual-settings — extra account
 * avatars in the sidebar shifted every baseline screenshot — and the repo
 * owner ruled against a third account even to keep delay-fault coverage.
 * This version gives the matrix its own mailboxes on the two EXISTING
 * accounts instead:
 *   - vader@mock.test gets one extra mailbox, "Matrix" (wdio.conf.js
 *     MOCK_ACCOUNTS[1].extraMailbox) — vader is never the active account in
 *     either visual spec, so a mailbox only it has never appears in a
 *     baseline. Its existing INBOX (700, exact-count fixture for
 *     connected-list-header) and Archive (permanently consumed by
 *     connected-bulk-delete-everywhere) are untouched.
 *   - luke@mock.test's existing Archive folder gets a bigger, renamed
 *     fixture (archiveCount 4, prefix "Luke archive" instead of the default
 *     "Archived message") — confirmed via a codebase search that no spec
 *     reads luke's Archive or asserts an exact luke INBOX count. luke IS the
 *     default active account, so nothing new was added to its INBOX or its
 *     folder list beyond renaming Archive's own contents.
 *   - luke's INBOX loses exactly one ordinary message (uid 2, "Luke message
 *     2") to the unified-inbox test — chosen because no spec names it (the
 *     one spec that names a specific luke INBOX message,
 *     connected-selection-actions.test.js, uses uid 7 for a non-destructive
 *     read/unread toggle) and INBOX deletes here are non-permanent (COPY to
 *     Trash), so the message isn't actually gone from the account.
 *
 * DROPPED: the delay-fault coverage (in-flight visibility, the owner's
 * switch-mailbox hypothesis) from the first pass. Faults in the mock IMAP
 * server are per-connection/per-account (src-mock-imap/src/scenario.rs's
 * Trigger is only OnCommand/OnNthCommand/OnConnect — there is no per-mailbox
 * scoping), so a delay lives on the shared vader or luke server and would
 * slow or flake every other spec's deletes (connected-selection-actions,
 * connected-move-to-folder, etc.) for the whole suite run. OnNthCommand was
 * considered and rejected: it requires deterministic command ordering across
 * the whole suite, which nothing here guarantees, and a fault that
 * occasionally fires against the wrong spec is worse than no fault. That
 * work already produced its finding before being dropped (see the report):
 * the owner's hypothesis did not reproduce (the tombstone hides a row
 * instantly and survives a plain switch fine); a reload during a genuinely
 * slow in-flight delete does show the row, correctly, because the server
 * hasn't deleted it yet. Re-running that specific scenario is what's lost —
 * covered here only by prose, not by a live test.
 *
 * Key grounding established by reading the product code (not asserted here,
 * just what shaped this spec's design):
 *   - `archive_emails` (src-tauri/src/main.rs → archive::run) always writes
 *     the vault `.eml` file, but calls `archive::run_with_backup(..., None,
 *     None)` — the backup_path/account_email args are hardcoded None, so the
 *     UI's "Archive selected" action NEVER writes an external-backup copy,
 *     regardless of whether a backup location is configured.
 *   - `backup_run_account` (the real full-account backup pipeline) mirrors
 *     every message in every folder straight from IMAP, and for any message
 *     not yet in the vault it calls the SAME `run_with_backup` archive.rs
 *     helper — meaning backing up a message also archives it. Backup and
 *     archive are NOT independent: you cannot get "backed up, never
 *     archived" through the running app except by backing up and then
 *     unarchiving (which removes only the vault copy, never the mirror). A
 *     corollary: backup_run_account SKIPS any message already in the vault
 *     (its delta check is against the vault, not the mirror).
 *   - `backup_run_account` walks every SELECTABLE folder for the account,
 *     in LIST order (src-mock-imap/src/commands.rs's do_list iterates
 *     state.mailboxes in array order — confirmed by reading it), and
 *     `skip_folders` skips a PREFIX of that list. vader's mailboxes array is
 *     [INBOX, Sent, Archive, Drafts, Trash, Matrix] — skipFolders: 5 backs
 *     up ONLY "Matrix", never touching vader's 700-message INBOX. This is
 *     what makes it safe to run the real backup pipeline here at all.
 *   - Neither `deleteSelectedFromServer` nor `purgeEverywhere`
 *     (src/services/workflows/messageMutations.js) used to prune the header
 *     sidecar cache themselves — see the "reload root cause" section below.
 *     Product commit 545e8e9 (already on this branch) fixed this; the test
 *     there now asserts the fix holds instead of documenting the break.
 *   - The bulk modal's step-2 legend (BulkOperationsModal.jsx:568-575) reads
 *     "N on server · M archived here [· backup configured]" — no backup
 *     COUNT, by design.
 *   - EmailRow.jsx has exactly two source badges: title="Archived" and
 *     title^="Local only". No per-row backup/cloud indicator exists.
 */

import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitForApp, waitForEmails } from './helpers.js';
import { appDataDir } from './mockImap.js';

describe('Storage matrix diagnostics', function () {
  this.timeout(600_000);

  const HOME = () => browser.testDataDir;
  const LUKE = 'luke@mock.test';
  const VADER = 'vader@mock.test';

  const accountOf = (email) => browser.mockAccounts.find((a) => a.email === email);
  const accountIdOf = (email) => accountOf(email).id;

  let backupRoot;

  // ── Disk helpers — read the vault / mirror / sidecar cache directly ────

  function findByUid(dir, uid) {
    if (!existsSync(dir)) return null;
    const prefix = `${uid}:`;
    const legacy = `${uid}.eml`;
    for (const name of readdirSync(dir)) {
      if (name.startsWith(prefix) || name === legacy) return name;
    }
    return null;
  }

  function vaultFile(accountId, mbox, uid) {
    return findByUid(join(appDataDir(HOME()), 'Maildir', accountId, mbox, 'cur'), uid);
  }

  function backupFile(email, mbox, uid) {
    return findByUid(join(backupRoot, email, mbox, 'cur'), uid);
  }

  /**
   * The DOM badge (archived/localOnly) and the on-disk file are not the
   * same clock — an early run through the matrix caught the badge flipping
   * true one poll cycle before the fs write it's supposed to follow was
   * visible to a second process's readdir. Poll a few seconds before
   * treating a disk check as ground truth for a positive expectation;
   * negative expectations (file should NOT exist) read once, since polling
   * for absence just delays the assertion.
   */
  async function waitForDisk(fn, { timeoutMs = 8000, interval = 300 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let result = fn();
    while (!result && Date.now() < deadline) {
      await browser.pause(interval);
      result = fn();
    }
    return result;
  }

  function cacheBaseName(accountId, mbox) {
    const safe = (s) => s.replace(/[^A-Za-z0-9]/g, '_');
    return `${safe(accountId)}_${safe(mbox)}`;
  }

  function sidecarExists(accountId, mbox, uid) {
    return existsSync(join(appDataDir(HOME()), 'email_cache', cacheBaseName(accountId, mbox), `${uid}.json`));
  }

  /**
   * Self-describing row+disk assertion for the matrix — a bare
   * `expect(x).toBe(true)` reports nothing about what was actually seen.
   * `want` is any subset of {present, archived, localOnly, vault, backup};
   * on mismatch this throws one error naming every field that disagreed
   * plus the full row and disk objects, so a failure is diagnosable from
   * the mocha output alone.
   */
  function checkRow(label, subject, row, disk, want) {
    const problems = [];
    const present = !!row;
    if ('present' in want && present !== want.present) {
      problems.push(`present: want ${want.present}, got ${present}`);
    }
    if (row) {
      if ('archived' in want && !!row.archived !== want.archived) {
        problems.push(`Archived badge: want ${want.archived}, got ${!!row.archived}`);
      }
      if ('localOnly' in want && !!row.localOnly !== want.localOnly) {
        problems.push(`Local-only badge: want ${want.localOnly}, got ${!!row.localOnly}`);
      }
    }
    if (disk) {
      if ('vault' in want && !!disk.vault !== want.vault) {
        problems.push(`vault .eml file: want ${want.vault}, got ${!!disk.vault}`);
      }
      if ('backup' in want && !!disk.backup !== want.backup) {
        problems.push(`backup mirror file: want ${want.backup}, got ${!!disk.backup}`);
      }
    }
    if (problems.length) {
      throw new Error(
        `[matrix ${label}] "${subject}" — ${problems.join('; ')}\n` +
        `  row=${JSON.stringify(row)}\n  disk=${JSON.stringify(disk)}`,
      );
    }
  }

  // ── Tauri invoke bridge — used for backup config, which has no fast UI path ──

  /**
   * `browser.execute()` does not await a returned Promise — the script's
   * return value is serialized at the point the (non-async) function
   * returns, so `window.__TAURI__.core.invoke(...)` (a pending Promise, no
   * own enumerable properties) always came back as `{}` regardless of what
   * the Rust command actually resolved with. `executeAsync` (WebDriver's
   * execute/async endpoint) is the one that actually waits for the callback.
   */
  function invoke(cmd, args) {
    return browser.executeAsync((c, a, done) => {
      window.__TAURI__.core.invoke(c, a).then(done).catch((e) => done({ __error: String(e && e.message || e) }));
    }, cmd, args);
  }

  // ── DOM helpers (same shapes as connected-bulk-delete-everywhere.test.js) ──

  const rows = () => browser.execute(() => {
    return [...document.querySelectorAll('[data-testid="email-row"]')].map((row) => ({
      subject: (row.innerText || '').split('\n')[0] || '',
      text: row.innerText || '',
      checked: !!row.querySelector('input[type="checkbox"]')?.checked,
      archived: row.querySelector('[title="Archived"]') !== null,
      localOnly: row.querySelector('[title^="Local only"]') !== null,
    }));
  });

  const rowFor = async (subject) => (await rows()).find((r) => r.text.includes(subject));

  const bodyIncludes = (needle) => browser.execute((t) => document.body.innerText.includes(t), needle);

  function toggleRowExact(subject) {
    return browser.execute((needle) => {
      for (const row of document.querySelectorAll('[data-testid="email-row"]')) {
        if (!(row.innerText || '').includes(needle)) continue;
        const box = row.querySelector('input[type="checkbox"]');
        if (!box) return false;
        box.click();
        return true;
      }
      return false;
    }, subject);
  }

  function clickBarButton(title) {
    return browser.execute((btnTitle) => {
      const btn = document.querySelector(`button[title="${btnTitle}"]`);
      if (!btn || btn.offsetHeight === 0) return false;
      btn.click();
      return true;
    }, title);
  }

  /** Confirm popover shared by "Delete from server" and "Delete everywhere". */
  function confirmDeletePopover() {
    return browser.execute(() => {
      for (const btn of document.querySelectorAll('button')) {
        if ((btn.textContent || '').trim() === 'Delete' && btn.offsetHeight > 0 && !btn.getAttribute('title')) {
          btn.click();
          return true;
        }
      }
      return false;
    });
  }

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

  const sidebarHasFolder = (name) => browser.execute((needle) =>
    (document.querySelector('[data-testid="sidebar"]')?.innerText || '').includes(needle), name);

  const folderHeaderText = () => browser.execute(() => document.querySelector('h2')?.textContent?.trim() || '');

  /**
   * The harness has a documented class of "first fetch of a session" races
   * (see connected-bulk-delete-everywhere.test.js's switchToVaderArchive). A
   * bare switch can time out a full 60s in waitForEmails() with nothing
   * rendered at all — retry the whole switch sequence once, not just the
   * sidebar-listing sub-step below.
   */
  async function switchToFolder(email, folderName, opts = {}) {
    try {
      await switchToFolderOnce(email, folderName, opts);
    } catch (e) {
      console.warn(`[storage-matrix] switchToFolder(${email}, ${folderName}) failed once (${e.message}) — retrying`);
      await switchToFolderOnce(email, folderName, opts);
    }
  }

  async function switchToFolderOnce(email, folderName, { requireRows = true } = {}) {
    expect(await clickSidebarItem(email)).toBe(true);
    try {
      await browser.waitUntil(() => sidebarHasFolder(folderName), { timeout: 8_000, interval: 300 });
    } catch {
      // First folder fetch of a session can race credential loading (same
      // gap connected-bulk-delete-everywhere.test.js works around) — retry once.
      expect(await clickSidebarItem(email)).toBe(true);
      await browser.waitUntil(() => sidebarHasFolder(folderName), {
        timeout: 15_000, interval: 300, timeoutMsg: `${email} never listed a "${folderName}" folder`,
      });
    }
    expect(await clickSidebarItem(folderName)).toBe(true);
    // waitForEmails() only checks "some row exists", which a virtualized
    // list can satisfy with the PREVIOUS folder's still-rendered rows for a
    // moment after the click — wait for the header to actually say the
    // folder we asked for before treating the switch as done.
    await browser.waitUntil(async () => (await folderHeaderText()) === folderName, {
      timeout: 10_000, interval: 300, timeoutMsg: `Folder header never showed "${folderName}" after switching (${email})`,
    });
    await waitForEmails();
    // waitForEmails()'s own success criteria includes the EMPTY-state
    // element — a mailbox visited for the first time this session can
    // resolve into that state genuinely empty. Every folder this spec
    // expects rows from is non-empty by construction — re-click once if it isn't.
    if (requireRows && (await rows()).length === 0) {
      expect(await clickSidebarItem(folderName)).toBe(true);
      await browser.waitUntil(async () => (await rows()).length > 0, {
        timeout: 20_000, interval: 500, timeoutMsg: `"${folderName}" (${email}) still empty on retry — cold-start folder fetch never produced rows`,
      });
    }
  }

  const waitClick = (fn, msg) => browser.waitUntil(fn, { timeout: 15_000, interval: 300, timeoutMsg: msg });
  const waitForBodyText = (needle, msg) => browser.waitUntil(() => bodyIncludes(needle), { timeout: 15_000, interval: 300, timeoutMsg: msg });

  // ── Suite setup ──────────────────────────────────────────────────────────

  before(async function () {
    await waitForApp();
    await waitForEmails();
    backupRoot = mkdtempSync(join(tmpdir(), 'mailvault-e2e-backup-'));
    console.log('[storage-matrix] backup mirror root:', backupRoot);
    console.log('[storage-matrix] luke accountId=%s, vader accountId=%s', accountIdOf(LUKE), accountIdOf(VADER));
  });

  /**
   * Never let cleanup throw — a failure here would mask whatever a test
   * above already reported.
   */
  after(async function () {
    try {
      await clickSidebarItem(LUKE);
      await browser.waitUntil(async () => (await folderHeaderText()) !== 'Archive', { timeout: 8_000, interval: 300 }).catch(() => {});
      await clickSidebarItem('INBOX');
      await waitForEmails();
    } catch (e) {
      console.warn('[storage-matrix] cleanup could not restore INBOX:', e.message);
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Section 1: the storage matrix
  // ═══════════════════════════════════════════════════════════════════════
  //
  // vader's "Matrix" mailbox (backup run once, in "storage matrix
  // combinations"'s own before() below, scoped to just this folder via
  // skipFolders: 5) gives rows 1/4/6/7. luke's Archive (backup never run for
  // luke) gives rows 2/3/5.
  //   Vader matrix 1 -> row 1 (untouched baseline after backup_run_account)
  //   Vader matrix 2 -> row 6 (unarchive after backup)
  //   Vader matrix 3 -> row 4 (delete-from-server after backup)
  //   Vader matrix 4 -> row 7 (unarchive + delete-from-server after backup)
  //   Vader matrix 5 -> reload-root-cause section below
  //   Vader matrix 6 -> cross-account section below
  //   Luke archive 1 -> row 3 (untouched — also the archive_emails
  //                     "does it actually write a vault file" negative case)
  //   Luke archive 2 -> row 2 (archived, no backup — the positive case)
  //   Luke archive 3 -> row 5 (archived + delete-from-server, no backup)
  //   Luke archive 4 -> cross-account section below

  describe('bulk modal legend never reports a backup count', function () {
    it('omits any backup mention when no backup location is configured', async function () {
      await switchToFolder(LUKE, 'Archive');
      expect(await browser.execute(() => {
        const btn = document.querySelector('[data-testid="email-list-header"] button');
        if (!btn) return false;
        btn.click();
        return true;
      })).toBe(true);
      await waitForBodyText('Bulk Email Operations', 'Bulk modal never opened');
      // Scoped away from the sidebar: it renders before the modal in the DOM
      // and carries its own "All" button (the server/local/all View Mode
      // toggle) — an unscoped search hits that one first and clicks it
      // silently, so the range preset never registers and rows never check
      // (see connected-bulk-delete-everywhere.test.js's clickByText comment).
      await waitClick(() => browser.execute(() => {
        const sidebar = document.querySelector('[data-testid="sidebar"]');
        for (const el of document.querySelectorAll('button')) {
          if (sidebar && sidebar.contains(el)) continue;
          if ((el.textContent || '').trim().startsWith('All') && el.offsetHeight > 0) { el.click(); return true; }
        }
        return false;
      }), 'The "All" preset never became clickable');
      // "Next" stays disabled until selectedCount > 0 — wait for the range
      // pick to actually check rows before trying to advance.
      await browser.waitUntil(
        async () => (await rows()).some((r) => r.checked),
        { timeout: 15_000, interval: 300, timeoutMsg: 'Rows never showed a checkmark after picking the "All" range' },
      );
      await waitClick(() => browser.execute(() => {
        const sidebar = document.querySelector('[data-testid="sidebar"]');
        for (const el of document.querySelectorAll('button')) {
          if (sidebar && sidebar.contains(el)) continue;
          if ((el.textContent || '').trim().startsWith('Next') && el.offsetHeight > 0 && !el.disabled) { el.click(); return true; }
        }
        return false;
      }), 'Could not advance to step 2');
      await waitForBodyText('Choose Action for', 'Modal never advanced to the action step');

      const legend = await browser.execute(() => {
        const els = [...document.querySelectorAll('div')].filter(d => (d.textContent || '').includes('on server') && (d.textContent || '').includes('archived here'));
        return els[0]?.textContent || '';
      });
      console.log('[storage-matrix] legend (no backup configured):', JSON.stringify(legend));
      expect(legend).toContain('on server');
      expect(legend).toContain('archived here');
      expect(legend).not.toContain('backup configured');
      expect(legend).not.toMatch(/\d+ backed up|\d+ in backup/i);

      // Escape only MINIMIZES a bulk session (selection and all) — only
      // step-1's own Cancel actually ends it. Caught this directly: leaving
      // this session minimized (never confirmed, no action chosen) carried
      // a stale luke-Archive selection across the rest of the file, and a
      // later test's reload made one of its 4 rows vanish from the list —
      // a real bug in this spec, not in the app. Back to step 1, then Cancel.
      expect(await browser.execute(() => {
        for (const el of document.querySelectorAll('button')) {
          if ((el.textContent || '').trim() === 'Back' && el.offsetHeight > 0) { el.click(); return true; }
        }
        return false;
      })).toBe(true);
      await waitForBodyText('Bulk Email Operations', 'Back button did not return to step 1');
      expect(await browser.execute(() => {
        for (const el of document.querySelectorAll('button')) {
          if ((el.textContent || '').trim() === 'Cancel' && el.offsetHeight > 0) { el.click(); return true; }
        }
        return false;
      })).toBe(true);
    });
  });

  describe('storage matrix combinations', function () {
    before(async function () {
      const loc = await invoke('backup_save_external_location', { path: backupRoot });
      console.log('[storage-matrix] backup_save_external_location ->', JSON.stringify(loc));

      // Scoped to JUST vader's "Matrix" mailbox (see the file-header comment
      // on skipFolders ordering) — INBOX (700 msgs), Sent, Archive, Drafts,
      // Trash are skipped entirely, untouched. Every message the backup
      // pipeline touches also gets archived (fetch_and_store always writes
      // the vault copy), so every Matrix row also becomes archived-here here.
      const result = await invoke('backup_run_account', {
        accountId: accountIdOf(VADER),
        accountJson: JSON.stringify(accountOf(VADER)),
        backupPath: null,
        skipFolders: 5,
      });
      console.log('[storage-matrix] backup_run_account(vader, skipFolders=5) ->', JSON.stringify(result));
    });

    it('row 1: server + archived + backed up', async function () {
      const accountId = accountIdOf(VADER);
      await switchToFolder(VADER, 'Matrix');
      const subject = 'Vader matrix 1';

      // This is the first-ever UI visit to this folder in the session (the
      // before() hook above wrote via a direct invoke, never through
      // loadEmails()) — the row can render before serverUidSet has been
      // populated by the live IMAP fetch, showing "Local only" (source
      // derives from serverUidSet.has(uid)) for a message that is, in fact,
      // still on the server. Wait for it to settle the same way rows
      // 6/4/7 already do before reading it as ground truth.
      await browser.waitUntil(async () => (await rowFor(subject))?.archived === true, {
        timeout: 10_000, interval: 300, timeoutMsg: `"${subject}" never settled into Archived (serverUidSet may still be populating)`,
      });

      const row = await rowFor(subject);
      const disk = { vault: !!(await waitForDisk(() => vaultFile(accountId, 'Matrix', 1))), backup: !!(await waitForDisk(() => backupFile(VADER, 'Matrix', 1))) };
      console.log('[matrix] row1', subject, 'ui=', row, 'disk=', disk);
      checkRow('row1', subject, row, disk, { present: true, archived: true, localOnly: false, vault: true, backup: true });
    });

    it('row 6 (odd but reachable — stale mirror): server + backed up, archive removed via Unarchive', async function () {
      const accountId = accountIdOf(VADER);
      await switchToFolder(VADER, 'Matrix');
      const subject = 'Vader matrix 2';

      // Confirm the pre-state: backup_run_account archived it too.
      await browser.waitUntil(async () => (await rowFor(subject))?.archived === true, {
        timeout: 10_000, interval: 300, timeoutMsg: `"${subject}" was not archived by backup_run_account`,
      });

      expect(await toggleRowExact(subject)).toBe(true);
      expect(await clickBarButton('Unarchive selected')).toBe(true);

      await browser.waitUntil(async () => {
        const r = await rowFor(subject);
        return r && !r.archived && !r.localOnly;
      }, { timeout: 15_000, interval: 300, timeoutMsg: `"${subject}" still showed a local badge after Unarchive` });

      const row = await rowFor(subject);
      const disk = { vault: !!vaultFile(accountId, 'Matrix', 2), backup: !!(await waitForDisk(() => backupFile(VADER, 'Matrix', 2))) };
      console.log('[matrix] row6', subject, 'ui=', row, 'disk=', disk);
      // Unarchive removed the vault copy but never touches the mirror.
      checkRow('row6', subject, row, disk, { present: true, archived: false, localOnly: false, vault: false, backup: true });
    });

    it('row 4: archived + backed up, removed from server only', async function () {
      const accountId = accountIdOf(VADER);
      await switchToFolder(VADER, 'Matrix');
      const subject = 'Vader matrix 3';

      await browser.waitUntil(async () => (await rowFor(subject))?.archived === true, {
        timeout: 10_000, interval: 300, timeoutMsg: `"${subject}" was not archived by backup_run_account`,
      });

      expect(await toggleRowExact(subject)).toBe(true);
      expect(await clickBarButton('Delete from server')).toBe(true);
      await waitForBodyText('cannot be undone', 'Delete-from-server confirmation never appeared');
      expect(await confirmDeletePopover()).toBe(true);

      await browser.waitUntil(async () => (await rowFor(subject))?.localOnly === true, {
        timeout: 30_000, interval: 500, timeoutMsg: `"${subject}" never settled into Local-only`,
      });

      const row = await rowFor(subject);
      const disk = { vault: !!(await waitForDisk(() => vaultFile(accountId, 'Matrix', 3))), backup: !!(await waitForDisk(() => backupFile(VADER, 'Matrix', 3))) };
      console.log('[matrix] row4', subject, 'ui=', row, 'disk=', disk);
      checkRow('row4', subject, row, disk, { present: true, localOnly: true, vault: true, backup: true });
    });

    it('row 7 (orphaned mirror): unarchived AND removed from server, mirror still there', async function () {
      const accountId = accountIdOf(VADER);
      await switchToFolder(VADER, 'Matrix');
      const subject = 'Vader matrix 4';

      await browser.waitUntil(async () => (await rowFor(subject))?.archived === true, {
        timeout: 10_000, interval: 300, timeoutMsg: `"${subject}" was not archived by backup_run_account`,
      });

      expect(await toggleRowExact(subject)).toBe(true);
      expect(await clickBarButton('Unarchive selected')).toBe(true);
      await browser.waitUntil(async () => {
        const r = await rowFor(subject);
        return r && !r.archived;
      }, { timeout: 15_000, interval: 300, timeoutMsg: `"${subject}" still archived after Unarchive` });

      expect(await toggleRowExact(subject)).toBe(true);
      expect(await clickBarButton('Delete from server')).toBe(true);
      await waitForBodyText('cannot be undone', 'Delete-from-server confirmation never appeared');
      expect(await confirmDeletePopover()).toBe(true);

      await browser.waitUntil(async () => !(await rowFor(subject)), {
        timeout: 30_000, interval: 500,
        timeoutMsg: `"${subject}" (server-gone, never archived) should have vanished from the row list entirely`,
      });

      const disk = { vault: !!vaultFile(accountId, 'Matrix', 4), backup: !!(await waitForDisk(() => backupFile(VADER, 'Matrix', 4))) };
      console.log('[matrix] row7', subject, 'ui=(row gone)', 'disk=', disk);
      // Orphaned — nothing in this app ever purges a mirror-only leftover.
      checkRow('row7', subject, null, disk, { present: false, vault: false, backup: true });
    });

    it('row 3: plain server message, untouched (also: archive_emails never ran here, so no vault file should exist)', async function () {
      const accountId = accountIdOf(LUKE);
      await switchToFolder(LUKE, 'Archive');
      const subject = 'Luke archive 1';
      const row = await rowFor(subject);
      const disk = { vault: !!vaultFile(accountId, 'Archive', 1), backup: !!backupFile(LUKE, 'Archive', 1) };
      console.log('[matrix] row3', subject, 'ui=', row, 'disk=', disk);
      checkRow('row3', subject, row, disk, { present: true, archived: false, localOnly: false, vault: false, backup: false });
    });

    it('row 2: server + archived, backup never run for this account — direct evidence archive_emails writes a real vault file', async function () {
      const accountId = accountIdOf(LUKE);
      await switchToFolder(LUKE, 'Archive');
      const subject = 'Luke archive 2';

      expect(await toggleRowExact(subject)).toBe(true);
      expect(await clickBarButton('Archive selected')).toBe(true);
      await browser.waitUntil(async () => (await rowFor(subject))?.archived === true, {
        timeout: 20_000, interval: 500, timeoutMsg: `"${subject}" never showed the Archived badge`,
      });

      const row = await rowFor(subject);
      const disk = { vault: !!(await waitForDisk(() => vaultFile(accountId, 'Archive', 2))), backup: !!backupFile(LUKE, 'Archive', 2) };
      console.log('[matrix] row2', subject, 'ui=', row, 'disk=', disk, '<- badge vs on-disk file, not just the badge');
      checkRow('row2', subject, row, disk, { archived: true, vault: true, backup: false });
    });

    it('row 5: server-deleted local-only, backup never run for this account', async function () {
      const accountId = accountIdOf(LUKE);
      await switchToFolder(LUKE, 'Archive');
      const subject = 'Luke archive 3';

      expect(await toggleRowExact(subject)).toBe(true);
      expect(await clickBarButton('Archive selected')).toBe(true);
      await browser.waitUntil(async () => (await rowFor(subject))?.archived === true, {
        timeout: 20_000, interval: 500, timeoutMsg: `"${subject}" never showed the Archived badge`,
      });

      expect(await toggleRowExact(subject)).toBe(true);
      expect(await clickBarButton('Delete from server')).toBe(true);
      await waitForBodyText('cannot be undone', 'Delete-from-server confirmation never appeared');
      expect(await confirmDeletePopover()).toBe(true);

      await browser.waitUntil(async () => (await rowFor(subject))?.localOnly === true, {
        timeout: 30_000, interval: 500, timeoutMsg: `"${subject}" never settled into Local-only`,
      });

      const row = await rowFor(subject);
      const disk = { vault: !!(await waitForDisk(() => vaultFile(accountId, 'Archive', 3))), backup: !!backupFile(LUKE, 'Archive', 3) };
      console.log('[matrix] row5', subject, 'ui=', row, 'disk=', disk);
      checkRow('row5', subject, row, disk, { localOnly: true, vault: true, backup: false });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Section: the "Expected: false, Received: true" reload failure — now a
  // regression pin, not a diagnosis. Product commit 545e8e9 (already on this
  // branch) prunes the header sidecar from inside deleteSelectedFromServer /
  // purgeEverywhere themselves; this asserts the fix holds. No delay.
  // ═══════════════════════════════════════════════════════════════════════

  describe('reload root-cause regression (no delay)', function () {
    it('the deleted uid does not repaint from a stale header sidecar on reload', async function () {
      const accountId = accountIdOf(VADER);
      await switchToFolder(VADER, 'Matrix');
      const subject = 'Vader matrix 5';
      const uid = 5;

      const sidecarBefore = sidecarExists(accountId, 'Matrix', uid);
      console.log(`[reload-root-cause] sidecar for uid ${uid} before delete:`, sidecarBefore);

      expect(await toggleRowExact(subject)).toBe(true);
      expect(await clickBarButton('Delete everywhere')).toBe(true);
      await waitForBodyText('cannot be undone', 'Delete-everywhere confirmation never appeared');
      expect(await confirmDeletePopover()).toBe(true);

      await browser.waitUntil(async () => !(await rowFor(subject)), {
        timeout: 20_000, interval: 500, timeoutMsg: `"${subject}" never disappeared after Delete everywhere`,
      });

      // Give the trailing loadEmails() reconcile inside purgeEverywhere a
      // moment to actually finish its network round-trip and its
      // save_email_cache write before inspecting the sidecar.
      await browser.pause(2000);
      const sidecarRightAfterDelete = sidecarExists(accountId, 'Matrix', uid);
      console.log(`[reload-root-cause] sidecar for uid ${uid} right after Delete Everywhere's own reconcile:`, sidecarRightAfterDelete);
      if (sidecarRightAfterDelete) {
        console.warn(`[reload-root-cause] sidecar for uid ${uid} survived the delete's own reconcile — the prune fix did not run/land as expected`);
      }

      await browser.execute(() => window.location.reload());
      await waitForApp();
      await switchToFolder(VADER, 'Matrix');

      const rowImmediatelyAfterReload = await rowFor(subject);
      console.log(`[reload-root-cause] row for "${subject}" immediately after reload:`, JSON.stringify(rowImmediatelyAfterReload));

      if (rowImmediatelyAfterReload) {
        throw new Error(
          `"${subject}" reappeared after reload — the deleted row's header sidecar was not pruned.\n` +
          `  sidecar before delete: ${sidecarBefore}\n  sidecar right after the delete's own reconcile: ${sidecarRightAfterDelete}\n` +
          `  row after reload: ${JSON.stringify(rowImmediatelyAfterReload)}`,
        );
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Section: two accounts at once — cross-account bleed
  // ═══════════════════════════════════════════════════════════════════════
  //
  // No artificial delay (see the file-header note on the dropped fault
  // coverage) — this tests whether starting a delete on one account and
  // immediately switching to the other, without waiting for the first to
  // settle, leaks a tombstone or a stray selection across the switch. It is
  // not a genuine in-flight race (both deletes likely complete before this
  // test even finishes reading the DOM), just a same-tick account switch.

  describe('two accounts at once: cross-account bleed', function () {
    it('start a delete on vader, switch to luke and delete there without waiting, switch back', async function () {
      await switchToFolder(VADER, 'Matrix');
      const vaderSubject = 'Vader matrix 6';
      expect(await toggleRowExact(vaderSubject)).toBe(true);
      expect(await clickBarButton('Delete from server')).toBe(true);
      await waitForBodyText('cannot be undone', 'Delete-from-server confirmation never appeared (vader)');
      expect(await confirmDeletePopover()).toBe(true);

      // Switch accounts immediately, without waiting for vader's delete to settle.
      await switchToFolder(LUKE, 'Archive');
      const lukeSubject = 'Luke archive 4';

      // Observed directly (not theorized): by this point in a full run —
      // vader's rows 1/6/4/7 plus a Delete Everywhere + reload in the
      // "reload root-cause" section before this test — luke's Archive can
      // read back with only 3 of its 4 rows, "Luke archive 4" missing, even
      // though nothing in this spec ever touches luke before this test and
      // a raw IMAP probe of the mock server confirms it still has all 4.
      // Isolating exactly which earlier test's reload causes it (a lingering
      // minimized bulk session was one candidate, fixed above, but did not
      // fully explain it) was not resolved in the time available — treat it
      // as a real, reportable finding and make this assertion self-describing
      // rather than let it die on a bare toggle failure with no context.
      if (!(await rowFor(lukeSubject))) {
        console.warn(`[cross-account] "${lukeSubject}" missing from luke's Archive after switching from vader — retrying with a full re-switch. rows seen: ${JSON.stringify(await rows())}`);
        // Use the well-tested switchToFolder helper, not a raw click — a raw
        // click retry here was observed to land on luke's INBOX instead of
        // Archive (whatever it hit inside the sidebar was not the Archive
        // folder entry), turning a diagnosable "row missing" finding into a
        // confusing "wrong folder entirely" one.
        await switchToFolder(LUKE, 'Archive', { requireRows: false });
        if (!(await rowFor(lukeSubject))) {
          throw new Error(
            `"${lukeSubject}" never reappeared in luke's Archive even after a full re-switch — this is the ` +
            `"row missing after an unrelated account's Delete Everywhere + reload" finding (see the report). ` +
            `Rows seen: ${JSON.stringify(await rows())}`,
          );
        }
      }
      expect(await toggleRowExact(lukeSubject)).toBe(true);
      expect(await clickBarButton('Delete from server')).toBe(true);
      await waitForBodyText('cannot be undone', 'Delete-from-server confirmation never appeared (luke)');
      expect(await confirmDeletePopover()).toBe(true);

      await browser.waitUntil(async () => !(await rowFor(lukeSubject)), {
        timeout: 15_000, interval: 300, timeoutMsg: `"${lukeSubject}" never disappeared on luke's account`,
      });
      console.log('[cross-account] luke deleted cleanly right after switching away from vader');

      // Switch back to vader and confirm ITS delete resolves correctly, with
      // no bleed from the luke operation (no stray checked row, no phantom
      // reappearance).
      await switchToFolder(VADER, 'Matrix');
      const vaderRowNow = await rowFor(vaderSubject);
      console.log('[cross-account] vader row right after switching back:', JSON.stringify(vaderRowNow));

      await browser.waitUntil(async () => {
        const r = await rowFor(vaderSubject);
        return !r || r.localOnly === true;
      }, { timeout: 20_000, interval: 500, timeoutMsg: `"${vaderSubject}" never settled after switching back from luke` });

      const vaderFinal = await rowFor(vaderSubject);
      console.log('[cross-account] vader row settled state:', JSON.stringify(vaderFinal));

      // No stray selection should have survived the account switches.
      const strayChecked = (await rows()).filter((r) => r.checked);
      console.log('[cross-account] rows still checked after both operations:', JSON.stringify(strayChecked));
      expect(strayChecked.length).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Section: unified inbox
  // ═══════════════════════════════════════════════════════════════════════

  describe('unified inbox: delete and switch', function () {
    async function switchToUnified() {
      // "All Inboxes" is the sidebar's actual label (see connected-unified-inbox.test.js).
      expect(await browser.execute(() => {
        const btn = document.querySelector('[data-testid="all-inboxes-btn"]');
        if (btn && btn.offsetHeight > 0) { btn.click(); return true; }
        return false;
      })).toBe(true);
      await waitForEmails();
    }

    it('delete a unified-inbox row, switch mailbox, and reload — does it come back?', async function () {
      await switchToUnified();
      const subject = 'Luke message 2';

      const found = await rowFor(subject);
      if (!found) {
        console.warn(`[unified] "${subject}" not visible in the unified list window — skipping (see report)`);
        this.skip();
        return;
      }

      expect(await toggleRowExact(subject)).toBe(true);
      expect(await clickBarButton('Delete from server')).toBe(true);
      await waitForBodyText('cannot be undone', 'Delete-from-server confirmation never appeared (unified)');
      expect(await confirmDeletePopover()).toBe(true);
      await browser.pause(500);

      const rightAfter = await rowFor(subject);
      console.log('[unified] row right after confirming delete:', JSON.stringify(rightAfter));

      // Switch to vader's own INBOX and back to Unified — the known gap
      // (deleteSelectedFromServer skips its trailing loadEmails() entirely
      // in unified mode) means the tombstone set when this delete started
      // may never get lifted, and unified mode never prunes the header
      // cache (saveEmailHeaders is called with `undefined` when isUnified).
      await switchToFolder(VADER, 'INBOX');
      await switchToUnified();
      const afterSwitch = await rowFor(subject);
      console.log('[unified] row after switching away and back to Unified:', JSON.stringify(afterSwitch));

      await browser.execute(() => window.location.reload());
      await waitForApp();
      await switchToUnified();
      const afterReload = await rowFor(subject);
      console.log('[unified] row after a reload back into Unified Inbox:', JSON.stringify(afterReload));
    });
  });
});
