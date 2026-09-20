/**
 * E2E: restoring local vault mail to a server genuinely runs in the daemon
 * (Task 4.10, covering Task 4.7/4.8's cutover of the 3 restore commands). No
 * e2e coverage existed for any of them before this file (Task 4.0's
 * confirmed-empty grep).
 *
 * ── Why Drafts, and why it stays empty until this file seeds it ────────────
 * `restore.rs`'s `run_restore` re-uploads local `.eml` files over IMAP
 * APPEND to a real mailbox on the target account's real server -- running it
 * against INBOX (or any folder another spec reads) would permanently add
 * messages to a shared fixture, the same isolation problem
 * `connected-migration-daemon.test.js` documents for migration. Drafts is
 * empty in every mock account's fixture by construction
 * (`connected-vault-move-daemon.test.js`'s own comment: "Drafts starts empty
 * in the fixture") and nothing else in this suite writes to it, so it is
 * this file's dedicated, self-cleaning target: local `.eml` files are seeded
 * directly through `maildir_store` (Task 2.8's daemon-owned vault writer,
 * the same primitive `connected-vault-move-daemon.test.js` uses to seed a
 * draft) with uids far outside any synced range, and every uploaded message
 * is deleted from the server in `after()`.
 *
 * ── Why test (a) drives the real UI and (b) does not ───────────────────────
 * `RestoreModal` never opens on its own in this harness: the real detection
 * path (`restoreDetection.js`'s `checkRestoreNeeded`) only fires after an
 * account's IMAP host is edited and a sync completes, which is out of scope
 * to fabricate here. Test (a) instead seeds `useSettingsStore`'s
 * `restoreDetected` field directly -- the same "write the state a slower
 * detector would have written, then click the REAL button" technique
 * `mockBilling.js`'s `setPremium`/`seedSignedIn` already use for premium
 * state in this suite -- and clicks the modal's real "Restore" button, which
 * calls the real `restoreManager.start()` -> real `api.startRestore()` ->
 * real daemon RPC. Test (b)'s cancel needs a big-enough batch (40 messages)
 * to reliably land mid-run over real loopback APPEND round trips with no
 * fault-injection API available to this suite's JS-side mock servers
 * (confirmed by reading `mockImap.js`); running that twice through the full
 * modal-open dance buys nothing test (a) hasn't already proven about the
 * channel/UI wiring, so it fires `start_restore` directly instead, the same
 * choice `connected-migration-daemon.test.js` makes for its own cancel case.
 */

import { ImapFlow } from 'imapflow';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hideDaemonBinaries, waitForApp, waitForEmails } from './helpers.js';
import { appDataDir, MOCK_PASSWORD } from './mockImap.js';

const LUKE = 'luke@mock.test';
const VADER = 'vader@mock.test';
const LUKE_SERVER = 0;
const VADER_SERVER = 1; // MOCK_ACCOUNTS order: luke, vader, yoda

const COUNT_A = 5;
const COUNT_CANCEL = 40;
const BASE_UID_A = 900101; // far outside any synced uid range, matching connected-vault-move-daemon.test.js's convention
const BASE_UID_CANCEL = 900201;

// ── Raw bridges ──────────────────────────────────────────────────────────

// `__error`, not `error`: an `executeAsync` result object carrying a bare
// `error` key is treated by webdriverio's client as a FAILED protocol
// response (silently retried, then thrown) rather than a normal return
// value -- connected-daemon-channel.test.js's own documented trap.
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

async function installRawCapture(names) {
  await browser.executeAsync((eventNames, done) => {
    window.__RESTORE_DAEMON_EVENTS__ = [];
    Promise.all(eventNames.map((name) =>
      window.__TAURI__.event.listen(name, (e) => window.__RESTORE_DAEMON_EVENTS__.push({ name, payload: e.payload, at: Date.now() }))))
      .then(() => done(true), () => done(false));
  }, names);
}
const rawEvents = (name) => browser.execute((n) => (window.__RESTORE_DAEMON_EVENTS__ || []).filter((e) => e.name === n), name);

// ── Seed local vault messages directly (maildir_store), no server round trip ──

function rawEml(subject, i) {
  return [
    'From: Restore Fixture <fixture@mock.test>',
    'To: nobody@mock.test',
    `Subject: ${subject}`,
    `Date: ${new Date(Date.now() - i * 1000).toUTCString()}`,
    `Message-ID: <${subject.toLowerCase().replaceAll(' ', '-')}@mock.test>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    `${subject} - body`,
    '',
  ].join('\r\n');
}

/** Seed `count` local .eml files under `<accountId>/Drafts/cur`, uid starting
 *  at `baseUid`, subjects `${prefix} N` -- the same `maildir_store` primitive
 *  `connected-vault-move-daemon.test.js` uses to seed a draft. */
async function seedLocalDrafts(accountId, prefix, baseUid, count) {
  const subjects = [];
  // Zero-padded to a fixed width: IMAP SUBJECT search matches a SUBSTRING
  // (RFC 3501), so an unpadded "…cancel 1" is itself a substring of "…cancel
  // 10".."…cancel 19" -- uidsForSubjects/purgeSubjects would silently count
  // every one of those as a match for subject "1" alone. Fixed-width digits
  // can never be a prefix of a different number in the same batch.
  const width = String(count).length;
  for (let i = 0; i < count; i++) {
    const uid = baseUid + i;
    const subject = `${prefix} ${String(i + 1).padStart(width, '0')}`;
    subjects.push(subject);
    const stored = await daemonRpc('maildir_store', {
      accountId, mailbox: 'Drafts', uid,
      rawSourceBase64: Buffer.from(rawEml(subject, i), 'utf8').toString('base64'),
      flags: ['seen'],
    });
    if (!stored.ok) throw new Error(`maildir_store (seed ${subject}) failed: ${stored.__error}`);
  }
  return subjects;
}

// ── The server, behind the app's back (ImapFlow) ───────────────────────────

async function withServer(serverIndex, email, fn) {
  const { host, port } = browser.mockImap[serverIndex];
  const client = new ImapFlow({ host, port, secure: false, auth: { user: email, pass: MOCK_PASSWORD }, logger: false });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout();
  }
}

async function uidsForSubjects(serverIndex, email, mailbox, subjects) {
  return withServer(serverIndex, email, async (client) => {
    const lock = await client.getMailboxLock(mailbox);
    try {
      const out = [];
      for (const subject of subjects) out.push(...(await client.search({ subject }, { uid: true })));
      return out;
    } finally {
      lock.release();
    }
  });
}

async function purgeSubjects(serverIndex, email, mailbox, subjects) {
  if (!subjects.length) return;
  try {
    await withServer(serverIndex, email, async (client) => {
      const lock = await client.getMailboxLock(mailbox);
      try {
        const uids = [];
        for (const subject of subjects) uids.push(...(await client.search({ subject }, { uid: true })));
        if (uids.length) await client.messageDelete(uids, { uid: true });
      } finally {
        lock.release();
      }
    });
  } catch (e) {
    console.warn('[connected-restore-daemon] purge failed:', e.message);
  }
}

function accountJson(serverIndex, email) {
  const { host, port } = browser.mockImap[serverIndex];
  return { email, password: MOCK_PASSWORD, imapHost: host, imapPort: port, imapSecure: true };
}

describe('Restore (local vault -> server) through the daemon (Task 4.10)', function () {
  this.timeout(240_000);

  let lukeId = null;
  let vaderId = null;
  let pidBefore = null;
  let subjectsA = [];
  let subjectsCancel = [];

  before(async function () {
    await waitForApp();
    await waitForEmails();
    lukeId = (browser.mockAccounts || []).find((a) => a.email === LUKE)?.id;
    vaderId = (browser.mockAccounts || []).find((a) => a.email === VADER)?.id;
    expect(lukeId).toBeTruthy();
    expect(vaderId).toBeTruthy();

    pidBefore = daemonPid(browser.testDataDir);
    expect(pidBefore).toBeGreaterThan(0);

    await installRawCapture(['restore-progress']);
  });

  after(async function () {
    await purgeSubjects(LUKE_SERVER, LUKE, 'Drafts', subjectsA);
    await purgeSubjects(VADER_SERVER, VADER, 'Drafts', subjectsCancel);
  });

  afterEach(async function () {
    if (this.currentTest?.state !== 'failed') return;
    try {
      const bodyText = await browser.execute(() => (document.body.innerText || '').slice(0, 500));
      console.log(`[connected-restore-daemon] diagnostic for "${this.currentTest.title}":`, JSON.stringify({ bodyText }));
    } catch (e) {
      console.log('[connected-restore-daemon] diagnostic capture itself failed:', e.message);
    }
  });

  it('(a) count_local_folder matches the seed, and the real RestoreModal UI genuinely uploads that many messages, with restore-progress reaching the frontend over the channel', async function () {
    subjectsA = await seedLocalDrafts(lukeId, 'Restore daemon full', BASE_UID_A, COUNT_A);

    const counted = await daemonRpc('count_local_folder', { accountId: lukeId, mailbox: 'Drafts' });
    expect(counted.ok).toBe(true);
    expect(counted.v).toBe(COUNT_A);

    // Seed the state a real host-change detection would have written
    // (restoreDetection.js's checkRestoreNeeded), then drive the real modal.
    await browser.execute((accountId, account, folders) => {
      window.__SETTINGS_STORE__.setState({
        restoreDetected: { accountId, account, folders },
      });
    }, lukeId, accountJson(LUKE_SERVER, LUKE), [{ mailbox: 'Drafts', localCount: COUNT_A }]);

    await browser.waitUntil(() => browser.execute(() => document.body.innerText.includes('Restore')), {
      timeout: 15_000, interval: 300, timeoutMsg: 'RestoreModal never opened for the seeded restoreDetected state',
    });

    const clicked = await browser.execute(() => {
      for (const btn of document.querySelectorAll('button')) {
        if (btn.offsetHeight === 0 || btn.disabled) continue;
        if (/restore \d+/i.test((btn.textContent || '').trim())) { btn.click(); return true; }
      }
      return false;
    });
    expect(clicked).toBe(true);

    let finalFrame = null;
    await browser.waitUntil(async () => {
      const events = await rawEvents('restore-progress');
      finalFrame = events.find((e) => e.payload.account_id === lukeId && e.payload.status === 'completed');
      return !!finalFrame;
    }, { timeout: 60_000, interval: 300, timeoutMsg: 'restore-progress never reported completion for the UI-driven restore' });

    expect(finalFrame.payload.uploaded_emails).toBe(COUNT_A);
    expect(finalFrame.payload.failed_emails).toBe(0);

    // count_local_folder's earlier count matches what genuinely landed on
    // the server, uploaded through the real UI click.
    await browser.waitUntil(async () => (await uidsForSubjects(LUKE_SERVER, LUKE, 'Drafts', subjectsA)).length === COUNT_A, {
      timeout: 20_000, interval: 500, timeoutMsg: `luke's server Drafts folder never showed all ${COUNT_A} restored messages`,
    });
  });

  it('(b) cancel_restore mid-run genuinely stops an in-flight upload, not just returns ok', async function () {
    subjectsCancel = await seedLocalDrafts(vaderId, 'Restore daemon cancel', BASE_UID_CANCEL, COUNT_CANCEL);

    const counted = await daemonRpc('count_local_folder', { accountId: vaderId, mailbox: 'Drafts' });
    expect(counted.ok).toBe(true);
    expect(counted.v).toBe(COUNT_CANCEL);

    const start = await daemonRpc('start_restore', {
      account: JSON.stringify(accountJson(VADER_SERVER, VADER)), accountId: vaderId, folders: ['Drafts'],
    });
    expect(start.ok).toBe(true);

    // No wait: race the 40-message batch over real loopback APPEND round
    // trips (no fault-injection API on this suite's JS-side mock servers).
    const cancelled = await daemonRpc('cancel_restore', {});
    expect(cancelled.ok).toBe(true);
    expect(cancelled.v.cancelled).toBeGreaterThan(0);

    let finalFrame = null;
    await browser.waitUntil(async () => {
      const events = await rawEvents('restore-progress');
      finalFrame = events.find((e) => e.payload.account_id === vaderId && e.payload.status === 'cancelled');
      return !!finalFrame;
    }, { timeout: 30_000, interval: 300, timeoutMsg: 'cancel_restore never produced a cancelled restore-progress frame' });

    expect(finalFrame.payload.uploaded_emails).toBeLessThan(COUNT_CANCEL);

    const remaining = await uidsForSubjects(VADER_SERVER, VADER, 'Drafts', subjectsCancel);
    expect(remaining.length).toBeLessThan(COUNT_CANCEL);
  });

  it('(c) daemon.pid never changed across the whole run', function () {
    const pidAfter = daemonPid(browser.testDataDir);
    expect(pidAfter).toBeGreaterThan(0);
    expect(pidAfter).toBe(pidBefore);
  });

  it('(d) NEGATIVE: with no daemon connection, count_local_folder reports errors.daemonUnavailable instead of hanging, and no restore-progress arrives', async function () {
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
    const binPath = fullCmd.split(/\s+/)[0];

    const eventsBefore = (await rawEvents('restore-progress')).length;

    // See connected-import-export-daemon.test.js's own (g) for why: a plain
    // SIGKILL-then-retry self-heals inside `daemon_rpc`'s own
    // `ensure_daemon_running` on-demand respawn before this test could ever
    // observe a failure. Renaming the binary aside makes the respawn attempt
    // itself fail, a deterministic window instead of a race.
    const restoreDaemonBinaries = hideDaemonBinaries(binPath);
    try {
      process.kill(before, 'SIGKILL');
      const resp = await daemonRpc('count_local_folder', { accountId: lukeId, mailbox: 'Drafts' });
      expect(resp.ok).toBe(false);
      expect(resp.__error).toContain('errors.daemonUnavailable');
      expect((await rawEvents('restore-progress')).length).toBe(eventsBefore);
    } finally {
      restoreDaemonBinaries();
    }

    let after = null;
    await browser.waitUntil(() => {
      after = daemonPid(browser.testDataDir);
      return after !== null && after !== before;
    }, { timeout: 30_000, interval: 250, timeoutMsg: `daemon.pid never changed from ${before} after restoring the binary (last read: ${after})` });
  });
});
