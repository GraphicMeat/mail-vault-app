/**
 * E2E Test: storage-matrix diagnostics for "Delete Everywhere"
 *
 * A message can live in three places: the IMAP server, the local vault
 * Maildir, and the external backup mirror. This spec walks every combination
 * of those three, across a reload, across three accounts at once, and in
 * unified inbox.
 *
 * It began as pure diagnostics. It is now regression pins, because the
 * diagnostics found real bugs and those bugs got fixed: the cross-account
 * sidecar prune, the subject column collapsing to zero width, a prune skipped
 * whenever the view moved mid-delete, and a confirmed delete silently lost when
 * the app reloaded while it was still on the wire. Every failure here now means
 * something regressed.
 *
 * FIXTURES (third pass). Each account here earns its place:
 *   - vader@mock.test owns one extra mailbox, "Matrix" (wdio.conf.js
 *     MOCK_ACCOUNTS[1].extraMailbox), so the matrix never touches vader's
 *     INBOX (700, an exact-count fixture for connected-list-header) or its
 *     Archive (permanently consumed by connected-bulk-delete-everywhere).
 *   - luke@mock.test's Archive carries a bigger, renamed fixture
 *     (archiveCount 4, prefix "Luke archive") — no other spec reads it.
 *   - yoda@mock.test is new and exists for two reasons the other two cannot
 *     serve. Its server stalls MOVE and EXPUNGE by 4s, which is the only way
 *     to observe an in-flight delete: mock faults are per-account with no
 *     per-mailbox scoping (src-mock-imap/src/scenario.rs's Trigger is
 *     OnCommand / OnNthCommand / OnConnect), so the same fault on luke or
 *     vader would slow every other spec's deletes. And its UIDs start at 901,
 *     which — since dates derive from the UID — makes its mail the newest in
 *     the suite and therefore the only mail that can reach the unified
 *     inbox's rendered window at all.
 *
 * The earlier cut dropped both of those and left the delay coverage as prose.
 * The reason given was that a third account shifts every visual-* baseline
 * screenshot; those specs are `local-manual` and never run in CI, so the real
 * cost is regenerating developer-local baselines once, and the coverage is
 * worth more than that.
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
 *     title^="Local only". Every row now carries a per-row state icon
 *     (`[data-testid="msg-state-icon"]`, `data-state="<id>"`) whose id encodes
 *     vault × server × mirror. This spec knows each row's disk truth, so it is
 *     the oracle for that icon: if the icon and the disk disagree, the icon is
 *     lying to the user.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  waitForApp, waitForEmails,
  clickSidebarItem, folderHeaderText, switchToFolder, churnAccounts,
} from './helpers.js';
import { appDataDir } from './mockImap.js';

describe('Storage matrix diagnostics', function () {
  this.timeout(600_000);

  const HOME = () => browser.testDataDir;
  const LUKE = 'luke@mock.test';
  const VADER = 'vader@mock.test';
  // The faulted account: MOVE and EXPUNGE stall 4s on its server alone, so a
  // delete started here is still on the wire while the view moves underneath
  // it. Its UIDs start at 901, which makes its mail the newest in the suite
  // and therefore the only mail that reaches the unified inbox's rendered
  // window (see wdio.conf.js MOCK_ACCOUNTS for both).
  const YODA = 'yoda@mock.test';

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

  /**
   * Every file the vault Maildir holds, as `accountId/mailbox/cur → [names]`.
   *
   * `vaultFile()` returning null has two very different causes — the archive
   * never wrote anything, or it wrote somewhere this spec is not looking (the
   * vault root is relocatable, and `maildir_cur_path` sanitises the mailbox
   * name) — and a boolean cannot tell them apart.
   */
  function vaultTree() {
    const root = join(appDataDir(HOME()), 'Maildir');
    if (!existsSync(root)) return { root, missing: true };
    const tree = {};
    for (const account of readdirSync(root)) {
      const accountDir = join(root, account);
      // The Maildir root also holds plain files (`.maildir_version`) — readdir
      // them and the whole checkpoint dies on ENOTDIR.
      if (!existsSync(accountDir) || !statSync(accountDir).isDirectory()) continue;
      for (const mbox of readdirSync(accountDir)) {
        const cur = join(accountDir, mbox, 'cur');
        if (existsSync(cur)) tree[`${account}/${mbox}`] = readdirSync(cur);
      }
    }
    return tree;
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
   * The durable journal of confirmed-but-unfinished server deletes, or null if
   * there is nothing owed. Written before the first IMAP round-trip of a delete
   * and cleared after the last, so its contents at a given moment say exactly
   * how far a delete got.
   */
  function pendingDeleteJournal() {
    const path = join(appDataDir(HOME()), 'pending_server_delete.json');
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, 'utf-8'));
    } catch (e) {
      return { __unparseable: e.message };
    }
  }

  /** Every UID the sidecar cache holds for one mailbox, ascending. */
  function sidecarUids(accountId, mbox) {
    const dir = join(appDataDir(HOME()), 'email_cache', cacheBaseName(accountId, mbox));
    if (!existsSync(dir)) return null;
    return readdirSync(dir)
      .filter((n) => /^\d+\.json$/.test(n))
      .map((n) => parseInt(n, 10))
      .sort((a, b) => a - b);
  }

  /**
   * A row can go missing at four different places, and the four look identical
   * from the DOM. Read all of them at once so a failure names the layer instead
   * of the symptom:
   *
   *   sidecar  — the on-disk header cache. Missing here = something pruned it.
   *   store    — `emails` in the mail store. Present in sidecar but not here =
   *              the load dropped it.
   *   sorted   — `sortedEmails`, after the tombstone and \Deleted filters.
   *              Present in `emails` but not here = a filter is hiding it.
   *   dom      — what the virtualizer actually rendered. Present in sorted but
   *              not here = it is below the render window, not missing.
   *
   * Plus the live tombstone set, which is the one piece of state that hides a
   * row without removing it from anywhere.
   */
  async function whereIsRow(accountId, mbox, uid) {
    const store = await browser.execute(() => {
      const s = window.__MAIL_STORE__?.getState?.();
      if (!s) return null;
      return {
        activeAccountId: s.activeAccountId,
        activeMailbox: s.activeMailbox,
        emailUids: (s.emails || []).map((e) => e.uid),
        sortedUids: (s.sortedEmails || []).map((e) => e.uid),
        tombstones: [...(s.deleteTombstones || [])],
        serverUidSetSize: s.serverUids?.uids?.size ?? null,
        serverUidsComplete: s.serverUids?.complete ?? null,
      };
    });
    return {
      uid,
      sidecar: sidecarUids(accountId, mbox),
      store: store && {
        ...store,
        inEmails: store.emailUids.includes(uid),
        inSorted: store.sortedUids.includes(uid),
      },
      dom: (await rows()).map((r) => r.text.replace(/\n/g, ' ').trim()),
    };
  }

  /**
   * Self-describing row+disk assertion for the matrix — a bare
   * `expect(x).toBe(true)` reports nothing about what was actually seen.
   * `want` is any subset of {present, archived, localOnly, vault, backup, icon};
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
      if ('icon' in want && row.icon !== want.icon) {
        problems.push(`state icon: want ${want.icon}, got ${row.icon}`);
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
    return [...document.querySelectorAll('[data-testid="email-row"]')].map((row) => {
      // The per-row state icon's `data-state` id — see checkRow's `icon` key.
      const icon = row.querySelector('[data-testid="msg-state-icon"]')?.getAttribute('data-state') || null;
      // `archived`/`localOnly` used to read the row's own title="Archived" /
      // title^="Local only" badges. The state-icon rollout (commit 8c2fe9f)
      // replaced those badges with the icon above and carries no title
      // attribute, so a selector-based read of them now silently finds
      // nothing forever. Derive the same two booleans from `icon` instead —
      // provably the same conditions the old badges rendered under: the old
      // "Archived" title showed whenever `isArchived && source !== 'local-only'`,
      // which is exactly every `archived*` id (including the `-server-unknown`
      // variant, which the old badge had no concept of and rendered
      // identically); the old "Local only" title showed whenever
      // `source === 'local-only'`, which is exactly every `local-only*` id.
      return {
        subject: (row.innerText || '').split('\n')[0] || '',
        text: row.innerText || '',
        checked: !!row.querySelector('input[type="checkbox"]')?.checked,
        archived: !!icon && icon.startsWith('archived'),
        localOnly: !!icon && icon.startsWith('local-only'),
        icon,
      };
    });
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

  // clickSidebarItem / switchToFolder / churnAccounts now live in helpers.js —
  // they were written here, but the switching coverage below needs them in
  // more than one spec and they carry hard-won waits worth sharing.

  /**
   * Visit every account in turn and come back. `home` is where the caller was
   * before the churn, so the view ends where it started.
   *
   * A single switch away and back is not what breaks: the cache writes and
   * tombstones that leak across accounts need the active pair to move several
   * times before a stale key lines up with fresh data. Run this after every
   * mutating action, not just once at the end.
   */
  const churn = (home) => churnAccounts([
    { email: LUKE, folder: 'Archive' },
    { email: YODA, folder: 'INBOX' },
    { email: VADER, folder: 'Matrix' },
    home,
  ]);

  const waitClick = (fn, msg) => browser.waitUntil(fn, { timeout: 15_000, interval: 300, timeoutMsg: msg });
  const waitForBodyText = (needle, msg) => browser.waitUntil(() => bodyIncludes(needle), { timeout: 15_000, interval: 300, timeoutMsg: msg });

  // ── Suite setup ──────────────────────────────────────────────────────────

  before(async function () {
    await waitForApp();
    await waitForEmails();
    backupRoot = mkdtempSync(join(tmpdir(), 'mailvault-e2e-backup-'));
    console.log('[storage-matrix] backup mirror root:', backupRoot);
    console.log('[storage-matrix] accountIds: luke=%s vader=%s yoda=%s',
      accountIdOf(LUKE), accountIdOf(VADER), accountIdOf(YODA));
  });

  /**
   * Bystander watch.
   *
   * The failure this spec keeps surfacing is a row disappearing from a mailbox
   * NOTHING in the failing test touched — luke's Archive losing a UID while a
   * test operates on vader. A failure at the end of the run cannot say which
   * action did it, so record the bystander caches after every single test: the
   * first checkpoint that comes back short names the culprit directly.
   *
   * Cheap (two readdirs) and never throws — a broken checkpoint must not mask
   * the assertion that actually failed.
   */
  afterEach(function () {
    try {
      console.log('[checkpoint] after "%s" — luke/Archive sidecar uids=%s, vader/Matrix=%s, yoda/INBOX=%s',
        this.currentTest?.title,
        JSON.stringify(sidecarUids(accountIdOf(LUKE), 'Archive')),
        JSON.stringify(sidecarUids(accountIdOf(VADER), 'Matrix')),
        JSON.stringify(sidecarUids(accountIdOf(YODA), 'INBOX')));
      // Where the vault actually put its .eml files. Several matrix rows
      // report "archived badge true, no vault file", and the two candidate
      // explanations — the write never happened, or this spec is reading the
      // wrong directory — are indistinguishable from a boolean. List the tree.
      console.log('[checkpoint] vault tree: %s', JSON.stringify(vaultTree()));
    } catch (e) {
      console.warn('[checkpoint] could not read caches:', e.message);
    }
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
  //   Yoda message 903 -> in-flight section below
  //   Yoda message 905 -> unified-inbox section below
  //
  // Note the UID collision this is built on, deliberately: "Vader matrix 4"
  // and "Luke archive 4" are both uid 4, in different accounts. A uid is
  // unique per mailbox and nowhere else, so any cache write that pairs one
  // mailbox's uid list with another mailbox's key drops the bystander — which
  // is exactly what the cross-account section watches for.

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
      // loadEmails()) — the row can render before the server uid set has been
      // populated by the live IMAP fetch. Until it is, the row renders the
      // honest `-server-unknown` variant: archived, but with no proof either
      // way about the server copy. `archived === true` alone is satisfied by
      // that transient, so wait for the enumeration to actually settle before
      // reading the icon as ground truth. The asserted icon below is still the
      // full state, not the condition waited on.
      await browser.waitUntil(async () => {
        const r = await rowFor(subject);
        return r?.archived === true && !r.icon?.includes('server-unknown');
      }, {
        timeout: 10_000, interval: 300, timeoutMsg: `"${subject}" never settled into Archived with a proven server uid set`,
      });

      const row = await rowFor(subject);
      const disk = { vault: !!(await waitForDisk(() => vaultFile(accountId, 'Matrix', 1))), backup: !!(await waitForDisk(() => backupFile(VADER, 'Matrix', 1))) };
      console.log('[matrix] row1', subject, 'ui=', row, 'disk=', disk);
      checkRow('row1', subject, row, disk, { present: true, archived: true, localOnly: false, vault: true, backup: true, icon: 'archived-backed-up' });
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
      checkRow('row6', subject, row, disk, { present: true, archived: false, localOnly: false, vault: false, backup: true, icon: 'server-only-backed-up' });
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
      checkRow('row4', subject, row, disk, { present: true, localOnly: true, vault: true, backup: true, icon: 'local-only-backed-up' });
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
      // No `icon:` here: the row is gone (present: false), so there is no
      // `[data-testid="msg-state-icon"]` element left to read a data-state
      // off of. This disk state — off server, never archived, mirrored — is
      // also not one of the six the icon renders for; nothing is shown for it.
      checkRow('row7', subject, null, disk, { present: false, vault: false, backup: true });
    });

    it('row 3: plain server message, untouched (also: archive_emails never ran here, so no vault file should exist)', async function () {
      const accountId = accountIdOf(LUKE);
      await switchToFolder(LUKE, 'Archive');
      const subject = 'Luke archive 1';
      const row = await rowFor(subject);
      const disk = { vault: !!vaultFile(accountId, 'Archive', 1), backup: !!backupFile(LUKE, 'Archive', 1) };
      console.log('[matrix] row3', subject, 'ui=', row, 'disk=', disk);
      checkRow('row3', subject, row, disk, { present: true, archived: false, localOnly: false, vault: false, backup: false, icon: 'server-only' });
    });

    it('row 2: server + archived, backup never run for this account — direct evidence archive_emails writes a real vault file', async function () {
      const accountId = accountIdOf(LUKE);
      await switchToFolder(LUKE, 'Archive');
      const subject = 'Luke archive 2';

      expect(await toggleRowExact(subject)).toBe(true);
      expect(await clickBarButton('Archive selected')).toBe(true);
      // Same settle condition as row 1: `archived` is also true for the
      // `-server-unknown` variant this row shows until the uid set is proven.
      await browser.waitUntil(async () => {
        const r = await rowFor(subject);
        return r?.archived === true && !r.icon?.includes('server-unknown');
      }, {
        timeout: 20_000, interval: 500, timeoutMsg: `"${subject}" never settled into Archived with a proven server uid set`,
      });

      const row = await rowFor(subject);
      const disk = { vault: !!(await waitForDisk(() => vaultFile(accountId, 'Archive', 2))), backup: !!backupFile(LUKE, 'Archive', 2) };
      console.log('[matrix] row2', subject, 'ui=', row, 'disk=', disk, '<- badge vs on-disk file, not just the badge');
      checkRow('row2', subject, row, disk, { archived: true, vault: true, backup: false, icon: 'archived' });
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
      checkRow('row5', subject, row, disk, { localOnly: true, vault: true, backup: false, icon: 'local-only' });
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
  // Section: three accounts at once — cross-account bleed
  // ═══════════════════════════════════════════════════════════════════════
  //
  // The bug class this section exists for: a write keyed by (account, mailbox)
  // that reads half its inputs before an await and half after. A single switch
  // away and back rarely lines the halves up wrong; several switches, with a
  // mutating action between them, does. So every action here is followed by a
  // full churn through all three accounts (`churn()`), and the assertions run
  // after the churn, not before it.
  //
  // Prior finding, retired: "Luke archive 4 vanishes from luke's Archive after
  // an unrelated account's Delete Everywhere + reload, while the server still
  // has it". Root-caused since (commit 3aaa244): the sidecar prune in
  // deleteSelectedFromServer / purgeEverywhere collected its uids before the
  // server round-trips and re-read the account/mailbox after them, so a switch
  // inside that window pruned the mailbox now on screen using uids from the
  // mailbox actually deleted from. UIDs are unique per mailbox, not globally,
  // so vader's Matrix uid 4 dropped luke's Archive uid 4. The assertions below
  // are now regression pins on that fix, not a diagnosis.

  describe('three accounts at once: cross-account bleed', function () {
    it('delete on vader, churn all three accounts, delete on luke, churn again', async function () {
      await switchToFolder(VADER, 'Matrix');
      const vaderSubject = 'Vader matrix 6';
      expect(await toggleRowExact(vaderSubject)).toBe(true);
      expect(await clickBarButton('Delete from server')).toBe(true);
      await waitForBodyText('cannot be undone', 'Delete-from-server confirmation never appeared (vader)');
      expect(await confirmDeletePopover()).toBe(true);

      // Move the view immediately, three times, without waiting for vader's
      // delete to settle. This is the window in which a prune keyed to the
      // live view writes vader's uids into somebody else's cache.
      const stops = await churn({ email: LUKE, folder: 'Archive' });
      for (const stop of stops) {
        console.log(`[cross-account] ${stop.email} ${stop.folder} after vader's delete: ${JSON.stringify(stop.subjects)}`);
      }

      const lukeSubject = 'Luke archive 4';
      if (!(await rowFor(lukeSubject))) {
        // uid 4 in luke's Archive is the same NUMBER as vader's Matrix uid 4,
        // which an earlier test deletes from the server. If this row is gone,
        // say which layer lost it rather than just that the DOM lacks it.
        const where = await whereIsRow(accountIdOf(LUKE), 'Archive', 4);
        throw new Error(
          `"${lukeSubject}" is missing from luke's Archive after a delete on vader and a churn through ` +
          `${stops.length} account stops — the server still has it.\n` +
          `  layer report: ${JSON.stringify(where, null, 2)}\n` +
          `  churn stops: ${JSON.stringify(stops)}`,
        );
      }

      expect(await toggleRowExact(lukeSubject)).toBe(true);
      expect(await clickBarButton('Delete from server')).toBe(true);
      await waitForBodyText('cannot be undone', 'Delete-from-server confirmation never appeared (luke)');
      expect(await confirmDeletePopover()).toBe(true);

      await browser.waitUntil(async () => !(await rowFor(lukeSubject)), {
        timeout: 15_000, interval: 300, timeoutMsg: `"${lukeSubject}" never disappeared on luke's account`,
      });

      // Churn again, this time landing back on vader, and confirm ITS delete
      // resolved without bleed from luke's.
      const stops2 = await churn({ email: VADER, folder: 'Matrix' });
      for (const stop of stops2) {
        console.log(`[cross-account] ${stop.email} ${stop.folder} after luke's delete: ${JSON.stringify(stop.subjects)}`);
      }

      // luke's Archive is passed through by the churn — the other three rows
      // must still be there. A prune that named the wrong mailbox takes out a
      // bystander, and only a stop that nothing acted on can show that.
      const lukeStop = stops2.find((s) => s.email === LUKE);
      const missing = ['Luke archive 1', 'Luke archive 2']
        .filter((s) => !lukeStop.subjects.some((seen) => seen.includes(s)));
      if (missing.length) {
        throw new Error(
          `luke's Archive lost ${missing.join(', ')} — nothing in this test deleted them. ` +
          `Subjects seen at that stop: ${JSON.stringify(lukeStop.subjects)}`,
        );
      }

      // yoda is never acted on at all in this test. Its INBOX is the cleanest
      // bystander in the suite: anything missing there came from another
      // account's operation.
      const yodaStop = stops2.find((s) => s.email === YODA);
      expect(yodaStop.subjects.length).toBeGreaterThan(0);

      await browser.waitUntil(async () => {
        const r = await rowFor(vaderSubject);
        return !r || r.localOnly === true;
      }, { timeout: 20_000, interval: 500, timeoutMsg: `"${vaderSubject}" never settled after churning away from vader` });

      console.log('[cross-account] vader row settled state:', JSON.stringify(await rowFor(vaderSubject)));

      // No stray selection should have survived six account switches.
      const strayChecked = (await rows()).filter((r) => r.checked);
      console.log('[cross-account] rows still checked after both operations:', JSON.stringify(strayChecked));
      expect(strayChecked.length).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Section: in-flight delete — the view moves while the delete is on the wire
  // ═══════════════════════════════════════════════════════════════════════
  //
  // This is the coverage that was dropped when a fault could only be put on a
  // shared account. yoda's server stalls MOVE and EXPUNGE by 4s, so between
  // confirming the delete and the server acting on it there is a real window
  // to switch account, switch folder, and reload — the exact window every
  // "cache written with half-stale inputs" bug lives in.
  //
  // Ground truth is always the server here: a delete out of INBOX is a MOVE to
  // Trash, so "did the delete happen" is answered by looking in Trash, never by
  // the row disappearing. The row disappears instantly either way — that is the
  // optimistic update plus a session tombstone, and it is exactly what makes a
  // lost delete invisible to the user.
  //
  // Whether the row is briefly visible again mid-flight is NOT asserted: the
  // server genuinely still has the message at that point, so showing it is
  // correct behaviour, not a bug.
  //
  // Fixtures used here: uid 903 for the churn case, uid 904 for the reload
  // case. Separate messages, because the first test's delete really does land
  // and the second must start from a message that is still on the server.

  describe('in-flight delete on the faulted account', function () {
    it('churns accounts while a 4s delete is still on the wire', async function () {
      await switchToFolder(YODA, 'INBOX');
      const subject = 'Yoda message 903';
      if (!(await rowFor(subject))) {
        // The rows render but their subject cell comes back empty for this
        // account, so say what the store actually holds — a blank subject in
        // the DOM and a missing message look identical from a row dump.
        const held = await browser.execute(() => {
          const s = window.__MAIL_STORE__?.getState?.();
          return s ? (s.emails || []).slice(0, 3).map((e) => ({
            uid: e.uid, subject: e.subject, from: e.from, date: e.date, source: e.source,
          })) : null;
        });
        // If the store has the subject but the row's text does not, the span is
        // there and has no width — measure it rather than guess.
        const geometry = await browser.execute(() => {
          const row = document.querySelector('[data-testid="email-row"]');
          if (!row) return null;
          const box = (el) => Math.round(el.getBoundingClientRect().width);
          return {
            viewport: [window.innerWidth, window.innerHeight],
            rowWidth: box(row),
            children: [...row.children].map((c) => ({ cls: c.className, w: box(c) })),
            spans: [...row.querySelectorAll('span')].map((s) => ({
              text: s.textContent, cls: s.className, w: box(s),
            })),
          };
        });
        throw new Error(
          `"${subject}" is not in yoda's INBOX.\n  store holds: ${JSON.stringify(held)}\n` +
          `  row geometry: ${JSON.stringify(geometry)}\n` +
          `  rendered rows: ${JSON.stringify(await rows())}`,
        );
      }

      const before = await churnAccounts([
        { email: LUKE, folder: 'Archive' },
        { email: VADER, folder: 'Matrix' },
        { email: YODA, folder: 'INBOX' },
      ]);
      const lukeBefore = before.find((s) => s.email === LUKE).subjects;
      const vaderBefore = before.find((s) => s.email === VADER).subjects;

      expect(await toggleRowExact(subject)).toBe(true);
      expect(await clickBarButton('Delete from server')).toBe(true);
      await waitForBodyText('cannot be undone', 'Delete-from-server confirmation never appeared (yoda)');
      expect(await confirmDeletePopover()).toBe(true);

      // No wait: the server is sitting on the MOVE for 4s. Move the view twice
      // inside that window.
      const during = await churnAccounts([
        { email: LUKE, folder: 'Archive' },
        { email: VADER, folder: 'Matrix' },
      ]);
      for (const stop of during) {
        console.log(`[in-flight] ${stop.email} ${stop.folder} mid-delete: ${JSON.stringify(stop.subjects)}`);
      }

      // Ground truth is the server, not the list: a delete out of INBOX is a
      // MOVE to Trash, so the message must be sitting there.
      await switchToFolder(YODA, 'Trash', { requireRows: false });
      await browser.waitUntil(async () => !!(await rowFor(subject)), {
        timeout: 30_000, interval: 500,
        timeoutMsg: `"${subject}" never reached yoda's Trash — the server delete did not survive the account churn`,
      });

      await switchToFolder(YODA, 'INBOX', { requireRows: false });
      await browser.waitUntil(async () => !(await rowFor(subject)), {
        timeout: 30_000, interval: 500,
        timeoutMsg: `"${subject}" is in yoda's Trash — the server delete landed — but yoda's INBOX still lists it`,
      });

      // The bystanders. A delete that stalls 4s gives every "prune the cache
      // that is on screen now" path its widest possible window — if any of
      // them fires, it fires against luke or vader, not yoda.
      const after = await churnAccounts([
        { email: LUKE, folder: 'Archive' },
        { email: VADER, folder: 'Matrix' },
      ]);
      const lukeAfter = after.find((s) => s.email === LUKE).subjects;
      const vaderAfter = after.find((s) => s.email === VADER).subjects;

      expect({ luke: lukeAfter.length, vader: vaderAfter.length })
        .toEqual({ luke: lukeBefore.length, vader: vaderBefore.length });
    });

    /**
     * The whole delete runs in the webview, so reloading inside it kills the
     * workflow before the remaining IMAP commands are sent. The rows are hidden
     * optimistically and a session tombstone keeps them hidden, so the user is
     * shown a completed delete either way — and before this was fixed, the
     * messages that never got sent were simply back on the next launch.
     *
     * What makes it survive now: the uids are journalled to disk before the
     * first round-trip and cleared after the last, and launch replays whatever
     * is left (src-tauri/src/pending_delete.rs,
     * services/workflows/replayPendingDeletes.js). This asserts the outcome the
     * user actually cares about — the message really is gone from INBOX and
     * really is in Trash — not that any particular mechanism ran.
     *
     * The 4s MOVE stall on this account is what makes the window observable; on
     * a fast server it is small but never zero, and it is exactly as wide as the
     * server is slow. That is the case a real provider hits.
     */
    it('a confirmed delete survives the app reloading mid-flight', async function () {
      await switchToFolder(YODA, 'INBOX');
      const subject = 'Yoda message 904';
      expect(await rowFor(subject)).toBeTruthy();


      expect(await toggleRowExact(subject)).toBe(true);
      expect(await clickBarButton('Delete from server')).toBe(true);
      await waitForBodyText('cannot be undone', 'Delete-from-server confirmation never appeared (yoda reload)');
      expect(await confirmDeletePopover()).toBe(true);

      // Wait for the row to disappear, then reload — that moment is the whole
      // contract. The row vanishing is the app telling the user the delete is
      // done, and the delete is only durable from the point the journal has
      // been written, so the workflow writes it BEFORE the optimistic update.
      // Reloading here is therefore the strictest fair test: the instant the
      // user is told it is gone, the app must be able to make that true.
      //
      // (Reloading earlier still — inside the few ms between the click and the
      // row disappearing — is a race no frontend can win, and no user can hit:
      // the app has not claimed anything yet at that point.)
      await browser.waitUntil(async () => !(await rowFor(subject)), {
        timeout: 20_000, interval: 200,
        timeoutMsg: `"${subject}" never disappeared after confirming the delete`,
      });
      const journalMidFlight = pendingDeleteJournal();
      console.log('[reload-durability] journal at the moment the row vanished:', JSON.stringify(journalMidFlight));

      // The server is still sitting on the 4s MOVE.
      await browser.execute(() => window.location.reload());
      await waitForApp();
      console.log('[reload-durability] journal right after reload:', JSON.stringify(pendingDeleteJournal()));
      // Wait for the launch replay to actually finish before asking the UI
      // anything. It waits on the keychain and then a 4s-stalled MOVE, and a
      // folder opened before it lands shows a pre-delete server state that
      // nothing re-fetches — which reads as "the delete was lost" when it was
      // merely not finished yet.
      await browser.waitUntil(async () => !!(await browser.execute(
        () => window.__MAIL_STORE__?.getState?.().pendingDeleteReplay)), {
        timeout: 60_000, interval: 500, timeoutMsg: 'The launch replay never ran at all',
      });
      const replay = await browser.execute(() => window.__MAIL_STORE__?.getState?.().pendingDeleteReplay || null);
      console.log('[reload-durability] replay result:', JSON.stringify(replay));

      // Re-switch on every poll: Trash may have been opened and cached before
      // the replay's MOVE landed, and a folder already on screen does not
      // re-fetch on its own.
      await browser.waitUntil(async () => {
        if (await rowFor(subject)) return true;
        await switchToFolder(YODA, 'INBOX', { requireRows: false });
        await switchToFolder(YODA, 'Trash', { requireRows: false });
        return !!(await rowFor(subject));
      }, {
        timeout: 90_000, interval: 1000,
        timeoutMsg: `"${subject}" never reached yoda's Trash — the delete the user confirmed was lost when ` +
          `the app reloaded while it was still in flight. The message is still on the server, and the app ` +
          `showed the user a row disappearing.\n` +
          `  journal mid-flight (before the reload): ${JSON.stringify(journalMidFlight)}\n` +
          `  replay: ${JSON.stringify(replay)}\n` +
          `  journal now: ${JSON.stringify(pendingDeleteJournal())}`,
      });

      // …and it must not still be listed where it was deleted from.
      await switchToFolder(YODA, 'INBOX', { requireRows: false });
      await browser.waitUntil(async () => !(await rowFor(subject)), {
        timeout: 30_000, interval: 500,
        timeoutMsg: `"${subject}" is in yoda's Trash but yoda's INBOX still lists it after the reload`,
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Section: unified inbox
  // ═══════════════════════════════════════════════════════════════════════
  //
  // Why the target is a yoda message and not a luke one, which is what this
  // test used to reach for and skip on: the unified list is one date-sorted
  // list across every account, rendered by a virtualizer that only puts the
  // visible window in the DOM. Message dates come from the UID
  // (mockImap.js `stamp` = 2026-01-01 + uid days), and vader's INBOX runs to
  // uid 700 — so 658 vader messages are newer than luke's newest, and NO luke
  // INBOX message can reach the rendered window without scrolling past ~600
  // rows. "Luke message 2" was the oldest message in the entire suite: the old
  // skip was arithmetic, not a bug. yoda's UIDs start at 901, which puts its
  // mail at the top of the list where a test can actually see it.

  describe('unified inbox: delete, churn accounts, reload', function () {
    async function switchToUnified() {
      // "All Inboxes" is the sidebar's actual label (see connected-unified-inbox.test.js).
      expect(await browser.execute(() => {
        const btn = document.querySelector('[data-testid="all-inboxes-btn"]');
        if (btn && btn.offsetHeight > 0) { btn.click(); return true; }
        return false;
      })).toBe(true);
      await waitForEmails();
    }

    it('a row deleted in unified mode stays gone across account churn and a reload', async function () {
      await switchToUnified();
      const subject = 'Yoda message 905';

      // Not a skip: if the newest account in the suite cannot reach the top of
      // the unified list, unified mode is not merging that account at all —
      // which is the finding, and it should fail loudly.
      await browser.waitUntil(async () => !!(await rowFor(subject)), {
        timeout: 20_000, interval: 500,
        timeoutMsg: `"${subject}" never appeared in the unified list. yoda's mail is the newest in the ` +
          `suite, so it should be at the very top — unified mode is not merging this account.`,
      });

      expect(await toggleRowExact(subject)).toBe(true);
      expect(await clickBarButton('Delete from server')).toBe(true);
      await waitForBodyText('cannot be undone', 'Delete-from-server confirmation never appeared (unified)');
      expect(await confirmDeletePopover()).toBe(true);

      console.log('[unified] row right after confirming delete:', JSON.stringify(await rowFor(subject)));

      // Churn through the single-account views while the (4s-stalled) delete is
      // still on the wire, then come back to Unified. The gap this probes:
      // deleteSelectedFromServer skips its trailing loadEmails() entirely in
      // unified mode, and unified mode never prunes the header cache
      // (saveEmailHeaders gets `undefined` when isUnified), so the tombstone
      // set when the delete started is the only thing hiding the row — and
      // tombstones do not survive a reload.
      await churnAccounts([
        { email: LUKE, folder: 'Archive' },
        { email: VADER, folder: 'Matrix' },
        { email: YODA, folder: 'INBOX', requireRows: false },
      ]);
      await switchToUnified();
      console.log('[unified] row after churning three accounts and returning:', JSON.stringify(await rowFor(subject)));

      await browser.execute(() => window.location.reload());
      await waitForApp();
      await switchToUnified();

      // After a reload the tombstone is gone, so this is the real question:
      // does the deleted message come back from the header cache?
      await browser.waitUntil(async () => !(await rowFor(subject)), {
        timeout: 30_000, interval: 500,
        timeoutMsg: `"${subject}" is back in the unified inbox after a reload. The server delete succeeded, ` +
          `so this row is being repainted from a header sidecar that unified mode never prunes.`,
      });
    });
  });
});
