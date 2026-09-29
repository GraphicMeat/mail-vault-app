/**
 * E2E: "Import as a separate folder" (MBOX import mode 3) makes a folder kept
 * only on this computer, and that folder lives like one.
 *
 * Through the import options dialog, a Takeout-shaped file (every message
 * labelled) goes into a new `MBOX import <day>` folder of its own: labels are
 * not read, so nothing lands in the folders they name. The folder shows under
 * "On this computer" with its rows, and keeps them across a reload, a daemon
 * sync of the account and a refresh of it: nothing prunes a folder no server
 * lists. A backup run mirrors it into the backup location, into a folder of
 * its own named by its directory and its creation stamp. Delete folder takes
 * it off the sidebar and the disk into the deleted bin, and the next backup
 * does not bring it back.
 *
 * Only the file pick is injected: under VITE_E2E, BackupRestore takes
 * `window.__MV_MBOX_SOURCE__` instead of opening the native panel (see
 * connected-mbox-import-visible). Mode 3 does not reload the app: it alerts
 * and opens the new folder.
 *
 * Luke's server folders are left alone: the backup skips every one of them
 * (`skipFolders` past his folder count), so only the local pass writes to the
 * backup location, a temp dir of this spec's own.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeSettings, reloadApp, runBackupAndWait, switchToFolder, visibleRowSubjects, waitForApp, waitForEmails,
} from './helpers.js';
import { openTab } from './mockBilling.js';
import { appDataDir, INFO_SEP } from './mockImap.js';

const LUKE = 'luke@mock.test';
const IMPORT_UID_BASE = 0xC000_0000;
const ALERTS_KEY = 'mv-e2e-mbox-local-folder-alerts';

// Every message labelled, each label naming a folder luke has or a system
// label: in mode 3 none of them may route a message anywhere.
const MESSAGES = [
  { subject: 'Local folder import one', messageId: 'local-folder-one@gmail.test', labels: 'Inbox,Opened' },
  { subject: 'Local folder import two', messageId: 'local-folder-two@gmail.test', labels: 'Flaky,Starred' },
  { subject: 'Local folder import three', messageId: 'local-folder-three@gmail.test', labels: 'Category Promotions,Unread' },
];

const takeoutMessage = ({ subject, messageId, labels }) => [
  'From 1790000000000000000@xxx Mon Jan 01 00:00:00 +0000 2026',
  `X-Gmail-Labels: ${labels}`,
  'From: Takeout <takeout@gmail.test>',
  `To: ${LUKE}`,
  `Subject: ${subject}`,
  // Dated now, so the rows sort to the top of the folder.
  `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
  `Message-ID: <${messageId}>`,
  '',
  `${subject} - body`,
  '',
  '',
].join('\n');

const daemonRpc = (method, params) => browser.executeAsync((m, p, done) => {
  try {
    window.__TAURI_INTERNALS__.invoke('daemon_rpc', { method: m, params: p })
      .then((v) => done({ ok: true, v }), (e) => done({ ok: false, __error: String((e && e.message) || e) }));
  } catch (e) {
    done({ ok: false, __error: String((e && e.message) || e) });
  }
}, method, params);

/** `browser.execute` does not await a Promise; `executeAsync` does. */
const invoke = (cmd, args) => browser.executeAsync((c, a, done) => {
  window.__TAURI__.core.invoke(c, a).then(done).catch((e) => done({ __error: String((e && e.message) || e) }));
}, cmd, args);

const sorted = (list) => [...list].sort();
const listing = (dir) => (existsSync(dir) ? sorted(readdirSync(dir)) : []);

/** Import-range files in `cur` whose content holds `messageId`. */
const importedCopies = (cur, messageId) => listing(cur)
  .filter((n) => Number(n.split(INFO_SEP)[0]) >= IMPORT_UID_BASE && readFileSync(join(cur, n), 'utf8').includes(messageId));

/** What the store and the sidebar say about luke's local folders. */
const localState = (lukeId) => browser.execute((id) => {
  const s = window.__MAIL_STORE__?.getState?.();
  const group = document.querySelector('[data-testid="local-folders"]');
  return {
    names: (s?.localFolders?.[id] || []).map((f) => f.name),
    activeAccountId: s?.activeAccountId,
    activeMailbox: s?.activeMailbox,
    group: group ? group.getAttribute('aria-label') : null,
    rows: group ? [...group.querySelectorAll('[data-testid="folder-row"]')].map((r) => r.getAttribute('data-path')) : [],
  };
}, lukeId);

describe('MBOX import as a separate folder: a folder kept on this computer', function () {
  this.timeout(300_000);

  let workDir = null;
  let backupRoot = null;
  let luke = null;
  let folder = null; // { name, dir, created } from list_local_folders
  let cur = null;

  const accountDir = () => join(appDataDir(browser.testDataDir), 'Maildir', luke.id);
  const mirrorCur = () => join(backupRoot, LUKE, `${folder.dir} (${folder.created})`, 'cur');

  /** The folder's rows on screen, once all three have listed. */
  async function waitForItsRows(what) {
    let rows = [];
    await browser.waitUntil(async () => {
      rows = await visibleRowSubjects();
      return MESSAGES.every((m) => rows.some((r) => r.includes(m.subject)));
    }, {
      timeout: 30_000, interval: 500,
      timeoutMsg: `${what}: the imported rows never listed in "${folder?.name}"; rows: ${JSON.stringify(rows).slice(0, 600)}`,
    });
  }

  before(async function () {
    await waitForApp();
    await waitForEmails();
    luke = (browser.mockAccounts || []).find((a) => a.email === LUKE);
    expect(luke?.id).toBeTruthy();
    workDir = mkdtempSync(join(tmpdir(), 'mv-mbox-local-folder-e2e-'));
    backupRoot = mkdtempSync(join(tmpdir(), 'mv-mbox-local-folder-backup-'));
  });

  after(function () {
    for (const dir of [workDir, backupRoot]) if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('imports a Takeout file into a new folder of its own, under On this computer, with its rows', async function () {
    const before = await daemonRpc('list_local_folders', { accountId: luke.id });
    expect(before).toEqual({ ok: true, v: [] });

    const sourcePath = join(workDir, 'takeout.mbox');
    writeFileSync(sourcePath, MESSAGES.map(takeoutMessage).join(''));

    await switchToFolder(LUKE, 'INBOX');
    await openTab('Backup & Restore');
    // Read back what was installed, not `true`: a stub assignment on a locked
    // webview property fails silently on tauri-wd, and a real native alert
    // would then sit over every later spec.
    const installed = await browser.execute((path, key) => {
      window.__MV_MBOX_SOURCE__ = path;
      sessionStorage.removeItem(key);
      const capture = (m) => {
        const seen = JSON.parse(sessionStorage.getItem(key) || '[]');
        seen.push(String(m));
        sessionStorage.setItem(key, JSON.stringify(seen));
      };
      capture.__mvCapture = true;
      window.alert = capture;
      return { source: window.__MV_MBOX_SOURCE__ === path, alert: window.alert?.__mvCapture === true };
    }, sourcePath, ALERTS_KEY);
    expect(installed).toEqual({ source: true, alert: true });

    await browser.waitUntil(() => browser.execute(() => {
      const button = [...document.querySelectorAll('[data-testid="settings-page"] button')]
        .find((b) => b.offsetHeight > 0 && (b.textContent || '').trim() === 'Import MBOX');
      if (!button) return false;
      button.click();
      return true;
    }), { timeout: 15_000, interval: 300, timeoutMsg: 'the Import MBOX button never became clickable' });

    // Ready once the probe answered: Import is enabled and, in the default
    // mode, the folder picker is up.
    await browser.waitUntil(() => browser.execute(() => {
      const confirm = document.querySelector('[data-testid="mbox-import-dialog"] [data-testid="mbox-import-confirm"]');
      return !!confirm && !confirm.disabled && !!document.querySelector('[data-testid="mbox-import-folder"]');
    }), { timeout: 30_000, interval: 300, timeoutMsg: 'the import options dialog never finished reading the file' });

    await browser.execute(() => document.querySelector('[data-testid="mbox-import-mode-folder"]').click());
    // The separate-folder mode asks for no folder: the picker goes.
    await browser.waitUntil(() => browser.execute(() =>
      document.querySelector('[data-testid="mbox-import-mode-folder"]')?.getAttribute('aria-pressed') === 'true'
        && !document.querySelector('[data-testid="mbox-import-folder"]')), {
      timeout: 5_000, interval: 100, timeoutMsg: 'the dialog never switched to "Import as a separate folder"',
    });
    await browser.execute(() => document.querySelector('[data-testid="mbox-import-confirm"]').click());

    // Mode 3 alerts (after the progress chip clears) and opens the new folder;
    // it does not reload.
    let alerts = [];
    await browser.waitUntil(async () => {
      alerts = await browser.execute((key) => JSON.parse(sessionStorage.getItem(key) || '[]'), ALERTS_KEY);
      return alerts.length > 0;
    }, { timeout: 90_000, interval: 300, timeoutMsg: 'the import never said it was done' });

    const after = await daemonRpc('list_local_folders', { accountId: luke.id });
    expect(after.ok).toBe(true);
    expect(after.v).toHaveLength(1);
    folder = after.v[0];
    expect(folder.name).toMatch(/^MBOX import \d{4}-\d{2}-\d{2}$/);
    expect(folder.dir).toBe(folder.name.replaceAll(' ', '_'));
    expect(folder.kind).toBe('import');
    expect(folder.source).toBe('takeout.mbox');
    expect(alerts.join('\n')).toContain(`3 email(s) are now in ${folder.name}, under On this computer`);

    // The disk: one import-range copy of each message in the new folder, its
    // marker beside cur/, and nothing in the folders the labels name.
    cur = join(accountDir(), folder.dir, 'cur');
    expect(existsSync(join(accountDir(), folder.dir, '.mailvault-local.json'))).toBe(true);
    for (const m of MESSAGES) {
      expect(importedCopies(cur, m.messageId)).toHaveLength(1);
      for (const labelled of ['INBOX', 'Flaky']) {
        expect(importedCopies(join(accountDir(), labelled, 'cur'), m.messageId)).toEqual([]);
      }
    }
    expect(listing(cur)).toHaveLength(3);

    await closeSettings();
    await browser.waitUntil(async () => {
      const s = await localState(luke.id);
      return s.activeAccountId === luke.id && s.activeMailbox === folder.name && s.names.includes(folder.name)
        && s.group === 'On this computer' && s.rows.includes(folder.name);
    }, {
      timeout: 30_000, interval: 300,
      timeoutMsg: `the new folder never opened under On this computer: ${JSON.stringify(await localState(luke.id))}`,
    });
    await waitForItsRows('after the import');
  });

  it('keeps the folder and its rows across a reload, a sync of the account and a refresh', async function () {
    expect(folder).toBeTruthy();
    const files = listing(cur);

    await reloadApp();
    await switchToFolder(LUKE, folder.name);
    expect((await localState(luke.id)).group).toBe('On this computer');
    await waitForItsRows('after a reload');

    // A daemon sync of the account's INBOX, the way the app asks for one.
    const synced = await browser.executeAsync((id, done) => {
      const a = window.__MAIL_STORE__.getState().accounts.find((x) => x.id === id);
      const account = {
        id,
        email: a.email,
        imapConfig: {
          email: a.email, imapHost: a.imapHost, imapPort: a.imapPort, imapSecure: a.imapSecure, imapSecurity: a.imapSecurity,
          authType: a.authType, smtpHost: a.smtpHost, smtpPort: a.smtpPort, smtpSecure: a.smtpSecure, name: a.name,
          oauth2Transport: a.oauth2Transport,
        },
      };
      const rpc = (method, params) => window.__TAURI_INTERNALS__.invoke('daemon_rpc', { method, params });
      rpc('sync.now', { account, mailbox: 'INBOX', autoClassify: false })
        .then((r) => rpc('sync.wait', { ticket: r.ticket, timeoutMs: 60_000 }))
        .then((v) => done({ ok: true, v }), (e) => done({ ok: false, __error: String((e && e.message) || e) }));
    }, luke.id);
    expect(synced.ok).toBe(true);
    expect(synced.v.success).toBe(true);

    // And the app's own refresh of the account, with the folder open.
    const refreshed = await browser.executeAsync((id, done) => {
      window.__MAIL_STORE__.getState().refreshAllAccounts({ accountId: id })
        .then(() => done({ ok: true }), (e) => done({ ok: false, __error: String((e && e.message) || e) }));
    }, luke.id);
    expect(refreshed.ok).toBe(true);

    expect(listing(cur)).toEqual(files);
    expect((await daemonRpc('list_local_folders', { accountId: luke.id })).v.map((f) => f.name)).toEqual([folder.name]);
    await switchToFolder(LUKE, folder.name);
    await waitForItsRows('after a sync and a refresh');
  });

  it('is mirrored into the backup location, into a folder of its own', async function () {
    expect(folder).toBeTruthy();
    const loc = await invoke('backup_save_external_location', { path: backupRoot });
    if (loc?.__error) throw new Error(`backup_save_external_location: ${loc.__error}`);

    const result = await runBackupAndWait({
      accountId: luke.id, accountJson: JSON.stringify(luke), backupPath: null, skipFolders: 999,
    });
    expect(result.success).toBe(true);

    // Every vault file, under its own name and with its own bytes.
    expect(listing(mirrorCur())).toEqual(listing(cur));
    for (const name of listing(cur)) {
      expect(readFileSync(join(mirrorCur(), name), 'utf8')).toBe(readFileSync(join(cur, name), 'utf8'));
    }
    // Its own folder: named by the directory and the creation stamp, never by
    // the display name a later folder of the same day can reuse.
    expect(readdirSync(join(backupRoot, LUKE))).toContain(`${folder.dir} (${folder.created})`);
    expect(existsSync(join(backupRoot, LUKE, folder.name))).toBe(false);
  });

  it('Delete folder takes it off the sidebar and the disk, and the next backup does not bring it back', async function () {
    expect(folder).toBeTruthy();
    await switchToFolder(LUKE, folder.name);

    const opened = await browser.execute((path) => {
      const row = document.querySelector(`[data-testid="local-folders"] [data-testid="folder-row"][data-path="${CSS.escape(path)}"]`);
      if (!row) return false;
      const r = row.getBoundingClientRect();
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 8, clientY: r.top + 8 }));
      return true;
    }, folder.name);
    expect(opened).toBe(true);

    await browser.waitUntil(() => browser.execute(() => {
      const item = [...document.querySelectorAll('[data-testid="folder-context-menu"] [role="menuitem"]')]
        .find((b) => (b.textContent || '').includes('Delete folder'));
      if (!item || item.disabled) return false;
      item.click();
      return true;
    }), { timeout: 10_000, interval: 200, timeoutMsg: 'the folder menu never offered an enabled "Delete folder…"' });

    await browser.waitUntil(() => browser.execute(() => {
      const confirm = document.querySelector('[data-testid="confirm-delete-folder"]');
      if (!confirm) return false;
      confirm.click();
      return true;
    }), { timeout: 10_000, interval: 200, timeoutMsg: 'the delete confirmation never showed' });

    await browser.waitUntil(async () => {
      const s = await localState(luke.id);
      return s.group === null && s.names.length === 0 && s.activeMailbox === 'INBOX';
    }, {
      timeout: 30_000, interval: 300,
      timeoutMsg: `the folder never left the sidebar: ${JSON.stringify(await localState(luke.id))}`,
    });
    expect(existsSync(join(accountDir(), folder.dir))).toBe(false);
    expect((await daemonRpc('list_local_folders', { accountId: luke.id })).v).toEqual([]);

    const bin = await daemonRpc('deleted.list', {});
    expect(bin.ok).toBe(true);
    const binned = bin.v.filter((d) => d.mailbox === folder.name).map((d) => String(d.messageId).replace(/[<>]/g, ''));
    expect(sorted(binned)).toEqual(sorted(MESSAGES.map((m) => m.messageId)));

    const mirrored = listing(mirrorCur());
    const result = await runBackupAndWait({
      accountId: luke.id, accountJson: JSON.stringify(luke), backupPath: null, skipFolders: 999,
    });
    expect(result.success).toBe(true);
    expect(existsSync(join(accountDir(), folder.dir))).toBe(false);
    expect(listing(mirrorCur())).toEqual(mirrored);
  });
});
