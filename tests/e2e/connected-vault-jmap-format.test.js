/**
 * E2E: the vault's message storage format, converted both ways through the
 * real app (Plan B Task 11).
 *
 * Seeded: 40 messages of luke's mock IMAP INBOX archived into the vault, 80 in
 * an MBOX import kept as a folder of luke's own ("On this computer"), and a
 * two-message canary folder imported under yoda. 122 messages over two
 * accounts; the job converts the whole vault, so whatever else the app cached
 * by the time Convert is pressed (bodies of opened folders) converts too, and
 * every count below is scoped to the seeded folders.
 *
 * The scenario, in order:
 *   1. Settings > Storage > Convert to JMAP, keeping the old files aside.
 *      While it runs: the chip counts, three opens each take under 300 ms
 *      (timed inside the page, so no WebDriver round trip is in the figure),
 *      and one opened message is flagged. The chip pauses and resumes; a
 *      vault move while it is paused is refused in the catalog's words
 *      (Task 10). One while it runs is refused too, and the job holds
 *      through the vault the shell closed for it, then carries on with
 *      nothing failed (format_migration_job.rs `hold_for_vault`). Cancel
 *      leaves Settings' Resume and Convert back. A Resume
 *      that meets an unreadable folder (the canary, chmod 000) stops the run
 *      as failed, and Settings and the chip say why; the folder readable
 *      again, the chip's Resume finishes the run.
 *   2. In JMAP: every seeded message is a record whose blob holds its original
 *      bytes, the mid-run flag survived, the old files sit under retired/.
 *      Search finds a body word, flag and unflag reach the record, delete
 *      takes the record into the deleted bin, a backup mirrors `.eml` files
 *      with the original bytes, View Source shows the original bytes, and
 *      Reclaim space removes nothing (every blob is named, or younger than
 *      the 24 h grace).
 *   3. The JMAP vault moves to another folder through Settings > Backup
 *      Settings and back: it still reads as JMAP, every record arrives, and a
 *      message opens there.
 *   4. Convert back to Maildir. Mid-run a message opens in under 300 ms and is
 *      unflagged; then the daemon is killed (SIGKILL) and the page reloaded.
 *      The daemon the app respawns carries the job on from its journal, the
 *      chip shows it and it finishes, and no seeded message was lost or
 *      doubled: same uids, same bytes, same flag letters on every message
 *      nothing touched.
 *   5. Delete old files: retired/ is gone. Reclaim space is still offered in
 *      Maildir format (the blobs are inside their grace) and removes nothing.
 *
 * "Kill the app" is the daemon here, on purpose: the conversion lives there
 * (src-daemon/src/format_migration_job.rs), the app is a shell over it, and a
 * WebDriver session cannot relaunch the app it drives. The page reload stands
 * for the shell's relaunch (connected-search-index-resume kills the same way).
 *
 * Mid-run determinism: a debug daemon waits MAILVAULT_E2E_FORMAT_MESSAGE_PAUSE_MS
 * (wdio.conf.js) before each message, so 122 messages take seconds, not the
 * fraction of one they take unpaced. Release builds compile the wait out.
 *
 * The native folder picker is replaced by `window.__MV_VAULT_FOLDER__` (VITE_E2E
 * only, MailStorageLocation.jsx), as MBOX import's is by `__MV_MBOX_SOURCE__`.
 * The mock servers outlive this file, so every mutation lands on vault-only
 * mail: luke's INBOX is archived and read, never flagged or deleted.
 */

import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeSettings, daemonExecutable, reloadApp, runBackupAndWait, switchToFolder, waitForApp, waitForEmails,
} from './helpers.js';
import { openTab } from './mockBilling.js';
import { appDataDir, INFO_SEP } from './mockImap.js';

const LUKE = 'luke@mock.test';
const YODA = 'yoda@mock.test';
const SEEDS = 80;
const CANARIES = 2;
const OPEN_BUDGET_MS = 300;
const RUN_TIMEOUT = 600_000;
const IS_WIN = process.platform === 'win32';

const pad = (i) => String(i).padStart(2, '0');
const subjectOf = (i) => `JMAP format seed ${pad(i)}`;
const tokenOf = (i) => `JFMTBODY${pad(i)}`;
const messageIdOf = (i) => `jmap-format-${pad(i)}@mock.test`;

// The catalog's English words (src/i18n/locales/en.json) the spec drives and reads.
const EN = {
  maildir: 'Maildir (.eml files)', // settings.storage.formatMaildir
  jmap: 'JMAP (JSON records + blobs)', // settings.storage.formatJmap
  convert: 'Convert', // settings.storage.convert
  convertTo: 'Convert to', // settings.storage.convertTitle
  start: 'Start conversion', // settings.storage.convertStart
  resume: 'Resume', // common.resume
  convertBack: 'Convert back', // settings.storage.convertBack
  stoppedAt: 'Conversion stopped at', // settings.storage.convertStopped
  failedLine: 'Conversion stopped: a folder of the vault could not be read.', // errors.formatFailed + errors.formatUnreadable
  retired: 'Old files kept aside:', // settings.storage.retiredSize
  retiredDelete: 'Delete old files', // settings.storage.retiredDelete
  deletePermanently: 'Delete permanently', // settings.storage.deletePermanently
  reclaim: 'Reclaim space', // settings.storage.reclaim
  moveBlocked: 'Finish or cancel the format conversion before moving the vault.', // errors.formatMoveBlocked
  moveMail: 'Move mail to another folder', // settings.storage.moveMailAnotherFolder
  resetToDefault: 'Reset to default', // common.resetToDefault
  moveMailBack: 'Move mail back', // settings.mailLocation.moveMailBack
  chipFailed: 'Message format conversion stopped', // formatMigration.failed
  chipDone: 'Message format converted', // formatMigration.done
};

// ── Seeds ───────────────────────────────────────────────────────────────────

/** One mbox message, ASCII only, dated `minutesAgo` before `now` so seed 01 heads the list. */
const mboxMessage = ({ subject, messageId, token, minutesAgo, now }) => [
  'From jmap-format@mock.test Mon Jan 01 00:00:00 +0000 2026',
  'From: Format Seed <seed@mock.test>',
  `To: ${LUKE}`,
  `Subject: ${subject}`,
  `Date: ${new Date(now - minutesAgo * 60_000).toUTCString().replace('GMT', '+0000')}`,
  `Message-ID: <${messageId}>`,
  '',
  `Body of ${subject}: ${token}.`,
  '',
  '',
].join('\n');

// ── Bridges ─────────────────────────────────────────────────────────────────

/** A daemon route. Resolves `{ok, v}` or `{ok: false, __error}` (a truthy `error` key reads back as a W3C error). */
const daemonRpc = (method, params) => browser.executeAsync((m, p, done) => {
  try {
    window.__TAURI_INTERNALS__.invoke('daemon_rpc', { method: m, params: p })
      .then((v) => done({ ok: true, v }), (e) => done({ ok: false, __error: String((e && e.message) || e) }));
  } catch (e) {
    done({ ok: false, __error: String((e && e.message) || e) });
  }
}, method, params);

/** A native command of the shell, same answer shape. */
const invoke = (cmd, args) => browser.executeAsync((c, a, done) => {
  window.__TAURI__.core.invoke(c, a)
    .then((v) => done({ ok: true, v }), (e) => done({ ok: false, __error: String((e && e.message) || e) }));
}, cmd, args);

const must = async (what, call) => {
  const r = await call;
  if (!r.ok) throw new Error(`${what}: ${r.__error}`);
  return r.v;
};

// ── Disk ────────────────────────────────────────────────────────────────────

const NAME_RE = new RegExp(`^(\\d+)${INFO_SEP === ';' ? ';' : ':'}2,([A-Za-z]*)(?:\\.eml)?$`);

/** The Maildir files of a mailbox directory: uid, flag letters, path. */
function curEntries(folder) {
  const cur = join(folder, 'cur');
  if (!existsSync(cur)) return [];
  return readdirSync(cur).map((name) => {
    const m = name.match(NAME_RE);
    return m ? { uid: Number(m[1]), flags: m[2], name, path: join(cur, name) } : null;
  }).filter(Boolean);
}

/** The uids holding a JMAP record (`jmap/<uid>.json`). */
function recordUids(folder) {
  const dir = join(folder, 'jmap');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map((n) => n.match(/^(\d+)\.json$/)).filter(Boolean).map((m) => Number(m[1]));
}

const sortNum = (list) => [...list].sort((a, b) => a - b);
/** Every uid the mailbox holds, in either format, once. */
const uidSet = (folder) => sortNum(new Set([...curEntries(folder).map((e) => e.uid), ...recordUids(folder)]));
const readRecord = (folder, uid) => JSON.parse(readFileSync(join(folder, 'jmap', `${uid}.json`), 'utf8'));
/** `message_blobs/<hex[0..2]>/<hex>.eml` (src-core/src/jmap_store/blobs.rs `blob_path`). */
const blobBytes = (root, id) => {
  const hex = String(id).replace(/^sha256-/, '');
  return readFileSync(join(root, 'message_blobs', hex.slice(0, 2), `${hex}.eml`));
};
/** The flag letters a message holds now: its record's keywords when it has one (a record wins), else its file name's. */
function flagState(folder, uid) {
  if (recordUids(folder).includes(uid)) {
    const rec = readRecord(folder, uid);
    return { flagged: rec.email?.keywords?.$flagged === true, format: 'jmap' };
  }
  const file = curEntries(folder).find((e) => e.uid === uid);
  return file ? { flagged: file.flags.includes('F'), format: 'maildir' } : null;
}

/** Files under `dir`, recursively. */
function countFiles(dir) {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) n += countFiles(join(dir, entry.name));
    else if (entry.isFile()) n += 1;
  }
  return n;
}

const daemonPid = (home) => {
  try { return parseInt(readFileSync(join(appDataDir(home), 'daemon.pid'), 'utf8').trim(), 10) || 0; } catch { return 0; }
};

function daemonLogText(home) {
  const dir = join(appDataDir(home), 'logs');
  if (!existsSync(dir)) return '';
  return readdirSync(dir).filter((f) => f.startsWith('daemon.log'))
    .map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
}

// ── The page ────────────────────────────────────────────────────────────────

/** The conversion's corner chip (FormatMigrationProgress.jsx), or null. */
const chip = () => browser.execute(() => {
  const job = document.querySelector('[data-testid="format-migration-job"]');
  if (!job) return null;
  const counts = job.querySelector('[data-testid="format-migration-counts"]')?.textContent.trim() || '';
  const [d, t] = counts.split(' of ');
  const num = (s) => (s === undefined ? null : Number(String(s).replace(/[^\d]/g, '')));
  return {
    state: job.getAttribute('data-state'),
    counts,
    done: num(d),
    total: num(t),
    text: (job.innerText || '').replace(/\s*\n\s*/g, ' | ').trim(),
    controls: [...job.querySelectorAll('[data-testid^="format-migration-"]')].map((b) => b.getAttribute('data-testid')),
  };
});

const clickChip = (name) => browser.execute((n) => {
  const b = document.querySelector(`[data-testid="format-migration-${n}"]`);
  if (!b) return false;
  b.click();
  return true;
}, name);

/** Settings > Storage > Message format (StorageFormatSettings.jsx), or null when not rendered. */
const formatUi = () => browser.execute(() => {
  const s = document.querySelector('[data-testid="storage-format"]');
  if (!s) return null;
  const line = (sel) => (s.querySelector(sel)?.innerText || '').replace(/\s*\n\s*/g, ' | ').trim() || null;
  return {
    current: line('[data-testid="storage-format-current"]'),
    migration: line('[data-testid="storage-format-migration"]'),
    retired: line('[data-testid="storage-format-retired"]'),
    alert: line(':scope > div > [role="alert"]'),
    buttons: [...s.querySelectorAll('button')].filter((b) => b.offsetHeight > 0)
      .map((b) => ({ text: (b.textContent || '').trim(), disabled: b.disabled })),
  };
});

const clickFormatButton = (label) => browser.execute((l) => {
  const s = document.querySelector('[data-testid="storage-format"]');
  const b = [...(s?.querySelectorAll('button') || [])]
    .find((x) => x.offsetHeight > 0 && !x.disabled && (x.textContent || '').trim() === l);
  if (!b) return false;
  b.click();
  return true;
}, label);

/** The Convert dialog: the open dialog that carries the old-files radios. */
const convertDialog = () => browser.execute(() => {
  const d = [...document.querySelectorAll('[role="dialog"]')]
    .find((x) => x.getAttribute('data-testid') !== 'settings-page' && x.querySelector('input[name="storage-format-old-files"]'));
  if (!d) return null;
  const titleId = d.getAttribute('aria-labelledby');
  return {
    title: (titleId && document.getElementById(titleId)?.textContent.trim()) || '',
    oldFiles: d.querySelector('input[name="storage-format-old-files"]:checked')?.value || null,
    alert: d.querySelector('[role="alert"]')?.textContent.trim() || null,
  };
});

const clickInConvertDialog = (label) => browser.execute((l) => {
  const d = [...document.querySelectorAll('[role="dialog"]')]
    .find((x) => x.getAttribute('data-testid') !== 'settings-page' && x.querySelector('input[name="storage-format-old-files"]'));
  const b = [...(d?.querySelectorAll('button') || [])].find((x) => !x.disabled && (x.textContent || '').trim() === l);
  if (!b) return false;
  b.click();
  return true;
}, label);

/** Settings > Backup Settings > "Where your mail is stored" (MailStorageLocation.jsx). */
const locationUi = () => browser.execute(() => {
  const path = document.querySelector('[data-testid="vault-path"]');
  const s = path?.closest('.settings-section');
  if (!s) return null;
  return {
    path: path.textContent.trim(),
    error: s.querySelector('p.text-mail-danger')?.textContent.trim() || null,
    notice: s.querySelector('p.text-mail-success')?.textContent.trim() || null,
    buttons: [...s.querySelectorAll('button')].filter((b) => b.offsetHeight > 0)
      .map((b) => ({ text: (b.textContent || '').trim(), disabled: b.disabled })),
  };
});

const clickLocationButton = (label) => browser.execute((l) => {
  const s = document.querySelector('[data-testid="vault-path"]')?.closest('.settings-section');
  const b = [...(s?.querySelectorAll('button') || [])]
    .find((x) => x.offsetHeight > 0 && !x.disabled && (x.textContent || '').trim() === l);
  if (!b) return false;
  b.click();
  return true;
}, label);

/**
 * Click the row of `subject` and time it, inside the page, until the reading
 * pane shows `token` in the body and no longer the snippet placeholder.
 * `{ms}` or `{error}`.
 */
const openTimed = (subject, token) => browser.executeAsync((s, tok, done) => {
  const row = [...document.querySelectorAll('[data-testid="email-row"]')].find((r) => r.offsetHeight > 0
    && !r.closest('[data-quick-actions-preview]')
    && ((r.querySelector('[data-testid="row-subject"]')?.textContent || '').trim() === s
      || (r.innerText || '').split('\n').map((l) => l.trim()).includes(s)));
  if (!row) { done({ error: `no visible row "${s}"` }); return; }
  const t0 = performance.now();
  row.click();
  const tick = () => {
    const body = document.querySelector('.email-plain-body, .email-content');
    const loading = document.querySelector('[data-testid="email-body-loading"]');
    if (body && !loading && (body.textContent || '').includes(tok)) { done({ ms: Math.round(performance.now() - t0) }); return; }
    if (performance.now() - t0 > 15_000) { done({ error: `"${s}" never showed ${tok}`, ms: Math.round(performance.now() - t0) }); return; }
    setTimeout(tick, 4);
  };
  tick();
}, subject, token);

/** A shortcut, through the app's own handler (useKeyboardShortcuts listens on window). */
const shortcut = (key) => browser.execute((k) => {
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
}, key);

const selectedSubject = () => browser.execute(() => window.__MAIL_STORE__?.getState?.().selectedEmail?.subject || null);

/** Rows the store holds for the open folder. */
const storeRowCount = () => browser.execute(() => (window.__MAIL_STORE__?.getState?.().sortedEmails || []).length);

/** Search the vault only, the way the index specs do (connected-search-index). */
const localSearch = async (query) => {
  const ran = await browser.execute((q) => {
    const store = window.__SEARCH_STORE__;
    if (!store) return false;
    store.setState({ searchQuery: q });
    store.getState().setSearchFilters({ folder: 'all', location: 'local' });
    store.getState().performSearch();
    return true;
  }, query);
  if (!ran) return [];
  await browser.waitUntil(() => browser.execute(() => {
    const s = window.__SEARCH_STORE__?.getState?.();
    return !!s && s.searchActive === true && s.isSearching === false;
  }), { timeout: 30_000, interval: 200, timeoutMsg: `search "${query}" never settled` });
  return browser.execute(() => (window.__SEARCH_STORE__?.getState?.().searchResults || []).map((r) => r.subject));
};

const clearSearch = () => browser.execute(() => { window.__SEARCH_STORE__?.getState?.().clearSearch?.(); });

describe('Vault storage format: Maildir to JMAP and back, through the app', function () {
  this.timeout(1_200_000);

  let home = null;
  let root = null; // the vault root: the app data dir, or where a move put it
  let luke = null;
  let yoda = null;
  let local = null; // luke's MBOX folder: { name, dir, created }
  let canary = null; // yoda's MBOX folder: { name, dir }
  let canaryMode = null; // its directory mode while chmod 000 is in force
  const work = []; // temp dirs this spec removes
  const seedUid = new Map(); // seed i -> its uid in luke's MBOX folder
  const snapshot = new Map(); // `${which}:${uid}` -> { bytes, flags }
  const touched = new Set(); // seed numbers whose flag letters this spec changed (opened, flagged)
  let deletedSeed = null;
  let mboxDir = null; // where this spec writes its .mbox files
  let jmapSets = null; // uid sets of the seeded folders, in JMAP, before the move

  const FOLDERS = ['inbox', 'local', 'canary'];
  const folderOf = (which, at = root) => {
    if (which === 'inbox') return join(at, 'Maildir', luke.id, 'INBOX');
    if (which === 'local') return join(at, 'Maildir', luke.id, local.dir);
    return join(at, 'Maildir', yoda.id, canary.dir);
  };
  /**
   * The seeded uids each folder holds now. luke's INBOX folder also takes the
   * bodies the app caches of his other INBOX mail, so it is read through the
   * snapshot; the two MBOX folders have no other writer and are read whole.
   */
  const seededSets = (at = root) => Object.fromEntries(FOLDERS.map((w) => [w,
    uidSet(folderOf(w, at)).filter((uid) => w !== 'inbox' || snapshot.has(`inbox:${uid}`))]));
  const snapshotUids = (which) => sortNum([...snapshot.keys()].filter((k) => k.startsWith(`${which}:`)).map((k) => Number(k.split(':')[1])));
  const migration = async () => (await must('storage_format_get', daemonRpc('storage_format_get', {})));

  /** Waits until the vault's file population stops changing (the app caches bodies after boot). */
  async function settleVault() {
    const total = () => {
      const maildir = join(root, 'Maildir');
      return existsSync(maildir) ? countFiles(maildir) : 0;
    };
    let last = -1;
    let same = 0;
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline && same < 3) {
      const n = total();
      same = n === last ? same + 1 : 0;
      last = n;
      await browser.pause(2000);
    }
    console.log(`[jmap-format] vault settled at ${last} files (${same >= 3 ? 'stable' : 'still moving after 120 s'})`);
  }

  /**
   * Waits for the conversion to end. Done: the answer. A run that ended
   * failed with folders waiting for their first full header sync
   * (E_FORMAT_REHOME_PENDING, Plan B 7b D7: a background account whose header
   * cache was still filling) is resumed, as the product asks, a few times.
   * Any other end throws with what the daemon said.
   */
  async function finishRun(label) {
    let last = null;
    for (let resumes = 0; ; resumes++) {
      try {
        await browser.waitUntil(async () => {
          last = await daemonRpc('storage_format_get', {});
          const m = last.ok ? last.v.migration : undefined;
          return last.ok && (m === null || (m.active === false && (m.state === 'failed' || m.state === 'cancelled')));
        }, { timeout: RUN_TIMEOUT, interval: 500 });
      } catch {
        throw new Error(`${label}: the conversion never ended; last storage_format_get: ${JSON.stringify(last)}`);
      }
      const m = last.v.migration;
      if (m === null) return last.v;
      if (m.state === 'failed' && String(m.error || '').startsWith('E_FORMAT_REHOME_PENDING') && resumes < 8) {
        console.log(`[jmap-format] ${label}: ${m.error}; resuming (${resumes + 1})`);
        await browser.pause(8000);
        await must('storage_format_resume', daemonRpc('storage_format_resume', {}));
        continue;
      }
      throw new Error(`${label}: the conversion ended ${JSON.stringify(m)}`);
    }
  }

  /** Settings > Storage, then Convert, the dialog's default (keep old files aside), Start. */
  async function startConversion(targetLabel) {
    await openTab('Storage');
    await browser.waitUntil(async () => !!(await formatUi())?.current, {
      timeout: 15_000, interval: 300, timeoutMsg: 'Settings > Storage never showed the message format section',
    });
    expect(await clickFormatButton(EN.convert)).toBe(true);
    await browser.waitUntil(async () => (await convertDialog()) !== null, {
      timeout: 10_000, interval: 200, timeoutMsg: 'the Convert dialog never opened',
    });
    const dialog = await convertDialog();
    expect(dialog.title).toBe(`${EN.convertTo} ${targetLabel}`);
    // Retire is what the dialog offers each time it opens: the old files kept aside.
    expect(dialog.oldFiles).toBe('retire');
    expect(await clickInConvertDialog(EN.start)).toBe(true);
    await browser.waitUntil(async () => (await convertDialog()) === null, {
      timeout: 30_000, interval: 200,
      timeoutMsg: `the Convert dialog stayed open: ${JSON.stringify(await convertDialog())}`,
    });
    await closeSettings();
  }

  /** The chip, running, with `done` past `atLeast`. */
  async function waitChipRunning(atLeast, why) {
    let c = null;
    await browser.waitUntil(async () => {
      c = await chip();
      return c?.state === 'running' && c.done >= atLeast && c.total > c.done;
    }, { timeout: 60_000, interval: 100, timeoutMsg: why }).catch(() => {
      throw new Error(`${why}; chip: ${JSON.stringify(c)}`);
    });
    return c;
  }

  async function openUnderBudget(seed, phase) {
    const r = await openTimed(subjectOf(seed), tokenOf(seed));
    if (r.error) throw new Error(`${phase}: ${r.error}`);
    console.log(`[jmap-format] ${phase}: opened seed ${pad(seed)} in ${r.ms} ms`);
    expect(r.ms).toBeLessThan(OPEN_BUDGET_MS);
    touched.add(seed);
    return r.ms;
  }

  /** Flag or unflag the open message by the `s` shortcut, and wait until the vault holds it. */
  async function toggleFlagOnDisk(seed, want) {
    expect(await selectedSubject()).toBe(subjectOf(seed));
    await shortcut('s');
    const uid = seedUid.get(seed);
    let state = null;
    await browser.waitUntil(() => {
      state = flagState(folderOf('local'), uid);
      return state?.flagged === want;
    }, { timeout: 20_000, interval: 200 }).catch(() => {
      throw new Error(`seed ${pad(seed)} (uid ${uid}) never became ${want ? 'flagged' : 'unflagged'} on disk: ${JSON.stringify(state)}`);
    });
    touched.add(seed);
    return state;
  }

  before(async function () {
    await waitForApp();
    await waitForEmails();
    home = browser.testDataDir;
    root = appDataDir(home);
    luke = browser.mockAccounts.find((a) => a.email === LUKE);
    yoda = browser.mockAccounts.find((a) => a.email === YODA);
    expect(luke?.id).toBeTruthy();
    expect(yoda?.id).toBeTruthy();
  });

  after(function () {
    // A failure between the chmod and its undo must not leave a folder nothing can read.
    if (canaryMode !== null && canary) {
      try { chmodSync(folderOf('canary'), canaryMode); } catch { /* best effort */ }
    }
    for (const dir of work) rmSync(dir, { recursive: true, force: true });
  });

  it('seeds 122 messages over two accounts: luke\'s IMAP INBOX archived, an MBOX folder, a canary folder', async function () {
    // luke's INBOX, archived into the vault: what an IMAP account's vault
    // folder is. "Luke message 1..40" are uids 1..40 (mockImap.js `mailbox`,
    // uidStart 1). Opening the folder first fills its header cache, which the
    // conversion's rehome gate reads (Plan B 7b D7).
    await switchToFolder(LUKE, 'INBOX');
    const uids = Array.from({ length: 40 }, (_, k) => k + 1);
    const archived = await must('archive_emails', invoke('daemon_rpc', {
      method: 'archive_emails',
      params: { accountId: luke.id, accountJson: JSON.stringify(luke), mailbox: 'INBOX', uids },
    }));
    console.log(`[jmap-format] archived luke's INBOX: ${JSON.stringify(archived)}`);

    // luke's MBOX folder of 80, and yoda's canary of 2: folders kept on this computer.
    const dir = mkdtempSync(join(tmpdir(), 'mv-jmap-format-'));
    work.push(dir);
    mboxDir = dir;
    const now = Date.now();
    const lukeMbox = join(dir, 'format-seed.mbox');
    writeFileSync(lukeMbox, Array.from({ length: SEEDS }, (_, k) => mboxMessage({
      subject: subjectOf(k + 1), messageId: messageIdOf(k + 1), token: tokenOf(k + 1), minutesAgo: k + 1, now,
    })).join(''));
    const canaryMbox = join(dir, 'format-canary.mbox');
    writeFileSync(canaryMbox, Array.from({ length: CANARIES }, (_, k) => mboxMessage({
      subject: `JMAP format canary ${pad(k + 1)}`, messageId: `jmap-format-canary-${pad(k + 1)}@mock.test`,
      token: `JFMTCANARY${pad(k + 1)}`, minutesAgo: k + 1, now,
    })).join(''));

    const lukeImport = await must('import_mbox (luke)', daemonRpc('import_mbox', { accountId: luke.id, sourcePath: lukeMbox, mode: 'folder' }));
    const yodaImport = await must('import_mbox (yoda)', daemonRpc('import_mbox', { accountId: yoda.id, sourcePath: canaryMbox, mode: 'folder' }));
    const lukeFolders = await must('list_local_folders', daemonRpc('list_local_folders', { accountId: luke.id }));
    local = lukeFolders.find((f) => f.dir === lukeImport.folder.dir);
    canary = yodaImport.folder;
    expect(local?.created).toBeTruthy();
    expect(canary?.dir).toBeTruthy();

    // The new folder in the sidebar, and its rows.
    await reloadApp();
    await switchToFolder(LUKE, local.name);
    await browser.waitUntil(async () => (await storeRowCount()) === SEEDS, {
      timeout: 30_000, interval: 300, timeoutMsg: `"${local.name}" never listed its ${SEEDS} rows`,
    });
    // Warm the reading pane once, outside any run: the budget is about the run, not the first paint.
    const warm = await openTimed(subjectOf(10), tokenOf(10));
    if (warm.error) throw new Error(`warm-up open: ${warm.error}`);
    console.log(`[jmap-format] warm-up open of seed 10: ${warm.ms} ms`);
    touched.add(10);
    await settleVault();

    // Snapshot from disk, once the app stopped caching: what every later read
    // is compared with, byte for byte.
    for (const which of FOLDERS) {
      const files = curEntries(folderOf(which));
      expect(recordUids(folderOf(which))).toEqual([]);
      for (const f of files) snapshot.set(`${which}:${f.uid}`, { bytes: readFileSync(f.path), flags: f.flags });
    }
    for (const f of curEntries(folderOf('local'))) {
      const text = readFileSync(f.path, 'latin1');
      const m = text.match(/Message-ID: <jmap-format-(\d\d)@mock\.test>/);
      if (m) seedUid.set(Number(m[1]), f.uid);
    }
    const sets = seededSets();
    expect(uids.every((uid) => sets.inbox.includes(uid))).toBe(true);
    expect(sets.local.length).toBe(SEEDS);
    expect(sets.canary.length).toBe(CANARIES);
    expect(seedUid.size).toBe(SEEDS);
    console.log(`[jmap-format] seeded ${sets.inbox.length} + ${sets.local.length} + ${sets.canary.length} messages`);
    expect((await migration()).format).toBe('maildir');
  });

  it('converts to JMAP: the chip counts, opens stay under 300 ms, a flag lands, Pause and Resume steer it', async function () {
    await startConversion(EN.jmap);
    const first = await waitChipRunning(1, 'the chip never showed the conversion running');
    expect(first.total).toBeGreaterThanOrEqual(122);
    expect(first.controls).toEqual(expect.arrayContaining(['format-migration-pause', 'format-migration-cancel']));

    // The UI stays responsive while it runs.
    await switchToFolder(LUKE, local.name);
    for (const seed of [1, 2, 3]) await openUnderBudget(seed, 'to JMAP, mid-run');
    // Flagged mid-run: whichever format holds it when the flag lands, the flag survives.
    await toggleFlagOnDisk(3, true);
    const during = await migration();
    expect(during.migration?.state).toBe('running');

    // Pause holds it where it stands; the counts stop.
    expect(await clickChip('pause')).toBe(true);
    await browser.waitUntil(async () => (await chip())?.state === 'paused', {
      timeout: 30_000, interval: 200, timeoutMsg: 'the chip never said paused',
    });
    const held = (await migration()).migration;
    await browser.pause(1500);
    expect((await migration()).migration.done).toBe(held.done);
    expect(held.done).toBeLessThan(held.total);

    // Resume carries on from there.
    expect(await clickChip('resume')).toBe(true);
    await browser.waitUntil(async () => {
      const m = (await migration()).migration;
      return m?.state === 'running' && m.done > held.done;
    }, { timeout: 30_000, interval: 200, timeoutMsg: 'Resume never moved the counts on' });
  });

  it('refuses to move the vault while the conversion is paused, in the catalog\'s words', async function () {
    expect(await clickChip('pause')).toBe(true);
    await browser.waitUntil(async () => (await chip())?.state === 'paused', {
      timeout: 30_000, interval: 200, timeoutMsg: 'the chip never said paused',
    });
    const status = await must('vault_get_status', invoke('vault_get_status', {}));
    const target = mkdtempSync(join(home, 'jmapmove-refused-'));
    work.push(target);
    await openTab('Backup & Restore', 'Backup Settings');
    expect(await browser.execute((p) => { window.__MV_VAULT_FOLDER__ = p; return window.__MV_VAULT_FOLDER__ === p; }, target)).toBe(true);
    try {
      expect(await clickLocationButton(EN.moveMail)).toBe(true);
      let ui = null;
      await browser.waitUntil(async () => { ui = await locationUi(); return !!ui?.error; }, {
        timeout: 60_000, interval: 300,
      }).catch(() => { throw new Error(`the move was never refused: ${JSON.stringify(ui)}`); });
      expect(ui.error).toBe(EN.moveBlocked);
      expect(ui.path).toBe(status.displayPath);
    } finally {
      await browser.execute(() => { delete window.__MV_VAULT_FOLDER__; });
    }
    // Still paused, still this job; the vault reopened under it.
    const m = (await migration()).migration;
    expect(m.state).toBe('paused');
    expect((await must('vault_get_status', invoke('vault_get_status', {}))).displayPath).toBe(status.displayPath);
    await closeSettings();
  });

  it('refuses to move the vault while the conversion runs: the job holds through the closed vault and carries on, nothing failed', async function () {
    // The shell closes the vault before it asks the daemon to move it and
    // reopens it on the refusal (src-tauri main.rs `vault_move_finish`). A
    // running job that meets the closed vault holds, and tries the same
    // message again once it is back: nothing is recorded as failed.
    const paused = (await migration()).migration;
    expect(paused.state).toBe('paused');
    const pid = daemonPid(home);
    const status = await must('vault_get_status', invoke('vault_get_status', {}));
    const target = mkdtempSync(join(home, 'jmapmove-running-'));
    work.push(target);
    const logCount = (line) => daemonLogText(home).split(line).length - 1;
    await openTab('Backup & Restore', 'Backup Settings');
    expect(await browser.execute((p) => { window.__MV_VAULT_FOLDER__ = p; return window.__MV_VAULT_FOLDER__ === p; }, target)).toBe(true);
    let before = null;
    let refusedAt = null;
    try {
      // Resumed only now, Settings already open, so the run spends little
      // time here (the chip's Resume has its own checks).
      await must('storage_format_resume', daemonRpc('storage_format_resume', {}));
      await browser.waitUntil(async () => {
        before = (await migration()).migration;
        return before?.state === 'running' && before.done > paused.done;
      }, { timeout: 30_000, interval: 100 }).catch(() => {
        throw new Error(`the resumed run never moved on: ${JSON.stringify(before)}`);
      });
      // Enough left that the run still goes when the refusal comes back.
      expect(before.done).toBeLessThan(before.total - 20);
      expect(before.failed).toBe(0);
      const closed = logCount('vault_close: closed');
      const reopened = logCount('vault_reopen: reopened');

      expect(await clickLocationButton(EN.moveMail)).toBe(true);
      let ui = null;
      await browser.waitUntil(async () => { ui = await locationUi(); return !!ui?.error; }, {
        timeout: 60_000, interval: 100,
      }).catch(() => { throw new Error(`the move was never refused: ${JSON.stringify(ui)}`); });
      refusedAt = (await migration()).migration;
      expect(ui.error).toBe(EN.moveBlocked);
      expect(ui.path).toBe(status.displayPath);

      // The same job in the same daemon, still running, nothing failed.
      expect(daemonPid(home)).toBe(pid);
      expect(refusedAt.jobId).toBe(before.jobId);
      expect(refusedAt.active).toBe(true);
      expect(refusedAt.state).toBe('running');
      expect(refusedAt.failed).toBe(0);
      // And it carries on past where the refusal found it.
      let m = null;
      await browser.waitUntil(async () => {
        m = (await migration()).migration;
        return m?.jobId === before.jobId && m.state === 'running' && m.failed === 0 && m.done > refusedAt.done;
      }, { timeout: 30_000, interval: 100 }).catch(() => {
        throw new Error(`the run never carried on after the refused move: ${JSON.stringify(m)} (at the refusal: ${JSON.stringify(refusedAt)})`);
      });
      // Held again for the cancel test, where the canary must still be to do.
      await must('storage_format_pause', daemonRpc('storage_format_pause', {}));

      // This press really closed the vault under the running job and reopened it (the log writer lags a little).
      await browser.waitUntil(() => logCount('vault_close: closed') > closed && logCount('vault_reopen: reopened') > reopened, {
        timeout: 20_000, interval: 300, timeoutMsg: 'daemon.log never showed the vault closed and reopened for the refused move',
      });
    } finally {
      await browser.execute(() => { delete window.__MV_VAULT_FOLDER__; });
    }
    const held = daemonLogText(home).includes(`[format_migration] job ${before.jobId}: the vault is out of reach; holding at`);
    console.log(`[jmap-format] move refused mid-run at ${refusedAt.done}/${refusedAt.total}; the job ${held ? 'held for the closed vault' : 'never met the closed vault (it closed and reopened within one pace)'}`);
    await browser.waitUntil(async () => (await chip())?.state === 'paused', {
      timeout: 30_000, interval: 200, timeoutMsg: 'the chip never said paused again',
    });
    expect((await must('vault_get_status', invoke('vault_get_status', {}))).displayPath).toBe(status.displayPath);
    await closeSettings();
  });

  it('a cancelled run offers Resume and Convert back; one stopped by an unreadable folder says so in Settings and on the chip', async function () {
    if (IS_WIN) {
      // chmod 000 does not make a folder unreadable on Windows: resume and finish.
      expect(await clickChip('resume')).toBe(true);
      return;
    }
    // The canary is yoda's, the last account in the job's order: still to do.
    const pending = (await migration()).migration;
    expect(pending.state).toBe('paused');
    expect(recordUids(folderOf('canary'))).toEqual([]);
    expect(curEntries(folderOf('canary')).length).toBe(CANARIES);

    expect(await clickChip('cancel')).toBe(true);
    await browser.waitUntil(async () => (await migration()).migration?.state === 'cancelled', {
      timeout: 30_000, interval: 200, timeoutMsg: 'Cancel never ended the run',
    });
    // A cancelled run has no chip; Settings carries it.
    await browser.waitUntil(async () => (await chip()) === null, { timeout: 10_000, interval: 200, timeoutMsg: 'the chip outlived the cancel' });
    await openTab('Storage');
    let ui = null;
    await browser.waitUntil(async () => { ui = await formatUi(); return !!ui?.migration; }, {
      timeout: 15_000, interval: 300,
    }).catch(() => { throw new Error(`Settings never showed the stopped run: ${JSON.stringify(ui)}`); });
    expect(ui.migration).toContain(EN.stoppedAt);
    expect(ui.current).toBe(EN.jmap); // nothing is rolled back: the vault keeps the target format
    const labels = ui.buttons.map((b) => b.text);
    expect(labels).toEqual(expect.arrayContaining([EN.resume, EN.convertBack]));

    // The canary unreadable, Resume plans again and stops at it.
    const folder = folderOf('canary');
    canaryMode = statSync(folder).mode & 0o7777;
    chmodSync(folder, 0o000);
    try {
      expect(await clickFormatButton(EN.resume)).toBe(true);
      await browser.waitUntil(async () => {
        const m = (await migration()).migration;
        return m?.state === 'failed' && m.active === false;
      }, { timeout: 60_000, interval: 300, timeoutMsg: 'the run never stopped at the unreadable folder' });
      const failed = (await migration()).migration;
      expect(String(failed.error)).toMatch(/^E_FORMAT_UNREADABLE:/);
      await browser.waitUntil(async () => { ui = await formatUi(); return (ui?.migration || '').includes(EN.failedLine); }, {
        timeout: 15_000, interval: 300,
      }).catch(() => { throw new Error(`Settings never said why the run stopped: ${JSON.stringify(ui)}`); });
      await closeSettings();
      let c = null;
      await browser.waitUntil(async () => { c = await chip(); return c?.state === 'failed'; }, {
        timeout: 15_000, interval: 200,
      }).catch(() => { throw new Error(`the chip never showed the failed run: ${JSON.stringify(c)}`); });
      expect(c.text).toContain(EN.chipFailed);
      expect(c.text).toContain(EN.failedLine);
      expect(c.controls).toContain('format-migration-resume');
      expect(c.controls).not.toContain('format-migration-cancel');
    } finally {
      chmodSync(folder, canaryMode);
      canaryMode = null;
    }
    // Readable again: the chip's Resume carries it on.
    expect(await clickChip('resume')).toBe(true);
  });

  it('finishes the run to JMAP: records hold the original bytes, the mid-run flag survived, the old files are kept aside', async function () {
    // Done means no message failed, the refused move's included: a run that
    // left one behind ends failed (E_FORMAT_UNVERIFIED), and finishRun throws.
    const end = await finishRun('to JMAP');
    expect(end.format).toBe('jmap');
    let c = null;
    await browser.waitUntil(async () => { c = await chip(); return c?.state === 'done'; }, {
      timeout: 15_000, interval: 200,
    }).catch(() => { throw new Error(`the chip never said done: ${JSON.stringify(c)}`); });
    expect(c.text).toContain(EN.chipDone);
    expect(c.done).toBe(c.total);
    expect(await clickChip('close')).toBe(true);

    for (const which of FOLDERS) {
      const folder = folderOf(which);
      expect(curEntries(folder)).toEqual([]);
      const want = snapshotUids(which);
      const records = recordUids(folder);
      expect(want.every((uid) => records.includes(uid))).toBe(true);
      if (which !== 'inbox') expect(sortNum(records)).toEqual(want);
      for (const uid of want) {
        const rec = readRecord(folder, uid);
        expect(rec.format).toBe('mailvault-jmap/1');
        expect(rec.uid).toBe(uid);
        const original = snapshot.get(`${which}:${uid}`).bytes;
        if (!blobBytes(root, rec.blob).equals(original)) {
          throw new Error(`${which} uid ${uid}: its blob is not the original message`);
        }
      }
    }
    expect(flagState(folderOf('local'), seedUid.get(3))).toEqual({ flagged: true, format: 'jmap' });

    const kept = await must('storage_format_retired', daemonRpc('storage_format_retired', {}));
    expect(kept.count).toBeGreaterThanOrEqual(snapshot.size);
    expect(existsSync(join(root, 'retired'))).toBe(true);

    await openTab('Storage');
    let ui = null;
    await browser.waitUntil(async () => { ui = await formatUi(); return ui?.current === EN.jmap && ui.migration === null && !!ui.retired; }, {
      timeout: 15_000, interval: 300,
    }).catch(() => { throw new Error(`Settings never showed the JMAP vault: ${JSON.stringify(ui)}`); });
    expect(ui.retired.startsWith(EN.retired)).toBe(true);
    expect(ui.buttons.map((b) => b.text)).toEqual(expect.arrayContaining([EN.convert, EN.retiredDelete, EN.reclaim]));
    await closeSettings();
  });

  it('in JMAP, search finds a body word, flag and unflag reach the record, delete bins it', async function () {
    // A message that only ever existed as a record: an import into a JMAP
    // vault writes the vault's format, and the index has to read it from
    // `jmap/<uid>.json`, a name no Maildir pass ever listed.
    const freshPath = join(mboxDir, 'format-fresh.mbox');
    writeFileSync(freshPath, mboxMessage({
      subject: 'JMAP format fresh 01', messageId: 'jmap-format-fresh-01@mock.test', token: 'JFMTFRESH01', minutesAgo: 1, now: Date.now(),
    }));
    const fresh = await must('import_mbox (fresh)', daemonRpc('import_mbox', { accountId: luke.id, sourcePath: freshPath, mode: 'folder' }));
    const freshFolder = join(root, 'Maildir', luke.id, fresh.folder.dir);
    expect(curEntries(freshFolder)).toEqual([]);
    expect(recordUids(freshFolder).length).toBe(1);
    let freshHits = [];
    await browser.waitUntil(async () => {
      freshHits = await localSearch('JFMTFRESH01');
      return freshHits.includes('JMAP format fresh 01');
    }, { timeout: 180_000, interval: 2000 }).catch(() => {
      throw new Error(`the local search never found a record-only message: ${JSON.stringify(freshHits)}`);
    });

    // And the converted ones, whose index rows were renamed.
    let hits = [];
    await browser.waitUntil(async () => {
      hits = await localSearch(tokenOf(7));
      return hits.includes(subjectOf(7));
    }, { timeout: 180_000, interval: 2000 }).catch(() => {
      throw new Error(`the local search never found ${tokenOf(7)}: ${JSON.stringify(hits)}`);
    });
    await clearSearch();

    await switchToFolder(LUKE, local.name);
    const r = await openTimed(subjectOf(7), tokenOf(7));
    if (r.error) throw new Error(`open after the conversion: ${r.error}`);
    touched.add(7);

    await openTimed(subjectOf(6), tokenOf(6));
    await toggleFlagOnDisk(6, true);
    expect(flagState(folderOf('local'), seedUid.get(6)).format).toBe('jmap');
    await toggleFlagOnDisk(6, false);

    deletedSeed = 8;
    const uid = seedUid.get(deletedSeed);
    await openTimed(subjectOf(deletedSeed), tokenOf(deletedSeed));
    expect(await selectedSubject()).toBe(subjectOf(deletedSeed));
    await shortcut('#');
    await browser.waitUntil(() => !uidSet(folderOf('local')).includes(uid), {
      timeout: 20_000, interval: 200, timeoutMsg: `seed ${pad(deletedSeed)} (uid ${uid}) never left the vault`,
    });
    const bin = await must('deleted.list', daemonRpc('deleted.list', {}));
    const binned = bin.filter((d) => String(d.messageId || '').replace(/[<>]/g, '') === messageIdOf(deletedSeed));
    expect(binned.length).toBe(1);
    snapshot.delete(`local:${uid}`);
    await browser.waitUntil(async () => (await storeRowCount()) === SEEDS - 1, {
      timeout: 20_000, interval: 300, timeoutMsg: 'the deleted row never left the list',
    });
  });

  it('in JMAP, a backup mirrors .eml files with the original bytes', async function () {
    const backupRoot = mkdtempSync(join(tmpdir(), 'mv-jmap-format-backup-'));
    work.push(backupRoot);
    await must('backup_save_external_location', invoke('backup_save_external_location', { path: backupRoot }));
    // skipFolders past luke's server folders: only the local pass runs, into a temp dir of this spec's own.
    const result = await runBackupAndWait({ accountId: luke.id, accountJson: JSON.stringify(luke), backupPath: null, skipFolders: 999 });
    expect(result.success).toBe(true);

    const mirrorCur = join(backupRoot, LUKE, `${local.dir} (${local.created})`, 'cur');
    const names = existsSync(mirrorCur) ? readdirSync(mirrorCur) : [];
    expect(names.length).toBe(SEEDS - 1);
    for (const name of names) {
      expect(name.endsWith('.eml')).toBe(true);
      const uid = Number(name.match(/^(\d+)/)?.[1]);
      const original = snapshot.get(`local:${uid}`);
      if (!original) throw new Error(`the mirror holds ${name}, which the vault never had`);
      if (!readFileSync(join(mirrorCur, name)).equals(original.bytes)) throw new Error(`mirror ${name}: not the original bytes`);
    }
  });

  it('in JMAP, View Source shows the original bytes', async function () {
    await switchToFolder(LUKE, local.name);
    const r = await openTimed(subjectOf(4), tokenOf(4));
    if (r.error) throw new Error(`open for View Source: ${r.error}`);
    touched.add(4);
    const clickIn = (label) => browser.execute((l) => {
      const header = document.querySelector('[data-testid="sender-header"]');
      const b = [...(header?.querySelectorAll('button') || [])].find((x) => x.offsetHeight > 0 && (x.textContent || '').trim() === l);
      if (!b) return false;
      b.click();
      return true;
    }, label);
    expect(await browser.execute(() => {
      const b = document.querySelector('[data-testid="sender-header"] [data-testid="header-toggle"]');
      if (!b) return false;
      if (b.getAttribute('aria-expanded') !== 'true') b.click();
      return true;
    })).toBe(true);
    await browser.waitUntil(() => clickIn('More'), { timeout: 10_000, interval: 200, timeoutMsg: 'the header never offered More' });
    await browser.waitUntil(() => clickIn('View Source'), { timeout: 10_000, interval: 200, timeoutMsg: 'the header never offered View Source' });
    const wantId = `Message-ID: <${messageIdOf(4)}>`;
    let shown = null;
    await browser.waitUntil(async () => {
      shown = await browser.execute((id) => {
        const pre = [...document.querySelectorAll('pre')].find((p) => (p.textContent || '').includes(id));
        return pre ? pre.textContent : null;
      }, wantId);
      return shown !== null;
    }, { timeout: 15_000, interval: 200, timeoutMsg: 'View Source never showed the message' });
    const original = snapshot.get(`local:${seedUid.get(4)}`).bytes.toString('latin1');
    expect(shown.replace(/\r\n/g, '\n')).toBe(original.replace(/\r\n/g, '\n'));
  });

  it('in JMAP, Reclaim space removes nothing: every blob is named or inside its grace', async function () {
    await openTab('Storage');
    expect(await clickFormatButton(EN.reclaim)).toBe(true);
    // The button gives no success line (StorageFormatSettings `act`); a refusal would show an alert.
    await browser.pause(1500);
    expect((await formatUi()).alert).toBe(null);
    await closeSettings();
    const swept = await must('storage_reclaim_space', daemonRpc('storage_reclaim_space', {}));
    expect(swept.removed).toBe(0);
    jmapSets = seededSets();
  });

  it('moves the JMAP vault to another folder through Settings, and back: JMAP still, every record there, a message opens', async function () {
    const status = await must('vault_get_status', invoke('vault_get_status', {}));
    expect(status.isCustom).toBe(false);
    const target = mkdtempSync(join(home, 'jmapmove-'));
    work.push(target);

    const moveThroughSettings = async (act, wantCustom) => {
      const pid = daemonPid(home);
      await act();
      let st = null;
      await browser.waitUntil(async () => {
        const r = await invoke('vault_get_status', {});
        st = r.ok ? r.v : null;
        const ui = await locationUi();
        return st?.isCustom === wantCustom && !ui?.error;
      }, { timeout: 180_000, interval: 500 }).catch(async () => {
        throw new Error(`the move never finished: status ${JSON.stringify(st)}, ui ${JSON.stringify(await locationUi())}`);
      });
      // A move restarts the daemon on the new root.
      await browser.waitUntil(() => { const p = daemonPid(home); return p > 0 && p !== pid; }, {
        timeout: 60_000, interval: 300, timeoutMsg: 'the daemon never restarted after the move',
      });
      await browser.waitUntil(async () => (await daemonRpc('storage_format_get', {})).ok, {
        timeout: 60_000, interval: 500, timeoutMsg: 'the restarted daemon never answered',
      });
      return st;
    };

    await openTab('Backup & Restore', 'Backup Settings');
    expect(await browser.execute((p) => { window.__MV_VAULT_FOLDER__ = p; return window.__MV_VAULT_FOLDER__ === p; }, target)).toBe(true);
    let moved;
    try {
      moved = await moveThroughSettings(() => clickLocationButton(EN.moveMail).then((ok) => expect(ok).toBe(true)), true);
    } finally {
      await browser.execute(() => { delete window.__MV_VAULT_FOLDER__; });
    }
    const oldRoot = root;
    root = target;
    // The shell may spell the folder through /private on macOS: compare where both lead.
    expect(realpathSync(moved.displayPath)).toBe(realpathSync(target));
    expect((await migration()).format).toBe('jmap');
    expect(seededSets(target)).toEqual(jmapSets);
    for (const which of FOLDERS) {
      expect(curEntries(folderOf(which))).toEqual([]);
      expect(existsSync(folderOf(which, oldRoot))).toBe(false);
    }
    expect(existsSync(join(target, 'message_blobs'))).toBe(true);
    expect(existsSync(join(target, 'retired'))).toBe(true);
    await closeSettings();

    await reloadApp();
    await switchToFolder(LUKE, local.name);
    expect(await storeRowCount()).toBe(SEEDS - 1);
    const r = await openTimed(subjectOf(9), tokenOf(9));
    if (r.error) throw new Error(`open after the move: ${r.error}`);
    touched.add(9);

    // And back to the app's own storage, the same way.
    await openTab('Backup & Restore', 'Backup Settings');
    const back = await moveThroughSettings(async () => {
      expect(await clickLocationButton(EN.resetToDefault)).toBe(true);
      await browser.waitUntil(() => clickLocationButton(EN.moveMailBack), {
        timeout: 10_000, interval: 200, timeoutMsg: 'the reset never offered Move mail back',
      });
    }, false);
    root = oldRoot;
    expect(back.displayPath).toBe(status.displayPath);
    expect((await migration()).format).toBe('jmap');
    expect(seededSets()).toEqual(jmapSets);
    expect(existsSync(join(root, 'retired'))).toBe(true);
    await closeSettings();
    await reloadApp();
  });

  it('converts back to Maildir; killed mid-run, the respawned daemon carries it on and the chip shows it', async function () {
    const before = seededSets();
    await settleVault();
    await startConversion(EN.maildir);
    await waitChipRunning(1, 'the chip never showed the reverse run');

    await switchToFolder(LUKE, local.name);
    await openUnderBudget(5, 'to Maildir, mid-run');
    // Unflagged mid-run, in the other direction.
    await openUnderBudget(3, 'to Maildir, mid-run');
    await toggleFlagOnDisk(3, false);

    // Killed early enough that the run is still going after the respawn, the
    // two waits below and the page reload (about 80 ms a message): 60 left.
    const pre = (await migration()).migration;
    expect(pre.state).toBe('running');
    if (pre.done >= pre.total - 60) {
      throw new Error(`the run got past the kill margin before the kill: ${pre.done} of ${pre.total} done, 60 must be left (it outran the kill test: raise MAILVAULT_E2E_FORMAT_MESSAGE_PAUSE_MS in wdio.conf.js)`);
    }
    const oldPid = daemonPid(home);
    expect(oldPid).toBeGreaterThan(0);
    daemonExecutable(oldPid); // throws unless that pid is a mailvault-daemon
    const killedAt = Date.now();
    process.kill(oldPid, 'SIGKILL');
    await browser.waitUntil(() => { const p = daemonPid(home); return p > 0 && p !== oldPid; }, {
      timeout: 60_000, interval: 250, timeoutMsg: 'no daemon came back after the kill',
    });
    // The new daemon carried the job on by itself (`resume_journaled`) and moved it past where the kill left it.
    let m = null;
    await browser.waitUntil(async () => {
      const r = await daemonRpc('storage_format_get', {});
      m = r.ok ? r.v.migration : null;
      return m?.active === true && m.state === 'running' && m.done > pre.done;
    }, { timeout: 60_000, interval: 250 }).catch(() => {
      throw new Error(`the respawned daemon never carried the run on: ${JSON.stringify(m)}`);
    });
    // Anti-vacuity: the new daemon's own start carried it on (the log writer lags a little).
    await browser.waitUntil(() => daemonLogText(home).includes('[format_migration] carried on after a restart'), {
      timeout: 20_000, interval: 300, timeoutMsg: 'daemon.log never said the run was carried on after the restart',
    });
    console.log(`[jmap-format] killed at ${pre.done}/${pre.total}; carried on at ${m.done}/${m.total}, ${Date.now() - killedAt} ms later`);

    // The shell's relaunch: a fresh page asks the daemon and shows the job again.
    await reloadApp();
    const now = (await migration()).migration;
    // Loud, never skipped: a run that finished before the reload settled would
    // check nothing here, so it fails and names the race (raise the pace in
    // wdio.conf.js MAILVAULT_E2E_FORMAT_MESSAGE_PAUSE_MS, or the kill margin).
    if (now === null) {
      throw new Error('the run was already gone when the page reloaded: it outran the kill test, so the chip after the relaunch could not be checked');
    }
    let c = null;
    await browser.waitUntil(async () => { c = await chip(); return c?.state === 'running' || c?.state === 'done'; }, {
      timeout: 20_000, interval: 200,
    }).catch(() => { throw new Error(`after the reload the chip never showed the run: ${JSON.stringify(c)} (daemon: ${JSON.stringify(now)})`); });
    const end = await finishRun('to Maildir');
    expect(end.format).toBe('maildir');

    // No seeded message lost or doubled: the same uids, each in one file, no record left.
    expect(seededSets()).toEqual(before);
    for (const which of FOLDERS) {
      expect(recordUids(folderOf(which))).toEqual([]);
      const files = curEntries(folderOf(which));
      expect(files.length).toBe(new Set(files.map((f) => f.uid)).size);
      expect(snapshotUids(which).every((uid) => files.some((f) => f.uid === uid))).toBe(true);
    }
    await switchToFolder(LUKE, local.name);
    expect(await storeRowCount()).toBe(SEEDS - 1);
  });

  it('round trip: every seeded message is back byte for byte, under its uid, with its flag letters', async function () {
    for (const which of FOLDERS) {
      for (const f of curEntries(folderOf(which))) {
        const original = snapshot.get(`${which}:${f.uid}`);
        if (!original && which === 'inbox') continue; // a body the app cached after the snapshot
        if (!original) throw new Error(`${which} uid ${f.uid}: not a seeded message`);
        if (!readFileSync(f.path).equals(original.bytes)) throw new Error(`${which} uid ${f.uid}: not the original bytes`);
        const seed = which === 'local' ? [...seedUid].find(([, uid]) => uid === f.uid)?.[0] : null;
        // Opening may add S; flag and unflag left them where they were, but S is the read state, not ours.
        if (seed != null && touched.has(seed)) {
          expect(f.flags.replace(/S/g, '')).toBe(original.flags.replace(/S/g, ''));
        } else {
          expect(f.flags).toBe(original.flags);
        }
      }
    }
    expect(flagState(folderOf('local'), seedUid.get(3)).flagged).toBe(false);
  });

  it('deletes the old files: retired/ is gone, and Reclaim space removes nothing', async function () {
    await openTab('Storage');
    let ui = null;
    await browser.waitUntil(async () => { ui = await formatUi(); return ui?.current === EN.maildir && !!ui.retired; }, {
      timeout: 15_000, interval: 300,
    }).catch(() => { throw new Error(`Settings never offered the old files: ${JSON.stringify(ui)}`); });
    expect(await clickFormatButton(EN.retiredDelete)).toBe(true);
    await browser.waitUntil(() => browser.execute((label) => {
      const d = document.querySelector('[role="alertdialog"]');
      const b = [...(d?.querySelectorAll('button') || [])].find((x) => !x.disabled && (x.textContent || '').trim() === label);
      if (!b) return false;
      b.click();
      return true;
    }, EN.deletePermanently), { timeout: 10_000, interval: 200, timeoutMsg: 'the delete confirmation never showed' });
    await browser.waitUntil(async () => { ui = await formatUi(); return ui && ui.retired === null; }, {
      timeout: 60_000, interval: 300,
    }).catch(() => { throw new Error(`the old files row never went: ${JSON.stringify(ui)}`); });
    expect(ui.alert).toBe(null);
    // The convert back left the blobs inside their 24 h grace: Reclaim stays offered in Maildir format.
    expect(existsSync(join(root, 'message_blobs'))).toBe(true);
    expect(ui.buttons.map((b) => b.text)).toEqual(expect.arrayContaining([EN.reclaim]));
    await closeSettings();

    expect(existsSync(join(root, 'retired'))).toBe(false);
    expect(await must('storage_format_retired', daemonRpc('storage_format_retired', {}))).toEqual({ bytes: 0, count: 0 });
    // Every blob is inside its grace: nothing goes, and the store stays.
    const swept = await must('storage_reclaim_space', daemonRpc('storage_reclaim_space', {}));
    expect(swept.removed).toBe(0);
    expect(existsSync(join(root, 'message_blobs'))).toBe(true);
  });
});
