/**
 * E2E: a vault whose UIDs belong to a generation the server has replaced.
 *
 * The vault Maildir is keyed (accountId, mailbox, uid), and a uid only means
 * anything inside one UIDVALIDITY generation. After a reissue — a change-server
 * migration, or one the server does on its own — every uid the vault holds
 * names a different message, and `getArchivedEmailIds` answers "yes, uid N is
 * archived" about mail that is not in the row.
 *
 * `.uidvalidity` records the generation `cur/` is keyed under. When it
 * disagrees with the mailbox's synced UIDVALIDITY, the vault is re-keyed by
 * Message-ID: a file the server still has moves to its new uid, and one the
 * server does not have moves to `orphaned/` — kept, never deleted, because the
 * vault may be its only copy.
 *
 * Seeded as a stale stamp rather than a stale file set because that is the one
 * input that makes the repair run: the same code path a real reissue takes.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { waitForApp, waitForEmails, switchToFolder } from './helpers.js';
import { appDataDir } from './mockImap.js';

const LUKE = 'luke@mock.test';
const OTHER = 'vader@mock.test';

// Deliberately unlike anything the mock server serves.
const GONE_UID = 999_001;
const MISFILED_UID = 999_002;
const GONE_MESSAGE_ID = 'only-on-the-previous-server@old-host.test';

const eml = (messageId, subject) => [
  'From: Old Host <team@previous-host.test>',
  'To: luke@mock.test',
  `Subject: ${subject}`,
  `Message-ID: <${messageId}>`,
  'Date: Thu, 19 Mar 2026 07:56:23 +0000',
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Archived under a uid from the previous generation.',
  '',
].join('\r\n');

describe('Vault — UID generation repair', function () {
  this.timeout(120_000);

  let accountId = null;
  let mailboxDir = null;
  let cur = null;
  let target = null;      // a real row: (uid, messageId) in the current generation
  let cacheDir = null;

  before(async function () {
    await waitForApp();
    await waitForEmails();
    await switchToFolder(LUKE, 'INBOX');

    accountId = browser.mockAccounts.find((a) => a.email === LUKE).id;
    const data = appDataDir(browser.testDataDir);
    mailboxDir = join(data, 'Maildir', accountId, 'INBOX');
    cur = join(mailboxDir, 'cur');
    cacheDir = join(data, 'email_cache', `${accountId.replace(/[^a-zA-Z0-9]/g, '_')}_INBOX`);

    // A row the server currently serves, and the Message-ID it serves it under.
    // The repair binds by Message-ID, so this is the only thing that can move a
    // vault file back onto a real uid.
    await browser.waitUntil(async () => {
      target = await browser.execute(() => {
        const rows = window.__MAIL_STORE__?.getState()?.sortedEmails || [];
        const row = rows.find((e) => e.messageId && e.uid);
        return row ? { uid: row.uid, messageId: row.messageId, subject: row.subject } : null;
      });
      return !!target;
    }, { timeout: 30_000, interval: 500, timeoutMsg: 'No row with a Message-ID to bind against' });

    mkdirSync(cur, { recursive: true });
    // The right message, filed under a uid from the dead generation.
    writeFileSync(
      join(cur, `${MISFILED_UID}:2,S.eml`),
      eml(target.messageId.replace(/^<|>$/g, ''), 'Misfiled by the previous server'),
    );
    // A message the current server has never had.
    writeFileSync(join(cur, `${GONE_UID}:2,.eml`), eml(GONE_MESSAGE_ID, 'Left behind by the previous server'));

    // The reissue itself: the vault says it is keyed under a generation the
    // mailbox no longer reports.
    writeFileSync(join(mailboxDir, '.uidvalidity'), '999999');
    rmSync(join(mailboxDir, 'orphaned'), { recursive: true, force: true });

    // Leaving and coming back is what makes the app re-read the vault's uid set,
    // which is where the repair is bound.
    await switchToFolder(OTHER, 'INBOX', { requireRows: false });
    await switchToFolder(LUKE, 'INBOX');
  });

  it('seeded both vault files and a stale generation stamp', function () {
    // Positive control: every assertion below is about files moving, and an
    // absence assertion proves nothing until the container is proven populated.
    expect(target).not.toBe(null);
    expect(existsSync(join(cur, `${GONE_UID}:2,.eml`)) || existsSync(join(mailboxDir, 'orphaned'))).toBe(true);
  });

  it('has a sidecar cache complete enough to prove a message is gone', function () {
    // The repair refuses to move anything aside while the cache is partial —
    // during a cold start it is empty, and every message would read as gone.
    // If this is ever false, the repair legitimately did nothing and the
    // assertions below are testing the wrong thing.
    const meta = JSON.parse(readFileSync(join(cacheDir, '_meta.json'), 'utf8'));
    const sidecars = readdirSync(cacheDir).filter((f) => /^\d+\.json$/.test(f)).length;
    expect(meta.uidValidity).toBeGreaterThan(0);
    expect(sidecars).toBeGreaterThanOrEqual(meta.totalEmails);
  });

  it('re-keys a vault file the server still has onto its current uid', async function () {
    await browser.waitUntil(
      async () => !existsSync(join(cur, `${MISFILED_UID}:2,S.eml`)),
      { timeout: 30_000, interval: 500, timeoutMsg: 'The misfiled vault file was never re-keyed' },
    );
    // Flags and timestamp ride along; only the uid changes.
    expect(existsSync(join(cur, `${target.uid}:2,S.eml`))).toBe(true);
  });

  it('sets aside a vault file the server does not have, without deleting it', function () {
    expect(existsSync(join(cur, `${GONE_UID}:2,.eml`))).toBe(false);
    const orphans = readdirSync(join(mailboxDir, 'orphaned'));
    expect(orphans.some((f) => f.startsWith(`${GONE_UID}:`))).toBe(true);
    // The mail itself survives — this is a vault, not a cache.
    const kept = readFileSync(join(mailboxDir, 'orphaned', orphans.find((f) => f.startsWith(`${GONE_UID}:`))), 'utf8');
    expect(kept).toContain(GONE_MESSAGE_ID);
  });

  it('records the generation it re-keyed onto, so it does not run again', function () {
    const meta = JSON.parse(readFileSync(join(cacheDir, '_meta.json'), 'utf8'));
    expect(readFileSync(join(mailboxDir, '.uidvalidity'), 'utf8').trim()).toBe(String(meta.uidValidity));
  });
});
