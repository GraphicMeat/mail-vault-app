/**
 * E2E: "Archive, Back up & Delete" in the bulk modal.
 *
 * The option copies the chosen messages into the vault AND onto the backup
 * drive, checks both copies, and only then removes them from the server. This
 * spec runs it on three rows and proves each of the three places from the
 * outside:
 *   - the server no longer lists them (the rows fall to "local only");
 *   - the vault holds an archived copy of each;
 *   - the backup drive holds the same bytes under the vault's Maildir name.
 *
 * It also proves the two gates in the real app: the option is disabled with
 * "Choose a backup folder first" while no backup folder is set, and it is
 * Premium (a free plan is sent to the upsell instead of running it).
 *
 * Runs against luke's dedicated "BackupDelete" folder (wdio.conf.js
 * MOCK_ACCOUNTS[0].backupDeleteMailbox, uids 9601-9603). The mock IMAP server
 * persists across spec files and this spec removes those three messages for
 * good, so nothing else may read that folder.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitForApp, waitForEmails, switchToFolder } from './helpers.js';
import { appDataDir } from './mockImap.js';

const LUKE = 'luke@mock.test';
const FOLDER = 'BackupDelete';
const UIDS = [9601, 9602, 9603];
const SUBJECT_RE = String.raw`ABD fixture \d+`;
const PREMIUM = { hasSubscription: true, premiumAccess: true, status: 'active', clientAccessGranted: true };

/** `browser.execute` does not await a Promise; `executeAsync` does. */
function invoke(cmd, args) {
  return browser.executeAsync((c, a, done) => {
    window.__TAURI__.core.invoke(c, a).then(done).catch((e) => done({ __error: String(e && e.message || e) }));
  }, cmd, args);
}

describe('Archive, Back up & Delete', function () {
  this.timeout(300_000);

  let account = null;
  let vaultCur = null;
  let backupRoot = null;
  let mirrorCur = null;
  let priorBilling = null;

  const rows = () => browser.execute((re) => {
    const pattern = new RegExp(re);
    return [...document.querySelectorAll('[data-testid="email-row"]')].map((row) => {
      const icon = row.querySelector('[data-testid="msg-state-icon"]')?.getAttribute('data-state') || null;
      return {
        subject: ((row.innerText || '').match(pattern) || [null])[0],
        archived: !!icon && icon.startsWith('archived'),
        localOnly: !!icon && icon.startsWith('local-only'),
        icon,
      };
    }).filter((r) => r.subject);
  }, SUBJECT_RE);

  const bodyIncludes = (needle) => browser.execute((t) => document.body.innerText.includes(t), needle);
  const waitForBodyText = (needle, msg, timeout = 15_000) =>
    browser.waitUntil(() => bodyIncludes(needle), { timeout, interval: 300, timeoutMsg: msg });

  const clickTestId = (testid) => browser.execute((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    if (!el || el.offsetHeight === 0 || el.disabled) return false;
    el.click();
    return true;
  }, testid);
  const testIdState = (testid) => browser.execute((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    return el ? { disabled: !!el.disabled, text: (el.innerText || '').trim() } : null;
  }, testid);
  const waitClick = (fn, msg) => browser.waitUntil(fn, { timeout: 15_000, interval: 300, timeoutMsg: msg });

  /** Same route the header's select button takes: open at step 1, pick All, go to step 2. */
  async function openBulkAtStepTwo() {
    expect(await browser.execute(() => {
      const btn = document.querySelector('.mail-list-toolbar button[aria-label="Select messages…"]');
      if (!btn) return false;
      btn.click();
      return true;
    })).toBe(true);
    await waitForBodyText('Bulk Email Operations', 'Bulk modal never opened');
    await waitClick(() => browser.execute(() => {
      for (const el of document.querySelectorAll('button')) {
        if (el.offsetHeight > 0 && !el.disabled && (el.textContent || '').trim() === 'All') { el.click(); return true; }
      }
      return false;
    }), 'The "All" preset never became clickable');
    await waitClick(() => browser.execute(() => {
      for (const el of document.querySelectorAll('button')) {
        if (el.offsetHeight > 0 && !el.disabled && (el.textContent || '').trim().startsWith('Next')) { el.click(); return true; }
      }
      return false;
    }), 'Could not advance to the action step');
    await waitForBodyText('Choose Action for', 'Modal never reached the action step');
  }

  /** Cancel the bulk session: Back to step 1, then Cancel. */
  async function abandonBulk() {
    for (const label of ['Back', 'Cancel']) {
      await browser.execute((l) => {
        for (const el of document.querySelectorAll('button')) {
          if ((el.textContent || '').trim() === l && el.offsetHeight > 0) { el.click(); return true; }
        }
        return false;
      }, label);
    }
  }

  const setStore = (patch) => browser.execute((p) => { window.__SETTINGS_STORE__.setState(p); }, patch);

  const vaultNames = (uid) => (existsSync(vaultCur) ? readdirSync(vaultCur).filter((n) => n.startsWith(`${uid}:`) || n.startsWith(`${uid};`)) : []);
  const mirrorNames = (uid) => (existsSync(mirrorCur) ? readdirSync(mirrorCur).filter((n) => n.split(/[:;._]/)[0] === String(uid)) : []);

  before(async function () {
    await waitForApp();
    await waitForEmails();
    account = browser.mockAccounts.find((a) => a.email === LUKE);
    vaultCur = join(appDataDir(browser.testDataDir), 'Maildir', account.id, FOLDER, 'cur');
    backupRoot = mkdtempSync(join(tmpdir(), 'mv-abd-'));
    mirrorCur = join(backupRoot, LUKE, FOLDER, 'cur');

    priorBilling = await browser.execute(() => window.__SETTINGS_STORE__.getState().billingProfile ?? null);
    await switchToFolder(LUKE, FOLDER);
    await browser.waitUntil(async () => (await rows()).length === UIDS.length, {
      timeout: 30_000, interval: 500, timeoutMsg: `${FOLDER} never listed its ${UIDS.length} fixtures`,
    });
  });

  after(async function () {
    try {
      await setStore({ billingProfile: priorBilling, externalBackupLocation: null });
      await invoke('backup_clear_external_location', {});
    } catch { /* best effort */ }
    if (backupRoot) rmSync(backupRoot, { recursive: true, force: true });
    try { await switchToFolder(LUKE, 'INBOX'); } catch { /* best effort */ }
  });

  it('is Premium: a free plan gets the upsell instead of a run', async function () {
    await setStore({ billingProfile: null });
    await openBulkAtStepTwo();

    expect((await testIdState('bulk-action-archive_backup_delete'))?.text).toContain('Premium');
    expect((await testIdState('bulk-action-archive_and_delete'))?.text).toContain('Premium');
    expect(await clickTestId('bulk-action-archive_backup_delete')).toBe(true);
    await waitForBodyText('part of Premium', 'The Premium upsell never appeared');
    expect((await testIdState('bulk-step2-confirm'))?.disabled).toBe(true);

    await abandonBulk();
  });

  it('is disabled until a backup folder is chosen', async function () {
    await setStore({ billingProfile: PREMIUM, externalBackupLocation: null });
    await openBulkAtStepTwo();

    const option = await testIdState('bulk-action-archive_backup_delete');
    expect(option?.disabled).toBe(true);
    expect(option?.text).toContain('Choose a backup folder first');
    expect((await testIdState('bulk-action-archive_and_delete'))?.disabled).toBe(false);

    await abandonBulk();
  });

  it('archives, backs up and deletes three rows from the server, leaving the vault and the drive holding them', async function () {
    const loc = await invoke('backup_save_external_location', { path: backupRoot });
    if (loc?.__error) throw new Error(`backup_save_external_location: ${loc.__error}`);
    await setStore({ billingProfile: PREMIUM, externalBackupLocation: loc });

    // Anti-vacuity: nothing of this folder is on the drive or in the vault yet.
    expect(UIDS.flatMap(mirrorNames)).toEqual([]);

    await openBulkAtStepTwo();
    const option = await testIdState('bulk-action-archive_backup_delete');
    expect(option?.disabled).toBe(false);
    expect(option?.text).not.toContain('Premium');
    expect(option?.text).not.toContain('Choose a backup folder first');

    expect(await clickTestId('bulk-action-archive_backup_delete')).toBe(true);
    await waitClick(() => clickTestId('bulk-step2-confirm'), 'Step 2 confirm never became clickable');
    await waitForBodyText('Archive, back up, then delete from server?', 'The confirmation never appeared');
    await waitClick(() => clickTestId('bulk-delete-confirm'), 'Could not confirm the run');

    await waitForBodyText('Operation Complete', 'The run never reported completion', 120_000);
  });

  it('removed all three from the server: each row is now local only', async function () {
    await browser.waitUntil(async () => {
      const list = await rows();
      return list.length === UIDS.length && list.every((r) => r.localOnly);
    }, {
      timeout: 60_000, interval: 500,
      timeoutMsg: `The rows never fell to local-only: ${JSON.stringify(await rows())}`,
    });
    // The store agrees the server no longer lists them.
    const serverUids = await browser.execute(() => [...(window.__MAIL_STORE__?.getState?.().serverUids?.uids || [])]);
    for (const uid of UIDS) expect(serverUids).not.toContain(uid);
  });

  it('left an archived copy of each in the vault', function () {
    for (const uid of UIDS) {
      const names = vaultNames(uid);
      expect(names, `vault files for uid ${uid}`).toHaveLength(1);
      expect((names[0].split(/[:;]2,/)[1] || '')).toContain('A');
    }
  });

  it('left the same bytes on the backup drive, one file per message', function () {
    for (const uid of UIDS) {
      const [vaultName] = vaultNames(uid);
      const mirrored = mirrorNames(uid);
      expect(mirrored, `drive files for uid ${uid}`).toHaveLength(1);
      expect(readFileSync(join(mirrorCur, mirrored[0]))).toEqual(readFileSync(join(vaultCur, vaultName)));
    }
  });
});
