/**
 * E2E (Graph conf): the app and the backup file one Outlook folder under one
 * key. Before this fix a non-English UI wrote "Gesendet" while the backup
 * wrote "Sent": two vault directories, two ledgers, status counts that never
 * agreed. The mock mailbox is German, so the keys have to come from the
 * well-known names, not from any display name.
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitForApp, waitForEmails, switchToFolder } from './helpers.js';
import { appDataDir } from './mockImap.js';
import { GRAPH_EMAIL } from './mockGraph.js';

/** `browser.execute` does not await a Promise; `executeAsync` does. */
function invoke(cmd, args) {
  return browser.executeAsync((c, a, done) => {
    window.__TAURI__.core.invoke(c, a).then(done).catch((e) => done({ __error: String(e && e.message || e) }));
  }, cmd, args);
}

const KEYS = ['Archive', 'Drafts', 'INBOX', 'Junk', 'Projekte', 'Sent', 'Trash'];

describe('Graph backup: one directory per folder on each side', function () {
  this.timeout(300_000);

  let account = null;
  let backupRoot = null;

  before(async function () {
    await waitForApp();
    await waitForEmails();
    account = browser.mockAccounts.find((a) => a.email === GRAPH_EMAIL);
    // Open Sent first, so the app has cached headers under its key before the
    // backup writes the vault under the same key.
    await switchToFolder(GRAPH_EMAIL, 'Sent');
    await waitForEmails();
    backupRoot = mkdtempSync(join(tmpdir(), 'mv-graph-backup-'));
    const loc = await invoke('backup_save_external_location', { path: backupRoot });
    if (loc?.__error) throw new Error(`backup_save_external_location: ${loc.__error}`);
  });

  after(function () {
    if (backupRoot) rmSync(backupRoot, { recursive: true, force: true });
  });

  it('writes the vault and the mirror under the English keys, one directory per folder', async function () {
    const result = await invoke('backup_run_account', {
      accountId: account.id, accountJson: JSON.stringify(account), backupPath: null, skipFolders: 0,
    });
    if (result?.__error) throw new Error(`backup_run_account: ${result.__error}`);
    console.log('[graph-backup] backup_run_account ->', JSON.stringify(result));

    const vaultRoot = join(appDataDir(browser.testDataDir), 'Maildir', account.id);
    const onlyDirs = (root) => readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    expect(onlyDirs(vaultRoot)).toEqual(KEYS);
    expect(onlyDirs(join(backupRoot, GRAPH_EMAIL))).toEqual(KEYS);
    expect(readdirSync(join(vaultRoot, 'Sent', 'cur')).filter((n) => n.endsWith('.eml'))).toHaveLength(5);
    expect(readdirSync(join(backupRoot, GRAPH_EMAIL, 'Sent', 'cur')).filter((n) => n.endsWith('.eml'))).toHaveLength(5);
    // Not `existsSync('Gesendete Elemente')`: the vault sanitizes a space to an
    // underscore, so the German name has to be matched as a substring or the
    // assertion passes on a vault keyed by display name too.
    expect(onlyDirs(vaultRoot).filter((n) => /Gesendete/.test(n))).toEqual([]);
  });

  it('reports app and mirror counts under the same key', async function () {
    // `backup_status` is the Tauri command name; `get_backup_status` is the
    // function it calls in src-tauri/src/backup.rs.
    const status = await invoke('backup_status', { accountId: account.id, accountJson: JSON.stringify(account), backupPath: null });
    if (status?.__error) throw new Error(`backup_status: ${status.__error}`);
    const sent = (status.folders || []).find((f) => f.path === 'Sent');
    // expect-webdriverio's expect takes exactly one argument, so the folder
    // list goes into a thrown message rather than a second expect() argument.
    if (!sent) throw new Error(`no folder keyed "Sent" in ${JSON.stringify(status.folders)}`);
    expect(sent.server_count).toBe(5);
    expect(sent.app_count).toBe(5);
    expect(sent.external_count).toBe(5);
    expect((status.folders || []).map((f) => f.path).sort()).toEqual(KEYS);
  });
});
