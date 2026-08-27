/**
 * E2E: one message the server refuses does not make the whole backup a failure.
 *
 * Reported 2026-08-27. The macOS notification read:
 *
 *   Backup failed - info@moderniosaplikacijos.lt - Unknown error.
 *   Will retry on next idle.
 *
 * The log for the same run read:
 *
 *   archive_emails: UID 799 failed: "IMAP fetch failed: UID FETCH 799 failed:
 *   io: bytes remaining in stream"
 *   backup: completed for info@moderniosaplikacijos.lt — 788 new emails backed
 *   up, 1 errors, 389.1s (folders: 10/10)
 *
 * Two defects, both asserted below: `success` was `total_errors == 0`, so a
 * single refused message flipped a complete run to "failed", and the result
 * carried no `error_message`, so the only thing the user was told about 788
 * saved messages was the words "Unknown error".
 *
 * Scoped to yoda's "Bokelmu&Awg-hle", which is LAST in its LIST order —
 * `skip_folders` skips a PREFIX, so skipFolders: 5 backs up that folder and
 * nothing else. Its uids start at 9101 (wdio.conf.js) precisely so the fault on
 * 9102 can name a message in this folder and in no other: mock faults match a
 * uid with no mailbox scoping.
 */

import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitForApp, waitForEmails } from './helpers.js';
import { appDataDir } from './mockImap.js';

const YODA = 'yoda@mock.test';
const FOLDER = 'Bokelmu&Awg-hle';   // the wire name — what SELECT and the mirror use
// The vault sanitizes every non-alphanumeric character out of a folder name
// (`maildir_cur_path` in src-tauri/src/main.rs); the external mirror does not.
const VAULT_FOLDER = 'Bokelmu_Awg-hle';
const FOLDER_UIDS = [9101, 9102, 9103];
const REFUSED_UID = 9102;

describe('Backup — a message the server refuses is a partial run, not a failed one', function () {
  this.timeout(300_000);

  let accountId = null;
  let cur = null;
  let mirror = null;
  let backupRoot = null;
  let result = null;

  /** `browser.execute` does not await a Promise; `executeAsync` does. */
  function invoke(cmd, args) {
    return browser.executeAsync((c, a, done) => {
      window.__TAURI__.core.invoke(c, a).then(done).catch((e) => done({ __error: String(e && e.message || e) }));
    }, cmd, args);
  }

  /** The Maildir name holding this uid, whatever flag suffix it carries. */
  function findByUid(dir, uid) {
    if (!existsSync(dir)) return null;
    for (const name of readdirSync(dir)) {
      if (name.startsWith(`${uid}:`) || name === `${uid}.eml`) return name;
    }
    return null;
  }

  before(async function () {
    await waitForApp();
    await waitForEmails();

    const account = browser.mockAccounts.find((a) => a.email === YODA);
    accountId = account.id;
    cur = join(appDataDir(browser.testDataDir), 'Maildir', accountId, VAULT_FOLDER, 'cur');

    // This spec's own mirror. connected-backup-orphan-restore points the app at
    // a temp dir it then deletes, so inheriting whatever location is stored
    // would test that spec's teardown instead of this one's subject.
    backupRoot = mkdtempSync(join(tmpdir(), 'mv-partial-mirror-'));
    mirror = join(backupRoot, YODA, FOLDER, 'cur');
    await invoke('backup_save_external_location', { path: backupRoot });

    result = await invoke('backup_run_account', {
      accountId,
      accountJson: JSON.stringify(account),
      backupPath: null,
      skipFolders: 5,
    });
    console.log('[backup-partial] backup_run_account ->', JSON.stringify(result));
  });

  after(function () {
    for (const uid of FOLDER_UIDS) {
      const name = findByUid(cur, uid);
      if (name) rmSync(join(cur, name), { force: true });
    }
    if (backupRoot) rmSync(backupRoot, { recursive: true, force: true });
  });

  it('reports success — the run completed, it just did not get everything', function () {
    expect(result.__error).toBe(undefined, `backup_run_account threw: ${result.__error}`);
    expect(result.success).toBe(
      true,
      'one refused message reported the whole run as failed — this is the "Backup failed" notification on a backup that worked'
    );
    expect(result.cancelled).toBe(false);
  });

  it('counts the message it could not fetch', function () {
    expect(result.errors).toBe(1);
    expect(result.emails_backed_up).toBe(FOLDER_UIDS.length - 1);
  });

  it('says what failed instead of leaving the UI to invent "Unknown error"', function () {
    expect(result.error_message).toEqual(expect.any(String));
    expect(result.error_message).toContain('1 of 3 messages could not be fetched');
    // The server's own words, not a category — this is the line that tells the
    // user (and the next reader of a bug report) which message and why.
    expect(result.error_message).toMatch(/Last error: \S/);
    expect(result.error_message).not.toContain('Unknown error');
  });

  it('saves every message the server did hand over', function () {
    for (const uid of FOLDER_UIDS.filter((u) => u !== REFUSED_UID)) {
      expect(findByUid(cur, uid)).not.toBe(null, `uid ${uid} never reached the vault`);
      expect(findByUid(mirror, uid)).not.toBe(null, `uid ${uid} never reached the external mirror`);
    }
  });

  it('leaves no half-written file behind for the refused message', function () {
    expect(findByUid(cur, REFUSED_UID)).toBe(null);
    expect(findByUid(mirror, REFUSED_UID)).toBe(null);
  });
});
