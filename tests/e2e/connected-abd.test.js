/**
 * E2E: the two account-wide jobs in Settings > Backup & Restore > Archive & delete:
 * "Archive, back up & delete from server" and "Archive & delete from server".
 *
 * Both save every chosen email into the vault, check the copy, and only then
 * take the email off the server (a move to Trash). The daemon owns the job, so
 * this spec drives the real screens and proves the result from the outside:
 *   - the server folder no longer lists the uids (a second IMAP client asks);
 *   - Trash holds the same messages, matched by Message-ID because the mock
 *     server is shared by every spec and Trash is not empty;
 *   - the vault holds an archived copy of each;
 *   - backup mode: the backup drive holds the same bytes under the vault's name;
 *   - archive mode: the drive is not touched at all.
 *
 * It also proves the panel: a running job minimizes into the pill, the pill
 * brings the panel back, and the job runs to its end either way.
 *
 * Runs against luke's dedicated folders AbdBackup (uids 9701-9703) and
 * AbdArchive (9751-9752), see wdio.conf.js MOCK_ACCOUNTS[0].abdMailboxes. The
 * mock server persists across spec files and this spec removes those messages
 * from their folders for good, so nothing else may read them. uid 9702 downloads
 * slowly (a body-fetch fault there) so the job is still running when the spec
 * minimizes its panel.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitForApp, waitForEmails, openSettings, closeSettings, clickSettingsNav } from './helpers.js';
import { appDataDir } from './mockImap.js';
import { imap } from './rawImap.js';

const LUKE = 'luke@mock.test';
const BACKUP_FOLDER = 'AbdBackup';
const BACKUP_UIDS = [9701, 9702, 9703];
const ARCHIVE_FOLDER = 'AbdArchive';
const ARCHIVE_UIDS = [9751, 9752];
const PREMIUM = { hasSubscription: true, premiumAccess: true, status: 'active', clientAccessGranted: true };

/** The Message-ID the mock gives a message (mockImap.js rfc822). */
const messageId = (uid) => `mock-${uid}-${LUKE}`;

/** `browser.execute` does not await a Promise; `executeAsync` does. */
function invoke(cmd, args) {
  return browser.executeAsync((c, a, done) => {
    window.__TAURI__.core.invoke(c, a).then(done).catch((e) => done({ __error: String((e && e.message) || e) }));
  }, cmd, args);
}

const wait = (predicate, timeout, message) =>
  browser.waitUntil(predicate, { timeout, interval: 300, timeoutMsg: message });

/** Click a sub-tab: the last visible button with the label (the sidebar may carry the same words). */
async function clickBackupSubTab(label) {
  const clicked = await browser.execute((wanted) => {
    const matches = [...document.querySelectorAll('button')]
      .filter((b) => b.offsetHeight > 0 && b.textContent.trim() === wanted);
    if (!matches.length) return false;
    matches[matches.length - 1].click();
    return true;
  }, label);
  await browser.pause(400);
  return clicked;
}

/** Click a visible, enabled control by testid. */
const clickTestId = (testid) => browser.execute((id) => {
  const el = document.querySelector(`[data-testid="${id}"]`);
  if (!el || el.offsetHeight === 0 || el.disabled) return false;
  el.click();
  return true;
}, testid);

const waitClick = (testid, message, timeout = 30_000) =>
  wait(() => clickTestId(testid), timeout, message);

/** Present and visible (a `[data-testid]` in the DOM with layout). */
const visible = (testid) => browser.execute((id) => {
  const el = document.querySelector(`[data-testid="${id}"]`);
  return !!el && el.offsetHeight > 0;
}, testid);

const attr = (testid, name) => browser.execute((id, n) =>
  document.querySelector(`[data-testid="${id}"]`)?.getAttribute(n) ?? null, testid, name);

const textOf = (testid) => browser.execute((id) =>
  (document.querySelector(`[data-testid="${id}"]`)?.innerText || '').trim(), testid);

const isChecked = (testid) => browser.execute((id) =>
  !!document.querySelector(`[data-testid="${id}"]`)?.checked, testid);

/** A native <select> is set through the prototype setter so React sees the change. */
const chooseAccount = (accountId) => browser.execute((id) => {
  const select = document.querySelector('[data-testid="abd-account"]');
  if (!select) return false;
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, id);
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}, accountId);

/** The uids a folder holds on the server, read by a second client with none of the app in the way. */
async function serverUids(port, mailbox) {
  const lines = await imap(port, mailbox, 'UID SEARCH ALL');
  const line = lines.find((l) => l.startsWith('* SEARCH'));
  return line ? line.replace('* SEARCH', '').split(/\s+/).filter(Boolean).map(Number) : [];
}

/** The Trash uids whose Message-ID is `uid`'s. */
async function trashUidsOf(port, uid) {
  const lines = await imap(port, 'Trash', `UID SEARCH HEADER Message-ID "${messageId(uid)}"`);
  const line = lines.find((l) => l.startsWith('* SEARCH'));
  return line ? line.replace('* SEARCH', '').split(/\s+/).filter(Boolean).map(Number) : [];
}

describe('Archive & delete jobs (Settings > Backup & Restore)', function () {
  this.timeout(600_000);

  let account = null;
  let port = null;
  let backupRoot = null;
  let priorBilling = null;

  const vaultCur = (folder) => join(appDataDir(browser.testDataDir), 'Maildir', account.id, folder, 'cur');
  const mirrorCur = (folder) => join(backupRoot, LUKE, folder, 'cur');
  const vaultNames = (folder, uid) => {
    const dir = vaultCur(folder);
    return existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith(`${uid}:`) || n.startsWith(`${uid};`)) : [];
  };
  const mirrorNames = (folder, uid) => {
    const dir = mirrorCur(folder);
    return existsSync(dir) ? readdirSync(dir).filter((n) => n.split(/[:;._]/)[0] === String(uid)) : [];
  };

  /** Settings > Backup & Restore > Archive & delete, with luke picked. */
  async function openAbdSection() {
    await openSettings();
    expect(await clickSettingsNav('Backup & Restore')).toBe(true);
    expect(await clickBackupSubTab('Archive & delete')).toBe(true);
    await wait(() => visible('abd-section'), 20_000, 'The Archive & delete section never rendered');
    expect(await chooseAccount(account.id)).toBe(true);
  }

  /** Open a card's setup, untick everything, tick only `folder`, wait for its dry run. */
  async function setUpOnly(setupTestId, folder, count) {
    await waitClick(setupTestId, `${setupTestId} never became clickable`, 20_000);
    await wait(() => visible('abd-setup'), 20_000, 'The setup screen never opened');
    // The listing reads the whole account from the server; it ends when the folder list shows.
    await wait(() => visible('abd-folders'), 120_000, 'The folder listing never finished');
    await wait(() => visible(`abd-folder-${folder}`), 30_000, `${folder} is not in the folder list`);

    // Everything starts ticked ("whole account"): clear it, then pick the one folder.
    if (await isChecked('abd-whole-account')) expect(await clickTestId('abd-whole-account')).toBe(true);
    await wait(async () => !(await isChecked(`abd-folder-${folder}`)), 10_000, 'The folders did not clear');
    expect(await clickTestId(`abd-folder-${folder}`)).toBe(true);
    await wait(() => isChecked(`abd-folder-${folder}`), 10_000, `${folder} did not tick`);

    // The dry run for exactly this selection: not stale, and it names the fixture's size.
    await wait(async () => (await visible('abd-summary')) && (await attr('abd-summary', 'data-stale')) === null
      && (await textOf('abd-summary-total')).startsWith(`${count} email`),
    30_000, `The summary never showed ${count} emails for ${folder}: ${await textOf('abd-summary-total')}`);
  }

  /**
   * Tick "I understand", Start, wait until the daemon has accepted the job (the
   * setup screen leaves on success and shows its error otherwise), then leave
   * Settings so the panel is on its own.
   */
  async function confirmAndStart() {
    expect(await clickTestId('abd-start')).toBe(false); // disabled until the tick
    expect(await clickTestId('abd-confirm')).toBe(true);
    await waitClick('abd-start', 'Start never became clickable after the tick', 15_000);
    await wait(async () => !(await visible('abd-setup')) || (await visible('abd-start-error')), 60_000,
      'Start was neither accepted nor refused');
    if (await visible('abd-start-error')) throw new Error(`The job did not start: ${await textOf('abd-start-error')}`);
    await closeSettings();
  }

  /** The job ended: the panel says Finished. Restores the panel first when the pill holds it. */
  async function waitForFinished() {
    if (await visible('abd-pill-restore')) expect(await clickTestId('abd-pill-restore')).toBe(true);
    await wait(async () => (await attr('abd-status', 'data-state')) === 'completed', 240_000,
      `The job never finished: ${await attr('abd-status', 'data-state')} / ${await textOf('abd-status')}`);
  }

  /** Close the finished panel (this dismisses the job, removing its files). */
  async function closePanel() {
    await waitClick('abd-done', 'The finished panel has no Close button');
    await wait(async () => !(await visible('abd-panel')), 15_000, 'The panel stayed after Close');
  }

  before(async function () {
    await waitForApp();
    await waitForEmails();
    account = browser.mockAccounts.find((a) => a.email === LUKE);
    port = account.imapPort;
    backupRoot = mkdtempSync(join(tmpdir(), 'mv-abd-job-'));

    priorBilling = await browser.execute(() => window.__SETTINGS_STORE__.getState().billingProfile ?? null);

    // Anti-vacuity: the server holds the fixtures, and neither the vault nor the drive holds a copy yet.
    // (A vault that already holds a copy would let the job skip the download, and it would finish before
    // this spec could minimize it.)
    expect(await serverUids(port, BACKUP_FOLDER)).toEqual(BACKUP_UIDS);
    expect(await serverUids(port, ARCHIVE_FOLDER)).toEqual(ARCHIVE_UIDS);
    for (const uid of BACKUP_UIDS) expect(vaultNames(BACKUP_FOLDER, uid), `vault already holds ${uid}`).toEqual([]);
    for (const uid of ARCHIVE_UIDS) expect(vaultNames(ARCHIVE_FOLDER, uid), `vault already holds ${uid}`).toEqual([]);
    for (const uid of BACKUP_UIDS) expect(await trashUidsOf(port, uid), `Trash already holds ${uid}`).toEqual([]);
    expect(existsSync(join(backupRoot, LUKE))).toBe(false);
  });

  after(async function () {
    // A job left over by a failed case would keep running into the next spec: stop it, then dismiss it.
    try {
      const rpc = (method, params) => browser.executeAsync((m, p, done) => {
        window.__TAURI__.core.invoke('daemon_rpc', { method: m, params: p }).then(done).catch((e) => done({ __error: String((e && e.message) || e) }));
      }, method, params);
      await rpc('abd.cancel', { accountId: account.id });
      await browser.pause(1500);
      await rpc('abd.dismiss', { accountId: account.id });
    } catch { /* best effort */ }
    try {
      // Both cleared: the slot was just removed, so restoring the stored location would disagree with it.
      await browser.execute((billing) => {
        window.__SETTINGS_STORE__.setState({ billingProfile: billing, externalBackupLocation: null });
      }, priorBilling);
      await invoke('backup_clear_external_location', {});
    } catch { /* best effort */ }
    if (backupRoot) rmSync(backupRoot, { recursive: true, force: true });
    // The moved copies are this spec's, and Trash is shared: take them out again.
    try {
      for (const uid of [...BACKUP_UIDS, ...ARCHIVE_UIDS]) {
        for (const trashUid of await trashUidsOf(port, uid)) {
          await imap(port, 'Trash', `UID STORE ${trashUid} +FLAGS (\\Deleted)`);
          await imap(port, 'Trash', `UID EXPUNGE ${trashUid}`);
        }
      }
    } catch { /* best effort */ }
    try { await closeSettings(); } catch { /* best effort */ }
  });

  it('archives, backs up and deletes a folder: minimize to the pill, restore, and it finishes', async function () {
    const loc = await invoke('backup_save_external_location', { path: backupRoot });
    if (loc?.__error) throw new Error(`backup_save_external_location: ${loc.__error}`);
    await browser.execute((billing, location) => {
      window.__SETTINGS_STORE__.setState({ billingProfile: billing, externalBackupLocation: location });
    }, PREMIUM, loc);

    await openAbdSection();
    await setUpOnly('abd-setup-backup', BACKUP_FOLDER, BACKUP_UIDS.length);
    // The defaults are the safe ones: after everything is saved, move to Trash.
    expect(await isChecked('abd-when-after-all')).toBe(true);
    expect(await isChecked('abd-how-trash')).toBe(true);
    await confirmAndStart();

    await wait(() => visible('abd-panel'), 30_000, 'The progress panel never appeared');
    expect(await textOf('abd-panel-title')).toContain('Archive, back up & delete');
    expect(await visible('abd-row-drive')).toBe(true); // backup mode shows the drive row

    // Still running (uid 9702 downloads slowly): minimize it to the pill.
    expect(await clickTestId('abd-minimize')).toBe(true);
    await wait(() => visible('abd-pill'), 10_000, 'The pill never appeared');
    expect(await visible('abd-panel')).toBe(false);
    expect(await attr('abd-pill', 'data-state'), 'the job must still be running when minimized').not.toBe('completed');

    // The job runs on with the panel folded away; the pill brings it back.
    expect(await clickTestId('abd-pill-restore')).toBe(true);
    await wait(() => visible('abd-panel'), 10_000, 'The panel did not come back from the pill');
    expect(await visible('abd-pill')).toBe(false);

    await waitForFinished();
    expect(await textOf('abd-row-deleted')).toContain(`${BACKUP_UIDS.length} of ${BACKUP_UIDS.length}`);
    expect(await textOf('abd-row-drive')).toContain(`${BACKUP_UIDS.length} of ${BACKUP_UIDS.length}`);
    await closePanel();
  });

  it('backup mode: the server lists none of them and Trash holds each', async function () {
    await wait(async () => (await serverUids(port, BACKUP_FOLDER)).length === 0, 30_000,
      `The server still lists ${JSON.stringify(await serverUids(port, BACKUP_FOLDER))} in ${BACKUP_FOLDER}`);
    for (const uid of BACKUP_UIDS) {
      expect((await trashUidsOf(port, uid)).length, `Trash copies of ${messageId(uid)}`).toBe(1);
    }
  });

  it('backup mode: the vault holds an archived copy of each', function () {
    for (const uid of BACKUP_UIDS) {
      const names = vaultNames(BACKUP_FOLDER, uid);
      expect(names, `vault files for uid ${uid}`).toHaveLength(1);
      expect((names[0].split(/[:;]2,/)[1] || '')).toContain('A');
    }
  });

  it('backup mode: the drive holds the same bytes, one file per message', function () {
    for (const uid of BACKUP_UIDS) {
      const [vaultName] = vaultNames(BACKUP_FOLDER, uid);
      const mirrored = mirrorNames(BACKUP_FOLDER, uid);
      expect(mirrored, `drive files for uid ${uid}`).toHaveLength(1);
      expect(readFileSync(join(mirrorCur(BACKUP_FOLDER), mirrored[0])))
        .toEqual(readFileSync(join(vaultCur(BACKUP_FOLDER), vaultName)));
    }
  });

  it('archive only, deleting as each is saved: the vault holds them, the drive is never touched', async function () {
    await openAbdSection();
    await setUpOnly('abd-setup-archive', ARCHIVE_FOLDER, ARCHIVE_UIDS.length);
    expect(await clickTestId('abd-when-as-saved')).toBe(true);
    await wait(() => isChecked('abd-when-as-saved'), 5_000, 'The timing choice did not change');
    // A different selection is a different dry run: wait for it before the tick.
    await wait(async () => (await attr('abd-summary', 'data-stale')) === null, 30_000, 'The summary stayed stale');
    await confirmAndStart();

    await wait(() => visible('abd-panel'), 30_000, 'The progress panel never appeared');
    expect(await textOf('abd-panel-title')).toContain('Archive & delete');
    expect(await textOf('abd-panel-title')).not.toContain('back up');
    expect(await visible('abd-row-drive')).toBe(false); // no drive row without a backup

    await waitForFinished();
    await closePanel();

    await wait(async () => (await serverUids(port, ARCHIVE_FOLDER)).length === 0, 30_000,
      `The server still lists ${JSON.stringify(await serverUids(port, ARCHIVE_FOLDER))} in ${ARCHIVE_FOLDER}`);
    for (const uid of ARCHIVE_UIDS) {
      expect((await trashUidsOf(port, uid)).length, `Trash copies of ${messageId(uid)}`).toBe(1);
      const names = vaultNames(ARCHIVE_FOLDER, uid);
      expect(names, `vault files for uid ${uid}`).toHaveLength(1);
      expect((names[0].split(/[:;]2,/)[1] || '')).toContain('A');
    }
    expect(existsSync(join(backupRoot, LUKE, ARCHIVE_FOLDER)), 'archive-only must not write to the drive').toBe(false);
  });
});
