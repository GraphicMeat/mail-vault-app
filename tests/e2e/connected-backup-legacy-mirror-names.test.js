/**
 * E2E: one message, one file, on each side, whatever name the mirror has for it.
 *
 * The backup pre-sync (backup.rs `sync_locations`), the backup's own mirror
 * write (archive.rs `fetch_and_store`), re-archiving (`archive_emails`) and the
 * verify before a server delete (`verify_archived_emails`) all used to look a
 * uid up with a fresh read_dir per message. They now list a folder once per
 * run, and each kept its own uid rule while doing so:
 *
 *   - the vault side matches `<uid>:` exactly;
 *   - the mirror side takes whatever precedes the first ':', '.' or '_', because
 *     the mirror has held `<uid>:2,<flags>.eml`, legacy `<uid>.eml` and
 *     `<uid>_<flags>.eml` over its life.
 *
 * Swap either rule, or forget that a copy just made counts, and a folder ends
 * up with two files for one uid under two names. Nothing errors; the mirror
 * just grows, and a restore uploads both. So every case here counts files per
 * uid rather than looking for one name.
 *
 * Scoped to vader's "Matrix" (LIST order [INBOX, Sent, Archive, Drafts, Trash,
 * Matrix], `skipFolders: 5`), the mailbox connected-read-state-vault and
 * connected-storage-matrix back up the same way. Nothing here changes the mock
 * server: a fetch sets no flag, and nothing is deleted or stored upstream.
 * Matrix holds uids 1..6, even ones read, Message-ID `<mock-<uid>-vader@mock.test>`.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitForApp, waitForEmails } from './helpers.js';
import { appDataDir } from './mockImap.js';

const VADER = 'vader@mock.test';
const FOLDER = 'Matrix';
const SERVER_UIDS = [1, 2, 3, 4, 5, 6];

// Outside the mock's uid space: the pre-sync is the only thing that can move them.
const MIRROR_LEGACY = 999_301;     // mirror `<uid>.eml` only: restores, marked archived
const MIRROR_FLAGGED = 999_302;    // mirror `<uid>:2,F.eml` only: restores with its flag, marked archived
const VAULT_ONLY = 999_303;        // vault only: mirrored under its own name
const BOTH_LEGACY = 999_304;       // vault `<uid>:2,S.eml`, mirror `<uid>.eml`: nothing moves
const LOCAL_UIDS = [MIRROR_LEGACY, MIRROR_FLAGGED, VAULT_ONLY, BOTH_LEGACY];

const SET_ASIDE_ID = 'set-aside-by-the-repair@old-host.test';

const eml = (messageId, subject) => [
  'From: Old Host <team@previous-host.test>',
  `To: ${VADER}`,
  `Subject: ${subject}`,
  `Message-ID: <${messageId}>`,
  'Date: Thu, 19 Mar 2026 22:36:07 +0000',
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  '',
  `Body of ${subject}.`,
  '',
].join('\r\n');

/** The vault's rule: `<uid>:` exactly. */
const vaultNames = (dir, uid) =>
  existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith(`${uid}:`)) : [];

/** The mirror's rule: the text before the first ':', '.' or '_'. */
const mirrorNames = (dir, uid) =>
  existsSync(dir) ? readdirSync(dir).filter((n) => n.split(/[:._]/)[0] === String(uid)) : [];

/** The Maildir flag letters of a vault name: `4:2,AS.eml` -> `AS`. */
const flagLetters = (name) => (name.split(':2,')[1] || '').replace(/\.eml$/, '');

/** `browser.execute` does not await a Promise; `executeAsync` does. */
function invoke(cmd, args) {
  return browser.executeAsync((c, a, done) => {
    window.__TAURI__.core.invoke(c, a).then(done).catch((e) => done({ __error: String(e && e.message || e) }));
  }, cmd, args);
}

describe('Legacy mirror names — one file per uid on each side of a backup', function () {
  this.timeout(300_000);

  let account = null;
  let cur = null;
  let mirror = null;
  let backupRoot = null;

  async function backup() {
    const result = await invoke('backup_run_account', {
      accountId: account.id,
      accountJson: JSON.stringify(account),
      backupPath: null,
      skipFolders: 5,
    });
    if (result?.__error) throw new Error(`backup_run_account: ${result.__error}`);
    console.log('[legacy-mirror] backup_run_account ->', JSON.stringify(result));
    return result;
  }

  /** Every uid this spec touches, with its file count on each side. */
  const counts = () => Object.fromEntries(
    [...SERVER_UIDS, ...LOCAL_UIDS].map((uid) => [uid, [vaultNames(cur, uid).length, mirrorNames(mirror, uid).length]]),
  );

  before(async function () {
    await waitForApp();
    await waitForEmails();

    account = browser.mockAccounts.find((a) => a.email === VADER);
    const mailboxDir = join(appDataDir(browser.testDataDir), 'Maildir', account.id, FOLDER);
    cur = join(mailboxDir, 'cur');
    const orphaned = join(mailboxDir, 'orphaned');
    mkdirSync(cur, { recursive: true });
    mkdirSync(orphaned, { recursive: true });

    backupRoot = mkdtempSync(join(tmpdir(), 'mv-legacy-mirror-'));
    mirror = join(backupRoot, VADER, FOLDER, 'cur');
    mkdirSync(mirror, { recursive: true });

    // Server uids 3 and 4 in the vault, and on the mirror under both legacy
    // shapes: the pre-sync has nothing to copy either way; the flag catch-up
    // marks both archived. (A server uid only the mirror holds is
    // connected-backup-restored-not-refetched's case.)
    writeFileSync(join(cur, '3:2,.eml'), eml(`mock-3-${VADER}`, 'Vader matrix 3'));
    writeFileSync(join(mirror, '3.eml'), eml(`mock-3-${VADER}`, 'Vader matrix 3'));
    writeFileSync(join(cur, '4:2,S.eml'), eml(`mock-4-${VADER}`, 'Vader matrix 4'));
    writeFileSync(join(mirror, '4_S.eml'), eml(`mock-4-${VADER}`, 'Vader matrix 4'));
    // Server uid 6 on the mirror as `6.eml`, holding a message the generation
    // repair set aside: the pre-sync must not restore it, so the backup fetches
    // uid 6 into the vault, and its mirror write has to see `6.eml` as uid 6.
    writeFileSync(join(mirror, '6.eml'), eml(SET_ASIDE_ID, 'Set aside by the repair'));
    writeFileSync(join(orphaned, '6:2,.eml'), eml(SET_ASIDE_ID, 'Set aside by the repair'));

    writeFileSync(join(mirror, `${MIRROR_LEGACY}.eml`), eml(`legacy-${MIRROR_LEGACY}@old-host.test`, 'Legacy mirror name'));
    writeFileSync(join(mirror, `${MIRROR_FLAGGED}:2,F.eml`), eml(`flagged-${MIRROR_FLAGGED}@old-host.test`, 'Flagged mirror name'));
    writeFileSync(join(cur, `${VAULT_ONLY}:2,S.eml`), eml(`vault-only-${VAULT_ONLY}@mock.test`, 'Vault only'));
    writeFileSync(join(cur, `${BOTH_LEGACY}:2,S.eml`), eml(`both-${BOTH_LEGACY}@mock.test`, 'On both sides'));
    writeFileSync(join(mirror, `${BOTH_LEGACY}.eml`), eml(`both-${BOTH_LEGACY}@mock.test`, 'On both sides'));

    // A stale vault copy of server uid 1 under a flag name the server never
    // gave it, and a body that is not the server's. Re-archiving uid 1 has to
    // replace it, not add a second file beside it.
    writeFileSync(join(cur, '1:2,F.eml'), eml('stale-copy@old-host.test', 'Stale vault copy'));

    const loc = await invoke('backup_save_external_location', { path: backupRoot });
    if (loc?.__error) throw new Error(`backup_save_external_location: ${loc.__error}`);
  });

  after(function () {
    if (backupRoot) rmSync(backupRoot, { recursive: true, force: true });
  });

  it('re-archiving a uid replaces the vault copy that was already there', async function () {
    expect(vaultNames(cur, 1)).toEqual(['1:2,F.eml']);

    // Task 3.5: archive_emails moved to the daemon, no longer a native
    // Tauri command — reach it through daemon_rpc like every other
    // daemon-owned method. backup_save_external_location/backup_run_account
    // in this file stay native (backup itself is deferred), so the shared
    // `invoke()` wrapper above stays untouched; only this call site changes.
    const result = await invoke('daemon_rpc', {
      method: 'archive_emails',
      params: {
        accountId: account.id,
        accountJson: JSON.stringify(account),
        mailbox: FOLDER,
        uids: [1],
      },
    });
    expect(result?.__error).toBe(undefined);
    expect(result.completed).toBe(1);

    const names = vaultNames(cur, 1);
    expect(names).toHaveLength(1);
    expect(names[0]).not.toBe('1:2,F.eml');
    expect(readFileSync(join(cur, names[0]), 'utf8')).toContain('Subject: Vader matrix 1');
  });

  it('the backup leaves exactly one file per uid in the vault and on the mirror', async function () {
    const result = await backup();
    expect(result.success).toBe(true);
    // Anti-vacuity: 2 and 5 are nowhere locally and 6 only on the mirror, so
    // the backup's own fetch-and-mirror path ran for them.
    expect(result.emails_backed_up).toBe(3);

    const want = Object.fromEntries([...SERVER_UIDS, ...LOCAL_UIDS].map((uid) => [uid, [1, 1]]));
    expect(counts()).toEqual(want);
  });

  it('restores each legacy mirror name under the vault name, and mirrors the vault-only file under its own', function () {
    expect(vaultNames(cur, MIRROR_LEGACY)).toEqual([`${MIRROR_LEGACY}:2,A.eml`]);
    expect(vaultNames(cur, MIRROR_FLAGGED)).toEqual([`${MIRROR_FLAGGED}:2,AF.eml`]);
    expect(mirrorNames(mirror, VAULT_ONLY)).toEqual([`${VAULT_ONLY}:2,S.eml`]);
    expect(mirrorNames(mirror, BOTH_LEGACY)).toEqual([`${BOTH_LEGACY}.eml`]);
    // uid 1 reached the vault by re-archiving, and the mirror by the pre-sync.
    expect(readFileSync(join(mirror, mirrorNames(mirror, 1)[0]), 'utf8')).toContain('Subject: Vader matrix 1');
  });

  it('marks every vault copy the backup counted as archived', function () {
    // Both were already on both sides, so only the flag catch-up can name them.
    expect(vaultNames(cur, 3)).toEqual(['3:2,A.eml']);
    expect(vaultNames(cur, 4)).toEqual(['4:2,AS.eml']);
    for (const uid of SERVER_UIDS) {
      const names = vaultNames(cur, uid);
      expect(names).toHaveLength(1);
      expect(flagLetters(names[0])).toContain('A');
    }
    // The catch-up walks the SERVER's uids, so a vault-only uid the server
    // never had is not promoted — it gains `A` the next time the mirror
    // restores it.
    expect(vaultNames(cur, VAULT_ONLY)).toEqual([`${VAULT_ONLY}:2,S.eml`]);
  });

  it('keeps the mirror copy the repair set aside instead of writing a second uid 6 beside it', function () {
    const names = mirrorNames(mirror, 6);
    expect(names).toHaveLength(1);
    expect(readFileSync(join(mirror, names[0]), 'utf8')).toContain(SET_ASIDE_ID);
    expect(readFileSync(join(cur, vaultNames(cur, 6)[0]), 'utf8')).toContain('Subject: Vader matrix 6');
  });

  it('a second backup adds nothing on either side', async function () {
    const before = counts();
    const result = await backup();
    expect(result.success).toBe(true);
    expect(result.emails_backed_up).toBe(0);
    expect(counts()).toEqual(before);
  });

  it('verifies restored and fetched copies by Message-ID, and reports a uid with no file as missing', async function () {
    // Task 3.5: verify_archived_emails moved to the daemon too.
    const result = await invoke('daemon_rpc', {
      method: 'verify_archived_emails',
      params: {
        accountId: account.id,
        mailbox: FOLDER,
        uids: [1, 3, 4, 6, MIRROR_LEGACY, 424_242],
        expectedIds: {
          1: `<mock-1-${VADER}>`,
          3: `<mock-3-${VADER}>`,
          6: `<mock-6-${VADER}>`,
          [MIRROR_LEGACY]: '<some-other-message@old-host.test>',
        },
      },
    });
    expect(result?.__error).toBe(undefined);
    expect([...result.verified].sort((a, b) => a - b)).toEqual([1, 3, 4, 6]);
    expect(result.missing).toEqual([424_242]);
    expect(result.mismatched).toEqual([MIRROR_LEGACY]);
  });
});
