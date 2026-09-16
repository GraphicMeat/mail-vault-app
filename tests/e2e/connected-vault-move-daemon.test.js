/**
 * E2E: moving the vault now that the daemon (not the app) owns custody, the
 * header/mailbox caches and the search index (Task 2.9b cutover).
 *
 * `connected-insights.test.js` is the only other spec that moves the vault,
 * and it is chronically flaky (task-2.3-report.md: screenshot-capture
 * infrastructure failures and a pre-existing `imap_get_email_light` growth
 * unrelated to any vault-move mechanics). This spec exercises the same
 * `vault_move_to` / `vault_move_to_default` path those specs use, but never
 * calls `captureInsights`/`screencapture` and never opens Insights at all —
 * it only asks the daemon direct questions before and after the move — so it
 * can live in the default `connected-ci` suite instead of the excluded one.
 *
 * Before Task 2.9b, `custody.db` opened in the app and moved with it because
 * the app's own vault handlers closed/reopened it around the copy. Since
 * 2.9b, the daemon opens custody at startup and `vault_close`/`vault_reopen`
 * (daemon-internal RPCs) close/reopen it there instead — so a vault move now
 * has to end with a *new* daemon process (the old one is stopped, never
 * reopened, per `vault_move_to`'s `MoveFollowUp::RestartDaemon` path in
 * `src-tauri/src/main.rs`) serving custody, the local index and the search
 * index off the new root. That is what this spec proves, with the daemon's
 * own log as the anti-vacuity check that a real process swap happened.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { waitForApp, waitForEmails, switchToFolder } from './helpers.js';
import { appDataDir } from './mockImap.js';

const LUKE = 'luke@mock.test';
const DRAFT_UID = 900001; // Drafts starts empty in the fixture; far outside any synced uid range.
const DRAFT_SUBJECT = 'Vault move draft';

/** `browser.execute` does not await a Promise; native Tauri commands need `executeAsync`. */
const invoke = (cmd, args) => browser.executeAsync((c, a, done) => {
  window.__TAURI__.core.invoke(c, a).then((v) => done({ ok: true, v }), (e) => done({ ok: false, error: String((e && e.message) || e) }));
}, cmd, args);

/** Task 2.6-2.9b: these names are daemon-owned or daemon-only bridge calls, not Tauri commands. */
const daemonRpc = (method, params) => browser.executeAsync((m, p, done) => {
  window.__TAURI_INTERNALS__.invoke('daemon_rpc', { method: m, params: p }).then((v) => done({ ok: true, v }), (e) => done({ ok: false, error: String((e && e.message) || e) }));
}, method, params);

/** The daemon writes this at `get_data_dir()/daemon.pid` — the APP data dir, which
 *  never moves (only mail data does) — same file `connected-daemon-channel.test.js`
 *  polls after a SIGKILL respawn. */
const daemonPid = (home) => {
  try { return parseInt(readFileSync(join(appDataDir(home), 'daemon.pid'), 'utf8').trim(), 10) || null; } catch { return null; }
};

/** Most recently written `daemon.log*` file — daily rotation, but a run near
 *  midnight must still find whichever file is actually being appended to. */
function daemonLogPath(home) {
  const dir = join(appDataDir(home), 'logs');
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((n) => n.startsWith('daemon.log'));
  if (!files.length) return null;
  files.sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs);
  return join(dir, files[0]);
}

/** Poll the daemon log (a non-blocking writer, so it lags real time a little)
 *  until `predicate` is true, or fail with the tail of what it actually said. */
async function waitForLogText(home, predicate, timeoutMsg, timeout = 20_000) {
  const start = Date.now();
  let text = '';
  while (Date.now() - start < timeout) {
    const path = daemonLogPath(home);
    text = path && existsSync(path) ? readFileSync(path, 'utf8') : '';
    if (predicate(text)) return text;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${timeoutMsg}\n--- last observed daemon.log tail ---\n${text.slice(-3000)}`);
}

const unarchivedRows = () => browser.execute(() => {
  const store = window.__MAIL_STORE__?.getState();
  return (store?.sortedEmails || [])
    .filter((e) => !e.isArchived && /Luke message \d+/.test(e.subject || ''))
    .map((e) => ({ uid: e.uid, subject: e.subject }));
});

const clickRowArchive = (subject) => browser.execute((needle) => {
  for (const row of document.querySelectorAll('[data-testid="email-row"]')) {
    if (!(row.innerText || '').includes(needle)) continue;
    const btn = row.querySelector('button[title="Archive"]');
    if (!btn) return false;
    btn.click();
    return true;
  }
  return false;
}, subject);

describe('Vault move — the daemon keeps custody, caches and the search index consistent', function () {
  this.timeout(240_000);

  let account = null;
  let cur = null;
  let seededUid = null;
  let seededSubject = null;

  before(async function () {
    await waitForApp();
    await waitForEmails();
    await switchToFolder(LUKE, 'INBOX');
    account = browser.mockAccounts.find((a) => a.email === LUKE);
    cur = join(appDataDir(browser.testDataDir), 'Maildir', account.id, 'INBOX', 'cur');

    // Seed a real vault message: archiving is what actually copies a message
    // onto disk (a synced header alone is not a vault file).
    const [target] = await unarchivedRows();
    if (!target) throw new Error('no unarchived Luke INBOX row to seed the vault with');
    ({ uid: seededUid, subject: seededSubject } = target);
    expect(await clickRowArchive(seededSubject)).toBe(true);
    await browser.waitUntil(() => existsSync(cur) && readdirSync(cur).some((n) => n.startsWith(`${seededUid}:`)),
      { timeout: 30_000, interval: 300, timeoutMsg: `"${seededSubject}" (uid ${seededUid}) never reached the vault` });

    // Seed a local draft directly through the daemon (Task 2.8's `maildir_store`
    // + Task 2.9b's `local_index_append`) — the same primitives
    // `composeHelpers.restoreDraft` uses, without opening Compose at all.
    const rawEml = `Subject: ${DRAFT_SUBJECT}\r\nFrom: ${LUKE}\r\nTo: ${LUKE}\r\nDate: Wed, 16 Sep 2026 00:00:00 +0000\r\nMessage-Id: <vault-move-draft@mock.test>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nDraft body for the vault-move spec.\r\n`;
    const stored = await daemonRpc('maildir_store', {
      accountId: account.id, mailbox: 'Drafts', uid: DRAFT_UID,
      rawSourceBase64: Buffer.from(rawEml, 'utf8').toString('base64'),
      // Same flag set `composeHelpers.restoreDraft` uses — the established
      // rule for anything written straight into the vault.
      flags: ['archived', 'seen', 'draft'],
    });
    if (!stored.ok) throw new Error(`maildir_store (seed draft) failed: ${stored.error}`);
    const indexed = await daemonRpc('local_index_append', {
      accountId: account.id, mailbox: 'Drafts',
      entriesJson: JSON.stringify([{ uid: DRAFT_UID, subject: DRAFT_SUBJECT, source: 'local_draft', date: Date.now() }]),
    });
    if (!indexed.ok) throw new Error(`local_index_append (seed draft) failed: ${indexed.error}`);
  });

  it('serves the seeded message, the draft index and custody off the new root, and leaves nothing behind on the old one', async function () {
    const home = browser.testDataDir;
    const oldRoot = appDataDir(home);
    const beforePid = daemonPid(home);
    expect(beforePid).toBeGreaterThan(0);

    // (d)'s "gone from the old root" check only means something if these were
    // actually there before the move — otherwise a folder that never had them
    // would pass identically. custody.db opens at daemon startup (Task 2.9b)
    // so it must exist by now; the search index only opens when enabled, so
    // its half of (d) is skipped (and said so in the report) if it is absent.
    const hadCustody = existsSync(join(oldRoot, 'custody', 'custody.db'));
    if (!hadCustody) throw new Error(`custody.db was never at the old root (${oldRoot}); (d) would prove nothing`);
    const hadIndex = existsSync(join(oldRoot, 'search_index', 'index.db'));

    const destination = mkdtempSync(join(home, 'vault-move-daemon-'));
    let moved = false;
    try {
      const move = await invoke('vault_move_to', { path: destination });
      if (!move.ok) throw new Error(`vault_move_to: ${move.error}`);
      moved = true;

      // (e) the daemon pid changed. A successful move never calls
      // `vault_reopen` against the old process (that path is only for a
      // failed move that still switched root) — it stops the old daemon and
      // the app's reconnect loop spawns a fresh one on the new root, exactly
      // like the SIGKILL case in connected-daemon-channel.test.js.
      let afterPid = null;
      try {
        await browser.waitUntil(() => { afterPid = daemonPid(home); return afterPid !== null && afterPid !== beforePid; },
          { timeout: 60_000, interval: 300 });
      } catch {
        throw new Error(`daemon.pid never changed from ${beforePid} after the move (last read: ${afterPid ?? 'missing/unreadable'})`);
      }
      expect(afterPid).toBeGreaterThan(0);

      // (a) a read of the seeded message succeeds — the new daemon process is
      // actually serving the new root, not just alive.
      const light = await daemonRpc('maildir_read_light', { accountId: account.id, mailbox: 'INBOX', uid: seededUid });
      if (!light.ok) throw new Error(`maildir_read_light after the move: ${light.error}`);
      expect(light.v.uid).toBe(seededUid);
      expect(light.v.subject).toBe(seededSubject);

      // (b) custody_status.path is under the new root.
      const status = await daemonRpc('custody_status', {});
      if (!status.ok) throw new Error(`custody_status after the move: ${status.error}`);
      if (!status.v.available) throw new Error(`custody_status.available is false after the move: ${JSON.stringify(status.v)}`);
      if (!status.v.path || !status.v.path.startsWith(destination)) {
        throw new Error(`custody_status.path "${status.v.path}" is not under the new root "${destination}"`);
      }
      const expectedCustodyPath = join('custody', 'custody.db');
      if (!status.v.path.endsWith(expectedCustodyPath)) {
        throw new Error(`custody_status.path "${status.v.path}" does not end with "${expectedCustodyPath}"`);
      }
      expect(existsSync(join(destination, 'custody', 'custody.db'))).toBe(true);

      // (c) local_index_read still returns the draft row.
      const idx = await daemonRpc('local_index_read', { accountId: account.id, mailbox: 'Drafts' });
      if (!idx.ok) throw new Error(`local_index_read after the move: ${idx.error}`);
      const entries = idx.v ? JSON.parse(idx.v) : [];
      const draft = entries.find((e) => Number(e.uid) === DRAFT_UID);
      if (!draft) throw new Error(`draft uid ${DRAFT_UID} missing from local_index_read after the move: ${JSON.stringify(entries)}`);
      expect(draft.subject).toBe(DRAFT_SUBJECT);

      // (d) the old root has no custody store and no search index left on it
      // — only checked for what was actually proven present before the move.
      if (existsSync(join(oldRoot, 'custody', 'custody.db'))) {
        throw new Error(`custody.db is still at the old root (${oldRoot}) after the move`);
      }
      if (hadIndex && existsSync(join(oldRoot, 'search_index', 'index.db'))) {
        throw new Error(`search_index/index.db is still at the old root (${oldRoot}) after the move`);
      }

      // (f) the daemon's own log: the OLD process closed the index (and, since
      // Task 2.9a/b, custody with it) before it stopped, and the NEW process
      // started exactly one search-index worker on the new root — the same
      // shape task-2.5-report.md captured manually for connected-insights.
      await waitForLogText(home, (text) => {
        const oldStart = text.lastIndexOf(`starting (pid: ${beforePid})`);
        const newStart = text.indexOf(`starting (pid: ${afterPid})`, oldStart + 1);
        if (oldStart < 0 || newStart < 0) return false;
        const closeSection = text.slice(oldStart, newStart);
        if (!closeSection.includes('vault_close: closing the search index')) return false;
        if (!closeSection.includes('vault_close: closed')) return false;
        const nextStart = text.indexOf('starting (pid:', newStart + 1);
        const newSection = nextStart >= 0 ? text.slice(newStart, nextStart) : text.slice(newStart);
        return (newSection.match(/search index worker started/g) || []).length === 1;
      }, `daemon.log never showed pid ${beforePid} closing the index and pid ${afterPid} starting exactly one search index worker`);
    } finally {
      // Move back to the default location no matter what failed above, so the
      // HOME this spec used is left clean.
      if (moved) {
        const back = await invoke('vault_move_to_default', {});
        if (!back.ok) console.warn(`[vault-move] cleanup vault_move_to_default failed: ${back.error}`);
      }
    }

    // `timeoutMsg` is built eagerly, before the wait runs, so it can never
    // report what the poll actually last saw (ruling 2, connected-daemon-channel
    // established the pattern) — record it in an outer variable instead.
    let lastStatus = null;
    try {
      await browser.waitUntil(async () => {
        const status = await daemonRpc('custody_status', {});
        lastStatus = status;
        return status.ok && status.v.available && status.v.path.startsWith(oldRoot);
      }, { timeout: 60_000, interval: 300 });
    } catch {
      throw new Error(`vault never reported back at the default location (${oldRoot}) after cleanup — last custody_status: ${JSON.stringify(lastStatus)}`);
    }
  });
});
