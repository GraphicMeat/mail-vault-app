/**
 * E2E: "Import and restore to the server" (MBOX import mode 1) uploads a
 * Takeout file to the account's server, folder by folder, and the app then
 * lists the mail as server rows where it went.
 *
 * Through the import options dialog (only the file pick is injected: under
 * VITE_E2E, BackupRestore takes `window.__MV_MBOX_SOURCE__` instead of the
 * native panel, see connected-mbox-import-visible), a Takeout-shaped file with
 * two labels goes up to luke's mock IMAP server:
 *   - `Important,Flaky,Opened`: Important is ignored, Flaky is a custom label
 *     naming a folder luke has, so the message goes to Flaky.
 *   - `MboxRestored,Starred`: a custom label no folder has, so the upload
 *     creates the folder on the server first (D3) and the message goes there,
 *     flagged (Starred).
 * The start answers at once; the daemon job reports by events and the corner
 * chip (MboxUploadProgress) follows it to its done summary. No reload, no
 * alert. On completion the app lists the folders again (the new one appears in
 * the store before any folder click), and each message lists in its folder as
 * a server row, not a local-only one. The mock server holds each message
 * exactly once, in its home folder and nowhere else. A second upload of the
 * same file uploads nothing and skips both.
 *
 * Folder choice. Flaky is only ever read by subject (email-viewer, pgp), and
 * what the upload adds to it is taken off again in `after()` (`trackMailbox`);
 * the created folder is this spec's own and is deleted from the server in
 * `after()` (as connected-migration-daemon does with its folders), once every
 * upload is cancelled and discarded, so the sidebar is as it was for the specs
 * after this one. The mock servers serve the whole run, so placements are
 * read against a baseline taken in `before`, never against zero (a CI
 * spec-file retry meets what an earlier attempt left). Off limits: luke's
 * INBOX (the upload keeps a vault copy under the server uid, and
 * connected-mbox-import-visible takes "vault max uid + 1" there as a server
 * uid), Archive (storage-matrix counts it, and it is the dialog's default
 * fallback, so the spec picks Trash) and Drafts (restore-daemon counts it).
 * Subjects avoid luke's slow-APPEND fault marker.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImapFlow } from 'imapflow';
import { closeSettings, switchToFolder, visibleRowSubjects, waitForApp, waitForEmails } from './helpers.js';
import { openTab } from './mockBilling.js';
import { MOCK_PASSWORD, SLOW_APPEND_MARKER, trackMailbox } from './mockImap.js';

const LUKE = 'luke@mock.test';
const LUKE_SERVER = 0; // MOCK_ACCOUNTS order: luke, vader, yoda
const IMPORT_UID_BASE = 0xC000_0000;
const ALERTS_KEY = 'mv-e2e-mbox-to-server-alerts';
const CREATED = 'MboxRestored';
const FALLBACK = 'Trash';
const FILE_NAME = 'takeout-server.mbox';

const FLAKY_MSG = { subject: 'Server upload for Flaky', messageId: 'server-upload-flaky@gmail.test', labels: 'Important,Flaky,Opened', home: 'Flaky' };
const NEW_MSG = { subject: 'Server upload into a new folder', messageId: 'server-upload-new@gmail.test', labels: `${CREATED},Starred`, home: CREATED };
const MESSAGES = [FLAKY_MSG, NEW_MSG];

// Every folder either message could reach: its home, the picked fallback, the
// dialog's default fallback, and INBOX.
const FOLDERS = ['Flaky', CREATED, FALLBACK, 'Archive', 'INBOX'];
// The mock servers serve the whole run, and a spec-file retry (CI) meets what
// an earlier attempt left: every placement is read against a baseline taken in
// `before`, never against zero. After an upload each message is in its home
// once (an upload skips what its home already holds), elsewhere as it was.
const routed = (base) => Object.fromEntries(MESSAGES.map((m) => [
  m.subject, { ...base[m.subject], [m.home]: Math.max(1, base[m.subject][m.home]) },
]));
/** How many of the messages an upload would send: those their home lacks. */
const freshIn = (base) => MESSAGES.filter((m) => base[m.subject][m.home] === 0).length;

const takeoutMessage = ({ subject, messageId, labels }) => [
  'From 1790000000000000000@xxx Mon Jan 01 00:00:00 +0000 2026',
  `X-Gmail-Labels: ${labels}`,
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

const daemonRpc = (method, params) => browser.executeAsync((m, p, done) => {
  try {
    window.__TAURI_INTERNALS__.invoke('daemon_rpc', { method: m, params: p })
      .then((v) => done({ ok: true, v }), (e) => done({ ok: false, __error: String((e && e.message) || e) }));
  } catch (e) {
    done({ ok: false, __error: String((e && e.message) || e) });
  }
}, method, params);

// ── The mock server, read behind the app's back ──────────────────────────

async function withLuke(fn) {
  const { host, port } = browser.mockImap[LUKE_SERVER];
  const client = new ImapFlow({ host, port, secure: false, auth: { user: LUKE, pass: MOCK_PASSWORD }, logger: false });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => {});
  }
}

/** Uids of `subject` in `folder` on luke's server; none when the folder does not exist. */
async function serverUids(client, folder, subject) {
  let lock;
  try {
    lock = await client.getMailboxLock(folder);
  } catch {
    return [];
  }
  try {
    return (await client.search({ subject }, { uid: true })) || [];
  } finally {
    lock.release();
  }
}

/** Copies of each message in each folder, on the server. */
const serverPlacement = () => withLuke(async (client) => {
  const out = {};
  for (const m of MESSAGES) {
    out[m.subject] = {};
    for (const f of FOLDERS) out[m.subject][f] = (await serverUids(client, f, m.subject)).length;
  }
  return out;
});

const serverFlags = (folder, subject) => withLuke(async (client) => {
  const lock = await client.getMailboxLock(folder);
  try {
    const [uid] = (await client.search({ subject }, { uid: true })) || [];
    if (!uid) return null;
    const msg = await client.fetchOne(uid, { flags: true }, { uid: true });
    return [...(msg?.flags || [])];
  } finally {
    lock.release();
  }
});

// ── The app ──────────────────────────────────────────────────────────────

const chipJobIds = () => browser.execute(() =>
  [...document.querySelectorAll('[data-testid="mbox-upload-job"]')].map((r) => r.getAttribute('data-job-id')));

const chipRow = (id) => browser.execute((jobId) => {
  const row = document.querySelector(`[data-testid="mbox-upload-job"][data-job-id="${CSS.escape(jobId)}"]`);
  return row ? { state: row.getAttribute('data-state'), text: (row.innerText || '').replace(/\s*\n\s*/g, ' | ') } : null;
}, id);

const alertsSeen = () => browser.execute((key) => JSON.parse(sessionStorage.getItem(key) || '[]'), ALERTS_KEY);

/** The folder paths in the store's server folder list, nested ones included. */
const storeFolders = () => browser.execute(() => {
  const s = window.__MAIL_STORE__?.getState?.();
  const paths = [];
  const walk = (list) => (list || []).forEach((m) => { paths.push(m.path); walk(m.children); });
  walk(s?.mailboxes);
  return { activeAccountId: s?.activeAccountId, paths };
});

/** What the open folder shows for `subject`: listed, as the server's row, with which state icon. */
const rowFor = (subject) => browser.execute((needle, base) => {
  const s = window.__MAIL_STORE__?.getState?.();
  const server = (s?.emails || []).find((e) => String(e.subject || '').includes(needle));
  const row = [...document.querySelectorAll('[data-testid="email-row"]')].find((r) => (r.innerText || '').includes(needle));
  return {
    listed: !!row,
    serverUid: server ? Number(server.uid) : null,
    belowImportRange: !!server && Number(server.uid) < base,
    icon: row?.querySelector('[data-testid="msg-state-icon"]')?.getAttribute('data-state') || null,
  };
}, subject, IMPORT_UID_BASE);

const dismissChip = (id) => browser.execute((jobId) => {
  const row = document.querySelector(`[data-testid="mbox-upload-job"][data-job-id="${CSS.escape(jobId)}"]`);
  row?.querySelector('[data-testid="mbox-upload-dismiss"]')?.click();
  return !!row;
}, id);

/**
 * Upload `sourcePath` through Settings > Backup & Restore > Import MBOX and
 * the options dialog, in "Import and restore to the server", on luke (the
 * account on screen, which the dialog preselects), with labels on and Trash
 * picked as the fallback. Returns what the dialog offered, the job id of the
 * new chip row and its done text.
 */
async function uploadThroughDialog(sourcePath) {
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

  const before = await chipJobIds();

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
    const server = document.querySelector('[data-testid="mbox-import-mode-server"]');
    const enabled = !server.disabled;
    server.click();
    const toggle = document.querySelector('[data-testid="mbox-import-use-labels"]');
    return {
      enabled,
      account: document.querySelector('[data-testid="mbox-import-account"]').value,
      folder: document.querySelector('[data-testid="mbox-import-folder"]').value,
      labels: toggle ? toggle.getAttribute('aria-checked') : null,
    };
  });
  await browser.waitUntil(() => browser.execute(() =>
    document.querySelector('[data-testid="mbox-import-mode-server"]')?.getAttribute('aria-pressed') === 'true'), {
    timeout: 5_000, interval: 100, timeoutMsg: 'the dialog never switched to "Import and restore to the server"',
  });

  // A WebDriver select never reaches React's onChange; the native setter plus
  // a bubbling change does (clickSettingsNav drives its select this way).
  await browser.execute((value) => {
    const select = document.querySelector('[data-testid="mbox-import-folder"]');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }, FALLBACK);
  await browser.waitUntil(() => browser.execute((value) =>
    document.querySelector('[data-testid="mbox-import-folder"]')?.value === value, FALLBACK), {
    timeout: 5_000, interval: 100, timeoutMsg: `the dialog's folder picker never took "${FALLBACK}"`,
  });
  // A file this small is no "many hours" upload.
  offered.longUploadWarning = await browser.execute(() => !!document.querySelector('[data-testid="mbox-import-long-upload"]'));

  await browser.execute(() => document.querySelector('[data-testid="mbox-import-confirm"]').click());

  // The start answers at once: the dialog closes. A refusal alerts instead,
  // and a file with an upload that stopped partway asks to resume.
  let outcome = null;
  await browser.waitUntil(async () => {
    const state = await browser.execute(() => ({
      open: !!document.querySelector('[data-testid="mbox-import-dialog"]'),
      resumable: !!document.querySelector('[data-testid="mbox-import-resumable"]'),
    }));
    const said = await alertsSeen();
    outcome = state.resumable ? 'resumable' : said.length ? `refused: ${said.join(' / ')}` : state.open ? null : 'started';
    return !!outcome;
  }, { timeout: 30_000, interval: 300, timeoutMsg: 'the dialog never closed after Import' });
  if (outcome === 'resumable') throw new Error('the dialog offered to resume an earlier upload of this file: a journal was left behind');
  if (outcome !== 'started') throw new Error(`the upload was ${outcome}`);

  let id = null;
  let row = null;
  try {
    await browser.waitUntil(async () => {
      id = (await chipJobIds()).find((j) => !before.includes(j)) || null;
      row = id ? await chipRow(id) : null;
      return row?.state === 'done';
    }, { timeout: 120_000, interval: 500 });
  } catch (e) {
    throw new Error(`the upload never finished in the chip: job ${id}, row ${JSON.stringify(row)}, alerts ${JSON.stringify(await alertsSeen())} (${e.message})`);
  }
  return { ...offered, id, text: row.text, alerts: await alertsSeen() };
}

describe('MBOX import and restore to the server', function () {
  this.timeout(300_000);

  let workDir = null;
  let lukeId = null;
  let sourcePath = null;
  let restoreFlaky = null;
  let baseline = null; // the server's placement before this spec uploads anything

  before(async function () {
    await waitForApp();
    await waitForEmails();
    lukeId = (browser.mockAccounts || []).find((a) => a.email === LUKE)?.id;
    expect(lukeId).toBeTruthy();
    for (const m of MESSAGES) expect(m.subject).not.toContain(SLOW_APPEND_MARKER);
    workDir = mkdtempSync(join(tmpdir(), 'mv-mbox-to-server-e2e-'));
    sourcePath = join(workDir, FILE_NAME);
    writeFileSync(sourcePath, MESSAGES.map(takeoutMessage).join(''));
    // Everything the upload APPENDs to luke's Flaky goes again in `after`.
    restoreFlaky = await trackMailbox(browser.mockImap[LUKE_SERVER], 'Flaky');
    baseline = await serverPlacement();
    console.log('[mbox-to-server] server placement before:', JSON.stringify(baseline));
  });

  after(async function () {
    // Stop every upload first: a job still running after a failed case would
    // create the folder again (its label routing creates a missing folder)
    // and APPEND into it after the delete below.
    try {
      const listed = await daemonRpc('mbox_upload_status', {});
      for (const job of listed.v?.jobs || []) {
        await daemonRpc('mbox_upload_cancel', { jobId: job.jobId });
        await daemonRpc('mbox_upload_discard', { jobId: job.jobId });
      }
      await browser.waitUntil(async () => (await daemonRpc('mbox_upload_status', {})).v?.jobs?.length === 0,
        { timeout: 60_000, interval: 500 });
    } catch (e) {
      console.warn(`[mbox-to-server] uploads still listed before the cleanup: ${e.message}`);
    }
    // Leave luke's server folders as the later specs expect them.
    await withLuke(async (client) => {
      try { await client.mailboxDelete(CREATED); } catch { /* never made, or already gone */ }
    }).catch((e) => console.warn(`[mbox-to-server] could not delete ${CREATED}: ${e.message}`));
    await restoreFlaky?.().catch((e) => console.warn(`[mbox-to-server] could not restore Flaky: ${e.message}`));
    try {
      await closeSettings();
      for (const id of await chipJobIds()) await dismissChip(id);
      await switchToFolder(LUKE, 'INBOX');
      await browser.executeAsync((done) => {
        Promise.resolve(window.__MAIL_STORE__.getState().refreshCurrentView()).then(() => done(true), () => done(false));
      });
      await browser.waitUntil(async () => !(await storeFolders()).paths.includes(CREATED), { timeout: 30_000, interval: 500 });
    } catch (e) {
      console.warn(`[mbox-to-server] the folder list still names ${CREATED}: ${e.message}`);
    }
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it('uploads each message once, to the folder its label names, and the app lists them there as server rows', async function () {
    expect(await serverPlacement()).toEqual(baseline);
    const fresh = freshIn(baseline);

    const run = await uploadThroughDialog(sourcePath);
    // luke is IMAP: the upload is offered, on the account on screen, with labels on.
    expect(run.enabled).toBe(true);
    expect(run.account).toBe(lukeId);
    expect(run.labels).toBe('true');
    expect(run.longUploadWarning).toBe(false);
    expect(run.alerts).toEqual([]);
    expect(run.text).toContain(`Upload of ${FILE_NAME} finished`);
    expect(run.text).toContain(`${fresh} uploaded, ${MESSAGES.length - fresh} skipped, 0 failed`);

    // The server is the proof: one copy of each, in its home, nowhere else
    // beyond what was there before, and the Starred label became the flag.
    expect(await serverPlacement()).toEqual(routed(baseline));
    expect(await serverFlags(CREATED, NEW_MSG.subject)).toContain('\\Flagged');
    // Done means done: no journal is left to resume.
    expect(await daemonRpc('mbox_upload_status', {})).toEqual({ ok: true, v: { jobs: [] } });

    // The app listed the folders again on its own: the new folder is in the
    // store before any folder is clicked.
    await browser.waitUntil(async () => {
      const s = await storeFolders();
      return s.activeAccountId === lukeId && s.paths.includes(CREATED);
    }, {
      timeout: 30_000, interval: 500,
      timeoutMsg: `the folder list never named ${CREATED} after the upload: ${JSON.stringify(await storeFolders())}`,
    });

    await dismissChip(run.id);
    await closeSettings();
    for (const { subject, folder } of [
      { subject: FLAKY_MSG.subject, folder: 'Flaky' },
      { subject: NEW_MSG.subject, folder: CREATED },
    ]) {
      await switchToFolder(LUKE, folder, { requireRows: false });
      let seen = null;
      await browser.waitUntil(async () => {
        seen = await rowFor(subject);
        return seen.listed && seen.belowImportRange;
      }, {
        timeout: 30_000, interval: 500,
        timeoutMsg: `"${subject}" never listed in ${LUKE} ${folder} as a server row: ${JSON.stringify(seen)}; rows ${JSON.stringify(await visibleRowSubjects()).slice(0, 600)}`,
      });
      // A server row, never the gold local-only one.
      expect(String(seen.icon || '')).not.toMatch(/^local-only/);
    }
  });

  it('a second upload of the same file uploads nothing and skips both', async function () {
    // Standalone: when the case above did not run, upload once the way the
    // dialog does (same params) and wait for the job to end.
    if (JSON.stringify(await serverPlacement()) !== JSON.stringify(routed(baseline))) {
      const first = await daemonRpc('import_mbox', {
        sourcePath, accountId: lukeId, mode: 'server', mailbox: FALLBACK, fallbackMailbox: FALLBACK, useLabels: true,
      });
      expect(first.ok).toBe(true);
      await browser.waitUntil(async () => (await daemonRpc('mbox_upload_status', {})).v?.jobs?.length === 0, {
        timeout: 120_000, interval: 500, timeoutMsg: 'the first upload never ended',
      });
    }
    expect(await serverPlacement()).toEqual(routed(baseline));

    const run = await uploadThroughDialog(sourcePath);
    expect(run.alerts).toEqual([]);
    expect(run.text).toContain(`0 uploaded, ${MESSAGES.length} skipped, 0 failed`);

    expect(await serverPlacement()).toEqual(routed(baseline));
    expect(await daemonRpc('mbox_upload_status', {})).toEqual({ ok: true, v: { jobs: [] } });
    await dismissChip(run.id);
  });
});
