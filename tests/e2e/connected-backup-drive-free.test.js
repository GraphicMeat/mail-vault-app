/**
 * E2E: backup to another drive is Premium (direct build, 2026-11-25).
 *
 * A free user with a drive already set:
 *  - a backup run still saves the vault and finishes, but nothing new lands
 *    on the drive, and what was there stays;
 *  - Settings > Backup shows the drive as paused, not hidden and not failing;
 *  - the message list still reads the drive (reading writes nothing), so no
 *    row says "Backup drive not connected": a planted copy shows its dot.
 *
 * The run is yoda's "Bokelmu&Awg-hle" alone (skipFolders: 6, the folder LAST
 * in LIST order), the same scope connected-backup-partial-failure uses.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitForApp, waitForEmails, runBackupAndWait, switchToFolder, openSettings, closeSettings, clickSettingsNav } from './helpers.js';
import { appDataDir, INFO_PREFIX } from './mockImap.js';
import { usePlan } from './premiumPlan.js';

const LUKE = 'luke@mock.test';
const YODA = 'yoda@mock.test';
const FOLDER = 'Bokelmu&Awg-hle';
const VAULT_FOLDER = 'Bokelmu_Awg-hle';
const MIRRORED_UID = 8; // luke INBOX "Luke message 8"
const PAUSED = 'Copies to this drive are paused because Premium is not active.';

const eml = (uid) => [
  `From: Sender ${uid} <sender${uid}@example.com>`,
  `To: ${LUKE}`,
  `Subject: Luke message ${uid}`,
  `Message-ID: <mirror-${uid}@mock.test>`,
  'Date: Thu, 19 Mar 2026 22:36:07 +0000',
  '',
  `Body of luke message ${uid}.`,
  '',
].join('\r\n');

const files = (dir) => (existsSync(dir) ? readdirSync(dir).sort() : []);

describe('Backup drive without Premium: paused, never failing', function () {
  this.timeout(300_000);

  let backupRoot = null;
  let yodaMirror = null;
  let vault = null;
  let result = null;

  function invoke(cmd, args) {
    return browser.executeAsync((c, a, done) => {
      window.__TAURI__.core.invoke(c, a).then(done).catch((e) => done({ __error: String(e && e.message || e) }));
    }, cmd, args);
  }

  before(async function () {
    await waitForApp();
    await waitForEmails();

    backupRoot = mkdtempSync(join(tmpdir(), 'mv-drive-free-'));
    // What a Premium run left on the drive before the plan ended.
    yodaMirror = join(backupRoot, YODA, FOLDER, 'cur');
    mkdirSync(yodaMirror, { recursive: true });
    writeFileSync(join(yodaMirror, 'old.eml'), 'copied while premium');
    const lukeMirror = join(backupRoot, LUKE, 'INBOX', 'cur');
    mkdirSync(lukeMirror, { recursive: true });
    writeFileSync(join(lukeMirror, `${MIRRORED_UID}${INFO_PREFIX}.eml`), eml(MIRRORED_UID));
    mkdirSync(join(backupRoot, LUKE, 'Sent', 'cur'), { recursive: true });

    await usePlan(null);
    const loc = await invoke('backup_save_external_location', { path: backupRoot });
    if (loc?.__error) throw new Error(`backup_save_external_location: ${loc.__error}`);
    await browser.execute((l) => window.__SETTINGS_STORE__.setState({ externalBackupLocation: l }), loc);

    const yoda = browser.mockAccounts.find((a) => a.email === YODA);
    vault = join(appDataDir(browser.testDataDir), 'Maildir', yoda.id, VAULT_FOLDER, 'cur');
    result = await runBackupAndWait({
      accountId: yoda.id,
      accountJson: JSON.stringify(yoda),
      backupPath: null,
      skipFolders: 6,
    });
    console.log('[drive-free] backup ->', JSON.stringify(result));
  });

  after(async function () {
    try { await closeSettings(); } catch { /* best effort */ }
    await invoke('backup_clear_external_location', {});
    for (const name of files(vault)) if (/^910[123]/.test(name)) rmSync(join(vault, name), { force: true });
    if (backupRoot) rmSync(backupRoot, { recursive: true, force: true });
  });

  it('saves the vault and finishes', function () {
    expect(result.__error).toBe(undefined);
    expect(result.cancelled).toBe(false);
    expect(result.emails_backed_up).toBeGreaterThan(0);
    expect(files(vault).filter((n) => /^910[123]/.test(n)).length).toBeGreaterThan(0);
  });

  it('writes nothing new to the drive and keeps what was there', function () {
    expect(files(yodaMirror)).toEqual(['old.eml']);
  });

  it('never tells the user the drive is not connected: a planted copy still shows its dot', async function () {
    await switchToFolder(LUKE, 'Archive');
    await switchToFolder(LUKE, 'INBOX');
    await waitForEmails();
    const rows = () => browser.execute(() =>
      [...document.querySelectorAll('[data-testid="email-row"]')]
        .filter((r) => r.offsetHeight > 0)
        .map((r) => ({
          text: (r.innerText || '').replace(/\s*\n\s*/g, ' | ').trim(),
          state: r.querySelector('[data-testid="msg-state-icon"]')?.getAttribute('data-state') || '',
        })));
    // Page the virtualized list (wrapping) until the planted row is drawn and
    // the scan has answered for it.
    let found = null;
    let seen = [];
    await browser.waitUntil(async () => {
      seen = await rows();
      found = seen.find((r) => new RegExp(`Luke message ${MIRRORED_UID}(?!\\d)`).test(r.text)) || null;
      if (found && found.state.endsWith('-backed-up')) return true;
      if (!found) {
        await browser.execute(() => {
          const list = [...document.querySelectorAll('div')]
            .filter((d) => d.clientHeight > 200 && d.scrollHeight - d.clientHeight > 200)
            .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0];
          if (!list) return;
          const next = list.scrollTop + list.clientHeight;
          list.scrollTop = next >= list.scrollHeight - list.clientHeight ? 0 : next;
        });
      }
      return false;
    }, { timeout: 90_000, interval: 500, timeoutMsg: 'the planted copy never showed its dot' })
      .catch((e) => { throw new Error(`${e.message}: row ${JSON.stringify(found)}; drawn ${JSON.stringify(seen.slice(0, 8))}`); });
    expect((await rows()).filter((r) => r.state.endsWith('-backup-unknown'))).toEqual([]);
  });

  it('Backup settings shows the drive as paused', async function () {
    await openSettings();
    expect(await clickSettingsNav('Backup & Restore')).toBe(true);
    await browser.waitUntil(() => browser.execute(() => !!document.querySelector('[data-testid="backup-drive-paused"]')),
      { timeout: 20_000, interval: 300, timeoutMsg: 'no paused notice in Backup settings' });
    const text = await browser.execute(() => document.querySelector('[data-testid="backup-drive-paused"]').innerText);
    expect(text).toContain(PAUSED);
    expect(text).toContain(backupRoot.split('/').pop());
  });
});
