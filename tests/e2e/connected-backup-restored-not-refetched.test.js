/**
 * E2E: a server uid the backup's pre-sync restores from the mirror is not
 * fetched again.
 *
 * Each folder of a backup run pre-syncs the vault with the mirror
 * (backup.rs `sync_locations`), copying back any mirror file whose uid the
 * vault lacks, and then fetches every server uid the vault does not hold. The
 * run used to count the vault BEFORE the pre-sync, so a uid only the mirror
 * held was still "missing" once restored: the fetch downloaded it again and
 * wrote the server's copy beside the restored one, under a second name, and
 * `emails_backed_up` counted it. Nothing errored; the vault just held two files
 * for one message.
 *
 * A restored copy is named with `A`, as the fetch's own copy is: the vault copy
 * the backup makes is what puts the row in the list and what Clear cached
 * emails keeps.
 *
 * Scoped to vader's "Matrix" (LIST order [INBOX, Sent, Archive, Drafts, Trash,
 * Matrix], `skipFolders: 5`), as connected-backup-legacy-mirror-names is.
 * Matrix holds uids 1..6, even ones read, Message-ID `<mock-<uid>-vader@mock.test>`.
 * Nothing here changes the mock server.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitForApp, waitForEmails, runBackupAndWait } from './helpers.js';
import { appDataDir, INFO_SEP } from './mockImap.js';

const VADER = 'vader@mock.test';
const FOLDER = 'Matrix';
const SERVER_UIDS = [1, 2, 3, 4, 5, 6];
// On the mirror only, under the legacy `<uid>.eml` name: 3 is unread on the
// server, 4 is read, so neither restored name matches what a fetch would write.
const RESTORED = [3, 4];
const FETCHED = SERVER_UIDS.filter((uid) => !RESTORED.includes(uid));
// Only the mirror's copy says this; the server's body does not.
const MIRROR_MARK = 'Restored from the backup mirror.';

const eml = (uid) => [
  `From: Sender ${uid} <sender${uid}@example.com>`,
  `To: ${VADER}`,
  `Subject: Vader matrix ${uid}`,
  `Message-ID: <mock-${uid}-${VADER}>`,
  'Date: Thu, 19 Mar 2026 22:36:07 +0000',
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  '',
  MIRROR_MARK,
  '',
].join('\r\n');

/** The vault's rule: `<uid>:` exactly. */
const vaultNames = (dir, uid) =>
  existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith(`${uid}${INFO_SEP}`)) : [];

/** The mirror's rule: the text before the first ':', '.' or '_'. */
const mirrorNames = (dir, uid) =>
  existsSync(dir) ? readdirSync(dir).filter((n) => n.split(/[:;._]/)[0] === String(uid)) : [];

/** The Maildir flag letters of a vault name: `4:2,AS.eml` -> `AS`. */
const flagLetters = (name) => (name.split(/[:;]2,/)[1] || '').replace(/\.eml$/, '');

/** `browser.execute` does not await a Promise; `executeAsync` does. */
function invoke(cmd, args) {
  return browser.executeAsync((c, a, done) => {
    window.__TAURI__.core.invoke(c, a).then(done).catch((e) => done({ __error: String(e && e.message || e) }));
  }, cmd, args);
}

describe('Backup pre-sync: a uid restored from the mirror is not fetched again', function () {
  this.timeout(300_000);

  let account = null;
  let cur = null;
  let mirror = null;
  let backupRoot = null;

  async function backup() {
    // Fire-and-forget since the runners moved to the daemon: the outcome comes
    // off the terminal `backup-progress` frame, not the RPC's return value.
    const result = await runBackupAndWait({
      accountId: account.id,
      accountJson: JSON.stringify(account),
      backupPath: null,
      skipFolders: 5,
    });
    console.log('[restored-not-refetched] backup ->', JSON.stringify(result));
    console.log('[restored-not-refetched] vault:', JSON.stringify(existsSync(cur) ? readdirSync(cur).sort() : []));
    return result;
  }

  /** Every server uid, with its file count in the vault and on the mirror. */
  const counts = () => Object.fromEntries(
    SERVER_UIDS.map((uid) => [uid, [vaultNames(cur, uid).length, mirrorNames(mirror, uid).length]]),
  );

  before(async function () {
    await waitForApp();
    await waitForEmails();

    account = browser.mockAccounts.find((a) => a.email === VADER);
    cur = join(appDataDir(browser.testDataDir), 'Maildir', account.id, FOLDER, 'cur');

    backupRoot = mkdtempSync(join(tmpdir(), 'mv-restored-'));
    mirror = join(backupRoot, VADER, FOLDER, 'cur');
    mkdirSync(mirror, { recursive: true });
    for (const uid of RESTORED) writeFileSync(join(mirror, `${uid}.eml`), eml(uid));

    const loc = await invoke('backup_save_external_location', { path: backupRoot });
    if (loc?.__error) throw new Error(`backup_save_external_location: ${loc.__error}`);
  });

  after(function () {
    if (backupRoot) rmSync(backupRoot, { recursive: true, force: true });
  });

  it('fetches and counts only the uids neither side held', async function () {
    // Anti-vacuity: the vault holds nothing of Matrix yet, so the restore and
    // the fetch below are this run's doing.
    expect(SERVER_UIDS.flatMap((uid) => vaultNames(cur, uid))).toEqual([]);

    const result = await backup();
    expect(result.success).toBe(true);
    expect(result.emails_backed_up).toBe(FETCHED.length);
  });

  it('leaves exactly one file per uid in the vault and on the mirror', function () {
    const want = Object.fromEntries(SERVER_UIDS.map((uid) => [uid, [1, 1]]));
    expect(counts()).toEqual(want);
  });

  it("keeps the restored copy, marked archived and caught up to the server's read state", function () {
    for (const uid of RESTORED) {
      const names = vaultNames(cur, uid);
      expect(names).toHaveLength(1);
      expect(readFileSync(join(cur, names[0]), 'utf8')).toContain(MIRROR_MARK);
      expect(flagLetters(names[0])).toContain('A');
    }
    expect(flagLetters(vaultNames(cur, 4)[0])).toContain('S');
    expect(flagLetters(vaultNames(cur, 3)[0])).not.toContain('S');
  });

  it('a second backup adds nothing on either side', async function () {
    const before = counts();
    const result = await backup();
    expect(result.success).toBe(true);
    expect(result.emails_backed_up).toBe(0);
    expect(counts()).toEqual(before);
  });
});
