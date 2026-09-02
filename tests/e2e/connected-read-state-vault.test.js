/**
 * E2E: read state is ONE fact, wherever you read it — the server, the vault
 * file, the vault's index, the header cache, the external mirror.
 *
 * Reported 2026-09-02 as "an issue with mark as read and unread between
 * server/vault/backup". Six copies of the flag, and the vault file name — the
 * one restore uploads, the mirror copies and every .eml read reports — was
 * written once with a hardcoded "seen" and never again. So:
 *
 *   - archiving an unread message stored it as READ (`<uid>:2,AS`), and a
 *     restore to a new server uploaded every vault message as read;
 *   - marking a message read or unread here changed the server, memory and
 *     local-index.json, and nothing else: the file, its mirror copy and the
 *     header sidecar kept the old state, so a switch away and back repainted
 *     the old state until a delta sync happened to correct it;
 *   - a change made on the server elsewhere never reached the vault at all —
 *     a backup run compared uids and skipped anything already stored.
 *
 * Two accounts, on purpose: luke for what the app does to the vault, vader for
 * what the backup does with the server's state. vader's "Matrix" is the one
 * mailbox a backup run can be scoped to (LIST order [INBOX, Sent, Archive,
 * Drafts, Trash, Matrix], `skipFolders: 5` — see wdio.conf.js and
 * connected-storage-matrix, which uses it the same way and runs after this
 * file; the flags this spec changes on the mock server are put back in
 * `after`).
 *
 * The "other client" is a raw IMAP session from this process to the mock
 * (rawImap.js) — the same wire the app uses, with none of the app in the way.
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitForApp, waitForEmails, switchToFolder } from './helpers.js';
import { appDataDir } from './mockImap.js';
import { serverFlags, storeFlag } from './rawImap.js';

const LUKE = 'luke@mock.test';
const VADER = 'vader@mock.test';


// ── Disk ────────────────────────────────────────────────────────────────────

/** The Maildir name holding this uid, whatever flag suffix it carries. */
function nameOf(dir, uid) {
  if (!existsSync(dir)) return null;
  for (const name of readdirSync(dir)) {
    if (name.startsWith(`${uid}:`) || name === `${uid}.eml`) return name;
  }
  return null;
}

/**
 * `flags` of the uid's entry in a JSON file, whichever of the three shapes it
 * has: a bare array (local-index.json), `{emails:[…]}` (archived_headers.json),
 * or ONE object (a header sidecar is a single message).
 */
function jsonFlags(path, uid) {
  if (!existsSync(path)) return null;
  const v = JSON.parse(readFileSync(path, 'utf-8'));
  const entries = Array.isArray(v) ? v : (v.uid != null ? [v] : (v.emails || []));
  const entry = entries.find((e) => Number(e.uid) === uid);
  return entry ? entry.flags : null;
}

const SEEN_NAME = (uid) => new RegExp(`^${uid}:2,[A-Z]*S[A-Z]*(\\.eml)?$`);
const UNSEEN_NAME = (uid) => new RegExp(`^${uid}:2,[A-Z]*(\\.eml)?$`);
const isSeenName = (name, uid) => !!name && SEEN_NAME(uid).test(name);
const isUnseenName = (name, uid) => !!name && UNSEEN_NAME(uid).test(name) && !isSeenName(name, uid);

function waitFor(pred, msg, timeout = 30_000) {
  return browser.waitUntil(async () => pred(), { timeout, interval: 300, timeoutMsg: msg });
}

/** `browser.execute` does not await a Promise; `executeAsync` does. */
function invoke(cmd, args) {
  return browser.executeAsync((c, a, done) => {
    window.__TAURI__.core.invoke(c, a).then(done).catch((e) => done({ __error: String(e && e.message || e) }));
  }, cmd, args);
}

// ── The list ────────────────────────────────────────────────────────────────

const rows = () => browser.execute(() =>
  [...document.querySelectorAll('[data-testid="email-row"]')].map((row) => ({
    text: (row.innerText || '').replace(/\s*\n\s*/g, ' | ').trim(),
    // The unread marker EmailRow/ThreadRow put on the row root.
    unread: row.classList.contains('bg-mail-surface'),
  })));

/** The vault's own answer for a message — read off its file, not the list. */
async function vaultFlags(accountId, mailbox, uid) {
  const light = await invoke('maildir_read_light', { accountId, mailbox, uid });
  if (light?.__error) throw new Error(`maildir_read_light: ${light.__error}`);
  return light ? light.flags : null;
}

// Whole segment, not substring: the row text is "Sender 4 | Luke message 4 |
// Jan 5", and "Luke message 4" is also inside "Luke message 41".
const hasSubject = (text, subject) => text.split(' | ').includes(subject);

const rowFor = async (subject) => (await rows()).find((r) => hasSubject(r.text, subject));

/** Plain single-message rows the store holds, with what it believes about them. */
const storeRows = (prefix) => browser.execute((p) => {
  const s = window.__MAIL_STORE__?.getState?.();
  const re = new RegExp(`^${p} \\d+$`);
  return (s?.sortedEmails || [])
    .filter((e) => re.test(e.subject || ''))
    .map((e) => ({ uid: e.uid, subject: e.subject, archived: !!e.isArchived, seen: !!e.flags?.includes('\\Seen') }));
}, prefix);

const clickRowButton = (subject, title) => browser.execute((needle, t) => {
  for (const row of document.querySelectorAll('[data-testid="email-row"]')) {
    if (!(row.innerText || '').split(/\s*\n\s*/).includes(needle)) continue;
    const btn = row.querySelector(`button[title="${t}"]`);
    if (!btn) return false;
    btn.click();
    return true;
  }
  return false;
}, subject, title);

const clickRowCheckbox = (subject) => browser.execute((needle) => {
  for (const row of document.querySelectorAll('[data-testid="email-row"]')) {
    if (!(row.innerText || '').split(/\s*\n\s*/).includes(needle)) continue;
    const box = row.querySelector('input[type="checkbox"]');
    if (!box) return false;
    box.click();
    return true;
  }
  return false;
}, subject);

const clickBarButton = (title) => browser.execute((t) => {
  const btn = document.querySelector(`button[title="${t}"]`);
  if (!btn || btn.offsetHeight === 0) return false;
  btn.click();
  return true;
}, title);

describe('Read state — what the app does reaches every copy the vault keeps', function () {
  this.timeout(300_000);

  let account = null;
  let cur = null;
  let index = null;
  let sidecarDir = null;
  let mirror = null;
  let backupRoot = null;

  let unreadSubject = null;
  let unreadUid = null;
  let readSubject = null;
  let readUid = null;

  before(async function () {
    await waitForApp();
    await waitForEmails();
    await switchToFolder(LUKE, 'INBOX');

    account = browser.mockAccounts.find((a) => a.email === LUKE);
    const data = appDataDir(browser.testDataDir);
    cur = join(data, 'Maildir', account.id, 'INBOX', 'cur');
    index = join(data, 'maildir', account.id, 'INBOX', 'local-index.json');
    sidecarDir = join(data, 'email_cache', `${account.id.replace(/[^a-zA-Z0-9]/g, '_')}_INBOX`);

    // This spec's own mirror, so the mirror assertions test this spec's subject
    // and not whatever location another spec left stored.
    backupRoot = mkdtempSync(join(tmpdir(), 'mv-read-state-mirror-'));
    mirror = join(backupRoot, LUKE, 'INBOX', 'cur');
    mkdirSync(mirror, { recursive: true });
    const loc = await invoke('backup_save_external_location', { path: backupRoot });
    if (loc?.__error) throw new Error(`backup_save_external_location: ${loc.__error}`);
  });

  after(async function () {
    // The mock servers outlive this file; put the flag this spec flipped back.
    if (unreadUid != null) {
      try { await storeFlag(account.imapPort, 'INBOX', unreadUid, '-FLAGS'); } catch (e) { console.warn('[read-state] restore failed:', e.message); }
    }
    if (backupRoot) rmSync(backupRoot, { recursive: true, force: true });
  });

  it('archives an unread message as unread, and a read one as read', async function () {
    // Unarchived plain rows, one of each state. The fixture makes odd uids
    // unread and even uids read (mockImap.js `mailbox`), so both exist.
    const plain = (await storeRows('Luke message')).filter((r) => !r.archived);
    const unread = plain.find((r) => !r.seen);
    const read = plain.find((r) => r.seen);
    if (!unread || !read) throw new Error(`need one unread and one read unarchived row, have ${JSON.stringify(plain)}`);
    ({ subject: unreadSubject, uid: unreadUid } = unread);
    ({ subject: readSubject, uid: readUid } = read);

    for (const [subject, uid] of [[unreadSubject, unreadUid], [readSubject, readUid]]) {
      expect(await clickRowButton(subject, 'Archive')).toBe(true);
      await waitFor(() => nameOf(cur, uid) !== null, `"${subject}" (uid ${uid}) never reached the vault`);
    }

    // The file name is what restore uploads and what the mirror copies: it
    // used to say "seen" for both of these.
    expect(isUnseenName(nameOf(cur, unreadUid), unreadUid)).toBe(true);
    expect(isSeenName(nameOf(cur, readUid), readUid)).toBe(true);

    // And what the vault reports when asked about its own file — a row built
    // from the .eml used to get the Maildir words alone and render unread.
    expect(await vaultFlags(account.id, 'INBOX', unreadUid)).not.toContain('\\Seen');
    expect(await vaultFlags(account.id, 'INBOX', readUid)).toContain('\\Seen');

    // The index was already written with the row's server flags before this
    // change; pinned so the two records cannot drift apart again.
    await waitFor(() => jsonFlags(index, unreadUid) !== null && jsonFlags(index, readUid) !== null,
      'local-index.json never got both entries');
    expect(jsonFlags(index, unreadUid)).not.toContain('\\Seen');
    expect(jsonFlags(index, readUid)).toContain('\\Seen');

    // And the row did not change state just by being archived.
    expect((await rowFor(unreadSubject)).unread).toBe(true);
    expect((await rowFor(readSubject)).unread).toBe(false);
  });

  it('marking it read lands on the server, the file, the index, the sidecar and the mirror', async function () {
    expect(unreadSubject).not.toBeNull();
    // A mirror copy, as a backup run would have left it — planted rather than
    // backed up, so no server fetch of luke's whole INBOX has to be waited on.
    const name = nameOf(cur, unreadUid);
    copyFileSync(join(cur, name), join(mirror, name.endsWith('.eml') ? name : `${name}.eml`));
    expect(isUnseenName(nameOf(mirror, unreadUid), unreadUid)).toBe(true);

    expect(await clickRowCheckbox(unreadSubject)).toBe(true);
    expect(await clickBarButton('Mark as read')).toBe(true);

    await waitFor(async () => (await rowFor(unreadSubject))?.unread === false, `"${unreadSubject}" stayed unread on screen`);
    await waitFor(async () => (await serverFlags(account.imapPort, 'INBOX', unreadUid))?.includes('\\Seen'),
      'the server never got \\Seen');
    await waitFor(() => isSeenName(nameOf(cur, unreadUid), unreadUid),
      `vault file never renamed to read — cur/ holds ${nameOf(cur, unreadUid)}`);
    await waitFor(() => isSeenName(nameOf(mirror, unreadUid), unreadUid),
      `mirror copy never renamed to read — mirror holds ${nameOf(mirror, unreadUid)}`);
    await waitFor(() => (jsonFlags(index, unreadUid) || []).includes('\\Seen'), 'local-index.json never got \\Seen');
    await waitFor(() => (jsonFlags(join(sidecarDir, `${unreadUid}.json`), unreadUid) || []).includes('\\Seen'),
      'the header sidecar never got \\Seen — the next repaint from cache would show it unread again');
  });

  it('marking it unread takes it back off every copy', async function () {
    expect(await clickRowCheckbox(unreadSubject)).toBe(true);
    expect(await clickBarButton('Mark as unread')).toBe(true);

    await waitFor(async () => (await rowFor(unreadSubject))?.unread === true, `"${unreadSubject}" stayed read on screen`);
    await waitFor(async () => !(await serverFlags(account.imapPort, 'INBOX', unreadUid))?.includes('\\Seen'),
      'the server kept \\Seen');
    await waitFor(() => isUnseenName(nameOf(cur, unreadUid), unreadUid),
      `vault file kept its S — cur/ holds ${nameOf(cur, unreadUid)}`);
    await waitFor(() => isUnseenName(nameOf(mirror, unreadUid), unreadUid),
      `mirror copy kept its S — mirror holds ${nameOf(mirror, unreadUid)}`);
    await waitFor(() => !(jsonFlags(index, unreadUid) || []).includes('\\Seen'), 'local-index.json kept \\Seen');
    await waitFor(() => !(jsonFlags(join(sidecarDir, `${unreadUid}.json`), unreadUid) || []).includes('\\Seen'),
      'the header sidecar kept \\Seen');
  });

  it('shows the same state from every copy the vault keeps, before and after a switch away', async function () {
    // Read again. The vault's own file has to say so — that is the copy a
    // vault-only row, a restore and the mirror are built from.
    expect(await clickRowCheckbox(unreadSubject)).toBe(true);
    expect(await clickBarButton('Mark as read')).toBe(true);
    await waitFor(async () => (await vaultFlags(account.id, 'INBOX', unreadUid) || []).includes('\\Seen'),
      'the vault file never said read');
    await waitFor(() => (jsonFlags(join(sidecarDir, `${unreadUid}.json`), unreadUid) || []).includes('\\Seen'),
      'sidecar never updated before the switch');

    // Leave for another account and come back: the list is repainted from the
    // cache first, and the cache has to agree. (The live fetch that follows
    // would put the row right anyway — the discriminating checks are above.)
    await switchToFolder(VADER, 'INBOX');
    await switchToFolder(LUKE, 'INBOX');

    await waitFor(async () => (await rowFor(unreadSubject))?.unread === false,
      `"${unreadSubject}" came back unread after a switch away and back`);
    expect((await rowFor(readSubject)).unread).toBe(false);
    expect(await vaultFlags(account.id, 'INBOX', unreadUid)).toContain('\\Seen');
  });
});

describe('Read state — a backup carries the server\'s state and catches up with changes made elsewhere', function () {
  this.timeout(300_000);

  const FOLDER = 'Matrix';
  const UNREAD_UID = 1;   // odd: unread in the fixture
  const READ_UID = 2;     // even: read in the fixture

  let account = null;
  let cur = null;
  let index = null;
  let mirror = null;
  let backupRoot = null;
  const flipped = [];     // [uid, op to undo] — put the mock back for the specs after this one

  async function backup() {
    const result = await invoke('backup_run_account', {
      accountId: account.id,
      accountJson: JSON.stringify(account),
      backupPath: null,
      skipFolders: 5,
    });
    if (result?.__error) throw new Error(`backup_run_account: ${result.__error}`);
    return result;
  }

  before(async function () {
    await waitForApp();
    await waitForEmails();

    account = browser.mockAccounts.find((a) => a.email === VADER);
    const data = appDataDir(browser.testDataDir);
    cur = join(data, 'Maildir', account.id, FOLDER, 'cur');
    index = join(data, 'maildir', account.id, FOLDER, 'local-index.json');
    backupRoot = mkdtempSync(join(tmpdir(), 'mv-read-state-backup-'));
    mirror = join(backupRoot, VADER, FOLDER, 'cur');
    const loc = await invoke('backup_save_external_location', { path: backupRoot });
    if (loc?.__error) throw new Error(`backup_save_external_location: ${loc.__error}`);

    // The fixture state has to be what this file assumes, or the assertions
    // below would be about a previous run's leftovers.
    expect(await serverFlags(account.imapPort, FOLDER, UNREAD_UID)).not.toContain('\\Seen');
    expect(await serverFlags(account.imapPort, FOLDER, READ_UID)).toContain('\\Seen');
  });

  after(async function () {
    for (const [uid, op] of flipped.reverse()) {
      try { await storeFlag(account.imapPort, FOLDER, uid, op); } catch (e) { console.warn('[read-state] restore failed:', e.message); }
    }
    if (backupRoot) rmSync(backupRoot, { recursive: true, force: true });
  });

  it('stores each message with its own read state, in the vault and in the mirror', async function () {
    const result = await backup();
    expect(result.success).toBe(true);
    expect(result.emails_backed_up).toBeGreaterThanOrEqual(2);

    expect(isUnseenName(nameOf(cur, UNREAD_UID), UNREAD_UID)).toBe(true);
    expect(isSeenName(nameOf(cur, READ_UID), READ_UID)).toBe(true);
    expect(isUnseenName(nameOf(mirror, UNREAD_UID), UNREAD_UID)).toBe(true);
    expect(isSeenName(nameOf(mirror, READ_UID), READ_UID)).toBe(true);
    // The index already carried the server's flags before this change —
    // pinned so file and index cannot drift apart again.
    expect(jsonFlags(index, UNREAD_UID)).not.toContain('\\Seen');
    expect(jsonFlags(index, READ_UID)).toContain('\\Seen');
  });

  it('a change made on the server elsewhere reaches the vault and the mirror at the next backup', async function () {
    // Another client reads the unread one and un-reads the read one.
    await storeFlag(account.imapPort, FOLDER, UNREAD_UID, '+FLAGS');
    flipped.push([UNREAD_UID, '-FLAGS']);
    await storeFlag(account.imapPort, FOLDER, READ_UID, '-FLAGS');
    flipped.push([READ_UID, '+FLAGS']);

    const result = await backup();
    expect(result.success).toBe(true);
    // Nothing new to fetch — the whole point is that a run with nothing to
    // fetch still carries the change.
    expect(result.emails_backed_up).toBe(0);

    expect(isSeenName(nameOf(cur, UNREAD_UID), UNREAD_UID)).toBe(true);
    expect(isUnseenName(nameOf(cur, READ_UID), READ_UID)).toBe(true);
    expect(isSeenName(nameOf(mirror, UNREAD_UID), UNREAD_UID)).toBe(true);
    expect(isUnseenName(nameOf(mirror, READ_UID), READ_UID)).toBe(true);
    expect(jsonFlags(index, UNREAD_UID)).toContain('\\Seen');
    expect(jsonFlags(index, READ_UID)).not.toContain('\\Seen');
  });
});
