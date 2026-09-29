/**
 * E2E: mail imported from an MBOX file shows up in the folder it went into.
 *
 * The importer used to number messages from `max local uid + 1`. On an
 * account whose vault does not hold every server message, that is a uid the
 * server already uses: the list keeps the server row for a uid and drops the
 * vault row, so the imported message never appeared, and the server message
 * under that uid opened the imported body. Imports now number from
 * `IMPORT_UID_BASE`, a range no server reaches.
 *
 * The native open panel cannot be driven (see
 * connected-import-export-daemon.test.js), so the first two cases import with
 * the same `daemon_rpc` the Import MBOX button sends.
 *
 * The last block goes through the import options dialog itself ("Import into
 * my existing folders"). Only the file pick is injected: under VITE_E2E,
 * BackupRestore takes `window.__MV_MBOX_SOURCE__` instead of opening the
 * panel. In a Takeout file, the two messages whose labels name existing
 * folders land in those folders and the one whose label names none lands in
 * the fallback folder picked in the dialog, each listing there; a repeat
 * import skips all three; a file without labels goes to the folder picked in
 * the dialog.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reloadApp, switchToFolder, visibleRowSubjects, waitForApp, waitForEmails } from './helpers.js';
import { openTab } from './mockBilling.js';
import { appDataDir, INFO_PREFIX, INFO_SEP } from './mockImap.js';

const LUKE = 'luke@mock.test';
const IMPORT_UID_BASE = 0xC000_0000;

const uidsIn = (cur) => (existsSync(cur) ? readdirSync(cur) : [])
  .map((n) => Number(n.split(INFO_SEP)[0]))
  .filter(Number.isInteger);

const daemonRpc = (method, params) => browser.executeAsync((m, p, done) => {
  try {
    window.__TAURI_INTERNALS__.invoke('daemon_rpc', { method: m, params: p })
      .then((v) => done({ ok: true, v }), (e) => done({ ok: false, __error: String((e && e.message) || e) }));
  } catch (e) {
    done({ ok: false, __error: String((e && e.message) || e) });
  }
}, method, params);

// ── The import options dialog ────────────────────────────────────────────

const ALERTS_KEY = 'mv-e2e-mbox-alerts';

/** The import-range files in luke's `folder` whose content holds `messageId`. */
const importedCopies = (lukeId, folder, messageId) => {
  const cur = join(appDataDir(browser.testDataDir), 'Maildir', lukeId, folder, 'cur');
  return (existsSync(cur) ? readdirSync(cur) : [])
    .filter((n) => Number(n.split(INFO_SEP)[0]) >= IMPORT_UID_BASE
      && readFileSync(join(cur, n), 'utf8').includes(messageId));
};

const takeoutMessage = ({ subject, messageId, labels }) => [
  'From 1790000000000000000@xxx Mon Jan 01 00:00:00 +0000 2026',
  ...(labels ? [`X-Gmail-Labels: ${labels}`] : []),
  'From: Takeout <takeout@gmail.test>',
  `To: ${LUKE}`,
  `Subject: ${subject}`,
  // Dated now, so the rows sort to the top of their folder.
  `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
  `Message-ID: <${messageId}>`,
  '',
  `${subject} - body`,
  '',
  '',
].join('\n');

/**
 * Import `sourcePath` through Settings > Backup & Restore > Import MBOX and
 * the options dialog, in "Import into my existing folders", on luke (the
 * account on screen, which the dialog preselects).
 *
 * Every dialog import ends in the result alert and then the app's own
 * `window.location.reload()`, which wipes page state. So the file seam, an
 * alert capture that survives the reload (sessionStorage) and the reload
 * marker are all set again for each import, and this returns only once the
 * NEW page is up. Returns the folder the dialog preselected, whether it
 * offered the labels toggle, and the alert texts.
 */
async function importThroughDialog(sourcePath, { pick } = {}) {
  await switchToFolder(LUKE, 'INBOX');
  await openTab('Backup & Restore');
  // Read back what was installed, not `true`: a stub assignment on a locked
  // webview property fails silently on tauri-wd (core.invoke does), and a
  // real native alert would then sit over every later spec.
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

  // Ready once the probe answered: Import is enabled and the folder picker is up.
  await browser.waitUntil(() => browser.execute(() => {
    const confirm = document.querySelector('[data-testid="mbox-import-dialog"] [data-testid="mbox-import-confirm"]');
    return !!confirm && !confirm.disabled && !!document.querySelector('[data-testid="mbox-import-folder"]');
  }), { timeout: 30_000, interval: 300, timeoutMsg: 'the import options dialog never finished reading the file' });

  const offered = await browser.execute(() => {
    document.querySelector('[data-testid="mbox-import-mode-local"]').click();
    const toggle = document.querySelector('[data-testid="mbox-import-use-labels"]');
    return {
      account: document.querySelector('[data-testid="mbox-import-account"]').value,
      folder: document.querySelector('[data-testid="mbox-import-folder"]').value,
      labels: toggle ? toggle.getAttribute('aria-checked') : null,
    };
  });

  if (pick) {
    // A WebDriver select never reaches React's onChange; the native setter
    // plus a bubbling change does (clickSettingsNav drives its select this way).
    await browser.execute((value) => {
      const select = document.querySelector('[data-testid="mbox-import-folder"]');
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, value);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }, pick);
    await browser.waitUntil(() => browser.execute((value) =>
      document.querySelector('[data-testid="mbox-import-folder"]')?.value === value, pick), {
      timeout: 5_000, interval: 100, timeoutMsg: `the dialog's folder picker never took "${pick}"`,
    });
  }

  await browser.execute(() => {
    window.__e2eBeforeReload = true;
    document.querySelector('[data-testid="mbox-import-confirm"]').click();
  });
  try {
    await browser.waitUntil(async () => {
      try {
        return await browser.execute(() => window.__e2eBeforeReload !== true);
      } catch {
        return false; // mid-navigation
      }
    }, { timeout: 90_000, interval: 300 });
  } catch (e) {
    // A failed import alerts and does not reload: its alert is the reason.
    const said = await browser.execute((key) => sessionStorage.getItem(key), ALERTS_KEY).catch(() => null);
    throw new Error(`the app never reloaded after the dialog import; alerts: ${said || 'none'} (${e.message})`);
  }
  await waitForApp();

  const alerts = await browser.execute((key) => JSON.parse(sessionStorage.getItem(key) || '[]'), ALERTS_KEY);
  return { ...offered, alerts };
}

describe('MBOX import shows the imported mail', function () {
  this.timeout(180_000);

  let workDir = null;

  before(async function () {
    await waitForApp();
    await waitForEmails();
    workDir = mkdtempSync(join(tmpdir(), 'mv-mbox-visible-e2e-'));
  });

  after(function () {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it('lists every imported message in the target INBOX after a reload', async function () {
    const lukeId = (browser.mockAccounts || []).find((a) => a.email === LUKE)?.id;
    expect(lukeId).toBeTruthy();

    // The fixture must reach the old collision: the uid the old importer
    // would have used (vault max + 1) belongs to a message the server lists.
    await switchToFolder(LUKE, 'INBOX');
    const cur = join(appDataDir(browser.testDataDir), 'Maildir', lukeId, 'INBOX', 'cur');
    const before = uidsIn(cur);
    const oldUid = Math.max(0, ...before) + 1;
    const serverUids = await browser.execute(() =>
      (window.__MAIL_STORE__?.getState?.().emails || []).map((e) => e.uid));
    expect(serverUids).toContain(oldUid);

    // Dated now, so they sort to the top of the list and need no scrolling.
    const date = new Date().toUTCString().replace('GMT', '+0000');
    const subjects = ['Takeout import one', 'Takeout import two'];
    const mbox = subjects.map((subject, i) => [
      'From takeout@gmail.test Mon Jan  1 00:00:00 2026',
      'From: Takeout <takeout@gmail.test>',
      `To: ${LUKE}`,
      `Subject: ${subject}`,
      `Date: ${date}`,
      `Message-ID: <takeout-visible-${i}@gmail.test>`,
      '',
      `${subject} - body`,
      '',
      '',
    ].join('\n')).join('');
    const mboxPath = join(workDir, 'takeout.mbox');
    writeFileSync(mboxPath, mbox);

    const resp = await daemonRpc('import_mbox', { accountId: lukeId, mailbox: 'INBOX', sourcePath: mboxPath });
    expect(resp.ok).toBe(true);
    expect(resp.v.emailCount).toBe(2);
    const added = uidsIn(cur).filter((u) => !before.includes(u));
    expect(added.sort()).toEqual([IMPORT_UID_BASE, IMPORT_UID_BASE + 1]);

    await reloadApp();
    await switchToFolder(LUKE, 'INBOX');

    let rows = [];
    await browser.waitUntil(async () => {
      rows = await visibleRowSubjects();
      return subjects.every((s) => rows.some((r) => r.includes(s)));
    }, {
      timeout: 30_000, interval: 500,
      timeoutMsg: `imported subjects never listed in ${LUKE} INBOX; rows: ${JSON.stringify(rows).slice(0, 600)}`,
    });
  });

  // A vault from before the import range: an import sits at a uid the server
  // uses, hidden behind the server's row. Opening the folder re-homes it into
  // the import range, where it lists, and the server's own message keeps U.
  it('re-homes an import an earlier version filed under a server uid', async function () {
    const lukeId = (browser.mockAccounts || []).find((a) => a.email === LUKE)?.id;
    const mailboxDir = join(appDataDir(browser.testDataDir), 'Maildir', lukeId, 'INBOX');
    const cur = join(mailboxDir, 'cur');

    await switchToFolder(LUKE, 'INBOX');
    const serverUids = await browser.execute(() =>
      (window.__MAIL_STORE__?.getState?.().emails || []).map((e) => e.uid));
    const taken = new Set(uidsIn(cur));
    const oldUid = serverUids.filter((u) => u < IMPORT_UID_BASE && !taken.has(u)).sort((a, b) => b - a)[0];
    expect(oldUid).toBeTruthy();

    const subject = 'Takeout filed under a server uid';
    const date = new Date().toUTCString().replace('GMT', '+0000');
    writeFileSync(join(cur, `${oldUid}${INFO_PREFIX}A.eml`), [
      'From: Takeout <takeout@gmail.test>', `To: ${LUKE}`, `Subject: ${subject}`, `Date: ${date}`,
      'Message-ID: <takeout-old-uid@gmail.test>', '', `${subject} - body`, '',
    ].join('\r\n'));
    // A vault from before this version has no stamp; the first test's folder
    // opens may already have stamped this one.
    rmSync(join(mailboxDir, '.import-rehome-done'), { force: true });

    let rows = [];
    await browser.waitUntil(async () => {
      await reloadApp();
      await switchToFolder(LUKE, 'INBOX');
      rows = await visibleRowSubjects();
      return rows.some((r) => r.includes(subject));
    }, {
      timeout: 90_000, interval: 1_000,
      timeoutMsg: `the old import never listed after a re-home; files: ${JSON.stringify(readdirSync(cur))}; rows: ${JSON.stringify(rows).slice(0, 400)}`,
    });

    const moved = readdirSync(cur).find((n) => Number(n.split(INFO_SEP)[0]) >= IMPORT_UID_BASE
      && readFileSync(join(cur, n), 'utf8').includes('takeout-old-uid@gmail.test'));
    expect(moved).toBeTruthy();
    expect(existsSync(join(mailboxDir, '.import-rehome.json'))).toBe(true);
  });

  // Three destinations, each told apart from the other two:
  //   - INBOX, by the system label "Inbox". The cases above already import
  //     into luke's INBOX.
  //   - Flaky, by a custom label naming an existing folder. The specs that
  //     open Flaky (email-viewer, pgp) find their rows by subject.
  //   - Trash, the fallback picked in the dialog, for the message whose only
  //     label ("Category Promotions") names no folder. luke's Trash holds no
  //     server mail; backup-orphan-restore finds its files there by uid and
  //     custody-claims its row by subject, and every other Trash spec
  //     (delete-undo, cleanup-rules, idle-repaint, instant-arrival,
  //     delete-reader-race, storage-matrix) works on yoda or vader.
  // Off limits: Kunden and Archive (connected-folder-subtree and storage-matrix
  // count them) and Drafts (connected-restore-daemon counts luke's local
  // Drafts with count_local_folder).
  describe('through the import options dialog, into my existing folders', function () {
    const FALLBACK = 'Trash';
    const INBOX_MSG = { subject: 'Dialog import for the inbox', messageId: 'dialog-inbox@gmail.test' };
    const FLAKY_MSG = { subject: 'Dialog import for Flaky', messageId: 'dialog-flaky@gmail.test' };
    const FALLBACK_MSG = { subject: 'Dialog import with no folder label', messageId: 'dialog-fallback@gmail.test' };
    const PLAIN_MSG = { subject: 'Dialog import without labels', messageId: 'dialog-plain@gmail.test' };
    let lukeId = null;
    let takeoutPath = null;

    // Where each Takeout message has import-range copies: every message in
    // every folder it could reach, Archive included (the unpicked default).
    const FOLDERS = ['INBOX', 'Flaky', FALLBACK, 'Archive'];
    const placement = () => Object.fromEntries([INBOX_MSG, FLAKY_MSG, FALLBACK_MSG].map((m) => [
      m.subject, Object.fromEntries(FOLDERS.map((f) => [f, importedCopies(lukeId, f, m.messageId).length])),
    ]));
    const NOWHERE = { INBOX: 0, Flaky: 0, [FALLBACK]: 0, Archive: 0 };
    const ROUTED = {
      [INBOX_MSG.subject]: { ...NOWHERE, INBOX: 1 },
      [FLAKY_MSG.subject]: { ...NOWHERE, Flaky: 1 },
      [FALLBACK_MSG.subject]: { ...NOWHERE, [FALLBACK]: 1 },
    };

    before(function () {
      lukeId = (browser.mockAccounts || []).find((a) => a.email === LUKE)?.id;
      expect(lukeId).toBeTruthy();
      takeoutPath = join(workDir, 'takeout-labels.mbox');
      writeFileSync(takeoutPath, [
        takeoutMessage({ ...INBOX_MSG, labels: 'Inbox,Opened' }),
        // Important is ignored; the custom label that exists as a folder wins.
        takeoutMessage({ ...FLAKY_MSG, labels: 'Important,Flaky,Opened' }),
        // Category labels never name a folder: this one has no home but the fallback.
        takeoutMessage({ ...FALLBACK_MSG, labels: 'Category Promotions,Opened' }),
      ].join(''));
    });

    it('files each labelled message into the folder its label names, the rest into the picked fallback, and each lists there', async function () {
      expect(placement()).toEqual({
        [INBOX_MSG.subject]: NOWHERE, [FLAKY_MSG.subject]: NOWHERE, [FALLBACK_MSG.subject]: NOWHERE,
      });

      // luke has an \Archive folder and no All Mail: the fallback defaults to
      // Archive. Pointed at Trash, a folder neither label names, so a router
      // that sent everything to the fallback, or ignored the picked one, fails.
      const run = await importThroughDialog(takeoutPath, { pick: FALLBACK });
      expect(run.account).toBe(lukeId);
      expect(run.labels).toBe('true');
      expect(run.folder).toBe('Archive');

      // The disk is the proof: exactly one import-range copy of each message,
      // in its own folder and nowhere else.
      expect(placement()).toEqual(ROUTED);

      for (const { subject, folder } of [
        { subject: INBOX_MSG.subject, folder: 'INBOX' },
        { subject: FLAKY_MSG.subject, folder: 'Flaky' },
        { subject: FALLBACK_MSG.subject, folder: FALLBACK },
      ]) {
        await switchToFolder(LUKE, folder, { requireRows: false });
        let rows = [];
        await browser.waitUntil(async () => {
          rows = await visibleRowSubjects();
          return rows.some((r) => r.includes(subject));
        }, {
          timeout: 30_000, interval: 500,
          timeoutMsg: `"${subject}" never listed in ${LUKE} ${folder}; rows: ${JSON.stringify(rows).slice(0, 600)}`,
        });
      }
      expect(run.alerts.join('\n')).toContain('3 email(s) are now in your vault');
    });

    it('a repeat import of the same file skips what each folder already holds', async function () {
      // Standalone: when the case above did not run, import once the way the
      // dialog does (same params) so there is something to skip.
      if (JSON.stringify(placement()) !== JSON.stringify(ROUTED)) {
        const first = await daemonRpc('import_mbox', {
          sourcePath: takeoutPath, accountId: lukeId, mode: 'local', mailbox: FALLBACK, fallbackMailbox: FALLBACK, useLabels: true,
        });
        expect(first.ok).toBe(true);
      }
      expect(placement()).toEqual(ROUTED);

      const run = await importThroughDialog(takeoutPath, { pick: FALLBACK });

      expect(placement()).toEqual(ROUTED);
      const said = run.alerts.join('\n');
      expect(said).toContain('0 email(s) are now in your vault');
      expect(said).toContain('3 email(s) were already in this folder and were skipped.');
    });

    it('a file without labels goes to the folder picked in the dialog', async function () {
      const plainPath = join(workDir, 'plain.mbox');
      writeFileSync(plainPath, takeoutMessage({ ...PLAIN_MSG }));

      const run = await importThroughDialog(plainPath, { pick: 'Flaky' });
      // No labels: no toggle, and the one folder defaults to INBOX.
      expect(run.labels).toBe(null);
      expect(run.folder).toBe('INBOX');

      expect(importedCopies(lukeId, 'Flaky', PLAIN_MSG.messageId)).toHaveLength(1);
      expect(importedCopies(lukeId, 'INBOX', PLAIN_MSG.messageId)).toEqual([]);

      await switchToFolder(LUKE, 'Flaky');
      let rows = [];
      await browser.waitUntil(async () => {
        rows = await visibleRowSubjects();
        return rows.some((r) => r.includes(PLAIN_MSG.subject));
      }, {
        timeout: 30_000, interval: 500,
        timeoutMsg: `"${PLAIN_MSG.subject}" never listed in ${LUKE} Flaky; rows: ${JSON.stringify(rows).slice(0, 600)}`,
      });
    });
  });
});
