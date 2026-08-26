/**
 * E2E: the backup mirror must not undo the vault's generation repair.
 *
 * The external mirror is a flat `<email>/<mailbox>/cur/` copy keyed by uid, and
 * it carries no UIDVALIDITY of its own. The vault does: `.uidvalidity` records
 * the generation `cur/` is keyed under, and when the server reissues its UID
 * space `repair_generation` re-binds what it can by Message-ID and moves the
 * rest into `orphaned/`.
 *
 * Every backup run begins with a bidirectional pre-sync (backup.rs
 * `sync_locations`). Its Backup → App half used to copy any mirror file whose
 * uid was missing from `cur/` straight back in — **uid alone, no Message-ID, no
 * generation** — which put the orphaned message back under the number the new
 * server has since given to someone else. And because the repair had already
 * stamped `.uidvalidity` with the current generation, it no-ops from then on:
 * nothing ever re-checked. The vault stayed wrong until the next reissue.
 *
 * Observed for real on rare@graphicmeat.com (2026-08-26): four March files sat
 * byte-identical in `cur/` and `orphaned/`, and the vault's INBOX uid 4 served a
 * StrictSeal mail under an August Zendesk row.
 *
 * Scoped to luke's Trash so the real backup pipeline can run without touching
 * any other spec's fixture. `skip_folders` skips a PREFIX of the LIST order, so
 * the target has to be the account's LAST mailbox: luke's are
 * [INBOX, Sent, Archive, Drafts, Trash] and nothing gives luke an
 * `extraMailbox`. Do NOT reach for yoda here — yoda carries the IMAP-UTF-7
 * folder `Bokelmu&Awg-hle` (wdio.conf.js), so `skipFolders: 4` there would back
 * up connected-folder-encoding's fixture as well.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitForApp, waitForEmails } from './helpers.js';
import { appDataDir } from './mockImap.js';

const LUKE = 'luke@mock.test';

// Deliberately outside every mock server's UID space, so `find_file_by_uid`
// misses in `cur/` and the restore path is actually reached.
const SET_ASIDE_UID = 999_101;
const RESTORABLE_UID = 999_102;

const SET_ASIDE_ID = 'set-aside-by-the-repair@old-host.test';
const RESTORABLE_ID = 'only-copy-left@mock.test';

const eml = (messageId, subject) => [
  'From: Old Host <team@previous-host.test>',
  `To: ${LUKE}`,
  `Subject: ${subject}`,
  `Message-ID: <${messageId}>`,
  'Date: Thu, 19 Mar 2026 22:36:07 +0000',
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  '',
  `Body of ${subject}.`,
  '',
].join('\r\n');

/** The Maildir name holding this uid, whatever flag suffix it carries. */
function findByUid(dir, uid) {
  if (!existsSync(dir)) return null;
  const prefix = `${uid}:`;
  const legacy = `${uid}.eml`;
  for (const name of readdirSync(dir)) {
    if (name.startsWith(prefix) || name === legacy) return name;
  }
  return null;
}

describe('Backup pre-sync — orphaned messages stay orphaned', function () {
  this.timeout(300_000);

  let accountId = null;
  let cur = null;
  let orphaned = null;
  let mirror = null;
  let backupRoot = null;

  /**
   * `browser.execute()` serializes the return value without awaiting a
   * Promise, so a Tauri invoke always came back `{}`. `executeAsync` waits.
   */
  function invoke(cmd, args) {
    return browser.executeAsync((c, a, done) => {
      window.__TAURI__.core.invoke(c, a).then(done).catch((e) => done({ __error: String(e && e.message || e) }));
    }, cmd, args);
  }

  before(async function () {
    await waitForApp();
    await waitForEmails();

    const account = browser.mockAccounts.find((a) => a.email === LUKE);
    accountId = account.id;

    const mailboxDir = join(appDataDir(browser.testDataDir), 'Maildir', accountId, 'Trash');
    cur = join(mailboxDir, 'cur');
    orphaned = join(mailboxDir, 'orphaned');
    mkdirSync(cur, { recursive: true });
    mkdirSync(orphaned, { recursive: true });

    backupRoot = mkdtempSync(join(tmpdir(), 'mv-orphan-mirror-'));
    mirror = join(backupRoot, LUKE, 'Trash', 'cur');
    mkdirSync(mirror, { recursive: true });

    // The repair's verdict: this message's Message-ID matched no uid the
    // current server issues, so it was moved out of the uid namespace.
    writeFileSync(join(orphaned, `${SET_ASIDE_UID}:2,.eml`), eml(SET_ASIDE_ID, 'Set aside by the repair'));
    // The mirror still holds that same message under the old uid.
    writeFileSync(join(mirror, `${SET_ASIDE_UID}:2,.eml`), eml(SET_ASIDE_ID, 'Set aside by the repair'));
    // ...alongside one the repair never touched, which must still come home.
    writeFileSync(join(mirror, `${RESTORABLE_UID}:2,S.eml`), eml(RESTORABLE_ID, 'Only copy left'));

    const loc = await invoke('backup_save_external_location', { path: backupRoot });
    console.log('[backup-orphan] backup_save_external_location ->', JSON.stringify(loc));

    // luke's mailboxes are [INBOX, Sent, Archive, Drafts, Trash] and
    // `skip_folders` skips a prefix of the LIST order, so this backs up Trash
    // and nothing else.
    const result = await invoke('backup_run_account', {
      accountId,
      accountJson: JSON.stringify(account),
      backupPath: null,
      skipFolders: 4,
    });
    console.log('[backup-orphan] backup_run_account ->', JSON.stringify(result));
  });

  after(function () {
    // Leave luke's Trash as this spec found it.
    for (const uid of [SET_ASIDE_UID, RESTORABLE_UID]) {
      const name = findByUid(cur, uid);
      if (name) rmSync(join(cur, name), { force: true });
    }
    const setAside = findByUid(orphaned, SET_ASIDE_UID);
    if (setAside) rmSync(join(orphaned, setAside), { force: true });
    if (backupRoot) rmSync(backupRoot, { recursive: true, force: true });
  });

  it('does not restore a message the generation repair set aside', function () {
    const restored = findByUid(cur, SET_ASIDE_UID);
    expect(restored).toBe(
      null,
      `the mirror put an orphaned message back into cur/ as ${restored} — the repair is undone on every backup run`
    );
  });

  it('still restores a mirror copy the repair never ruled out', function () {
    const name = findByUid(cur, RESTORABLE_UID);
    expect(name).not.toBe(null);
    expect(readFileSync(join(cur, name), 'utf8')).toContain(RESTORABLE_ID);
  });

  it('keeps the orphaned copy on disk — nothing here deletes mail', function () {
    expect(findByUid(orphaned, SET_ASIDE_UID)).not.toBe(null);
  });
});
