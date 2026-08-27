/**
 * E2E: the vault, asked through the transport that actually ships.
 *
 * `services/transport.js` answers some commands from the background daemon and
 * the rest from Tauri, and the two are independent implementations. The maildir
 * family disagreed on every routed command:
 *
 *   maildir_exists        daemon `{exists: bool}` vs Tauri a bare `bool`
 *   maildir_storage_stats daemon {total_size,...} vs Tauri {totalBytes,...}
 *   maildir_store         core writes `<uid>:archived,seen:<ts>.eml`,
 *                         Tauri writes `<uid>:2,AS`
 *
 * `{exists: false}` is truthy, so once the daemon's heartbeat connected,
 * `isEmailSaved` said "already in the vault" about every message,
 * `saveEmailLocally` took its already-cached branch, nothing was copied, and
 * the archive died on a uid `maildir_list` (Tauri, never routed) had never seen:
 *
 *   Could not copy that email into your vault. Nothing was removed from the
 *   server. (Email UID 30 not found in Maildir)
 *
 * Which is why this is an E2E and not a unit test: the failure needs two real
 * processes and a heartbeat that connects PART WAY THROUGH the session. The
 * first archives of a run worked; a later one did not.
 *
 * `daemon must be routed in this run` is the anti-vacuity guard. Without it a
 * run where the daemon never came up would pass every case below while proving
 * nothing at all.
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { waitForApp, waitForEmails, switchToFolder } from './helpers.js';
import { appDataDir } from './mockImap.js';

const LUKE = 'luke@mock.test';

describe('Vault — daemon/Tauri contract', function () {
  this.timeout(240_000);

  let accountId = null;
  let cur = null;

  /** Every message file in the vault's cur/, by uid. */
  const vault = () => {
    let names = [];
    try { names = readdirSync(cur); } catch { return new Map(); }
    const out = new Map();
    for (const name of names) {
      const head = name.split(':')[0];
      if (!/^\d+$/.test(head)) continue;
      out.set(Number(head), {
        name,
        // Tauri's own format. The daemon's would not match, which is the point.
        archived: /:2,[A-Z]*A/.test(name),
        size: statSync(join(cur, name)).size,
      });
    }
    return out;
  };

  const rows = () => browser.execute(() =>
    [...document.querySelectorAll('[data-testid="email-row"]')].map((row) => ({
      text: (row.innerText || '').replace(/\s*\n\s*/g, ' | ').trim(),
      icon: row.querySelector('[data-testid="msg-state-icon"]')?.getAttribute('data-state') || null,
    })));

  /** uid + subject for every unarchived Luke row the list currently holds. */
  const unarchivedRows = () => browser.execute(() => {
    const store = window.__MAIL_STORE__?.getState();
    return (store?.sortedEmails || [])
      .filter((e) => !e.isArchived && /Luke message \d+/.test(e.subject || ''))
      .map((e) => ({ uid: e.uid, subject: e.subject }));
  });

  /** The row's own hover Archive button — the saveEmailLocally path, not bulk. */
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

  const storeError = () => browser.execute(() => window.__MAIL_STORE__?.getState()?.error || null);

  before(async function () {
    await waitForApp();
    await waitForEmails();
    await switchToFolder(LUKE, 'INBOX');
    accountId = browser.mockAccounts.find((a) => a.email === LUKE).id;
    cur = join(appDataDir(browser.testDataDir), 'Maildir', accountId, 'INBOX', 'cur');
  });

  it('routes the daemon in this run, so the cases below mean something', async function () {
    // The heartbeat spawns the daemon on its first tick and retries 5s → 10s →
    // 20s → 40s → 60s, so "alive" arrives seconds into the session, not at boot.
    // That gap IS the bug's window.
    await browser.waitUntil(async () =>
      (await browser.execute(() => window.__DB_PROBE__?.daemonHealth?.().alive)) === true, {
      timeout: 180_000, interval: 1_000,
      timeoutMsg: 'the daemon never came up, so nothing below exercises the routed path. '
        + 'The app spawns target/debug/mailvault-daemon on demand; `npm run test:e2e` builds it, '
        + 'but a re-run of `wdio run` alone on a tree that never built it will not.',
    });
  });

  it('answers "is it in the vault?" with a boolean, not an envelope', async function () {
    const [row] = await unarchivedRows();
    if (!row) throw new Error('no unarchived Luke row to ask about');

    // executeAsync, not execute: `execute` does not await a Promise, so a Tauri
    // invoke comes back `{}` and every assertion below would be about nothing.
    const answer = await browser.executeAsync((id, uid, done) => {
      window.__DB_PROBE__.isEmailSaved(id, 'INBOX', uid)
        .then((v) => done({ value: v, type: typeof v }))
        .catch((e) => done({ error: String(e) }));
    }, accountId, row.uid);

    expect(answer.error).toBeUndefined();
    // `{exists:false}` came back as an object, and every caller read it as yes.
    expect(answer.type).toBe('boolean');
    expect(answer.value).toBe(false);
  });

  it('copies the message onto disk on every archive, not just the early ones', async function () {
    // Three in a row, deliberately: the routing flip lands mid-session, so the
    // first archive of a run could pass while a later one could not.
    const targets = (await unarchivedRows()).slice(0, 3);
    expect(targets.length).toBe(3);

    for (const { uid, subject } of targets) {
      if (vault().has(uid)) throw new Error(`"${subject}" (uid ${uid}) was already in the vault`);
      expect(await clickRowArchive(subject)).toBe(true);

      try {
        await browser.waitUntil(async () => {
          const file = vault().get(uid);
          return !!file && file.archived && file.size > 0;
        }, { timeout: 60_000, interval: 300 });
      } catch {
        // Read cur/ here, not in a `timeoutMsg` — that string is built before
        // the wait starts and would describe the vault as it was at t=0.
        throw new Error(`"${subject}" (uid ${uid}) never reached the vault as an archived file. `
          + `cur/ holds: ${[...vault().keys()].join(',') || '(nothing)'}. `
          + `store error: ${await storeError() || 'none'}`);
      }

      // The row has to agree with the disk, and nothing may have errored.
      const seen = (await rows()).find((r) => r.text.includes(subject));
      if (!seen?.icon?.startsWith('archived')) {
        throw new Error(`"${subject}" is on disk but the row shows ${seen?.icon || 'no state icon'}`);
      }
      const err = await storeError();
      if (err) throw new Error(`archiving "${subject}" surfaced: ${err}`);
    }
  });

  it('reports a real vault size once the vault holds something', async function () {
    // Same registry, same class of bug, no bug report: getStorageUsage() read
    // camelCase off a snake_case struct and every field came back undefined.
    // The `|| 0` in the settings UI turns that into a confident "0 KB".
    const usage = await browser.executeAsync((done) => {
      window.__DB_PROBE__.storageUsage()
        .then(done)
        .catch((e) => done({ error: String(e) }));
    });

    if (!Number.isFinite(usage.totalBytes) || !Number.isFinite(usage.totalMB)) {
      throw new Error(`storage usage is not numeric: ${JSON.stringify(usage)}`);
    }
    expect(usage.emailCount).toBeGreaterThan(0);
    expect(usage.totalBytes).toBeGreaterThan(0);
  });
});
