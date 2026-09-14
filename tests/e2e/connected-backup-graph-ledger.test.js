/**
 * E2E: an Outlook backup files every message under the uid the ledger gives it.
 *
 * A Graph message has no uid. The app mints one per mailbox and keeps it in
 * `email_cache/<account>_<mailbox>/graph_id_map.json` ({"<uid>":"<graph id>"}).
 * The backup used to ignore that ledger and name each file by the message's
 * POSITION in a newest-first listing, so one arrival shifted every position:
 * the new mail's position hit an existing file and was skipped, and the oldest
 * message was fetched again under the next number, the number the ledger gives
 * the new mail. Two copies of one message, and the new one never backed up.
 *
 * Each folder below is one shape of that on disk before the run:
 *   INBOX     ledger 1-6, vault 1-6, one arrival. Position numbering files the
 *             OLDEST message as uid 7; the ledger gives 7 to the arrival.
 *   Archive   ledger 1-6, vault 1-7 where 7 is a second copy of 6 (the shape
 *             found on a real account). A new uid must not land on that file.
 *   Projects  no ledger: a folder only the old backup ever filed, positions
 *             1-3 from before one arrival. Its files are adopted by Message-ID
 *             and only the arrival is fetched.
 *   Receipts  a ledger that cannot be parsed. That folder fails loudly and
 *             nothing in it is written; the other folders are not held up.
 *
 * The Graph account is synthetic (not in accounts.json) and only the backup
 * command sees it, through the loopback Graph mock (tests/e2e/mockGraph.js).
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitForApp, waitForEmails } from './helpers.js';
import { appDataDir } from './mockImap.js';

const ACCOUNT_ID = '7f3c2a1e-9b4d-4c8e-a6f1-0d5e8b2c4a17';
const EMAIL = 'ledger-owner@outlook-mock.test';
const TOKEN = 'e2e-graph-token';

const eml = (messageId, subject, date) => [
  'From: Sender <sender@outlook-mock.test>',
  `To: ${EMAIL}`,
  `Subject: ${subject}`,
  `Message-ID: <${messageId}>`,
  `Date: ${new Date(date).toUTCString()}`,
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  '',
  `Body of ${subject}.`,
  '',
].join('\r\n');

/** A mock message. `n` orders them: higher = newer. */
const msg = (folder, key, n) => {
  const receivedDateTime = new Date(Date.UTC(2026, 7, 1, 8, n)).toISOString();
  const internetMessageId = `${folder}-${key}@outlook-mock.test`;
  return {
    id: `graph-${folder}-${key}`,
    internetMessageId: `<${internetMessageId}>`,
    receivedDateTime,
    subject: `${folder} ${key}`,
    mime: eml(internetMessageId, `${folder} ${key}`, receivedDateTime),
  };
};

// Oldest first; the mock serves them newest first, as Graph does.
const INBOX = [1, 2, 3, 4, 5, 6].map((n) => msg('inbox', `m${n}`, n));
const INBOX_NEW = msg('inbox', 'new', 50);
const ARCHIVE = [1, 2, 3, 4, 5, 6].map((n) => msg('archive', `m${n}`, n));
const ARCHIVE_NEW = msg('archive', 'new', 50);
const PROJECTS = [1, 2, 3].map((n) => msg('projects', `m${n}`, n));
const PROJECTS_NEW = msg('projects', 'new', 50);
const RECEIPTS = [msg('receipts', 'm1', 1)];
const RECEIPTS_NEW = msg('receipts', 'new', 50);
const APP_ALLOCATED = msg('inbox', 'listed-by-the-app', 60);

const newestFirst = (list) => [...list].sort((a, b) => b.receivedDateTime.localeCompare(a.receivedDateTime));

/** Rust's cache_base_name: every non-alphanumeric character becomes '_'. */
const cacheBase = (accountId, mailbox) =>
  `${accountId.replace(/[^0-9A-Za-z]/g, '_')}_${mailbox.replace(/[^0-9A-Za-z]/g, '_')}`;

/** `browser.execute` does not await a Promise; `executeAsync` does. */
function invoke(cmd, args) {
  return browser.executeAsync((c, a, done) => {
    window.__TAURI__.core.invoke(c, a).then(done).catch((e) => done({ __error: String(e && e.message || e) }));
  }, cmd, args);
}

describe('Outlook backup files every message under its ledger uid', function () {
  this.timeout(300_000);

  let root;
  let mirrorRoot;
  let account;

  const cur = (mailbox) => join(root, 'Maildir', ACCOUNT_ID, mailbox, 'cur');
  const mirror = (mailbox) => join(mirrorRoot, EMAIL, mailbox, 'cur');
  const ledgerPath = (mailbox) => join(root, 'email_cache', cacheBase(ACCOUNT_ID, mailbox), 'graph_id_map.json');
  const readLedger = (mailbox) => JSON.parse(readFileSync(ledgerPath(mailbox), 'utf8'));

  /** Files for `uid` under the vault rule (`<uid>:` exactly). */
  const vaultNames = (dir, uid) => (existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith(`${uid}:`)) : []);
  /** Files for `uid` under the mirror rule (text before the first ':', '.' or '_'). */
  const mirrorNames = (dir, uid) => (existsSync(dir) ? readdirSync(dir).filter((n) => n.split(/[:._]/)[0] === String(uid)) : []);
  /** The Message-ID in the one file for `uid`, or a description of why there is not exactly one. */
  const messageIdAt = (dir, uid, names) => {
    const found = names(dir, uid);
    if (found.length !== 1) return `${found.length} files for uid ${uid}`;
    return readFileSync(join(dir, found[0]), 'utf8').match(/^Message-ID: (<[^>]+>)/m)?.[1] ?? 'no Message-ID';
  };
  const seedFile = (mailbox, uid, m) => writeFileSync(join(cur(mailbox), `${uid}:2,.eml`), m.mime);
  const seedLedger = (mailbox, content) => {
    mkdirSync(join(root, 'email_cache', cacheBase(ACCOUNT_ID, mailbox)), { recursive: true });
    writeFileSync(ledgerPath(mailbox), content);
  };

  async function serve(folders) {
    const r = await fetch(`${browser.mockGraph.origin}/__mock/folders`, { method: 'PUT', body: JSON.stringify(folders) });
    if (!r.ok) throw new Error(`mock Graph PUT failed: ${r.status}`);
    await fetch(`${browser.mockGraph.origin}/__mock/requests`, { method: 'DELETE' });
  }

  const hold = (id) => fetch(`${browser.mockGraph.origin}/__mock/hold`, { method: 'PUT', body: JSON.stringify({ id }) });
  const release = () => fetch(`${browser.mockGraph.origin}/__mock/hold`, { method: 'DELETE' });

  /** Graph ids whose MIME the app downloaded since the last serve(). */
  async function mimeFetches() {
    const log = await (await fetch(`${browser.mockGraph.origin}/__mock/requests`)).json();
    return log.map((r) => r.path.match(/^\/v1\.0\/me\/messages\/([^/]+)\/\$value$/)?.[1]).filter(Boolean).sort();
  }

  async function backup() {
    const result = await invoke('backup_run_account', {
      accountId: ACCOUNT_ID,
      accountJson: JSON.stringify(account),
      backupPath: null,
      skipFolders: 0,
    });
    if (result?.__error) throw new Error(`backup_run_account: ${result.__error}`);
    console.log('[graph-ledger] backup_run_account ->', JSON.stringify(result));
    return result;
  }

  before(async function () {
    await waitForApp();
    await waitForEmails();
    if (!browser.mockGraph?.origin) throw new Error('mock Graph is not running: wdio.conf.js onPrepare did not start it');

    root = appDataDir(browser.testDataDir);
    account = {
      ...browser.mockAccounts[0],
      id: ACCOUNT_ID,
      name: EMAIL,
      email: EMAIL,
      authType: 'oauth2',
      oauth2Transport: 'graph',
      oauth2AccessToken: TOKEN,
    };

    for (const mailbox of ['INBOX', 'Archive', 'Projects', 'Receipts']) mkdirSync(cur(mailbox), { recursive: true });

    // INBOX and Archive: the ledger the app's earlier listings wrote, uid 1 =
    // the newest at the time. Files match it.
    const seeded = (list) => Object.fromEntries(newestFirst(list).map((m, i) => [i + 1, m.id]));
    seedLedger('INBOX', JSON.stringify(seeded(INBOX)));
    newestFirst(INBOX).forEach((m, i) => seedFile('INBOX', i + 1, m));
    seedLedger('Archive', JSON.stringify(seeded(ARCHIVE)));
    newestFirst(ARCHIVE).forEach((m, i) => seedFile('Archive', i + 1, m));
    seedFile('Archive', 7, newestFirst(ARCHIVE)[5]); // a second copy of uid 6's message, outside the ledger

    // Projects: no ledger, files at the positions a listing had before PROJECTS_NEW arrived.
    newestFirst(PROJECTS).forEach((m, i) => seedFile('Projects', i + 1, m));

    // Receipts: a ledger cut off mid-write.
    seedLedger('Receipts', '{"1":"graph-receipts-m1",');
    seedFile('Receipts', 1, RECEIPTS[0]);

    mirrorRoot = mkdtempSync(join(tmpdir(), 'mv-graph-ledger-'));
    const loc = await invoke('backup_save_external_location', { path: mirrorRoot });
    if (loc?.__error) throw new Error(`backup_save_external_location: ${loc.__error}`);

    await serve([
      { id: 'folder-inbox', displayName: 'Inbox', messages: [...INBOX, INBOX_NEW] },
      { id: 'folder-archive', displayName: 'Archive', messages: [...ARCHIVE, ARCHIVE_NEW] },
      { id: 'folder-projects', displayName: 'Projects', messages: [...PROJECTS, PROJECTS_NEW] },
      { id: 'folder-receipts', displayName: 'Receipts', messages: [...RECEIPTS, RECEIPTS_NEW] },
    ]);
  });

  after(async function () {
    if (browser.mockGraph?.origin) await release();
    if (mirrorRoot) rmSync(mirrorRoot, { recursive: true, force: true });
  });

  let firstRun;
  let firstFetches;

  it('seeds what it claims to (anti-vacuity)', async function () {
    expect(Object.keys(readLedger('INBOX'))).toHaveLength(6);
    expect(readdirSync(cur('Archive'))).toHaveLength(7);
    expect(existsSync(ledgerPath('Projects'))).toBe(false);
    const folders = await (await fetch(`${browser.mockGraph.base}/me/mailFolders?$top=100`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
    expect(folders.value.map((f) => f.displayName)).toEqual(['Inbox', 'Archive', 'Projects', 'Receipts']);
    await fetch(`${browser.mockGraph.origin}/__mock/requests`, { method: 'DELETE' });

    firstRun = await backup();
    firstFetches = await mimeFetches();
  });

  it('files an arrival under the next ledger uid, not the oldest message', function () {
    expect(messageIdAt(cur('INBOX'), 7, vaultNames)).toBe(INBOX_NEW.internetMessageId);
    expect(messageIdAt(mirror('INBOX'), 7, mirrorNames)).toBe(INBOX_NEW.internetMessageId);
    expect(readLedger('INBOX')['7']).toBe(INBOX_NEW.id);
    for (let uid = 1; uid <= 6; uid++) {
      expect(messageIdAt(cur('INBOX'), uid, vaultNames)).toBe(newestFirst(INBOX)[uid - 1].internetMessageId);
    }
  });

  it('never gives new mail a uid a file already holds, and leaves that file alone', function () {
    expect(messageIdAt(cur('Archive'), 8, vaultNames)).toBe(ARCHIVE_NEW.internetMessageId);
    expect(messageIdAt(mirror('Archive'), 8, mirrorNames)).toBe(ARCHIVE_NEW.internetMessageId);
    expect(readFileSync(join(cur('Archive'), '7:2,.eml'), 'utf8')).toBe(newestFirst(ARCHIVE)[5].mime);
    expect(readLedger('Archive')['8']).toBe(ARCHIVE_NEW.id);
    expect(readLedger('Archive')['7']).toBe(undefined);
  });

  it('adopts the files a folder already has and fetches only what is new', function () {
    expect(readLedger('Projects')).toEqual({
      1: PROJECTS[2].id,
      2: PROJECTS[1].id,
      3: PROJECTS[0].id,
      4: PROJECTS_NEW.id,
    });
    expect(messageIdAt(cur('Projects'), 4, vaultNames)).toBe(PROJECTS_NEW.internetMessageId);
    expect(readdirSync(cur('Projects'))).toHaveLength(4);
  });

  it('stops only the folder whose ledger cannot be read, and says so', function () {
    expect(firstRun.success).toBe(true);
    expect(firstRun.errors).toBe(1);
    expect(firstRun.error_message).toMatch(/ledger/i);
    expect(firstRun.error_message).toMatch(/^Receipts was not backed up: /);
    expect(readFileSync(ledgerPath('Receipts'), 'utf8')).toBe('{"1":"graph-receipts-m1",');
    expect(readdirSync(cur('Receipts'))).toEqual(['1:2,.eml']);
  });

  it('downloads exactly the three arrivals and nothing else', function () {
    expect(firstRun.emails_backed_up).toBe(3);
    expect(firstFetches).toEqual([ARCHIVE_NEW.id, INBOX_NEW.id, PROJECTS_NEW.id].sort());
  });

  it('a second backup fetches nothing and rewrites no ledger', async function () {
    const mtimes = ['INBOX', 'Archive', 'Projects'].map((m) => statSync(ledgerPath(m)).mtimeMs);
    await fetch(`${browser.mockGraph.origin}/__mock/requests`, { method: 'DELETE' });
    const again = await backup();
    expect(again.emails_backed_up).toBe(0);
    expect(await mimeFetches()).toEqual([]);
    expect(['INBOX', 'Archive', 'Projects'].map((m) => statSync(ledgerPath(m)).mtimeMs)).toEqual(mtimes);
  });

  it('the app and the backup share one numbering', async function () {
    // What the app's listing path asks: known ids come back as filed.
    const known = await invoke('graph_allocate_uids', {
      accountId: ACCOUNT_ID,
      mailbox: 'INBOX',
      entries: [[INBOX_NEW.id, INBOX_NEW.internetMessageId], [newestFirst(INBOX)[0].id, null]],
    });
    expect(known).toEqual([7, 1]);

    // A message the app lists first gets its uid from the same ledger, and the
    // next backup files it there.
    const minted = await invoke('graph_allocate_uids', {
      accountId: ACCOUNT_ID,
      mailbox: 'INBOX',
      entries: [[APP_ALLOCATED.id, APP_ALLOCATED.internetMessageId]],
    });
    expect(minted).toEqual([8]);
    expect(readLedger('INBOX')['8']).toBe(APP_ALLOCATED.id);

    await serve([
      { id: 'folder-inbox', displayName: 'Inbox', messages: [...INBOX, INBOX_NEW, APP_ALLOCATED] },
    ]);
    const result = await backup();
    expect(result.emails_backed_up).toBe(1);
    expect(messageIdAt(cur('INBOX'), 8, vaultNames)).toBe(APP_ALLOCATED.internetMessageId);
    expect(messageIdAt(mirror('INBOX'), 8, mirrorNames)).toBe(APP_ALLOCATED.internetMessageId);
  });

  it('a run cancelled after a folder the ledger refused resumes at that folder, and says why', async function () {
    // Receipts' ledger is still unreadable. Slow comes after it: its newer
    // message is gone (404), its older one is held on the mock, and the run is
    // cancelled while it waits. A resumed run skips folders by position, so the
    // checkpoint must not pass Receipts; and the refusal, not the later 404, is
    // what the user reads.
    const HELD = msg('slow', 'held', 1);
    const GONE = { ...msg('slow', 'gone', 30), mime: null };
    await serve([
      { id: 'folder-inbox', displayName: 'Inbox', messages: [...INBOX, INBOX_NEW] },
      { id: 'folder-receipts', displayName: 'Receipts', messages: [...RECEIPTS, RECEIPTS_NEW] },
      { id: 'folder-slow', displayName: 'Slow', messages: [HELD, GONE] },
    ]);
    await hold(HELD.id);

    // Started without waiting on it: a pending executeAsync holds the WebDriver
    // session, and backup_cancel has to go through that same session.
    await browser.execute((cmd, args) => {
      window.__graphLedgerRun = window.__TAURI__.core.invoke(cmd, args)
        .catch((e) => ({ __error: String(e && e.message || e) }));
    }, 'backup_run_account', { accountId: ACCOUNT_ID, accountJson: JSON.stringify(account), backupPath: null, skipFolders: 0 });

    await browser.waitUntil(async () => (await mimeFetches()).includes(HELD.id), {
      timeout: 60_000,
      interval: 200,
      timeoutMsg: 'the backup never asked for the held message',
    });
    expect(await mimeFetches()).toContain(GONE.id); // anti-vacuity: the 404 came before the hold
    await invoke('backup_cancel', {});
    await release();

    const result = await browser.executeAsync((done) => { window.__graphLedgerRun.then(done); });
    if (result?.__error) throw new Error(`backup_run_account: ${result.__error}`);
    console.log('[graph-ledger] cancelled run ->', JSON.stringify(result));
    expect(result.cancelled).toBe(true);
    // Inbox is folder 0, Receipts 1, Slow 2. Counting Receipts would resume at Slow.
    expect(result.completed_folders).toBe(1);
    expect(result.error_message).toMatch(/^Receipts was not backed up: /);
    expect(result.error_message).toMatch(/ledger/i);
  });
});
