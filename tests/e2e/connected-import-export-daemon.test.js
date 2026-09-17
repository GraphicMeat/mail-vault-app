/**
 * E2E: backup ZIP export/import and mbox export/import genuinely run in the
 * daemon (Task 4.10, covering Tasks 4.3-4.6's cutover). No e2e coverage
 * existed for any of these four commands before this file (Task 4.0's
 * confirmed-empty grep) -- this is from-scratch coverage, not a fix.
 *
 * ── The one native surface this harness cannot drive ───────────────────────
 * `doExport`/`handleImportData`/`handleExportMbox`/`handleImportMbox`
 * (BackupRestore.jsx) all open a REAL native macOS save/open panel via
 * `@tauri-apps/plugin-dialog` before calling `send('export_backup', ...)` etc.
 * wry/tauri-driver cannot click a native OS panel, and clicking through to
 * one from this suite would hang the run waiting on a modal nothing can
 * dismiss. Three separate attempts at intercepting the JS-side IPC bridge
 * instead all failed: neither a plain assignment nor `Object.defineProperty`
 * can override `window.__TAURI_INTERNALS__.invoke` itself, and replacing the
 * WHOLE `window.__TAURI_INTERNALS__` window property with a Proxy also
 * silently fails to stick (confirmed each time by an explicit readback
 * check, not assumed) -- the property is locked down at the window-binding
 * level in this Tauri build, not just on the object Tauri hands out.
 *
 * This file therefore clicks the "Export Backup" button (real UI, proves the
 * button and its confirmation dialog render) and stops there rather than
 * clicking through to the native panel; every actual export/import
 * operation is driven the same way the migration and restore daemon
 * commands prove their non-UI-reachable paths (cancel, pause) -- a direct
 * `daemon_rpc` call against the real running daemon binary, asserting on
 * the real `export-progress`/`import-progress`/`mbox-*-progress` events
 * over the real channel via `window.__TAURI__.event.listen` (not app
 * state). Everything downstream of the picker -- the real daemon RPC, the
 * real file I/O, the real channel events -- is exercised exactly as
 * production code would run it; only the native file-picker click itself is
 * out of reach. `db.ensureAccountsInFile` (the app's own JS write that
 * `import_backup`'s handler depends on for decision 2, "accounts.json stays
 * app-only") is proven by the project's own unit test
 * (`backupRestoreImportAccountsMerge.test.jsx`, from Task 4.4) driving the
 * real component in isolation; this file proves the other half -- that the
 * daemon route itself never touches accounts.json -- end to end against the
 * real running binary.
 *
 * ── Decision 2 (accounts.json stays app-only), the daemon half ─────────────
 * A direct `import_backup` daemon_rpc call for an ALREADY-known account
 * (zero new accounts in the result) is exactly where a daemon-side write
 * would fire if one existed -- snapshot `accounts.json`'s mtime and bytes,
 * fire the call, assert both are unchanged. The same check Task 4.3's own
 * `import_backup_never_touches_accounts_json_on_disk` unit test makes,
 * replayed here against the real daemon binary, not just the route function
 * in isolation.
 *
 * ── Decision 3 (the archived-flag fix) regression, made real ───────────────
 * `import_mbox` imports a message with no flags at all before this phase's
 * fix -- `vault_files::clear_cache` deletes anything without `"archived"`.
 * This file imports a real MBOX via the real daemon RPC, reads the written
 * filename's flag letter directly (verified against
 * `src-core/src/vault_files.rs`'s `"archived" | "a" => flag_chars.push('A')`,
 * not assumed), then calls the real `maildir_clear_cache` daemon RPC and
 * proves the file survives -- the concrete, load-bearing regression test the
 * plan calls for, not a filename-shape check alone.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitForApp, waitForEmails } from './helpers.js';
import { openTab } from './mockBilling.js';
import { appDataDir } from './mockImap.js';

const LUKE = 'luke@mock.test';
const NEW_ACCOUNT_EMAIL = 'imported-new-account@mock.test';

// ── Raw bridges: daemon_rpc, pid ─────────────────────────────────────────

// `__error`, not `error`: an `executeAsync` result object carrying a bare
// `error` key is treated by webdriverio's client as a FAILED protocol
// response (silently retried, then thrown) rather than a normal return
// value -- connected-daemon-channel.test.js's own documented trap. This bites
// hardest exactly where it matters here: a negative test whose whole point
// is a genuinely failing daemon_rpc call.
const daemonRpc = (method, params) => browser.executeAsync((m, p, done) => {
  try {
    window.__TAURI_INTERNALS__.invoke('daemon_rpc', { method: m, params: p })
      .then((v) => done({ ok: true, v }), (e) => done({ ok: false, __error: String((e && e.message) || e) }));
  } catch (e) {
    done({ ok: false, __error: String((e && e.message) || e) });
  }
}, method, params);

const daemonPid = (home) => {
  try { return parseInt(readFileSync(join(appDataDir(home), 'daemon.pid'), 'utf8').trim(), 10) || null; } catch { return null; }
};

/** `window.__TAURI__.event.listen`, independent of any component's own React
 *  state -- the same technique `connected-archive-daemon.test.js` uses to
 *  prove events travel the real channel, not just that the feature "works". */
async function installRawCapture(names) {
  await browser.executeAsync((eventNames, done) => {
    window.__IE_DAEMON_EVENTS__ = [];
    Promise.all(eventNames.map((name) =>
      window.__TAURI__.event.listen(name, (e) => window.__IE_DAEMON_EVENTS__.push({ name, payload: e.payload, at: Date.now() }))))
      .then(() => done(true), () => done(false));
  }, names);
}
const rawEvents = (name) => browser.execute((n) => (window.__IE_DAEMON_EVENTS__ || []).filter((e) => e.name === n), name);

// ── Click helpers (matching connected-archive-daemon.test.js's style) ──────

const clickByText = (selector, text) => browser.execute((sel, needle) => {
  for (const el of document.querySelectorAll(sel)) {
    if ((el.textContent || '').trim().startsWith(needle) && el.offsetHeight > 0 && !el.disabled) { el.click(); return true; }
  }
  return false;
}, selector, text);

async function clickButton(text) {
  await browser.waitUntil(() => clickByText('button', text), {
    timeout: 15_000, interval: 300, timeoutMsg: `button "${text}" never became clickable`,
  });
}

// ── Fixture builders (plain files + the system `zip` CLI -- no new npm dep;
//    matches `mailvault-backup/manifest.json` + `mailvault-backup/emails/<email>/<mailbox>/<uid>:2,<flags>.eml`,
//    the exact layout `backup_zip.rs`'s own Rust tests build with `zip::ZipWriter`) ──

function buildBackupZip(destZipPath, { accountEmail, mailbox, files }) {
  const staging = mkdtempSync(join(tmpdir(), 'mv-backup-fixture-'));
  try {
    const root = join(staging, 'mailvault-backup');
    const emailsDir = join(root, 'emails', accountEmail, mailbox);
    mkdirSync(emailsDir, { recursive: true });
    for (const f of files) writeFileSync(join(emailsDir, f.name), f.body);
    writeFileSync(join(root, 'manifest.json'), JSON.stringify({
      version: 2, exportedAt: new Date().toISOString(), accounts: [{ email: accountEmail }], settings: null,
    }));
    execFileSync('zip', ['-rq', destZipPath, 'mailvault-backup'], { cwd: staging });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function emlBody(subject, msgId) {
  return [
    'From: Fixture <fixture@mock.test>',
    `To: ${LUKE}`,
    `Subject: ${subject}`,
    'Date: Thu, 01 Jan 2026 12:00:00 +0000',
    `Message-ID: <${msgId}@mock.test>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    `${subject} - body`,
    '',
  ].join('\r\n');
}

function readAccountsJson(home) {
  const p = join(appDataDir(home), 'accounts.json');
  if (!existsSync(p)) return [];
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return []; }
}

describe('Backup ZIP and MBOX import/export through the daemon (Task 4.10)', function () {
  this.timeout(240_000);

  let lukeId = null;
  let pidBefore = null;
  let workDir = null;

  before(async function () {
    await waitForApp();
    await waitForEmails();
    lukeId = (browser.mockAccounts || []).find((a) => a.email === LUKE)?.id;
    expect(lukeId).toBeTruthy();

    pidBefore = daemonPid(browser.testDataDir);
    expect(pidBefore).toBeGreaterThan(0);

    workDir = mkdtempSync(join(tmpdir(), 'mv-import-export-e2e-'));

    await installRawCapture(['export-progress', 'import-progress', 'mbox-export-progress', 'mbox-import-progress']);
    await openTab('Backup & Restore');
  });

  after(async function () {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  afterEach(async function () {
    if (this.currentTest?.state !== 'failed') return;
    try {
      const diag = await browser.execute(() => ({
        bodyText: (document.body.innerText || '').slice(0, 500),
      }));
      console.log(`[connected-import-export-daemon] diagnostic for "${this.currentTest.title}":`, JSON.stringify(diag));
    } catch (e) {
      console.log('[connected-import-export-daemon] diagnostic capture itself failed:', e.message);
    }
  });

  it('(a) "Export Backup" renders its confirmation dialog through the real UI, and export_backup genuinely runs in the daemon with export-progress reaching the frontend over the channel', async function () {
    // As far as this harness can click: the button, and the dialog it opens
    // (proving BackupRestore.jsx's own render path), stopping short of the
    // native save panel neither wry nor tauri-driver can drive.
    await clickButton('Export Backup');
    await browser.waitUntil(() => browser.execute(() => document.body.innerText.includes('Choose a location')), {
      timeout: 15_000, interval: 300, timeoutMsg: 'Export confirmation dialog never rendered',
    });
    await clickButton('Cancel');

    const dest = join(workDir, 'export-a.zip');
    const resp = await daemonRpc('export_backup', {
      destPath: dest, archivedOnly: false, settingsJson: '{}', accountsJson: JSON.stringify(readAccountsJson(browser.testDataDir)),
    });
    expect(resp.ok).toBe(true);
    expect(existsSync(dest)).toBe(true);

    // The event must have genuinely traveled the channel (daemon bus ->
    // daemon_channel -> app.emit -> frontend listen), not merely have been
    // computed by React from the RPC's own return value.
    const events = await rawEvents('export-progress');
    expect(events.length).toBeGreaterThan(0);
    const last = events[events.length - 1];
    expect(last.payload.active).toBe(false);
  });

  it('(b) import_backup lands a brand-new account\'s files under the gate with correct flags (the JS write into accounts.json is proven separately by backupRestoreImportAccountsMerge.test.jsx)', async function () {
    const newZip = join(workDir, 'new-account.zip');
    buildBackupZip(newZip, {
      accountEmail: NEW_ACCOUNT_EMAIL,
      mailbox: 'INBOX',
      files: [{ name: '1:2,A.eml', body: emlBody('Imported new-account message', 'new-account-1') }],
    });

    const resp = await daemonRpc('import_backup', { sourcePath: newZip });
    expect(resp.ok).toBe(true);
    expect(resp.v.newAccounts.length).toBe(1);
    const newAccount = resp.v.newAccounts[0];
    expect(newAccount.email).toBe(NEW_ACCOUNT_EMAIL);
    expect(typeof newAccount.id).toBe('string');
    expect(newAccount.id.length).toBeGreaterThan(0);

    const cur = join(appDataDir(browser.testDataDir), 'Maildir', newAccount.id, 'INBOX', 'cur');
    await browser.waitUntil(() => existsSync(cur) && readdirSync(cur).some((n) => n.startsWith('1:')), {
      timeout: 15_000, interval: 300, timeoutMsg: `imported file for the new account never reached ${cur}`,
    });
    const names = readdirSync(cur);
    const written = names.find((n) => n.startsWith('1:'));
    // Round-trip, byte-for-byte: import_backup preserves whatever flags the
    // exported filename already carried (decision 3's note that this path
    // needs no fix, unlike import_mbox).
    expect(written).toContain(':2,A');

    const events = await rawEvents('import-progress');
    expect(events.some((e) => e.payload.active === false)).toBe(true);
  });

  it('(c) the daemon route itself never touches accounts.json', async function () {
    // A second import of the SAME already-known account (from test (b))
    // discovers zero new accounts, so if the daemon write path exists at
    // all, this is exactly where it would fire.
    const repeatZip = join(workDir, 'repeat-known-account.zip');
    buildBackupZip(repeatZip, {
      accountEmail: LUKE,
      mailbox: 'INBOX',
      files: [{ name: '999001:2,A.eml', body: emlBody('Repeat known-account message', 'repeat-known-1') }],
    });

    const accountsPath = join(appDataDir(browser.testDataDir), 'accounts.json');
    const beforeMtime = statSync(accountsPath).mtimeMs;
    const beforeBytes = readFileSync(accountsPath);

    const resp = await daemonRpc('import_backup', { sourcePath: repeatZip });
    expect(resp.ok).toBe(true);
    expect(resp.v.newAccounts.length).toBe(0);

    const afterMtime = statSync(accountsPath).mtimeMs;
    const afterBytes = readFileSync(accountsPath);
    expect(afterMtime).toBe(beforeMtime);
    expect(Buffer.compare(beforeBytes, afterBytes)).toBe(0);
  });

  it('(d) exports and imports a MBOX file through the daemon, with mbox-export-progress/mbox-import-progress reaching the frontend', async function () {
    const dest = join(workDir, 'export-d.mbox');
    // export_mbox_all exports every account's messages into one file (no
    // accountId param -- mbox.rs's own route only reads destPath/archivedOnly).
    const exportResp = await daemonRpc('export_mbox_all', { destPath: dest, archivedOnly: false });
    expect(exportResp.ok).toBe(true);
    expect(existsSync(dest)).toBe(true);
    expect((await rawEvents('mbox-export-progress')).some((e) => e.payload.active === false)).toBe(true);

    // Import it straight back into the same account/mailbox.
    const importResp = await daemonRpc('import_mbox', { accountId: lukeId, mailbox: 'INBOX', sourcePath: dest });
    expect(importResp.ok).toBe(true);
    // No file-content assertion here: (e) below does the load-bearing,
    // flag-specific mbox-import regression against a hand-built fixture with
    // a known single message, so this step only proves the round trip and
    // the channel event.
    expect((await rawEvents('mbox-import-progress')).some((e) => e.payload.active === false)).toBe(true);
  });

  it('(e) THE ARCHIVED-FLAG REGRESSION: an mbox-imported message carries the A flag and survives maildir_clear_cache', async function () {
    const mboxPath = join(workDir, 'archived-flag.mbox');
    const subject = 'MBOX archived-flag regression message';
    writeFileSync(mboxPath, [
      'From fixture@mock.test Thu Jan 01 12:00:00 2026',
      'From: fixture@mock.test',
      `To: ${LUKE}`,
      `Subject: ${subject}`,
      'Date: Thu, 01 Jan 2026 12:00:00 +0000',
      'Message-ID: <archived-flag-regression@mock.test>',
      '',
      `${subject} - body`,
      '',
      '',
    ].join('\n'));

    const importResp = await daemonRpc('import_mbox', { accountId: lukeId, mailbox: 'INBOX', sourcePath: mboxPath });
    expect(importResp.ok).toBe(true);
    await browser.waitUntil(async () => (await rawEvents('mbox-import-progress')).some((e) => e.payload.active === false), {
      timeout: 30_000, interval: 300, timeoutMsg: 'mbox-import-progress never reported completion for the archived-flag fixture',
    });

    const cur = join(appDataDir(browser.testDataDir), 'Maildir', lukeId, 'INBOX', 'cur');
    let written = null;
    await browser.waitUntil(() => {
      const names = existsSync(cur) ? readdirSync(cur) : [];
      written = names.find((n) => n.includes('archived-flag-regression') || false);
      // The mbox importer assigns its own local uid (max local uid + 1), not
      // a value this test controls -- find the newest file instead.
      if (!written && names.length) {
        written = names.map((n) => ({ n, t: statSync(join(cur, n)).mtimeMs })).sort((a, b) => b.t - a.t)[0]?.n;
      }
      return !!written;
    }, { timeout: 15_000, interval: 300, timeoutMsg: `no file appeared under ${cur} for the archived-flag fixture` });

    // Verified against src-core/src/vault_files.rs's own flag_chars mapping
    // ("archived" | "a" => flag_chars.push('A')) rather than assumed.
    expect(written).toMatch(/:2,[A-Za-z]*A[A-Za-z]*\.eml$/);

    const before = readdirSync(cur).length;
    const cleared = await daemonRpc('maildir_clear_cache', { accountId: lukeId, mailbox: 'INBOX' });
    expect(cleared.ok).toBe(true);

    const after = existsSync(cur) ? readdirSync(cur) : [];
    expect(after).toContain(written);
    expect(after.length).toBe(before);
  });

  it('(f) daemon.pid never changed across the whole run', function () {
    const pidAfter = daemonPid(browser.testDataDir);
    expect(pidAfter).toBeGreaterThan(0);
    expect(pidAfter).toBe(pidBefore);
  });

  it('(g) NEGATIVE: with no daemon connection, export_backup reports errors.daemonUnavailable instead of hanging, and no export-progress arrives', async function () {
    const before = daemonPid(browser.testDataDir);
    expect(before).toBeGreaterThan(0);
    let fullCmd;
    try {
      fullCmd = execFileSync('ps', ['-p', String(before), '-o', 'command='], { encoding: 'utf8' }).trim();
    } catch {
      throw new Error(`daemon.pid names ${before} but no such process exists; refusing to kill by name`);
    }
    if (!fullCmd.includes('mailvault-daemon')) {
      throw new Error(`daemon.pid names ${before} but its command line ("${fullCmd}") is not mailvault-daemon; refusing to touch it`);
    }
    // The FIRST token is the executable path: `ensure_daemon_socket`
    // (src-tauri/src/main.rs) spawns it with `Command::new(&daemon_bin)` and
    // no arguments.
    const binPath = fullCmd.split(/\s+/)[0];
    const hiddenPath = `${binPath}.e2e-hidden`;

    const eventsBefore = (await rawEvents('export-progress')).length;

    // A plain SIGKILL-then-immediately-retry is NOT a reliable "no daemon"
    // window: `daemon_rpc` (main.rs) calls `ensure_daemon_running` on its own
    // slow path, which RESPAWNS the daemon on demand, synchronously, inside
    // the very same call that discovers it dead -- self-healing before this
    // test could ever observe a failure (confirmed by a first attempt at this
    // test: `resp.ok` came back `true`). Renaming the binary aside first
    // makes the respawn attempt itself fail ("mailvault-daemon binary not
    // found", `find_daemon_binary` returns `None`) -- a real, deterministic
    // daemonUnavailable window instead of a race against the reconnect loop.
    renameSync(binPath, hiddenPath);
    try {
      process.kill(before, 'SIGKILL');
      const dest = join(workDir, 'never-written.zip');
      const resp = await daemonRpc('export_backup', {
        destPath: dest, archivedOnly: false, settingsJson: '', accountsJson: '[]',
      });
      expect(resp.ok).toBe(false);
      // `errors.daemonUnavailable` is the literal marker string `daemon_rpc`
      // (Rust) returns for every pre-response failure -- main.rs's own
      // `DAEMON_UNAVAILABLE` const, text-matched by the frontend classifier.
      expect(resp.__error).toContain('errors.daemonUnavailable');
      expect(existsSync(dest)).toBe(false);
      expect((await rawEvents('export-progress')).length).toBe(eventsBefore);
    } finally {
      renameSync(hiddenPath, binPath);
    }

    // Leave the shared runner in a working state for whatever spec file
    // (in this run or the next) uses this same app+daemon session next --
    // the app's own daemon_channel reconnect loop (proven end to end by
    // connected-daemon-channel.test.js) respawns it on its own now that the
    // binary is back.
    let after = null;
    await browser.waitUntil(() => {
      after = daemonPid(browser.testDataDir);
      return after !== null && after !== before;
    }, { timeout: 30_000, interval: 250, timeoutMsg: `daemon.pid never changed from ${before} after restoring the binary (last read: ${after})` });
  });
});
