/**
 * E2E Test: storage-matrix diagnostics for "Delete Everywhere"
 *
 * A message can live in three places: the IMAP server, the local vault
 * Maildir, and the external backup mirror. This spec is diagnostic, not a
 * regression pin — it exists to show what actually happens across every
 * combination of those three, across delays, across a reload, across two
 * accounts at once, and in unified inbox. It does not change product code.
 *
 * Runs against two extra seeded mock-IMAP accounts (wdio.conf.js
 * MOCK_ACCOUNTS, accounts 3 and 4 — see the comment there), so it never
 * touches luke/vader's fixtures the rest of the connected-* suite depends
 * on:
 *   - yoda@mock.test — no fault, backup run once at the top of "storage
 *     matrix combinations" below, before any other op touches it
 *   - leia@mock.test — STORE/EXPUNGE/MOVE delayed 4s, backup never run
 *
 * (First cut of this spec drove the AccountModal live to add its own
 * throwaway accounts. That raced accounts.json's disk write against the
 * "Connected!" UI text and was too fragile to build a suite on — seeding
 * through wdio.conf.js's onPrepare, same as luke/vader, is what every other
 * connected-* spec already relies on.)
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
 *     helper — meaning backing up a message also archives it (writes the
 *     vault .eml + local-index.json entry with the "archived" flag). Backup
 *     and archive are NOT independent: you cannot get "backed up, never
 *     archived" through the running app except by backing up and then
 *     unarchiving (which removes only the vault copy, never the mirror).
 *     A corollary: backup_run_account SKIPS any message already in the
 *     vault (its own delta check is against the vault, not the mirror) — so
 *     archiving a message first and backing up second never mirrors it.
 *   - Neither `deleteSelectedFromServer` nor `purgeEverywhere`
 *     (src/services/workflows/messageMutations.js) ever call
 *     `db.saveEmailHeaders(..., { removedUids })` themselves — they rely
 *     entirely on the `loadEmails()` call at the end of each to prune the
 *     on-disk header sidecar cache (email_cache/<accountId>_<mailbox>/
 *     <uid>.json, src-tauri/src/main.rs:754-848). That cache is patch-only:
 *     "nothing is deleted unless removedUids names it explicitly" (db/
 *     caches.js:83). See the "reload root cause" section below for how this
 *     interacts with the optimistic removal already having happened before
 *     that reconcile runs.
 *   - The bulk modal's step-2 legend (BulkOperationsModal.jsx:568-575) reads
 *     "N on server · M archived here [· backup configured]" — it has no
 *     backup COUNT, by design (the comment there says reading one means
 *     resolving the bookmark and walking the mirror on every modal open).
 *   - EmailRow.jsx has exactly two source badges: title="Archived" and
 *     title^="Local only" (EmailRow.jsx:55-59,146-148). There is no per-row
 *     backup/cloud indicator at all.
 */

import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitForApp, waitForEmails } from './helpers.js';
import { appDataDir } from './mockImap.js';

describe('Storage matrix diagnostics', function () {
  this.timeout(600_000);

  const HOME = () => browser.testDataDir;
  const YODA = 'yoda@mock.test';
  const LEIA = 'leia@mock.test';

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
   * same clock — the first run through the matrix caught the badge
   * flipping true one poll cycle before the fs write it's supposed to
   * follow was visible to a second process's readdir. Poll a few seconds
   * before treating a disk check as ground truth for a positive
   * expectation; negative expectations (file should NOT exist) read once,
   * since polling for absence just delays the assertion.
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

  // ── Tauri invoke bridge — used for backup config, which has no fast UI path ──

  /**
   * `browser.execute()` does not await a returned Promise — the script's
   * return value is serialized at the point the (non-async) function
   * returns, so `window.__TAURI__.core.invoke(...)` (a pending Promise, no
   * own enumerable properties) always came back as `{}` regardless of what
   * the Rust command actually resolved with. Caught this directly: both
   * backup_save_external_location and backup_run_account logged `{}` on the
   * first real run of this section. `executeAsync` (WebDriver's execute/async
   * endpoint) is the one that actually waits for the callback.
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
   * (see connected-bulk-delete-everywhere.test.js's switchToVaderArchive) —
   * this spec hits a wider version of it than any other connected-* spec
   * because yoda/leia are freshly-seeded accounts a full suite run never
   * warms up before this file's tests reach them. A bare switch can time out
   * a full 60s in waitForEmails() with nothing rendered at all — retry the
   * whole switch sequence once, not just the sidebar-listing sub-step below.
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
    // resolve into that state genuinely empty (caught this directly: a
    // never-before-visited account's Archive folder showed "No emails in
    // this folder" for 10+ seconds, then the exact same folder loaded fine
    // on its second visit later in the run). Every folder this spec expects
    // rows from is non-empty by construction — re-click once if it isn't.
    if (requireRows && (await rows()).length === 0) {
      expect(await clickSidebarItem(folderName)).toBe(true);
      await browser.waitUntil(async () => (await rows()).length > 0, {
        timeout: 20_000, interval: 500, timeoutMsg: `"${folderName}" (${email}) still empty on retry — cold-start folder fetch never produced rows`,
      });
    }
  }

  const waitClick = (fn, msg) => browser.waitUntil(fn, { timeout: 15_000, interval: 300, timeoutMsg: msg });
  const waitForBodyText = (needle, msg) => browser.waitUntil(() => bodyIncludes(needle), { timeout: 15_000, interval: 300, timeoutMsg: msg });

  const dispatchEscape = () => browser.execute(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
  });

  // ── Suite setup ──────────────────────────────────────────────────────────

  before(async function () {
    await waitForApp();
    await waitForEmails();
    backupRoot = mkdtempSync(join(tmpdir(), 'mailvault-e2e-backup-'));
    console.log('[storage-matrix] backup mirror root:', backupRoot);
    console.log('[storage-matrix] yoda accountId=%s, leia accountId=%s', accountIdOf(YODA), accountIdOf(LEIA));
  });

  /**
   * Never let cleanup throw — a failure here would mask whatever a test
   * above already reported.
   */
  after(async function () {
    try {
      const [lukeEmail] = browser.mockAccounts.map((a) => a.email);
      await clickSidebarItem(lukeEmail);
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
  // yoda's Archive (backup run once, in "storage matrix combinations"'s own
  // before() below, before any row-specific op) gives rows 1/4/6/7. leia's
  // Archive (backup never run for this account) gives rows 2/3/5.
  //   Yoda archive 1 -> row 1 (untouched baseline after backup_run_account)
  //   Yoda archive 2 -> row 6 (unarchive after backup)
  //   Yoda archive 3 -> row 4 (delete-from-server after backup)
  //   Yoda archive 4 -> row 7 (unarchive + delete-from-server after backup)
  //   Leia archive 1 -> row 3 (untouched — also the archive_emails
  //                     "does it actually write a vault file" negative case)
  //   Leia archive 2 -> row 2 (archived, no backup — the positive case)
  //   Leia archive 3 -> row 5 (archived + delete-from-server, no backup)
  //   Leia archive 4/5/6 -> reserved for the delay/hypothesis sections below

  describe('bulk modal legend never reports a backup count', function () {
    it('omits any backup mention when no backup location is configured', async function () {
      await switchToFolder(LEIA, 'Archive');
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
      // pick to actually check rows before trying to advance (the original
      // connected-bulk-delete-everywhere.test.js hits this same gap).
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

      await dispatchEscape();
    });
  });

  describe('storage matrix combinations', function () {
    before(async function () {
      const loc = await invoke('backup_save_external_location', { path: backupRoot });
      console.log('[storage-matrix] backup_save_external_location ->', JSON.stringify(loc));

      // Snapshot backup for yoda BEFORE any row-specific action — every
      // Archive message currently on yoda's server (and not yet vaulted)
      // gets mirrored, and since fetch_and_store always marks what it
      // stores "archived", every one of them also becomes an archived-here
      // row at this point.
      const result = await invoke('backup_run_account', {
        accountId: accountIdOf(YODA),
        accountJson: JSON.stringify(accountOf(YODA)),
        backupPath: null,
        skipFolders: 0,
      });
      console.log('[storage-matrix] backup_run_account(yoda) ->', JSON.stringify(result));
    });

    it('row 1: server + archived + backed up', async function () {
      const accountId = accountIdOf(YODA);
      await switchToFolder(YODA, 'Archive');
      const subject = 'Yoda archive 1';
      const row = await rowFor(subject);
      const disk = { vault: !!(await waitForDisk(() => vaultFile(accountId, 'Archive', 1))), backup: !!(await waitForDisk(() => backupFile(YODA, 'Archive', 1))) };
      console.log('[matrix] row1', subject, 'ui=', row, 'disk=', disk);
      expect(row).toBeTruthy();
      expect(row.archived).toBe(true);
      expect(row.localOnly).toBe(false);
      expect(disk.vault).toBe(true);
      expect(disk.backup).toBe(true);
    });

    it('row 6 (odd but reachable — stale mirror): server + backed up, archive removed via Unarchive', async function () {
      const accountId = accountIdOf(YODA);
      await switchToFolder(YODA, 'Archive');
      const subject = 'Yoda archive 2';

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
      const disk = { vault: !!vaultFile(accountId, 'Archive', 2), backup: !!(await waitForDisk(() => backupFile(YODA, 'Archive', 2))) };
      console.log('[matrix] row6', subject, 'ui=', row, 'disk=', disk);
      expect(row.archived).toBe(false);
      expect(row.localOnly).toBe(false);
      expect(disk.vault).toBe(false); // Unarchive removed the vault copy
      expect(disk.backup).toBe(true); // ...but never touches the mirror
    });

    it('row 4: archived + backed up, removed from server only', async function () {
      const accountId = accountIdOf(YODA);
      await switchToFolder(YODA, 'Archive');
      const subject = 'Yoda archive 3';

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
      const disk = { vault: !!(await waitForDisk(() => vaultFile(accountId, 'Archive', 3))), backup: !!(await waitForDisk(() => backupFile(YODA, 'Archive', 3))) };
      console.log('[matrix] row4', subject, 'ui=', row, 'disk=', disk);
      expect(row.localOnly).toBe(true);
      expect(disk.vault).toBe(true);
      expect(disk.backup).toBe(true);
    });

    it('row 7 (orphaned mirror): unarchived AND removed from server, mirror still there', async function () {
      const accountId = accountIdOf(YODA);
      await switchToFolder(YODA, 'Archive');
      const subject = 'Yoda archive 4';

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

      const disk = { vault: !!vaultFile(accountId, 'Archive', 4), backup: !!(await waitForDisk(() => backupFile(YODA, 'Archive', 4))) };
      console.log('[matrix] row7', subject, 'ui=(row gone)', 'disk=', disk);
      expect(disk.vault).toBe(false);
      expect(disk.backup).toBe(true); // orphaned — nothing in this app ever purges a mirror-only leftover
    });

    it('row 3: plain server message, untouched (also: archive_emails never ran here, so no vault file should exist)', async function () {
      const accountId = accountIdOf(LEIA);
      await switchToFolder(LEIA, 'Archive');
      const subject = 'Leia archive 1';
      const row = await rowFor(subject);
      const disk = { vault: !!vaultFile(accountId, 'Archive', 1), backup: !!backupFile(LEIA, 'Archive', 1) };
      console.log('[matrix] row3', subject, 'ui=', row, 'disk=', disk);
      expect(row).toBeTruthy();
      expect(row.archived).toBe(false);
      expect(row.localOnly).toBe(false);
      expect(disk.vault).toBe(false);
      expect(disk.backup).toBe(false);
    });

    it('row 2: server + archived, backup never run for this account — direct evidence archive_emails writes a real vault file', async function () {
      const accountId = accountIdOf(LEIA);
      await switchToFolder(LEIA, 'Archive');
      const subject = 'Leia archive 2';

      expect(await toggleRowExact(subject)).toBe(true);
      expect(await clickBarButton('Archive selected')).toBe(true);
      await browser.waitUntil(async () => (await rowFor(subject))?.archived === true, {
        timeout: 20_000, interval: 500, timeoutMsg: `"${subject}" never showed the Archived badge`,
      });

      const row = await rowFor(subject);
      const disk = { vault: !!(await waitForDisk(() => vaultFile(accountId, 'Archive', 2))), backup: !!backupFile(LEIA, 'Archive', 2) };
      console.log('[matrix] row2', subject, 'ui=', row, 'disk=', disk, '<- badge vs on-disk file, not just the badge');
      expect(row.archived).toBe(true);
      expect(disk.vault).toBe(true);
      expect(disk.backup).toBe(false);
    });

    it('row 5: server-deleted local-only, backup never run for this account', async function () {
      const accountId = accountIdOf(LEIA);
      await switchToFolder(LEIA, 'Archive');
      const subject = 'Leia archive 3';

      expect(await toggleRowExact(subject)).toBe(true);
      expect(await clickBarButton('Archive selected')).toBe(true);
      await browser.waitUntil(async () => (await rowFor(subject))?.archived === true, {
        timeout: 20_000, interval: 500, timeoutMsg: `"${subject}" never showed the Archived badge`,
      });

      expect(await toggleRowExact(subject)).toBe(true);
      expect(await clickBarButton('Delete from server')).toBe(true);
      await waitForBodyText('cannot be undone', 'Delete-from-server confirmation never appeared');
      expect(await confirmDeletePopover()).toBe(true);

      // leia's delete path is delayed 4s (see wdio.conf.js) — this row's
      // settle just takes longer than a plain account's would.
      await browser.waitUntil(async () => (await rowFor(subject))?.localOnly === true, {
        timeout: 30_000, interval: 500, timeoutMsg: `"${subject}" never settled into Local-only`,
      });

      const row = await rowFor(subject);
      const disk = { vault: !!(await waitForDisk(() => vaultFile(accountId, 'Archive', 3))), backup: !!backupFile(LEIA, 'Archive', 3) };
      console.log('[matrix] row5', subject, 'ui=', row, 'disk=', disk);
      expect(row.localOnly).toBe(true);
      expect(disk.vault).toBe(true);
      expect(disk.backup).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Section 2 + 3: delays and the owner's switch-mailbox hypothesis
  // ═══════════════════════════════════════════════════════════════════════
  //
  // leia's mock server delays STORE/EXPUNGE/MOVE by 4s (wdio.conf.js) —
  // every delete against leia is now observably "in flight" for a real
  // window.

  describe('delayed delete: in-flight visibility', function () {
    it('no fault control: a plain delete-from-server never shows a stale row mid-flight (yoda, no delay)', async function () {
      await switchToFolder(YODA, 'INBOX');
      const subject = 'Yoda 1';
      expect(await toggleRowExact(subject)).toBe(true);
      expect(await clickBarButton('Delete from server')).toBe(true);
      await waitForBodyText('cannot be undone', 'Delete-from-server confirmation never appeared');
      expect(await confirmDeletePopover()).toBe(true);

      await browser.waitUntil(async () => !(await rowFor(subject)), {
        timeout: 15_000, interval: 300, timeoutMsg: `"${subject}" (no delay) never disappeared after Delete from server`,
      });
      console.log('[delay] control (no delay): row gone promptly, as expected');
    });

    it('leia (4s delay): the row during the in-flight window, and after it settles', async function () {
      await switchToFolder(LEIA, 'Archive');
      const subject = 'Leia archive 4';

      expect(await toggleRowExact(subject)).toBe(true);
      expect(await clickBarButton('Delete from server')).toBe(true);
      await waitForBodyText('cannot be undone', 'Delete-from-server confirmation never appeared');

      const t0 = Date.now();
      expect(await confirmDeletePopover()).toBe(true);

      // Sample mid-flight, well before the 4s server delay elapses.
      await browser.pause(1200);
      const midFlight = await rowFor(subject);
      console.log(`[delay] t+${Date.now() - t0}ms mid-flight row for "${subject}":`, JSON.stringify(midFlight));

      // Now wait out the delay and confirm it settles to gone-or-local-only.
      await browser.waitUntil(async () => {
        const r = await rowFor(subject);
        return !r || r.localOnly === true;
      }, { timeout: 20_000, interval: 500, timeoutMsg: `"${subject}" never settled after the delay elapsed` });

      const settled = await rowFor(subject);
      console.log(`[delay] t+${Date.now() - t0}ms settled row for "${subject}":`, JSON.stringify(settled));
    });
  });

  describe("owner's hypothesis: delete in flight, switch away and back", function () {
    it('switch to another folder mid-delete, then back — does the row reappear?', async function () {
      await switchToFolder(LEIA, 'Archive');
      const subject = 'Leia archive 5';

      expect(await toggleRowExact(subject)).toBe(true);
      expect(await clickBarButton('Delete from server')).toBe(true);
      await waitForBodyText('cannot be undone', 'Delete-from-server confirmation never appeared');
      expect(await confirmDeletePopover()).toBe(true);

      // Give the optimistic removal a moment to paint, then switch away
      // while the 4s server delay is still pending.
      await browser.pause(600);
      const beforeSwitch = await rowFor(subject);
      console.log('[hypothesis] row just before switching folders:', JSON.stringify(beforeSwitch));

      expect(await clickSidebarItem('INBOX')).toBe(true);
      await waitForEmails();
      await browser.pause(500);

      // Switch back to Archive while the delay may still be in flight.
      expect(await clickSidebarItem('Archive')).toBe(true);
      await waitForEmails();
      const rightAfterSwitchBack = await rowFor(subject);
      console.log('[hypothesis] row immediately after switching back to Archive:', JSON.stringify(rightAfterSwitchBack));

      // Wait out the rest of the delay window and check the final state.
      await browser.waitUntil(async () => {
        const r = await rowFor(subject);
        return !r || r.localOnly === true;
      }, { timeout: 20_000, interval: 500, timeoutMsg: `"${subject}" never settled after switching back` });

      const finalState = await rowFor(subject);
      console.log('[hypothesis] final settled row after switch-away-and-back:', JSON.stringify(finalState));

      // Report, don't assume: whether or not the row was visible mid-flight
      // is exactly what this test exists to observe (see the report for the
      // conclusion this run reached).
    });

    it('reload instead of switch — does the row reappear after a fresh boot?', async function () {
      await switchToFolder(LEIA, 'Archive');
      const subject = 'Leia archive 6';

      expect(await toggleRowExact(subject)).toBe(true);
      expect(await clickBarButton('Delete from server')).toBe(true);
      await waitForBodyText('cannot be undone', 'Delete-from-server confirmation never appeared');
      expect(await confirmDeletePopover()).toBe(true);

      // Reload immediately — well inside the 4s server delay window, so the
      // server-side delete has almost certainly not landed yet either.
      await browser.pause(600);
      await browser.execute(() => window.location.reload());
      await waitForApp();
      await switchToFolder(LEIA, 'Archive');

      const afterReload = await rowFor(subject);
      console.log('[hypothesis] row right after a reload during an in-flight delete:', JSON.stringify(afterReload));

      // The tombstone (session state) is gone after reload by construction —
      // whatever hides or shows this row now must come from the persisted
      // header cache / server reconcile, not the tombstone. Poll to the
      // settled state and report both readings.
      await browser.waitUntil(async () => {
        const r = await rowFor(subject);
        return !r || r.localOnly === true;
      }, { timeout: 20_000, interval: 500, timeoutMsg: `"${subject}" never settled after the post-reload delta-sync` }).catch((e) => {
        console.warn('[hypothesis]', e.message);
      });
      const settledAfterReload = await rowFor(subject);
      console.log('[hypothesis] settled row after reload + delta-sync:', JSON.stringify(settledAfterReload));
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Section: isolating the "Expected: false, Received: true" reload failure
  // ═══════════════════════════════════════════════════════════════════════
  //
  // No delay here at all — this reproduces the exact shape of the failing
  // assertion in connected-bulk-delete-everywhere.test.js: a clean,
  // undelayed Delete Everywhere, then an immediate reload. The header
  // sidecar file is read directly off disk before and after, which is the
  // one piece of evidence the original spec's DOM-only assertion couldn't
  // provide.

  describe('reload root-cause isolation (no delay)', function () {
    it('does the deleted uid\'s header sidecar survive the post-delete reconcile?', async function () {
      const accountId = accountIdOf(YODA);
      await switchToFolder(YODA, 'INBOX');
      const subject = 'Yoda 2';
      const uid = 2;

      const sidecarBefore = sidecarExists(accountId, 'INBOX', uid);
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
      const sidecarRightAfterDelete = sidecarExists(accountId, 'INBOX', uid);
      console.log(`[reload-root-cause] sidecar for uid ${uid} right after Delete Everywhere's own reconcile:`, sidecarRightAfterDelete);

      await browser.execute(() => window.location.reload());
      await waitForApp();
      await switchToFolder(YODA, 'INBOX');

      const rowImmediatelyAfterReload = await rowFor(subject);
      console.log(`[reload-root-cause] row for "${subject}" immediately after reload:`, JSON.stringify(rowImmediatelyAfterReload));

      // This is the exact assertion shape that failed in
      // connected-bulk-delete-everywhere.test.js's last test.
      expect(!!rowImmediatelyAfterReload).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Section 4: two accounts at once — cross-account bleed
  // ═══════════════════════════════════════════════════════════════════════

  describe('two accounts at once: cross-account bleed', function () {
    it('start a delayed delete on leia, switch to yoda and delete there, switch back', async function () {
      await switchToFolder(LEIA, 'INBOX');
      const leiaSubject = 'Leia 1';
      expect(await toggleRowExact(leiaSubject)).toBe(true);
      expect(await clickBarButton('Delete from server')).toBe(true);
      await waitForBodyText('cannot be undone', 'Delete-from-server confirmation never appeared (leia)');
      expect(await confirmDeletePopover()).toBe(true);
      await browser.pause(500);

      // Switch accounts while leia's delete is still in flight (4s delay).
      await switchToFolder(YODA, 'INBOX');
      const yodaSubject = 'Yoda 3';
      expect(await toggleRowExact(yodaSubject)).toBe(true);
      expect(await clickBarButton('Delete from server')).toBe(true);
      await waitForBodyText('cannot be undone', 'Delete-from-server confirmation never appeared (yoda)');
      expect(await confirmDeletePopover()).toBe(true);

      await browser.waitUntil(async () => !(await rowFor(yodaSubject)), {
        timeout: 15_000, interval: 300, timeoutMsg: `"${yodaSubject}" (no delay) never disappeared on yoda's account`,
      });
      console.log('[cross-account] yoda deleted cleanly while leia delete was still in flight');

      // Switch back to leia and confirm ITS delete resolves correctly, with
      // no bleed from the yoda operation (no stray checked row, no phantom
      // reappearance).
      await switchToFolder(LEIA, 'INBOX');
      const leiaRowNow = await rowFor(leiaSubject);
      console.log('[cross-account] leia row right after switching back:', JSON.stringify(leiaRowNow));

      await browser.waitUntil(async () => {
        const r = await rowFor(leiaSubject);
        return !r || r.localOnly === true;
      }, { timeout: 20_000, interval: 500, timeoutMsg: `"${leiaSubject}" never settled after switching back from yoda` });

      const leiaFinal = await rowFor(leiaSubject);
      console.log('[cross-account] leia row settled state:', JSON.stringify(leiaFinal));

      // No stray selection should have survived the account switches.
      const strayChecked = (await rows()).filter((r) => r.checked);
      console.log('[cross-account] rows still checked after both operations:', JSON.stringify(strayChecked));
      expect(strayChecked.length).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Section 5: unified inbox
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
      const subject = 'Leia 2';

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

      const midFlight = await rowFor(subject);
      console.log('[unified] row mid-flight (leia has a 4s delete delay):', JSON.stringify(midFlight));

      // Switch to yoda's own INBOX and back to Unified — the known gap
      // (deleteSelectedFromServer skips its trailing loadEmails() entirely
      // in unified mode) means the tombstone set when this delete started
      // may never get lifted, and unified mode never prunes the header
      // cache (saveEmailHeaders is called with `undefined` when isUnified).
      await switchToFolder(YODA, 'INBOX');
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
