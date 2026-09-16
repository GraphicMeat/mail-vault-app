/**
 * E2E: archive and bulk delete genuinely run in the daemon (Task 3.10).
 *
 * Everything below drives the real UI and the real app+daemon binaries - no
 * unit mock, no direct `daemon_rpc` shortcut for the operations themselves
 * (only for reading back state afterward, the same pattern
 * `connected-vault-move-daemon.test.js` uses). It proves:
 *
 *  (a) archiving a batch through the UI emits `archive-progress` on the real
 *      Tauri event channel with `operation: "archive"` and camelCase keys;
 *  (b) the archived `.eml` files really exist on disk and custody rows were
 *      appended BY THE DAEMON (read back through `daemon_rpc`'s
 *      `local_index_read`, the same route `custody.rs` backs with
 *      `mailvault_core::custody::entries` - Task 3.4's in-process append);
 *  (c) `cancel_archive`, triggered through the UI's own Cancel button,
 *      genuinely stops an in-flight archive;
 *  (d) THE KEY REGRESSION TEST (N4): `cancel_archive` does NOT stop a
 *      concurrent `bulk_delete_emails` run. Before Task 3.4/3.5, both
 *      commands replaced the SAME `ArchiveCancelToken` slot on entry
 *      (`main.rs:3671` at the pre-cutover commits) - `cancel_archive` reads
 *      whatever token currently sits in that slot, so calling it while only
 *      a bulk delete is running incorrectly cancels the bulk delete. Task
 *      3.4 replaced the single slot with a registry keyed by operation kind
 *      ("archive" vs "bulk_delete"), so this must now be a no-op. Proving it
 *      end to end (not just in the Rust unit tests that already cover the
 *      registry) is this task's whole point;
 *  (e) `daemon.pid` never changes across the run - no crash/restart hides a
 *      real failure behind a fresh process.
 *
 * ── Why yoda ─────────────────────────────────────────────────────────────
 * yoda@mock.test (wdio.conf.js account 3) is the one account that exists to
 * carry faults, and its MOVE/EXPUNGE are already stalled 4s each - the two
 * commands a permanent server delete ends on (`UID STORE +FLAGS (\Deleted)`
 * then `UID EXPUNGE`, since yoda's mock advertises UIDPLUS). That stall is
 * reused here, unmodified, to hold `bulk_delete_emails` genuinely in flight
 * for test (d) - no new fixture, no `slowFetch` fault of this spec's own
 * (wdio.conf.js and mockImap.js are read-only for this task).
 *
 * Archive has no such fault on any account, so test (c)'s cancellation
 * instead races the daemon's own 5-permit semaphore (`Semaphore::new(5)` in
 * `src-core/src/archive.rs`): a batch bigger than 5 always leaves some UIDs
 * queued on a permit, and the archive-only Cancel button is wired to fire
 * the instant the FIRST `archive-progress` completion reaches this page -
 * inside the browser's own event loop, with no WebDriver round trip in the
 * critical path - so the cancel lands as early as a real click ever could.
 *
 * ── Fixtures ─────────────────────────────────────────────────────────────
 * Three disjoint batches, APPENDed straight to yoda's INBOX with ImapFlow
 * (the same technique `connected-delete-reader-race.test.js` uses), each
 * with a subject prefix unique to this spec so no other file's fixtures or
 * assertions are touched. Dated "now" (recent), same as that spec, and
 * purged from the server in `after()` for the same reason: yoda's mail is
 * deliberately the newest in the suite (uids start at 901) so it heads All
 * Inboxes without scrolling - a spec that left mail behind would move that
 * goalpost for every later file. Local (vault/custody) state needs no
 * cleanup: `beforeSession`'s `resetAppState` wipes the data dir per spec
 * file.
 */

import { ImapFlow } from 'imapflow';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { waitForApp, waitForEmails, switchToFolder } from './helpers.js';
import { appDataDir, MOCK_PASSWORD } from './mockImap.js';

const YODA = 'yoda@mock.test';
const YODA_SERVER = 2; // MOCK_ACCOUNTS order: luke, vader, yoda

// Disjoint subject families, one per batch, so a row's subject alone says
// which test it belongs to and no batch can be mistaken for another.
const PREFIX_A = 'Archive daemon full';   // (a)/(b): archived to completion
const PREFIX_C = 'Archive daemon cancel'; // (c): cancelled mid-flight
const PREFIX_D = 'Bulk delete daemon';    // (d): the N4 regression

const COUNT_A = 6;
const COUNT_C = 10; // > the 5-permit semaphore, so cancel always has a queued tail
const COUNT_D = 6;

describe('Archive and bulk delete through the daemon (Task 3.10)', function () {
  this.timeout(240_000);

  let yodaId = null;
  let pidBefore = null;
  // uid -> subject, per batch, filled in by the seeding step (the mock
  // server assigns uids on APPEND; nothing here hardcodes them).
  let batchA = [];
  let batchC = [];
  let batchD = [];

  // ── The server, behind the app's back (ImapFlow, same shape as
  //    connected-delete-reader-race.test.js) ────────────────────────────

  async function withYoda(fn) {
    const { host, port } = browser.mockImap[YODA_SERVER];
    const client = new ImapFlow({ host, port, secure: false, auth: { user: YODA, pass: MOCK_PASSWORD }, logger: false });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.logout();
    }
  }

  const rfc822 = (subject, date) => Buffer.from([
    'From: Archiver <archiver@mock.test>',
    `To: ${YODA}`,
    `Subject: ${subject}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${subject.toLowerCase().replaceAll(' ', '-')}@mock.test>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    `${subject} - body`,
    '',
  ].join('\r\n'));

  /** APPEND `count` fresh messages `${prefix} 1..count` to yoda's INBOX,
   *  return their real server-assigned uids paired with their subjects. */
  async function seedBatch(prefix, count) {
    const now = Date.now();
    return withYoda(async (client) => {
      const lock = await client.getMailboxLock('INBOX');
      try {
        const out = [];
        for (let i = 1; i <= count; i++) {
          const subject = `${prefix} ${i}`;
          const date = new Date(now - i * 1000); // strictly ordered, all "now"
          await client.append('INBOX', rfc822(subject, date), [], date);
          // Re-queried rather than trusted off APPEND's own return, same as
          // connected-delete-reader-race.test.js's `seed()`.
          const [uid] = await client.search({ subject }, { uid: true });
          if (!uid) throw new Error(`APPEND of "${subject}" left no uid findable by search`);
          out.push({ uid, subject });
        }
        return out;
      } finally {
        lock.release();
      }
    });
  }

  /** How many uids `client.search({subject}, {uid:true})` currently finds
   *  for a subject - one call per subject, the same shape every other spec
   *  in this suite already uses (nobody here relies on an `{or: [...]}`
   *  combinator, so this doesn't invent one either). */
  async function uidsForSubjects(client, subjects) {
    const out = [];
    for (const subject of subjects) {
      out.push(...(await client.search({ subject }, { uid: true })));
    }
    return out;
  }

  /** Best-effort removal of every batch's messages from wherever they ended
   *  up (INBOX if never deleted, gone already if bulk_delete ran). Never
   *  throws - a cleanup failure must not mask a real assertion failure. */
  async function purgeAll() {
    const subjects = [...batchA, ...batchC, ...batchD].map((m) => m.subject);
    if (!subjects.length) return;
    try {
      await withYoda(async (client) => {
        const lock = await client.getMailboxLock('INBOX');
        try {
          const uids = await uidsForSubjects(client, subjects);
          if (uids.length) await client.messageDelete(uids, { uid: true });
        } finally {
          lock.release();
        }
      });
    } catch (e) {
      console.warn('[connected-archive-daemon] purge failed:', e.message);
    }
  }

  // ── The daemon, queried directly (anti-vacuity + custody proof) ────────

  /** `error`/`stackTrace` in an executeAsync result is treated by the
   *  webdriver client as a failed protocol response and silently retried -
   *  `__error` avoids that trap (connected-daemon-channel.test.js). */
  const daemonRpc = (method, params) => browser.executeAsync((m, p, done) => {
    window.__TAURI_INTERNALS__.invoke('daemon_rpc', { method: m, params: p }).then((v) => done({ ok: true, v }), (e) => done({ ok: false, __error: String((e && e.message) || e) }));
  }, method, params);

  const daemonPid = (home) => {
    try { return parseInt(readFileSync(join(appDataDir(home), 'daemon.pid'), 'utf8').trim(), 10) || null; } catch { return null; }
  };

  // ── Raw event capture: the channel path, not app state ─────────────────
  //
  // `messageMutations.js`/`BulkOperationManager.js` paint UI state off these
  // same events, but their React state is not what this spec should trust -
  // `accountSlice.cancelArchive` nulls `bulkSaveProgress` on click, before
  // the daemon has actually stopped anything. A listener installed on
  // `window.__TAURI__.event` directly, independent of any component, is the
  // one source of truth for what the channel actually carried (same
  // technique `connected-daemon-channel.test.js` uses for `daemon-ping`).
  async function installRawCapture() {
    await browser.executeAsync((done) => {
      window.__ARCHIVE_DAEMON_EVENTS__ = [];
      Promise.all(['archive-progress', 'bulk-operation-progress'].map((name) =>
        window.__TAURI__.event.listen(name, (e) => window.__ARCHIVE_DAEMON_EVENTS__.push({ name, payload: e.payload, at: Date.now() }))))
        .then(() => done(true), () => done(false));
    });
  }

  const rawEvents = (name) => browser.execute((n) => (window.__ARCHIVE_DAEMON_EVENTS__ || []).filter((e) => e.name === n), name);

  // ── The UI ───────────────────────────────────────────────────────────

  const rows = () => browser.execute((prefixes) => {
    const out = [];
    for (const row of document.querySelectorAll('[data-testid="email-row"]')) {
      const text = row.innerText || '';
      const prefix = prefixes.find((p) => text.includes(p));
      if (!prefix) continue;
      out.push({ subject: text, checked: !!row.querySelector('input[type="checkbox"]')?.checked });
    }
    return out;
  }, [PREFIX_A, PREFIX_C, PREFIX_D]);

  function toggleRow(subject) {
    return browser.execute((needle) => {
      for (const row of document.querySelectorAll('[data-testid="email-row"]')) {
        if (!(row.innerText || '').includes(needle)) continue;
        const box = row.querySelector('input[type="checkbox"]');
        if (!box) return false;
        box.click();
        return true;
      }
      return false;
    }, subject);
  }

  async function selectSubjects(subjects) {
    for (const s of subjects) {
      await browser.waitUntil(() => toggleRow(s), { timeout: 15_000, interval: 300, timeoutMsg: `could not check the row for "${s}"` });
    }
  }

  const selectedCount = () => browser.execute(() => window.__MAIL_STORE__?.getState?.().selectedEmailIds?.size ?? 0);

  const clickByTitle = (title) => browser.execute((t) => {
    const btn = document.querySelector(`button[title="${t}"]`);
    if (!btn || btn.offsetHeight === 0) return false;
    btn.click();
    return true;
  }, title);

  const clickByText = (selector, text) => browser.execute((sel, needle) => {
    for (const el of document.querySelectorAll(sel)) {
      if ((el.textContent || '').trim() === needle && el.offsetHeight > 0 && !el.disabled) { el.click(); return true; }
    }
    return false;
  }, selector, text);

  const clickTestId = (testid) => browser.execute((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    if (!el || el.offsetHeight === 0 || el.disabled) return false;
    el.click();
    return true;
  }, testid);

  /** Archive the current selection via SelectionActionBar's "Archive
   *  selected" button - `saveEmailsLocally`/`_archiveGroup`, one
   *  `archive_emails` call for the whole selection. */
  async function clickArchiveSelected() {
    await browser.waitUntil(() => clickByTitle('Archive selected'), {
      timeout: 15_000, interval: 300, timeoutMsg: 'SelectionActionBar never offered "Archive selected"',
    });
  }

  /** `Select messages…` -> Next -> Delete -> confirm -> confirm again.
   *  Assumes the wanted rows are already checked (selectedCount > 0), so
   *  step 1's date-range presets are never touched - an exact selection by
   *  subject, not a range that could also catch yoda's other fixtures. */
  async function runBulkDeleteOnSelection() {
    await browser.waitUntil(() => browser.execute(() => {
      const btn = document.querySelector('.mail-list-toolbar button[aria-label="Select messages…"]');
      if (!btn) return false;
      btn.click();
      return true;
    }), { timeout: 15_000, interval: 300, timeoutMsg: '"Select messages…" never became available' });
    await browser.waitUntil(() => browser.execute(() => document.body.innerText.includes('Bulk Email Operations')), {
      timeout: 15_000, interval: 300, timeoutMsg: 'Bulk modal never opened',
    });
    await browser.waitUntil(() => clickByText('button', 'Next'), { timeout: 15_000, interval: 300, timeoutMsg: '"Next" never became clickable (selectedCount stayed 0?)' });
    await browser.waitUntil(() => browser.execute(() => document.body.innerText.includes('Choose Action for')), {
      timeout: 15_000, interval: 300, timeoutMsg: 'Modal never advanced to the action step',
    });
    await browser.waitUntil(() => clickTestId('bulk-action-delete'), { timeout: 15_000, interval: 300, timeoutMsg: 'Could not select the Delete action' });
    await browser.waitUntil(() => clickTestId('bulk-step2-confirm'), { timeout: 15_000, interval: 300, timeoutMsg: 'Step 2 confirm never became clickable' });
    await browser.waitUntil(() => clickTestId('bulk-delete-confirm'), { timeout: 15_000, interval: 300, timeoutMsg: 'Delete confirmation dialog never appeared' });
  }

  const curDir = () => join(appDataDir(browser.testDataDir), 'Maildir', yodaId, 'INBOX', 'cur');
  const eachEmlExists = (uids) => {
    if (!existsSync(curDir())) return false;
    const names = readdirSync(curDir());
    return uids.every((uid) => names.some((n) => n.startsWith(`${uid}:`)));
  };

  before(async function () {
    await waitForApp();
    await waitForEmails();
    yodaId = (browser.mockAccounts || []).find((a) => a.email === YODA)?.id;
    expect(yodaId).toBeTruthy();

    pidBefore = daemonPid(browser.testDataDir);
    expect(pidBefore).toBeGreaterThan(0);

    batchA = await seedBatch(PREFIX_A, COUNT_A);
    batchC = await seedBatch(PREFIX_C, COUNT_C);
    batchD = await seedBatch(PREFIX_D, COUNT_D);

    await switchToFolder(YODA, 'INBOX');
    await browser.waitUntil(async () => {
      const r = await rows();
      return [...batchA, ...batchC, ...batchD].every((m) => r.some((row) => row.subject.includes(m.subject)));
    }, { timeout: 60_000, interval: 500, timeoutMsg: "yoda's INBOX never rendered all three seeded batches" });

    await installRawCapture();
  });

  after(purgeAll);

  it('(a)/(b): archives a full batch through the daemon - camelCase progress events, .eml files and custody rows the daemon itself wrote', async function () {
    await selectSubjects(batchA.map((m) => m.subject));
    expect(await selectedCount()).toBe(COUNT_A);
    await clickArchiveSelected();

    // The click clears the selection synchronously (messageMutations.js's
    // saveSelectedLocally) - proof the archive actually started, before
    // waiting on the slower disk/event proof below.
    await browser.waitUntil(async () => (await selectedCount()) === 0, {
      timeout: 15_000, interval: 200, timeoutMsg: 'selection was never cleared - did the click land?',
    });

    let finalFrame = null;
    await browser.waitUntil(async () => {
      const events = await rawEvents('archive-progress');
      finalFrame = events.find((e) =>
        e.payload.operation === 'archive' && e.payload.accountId === yodaId && e.payload.mailbox === 'INBOX'
        && e.payload.active === false && (e.payload.completed + e.payload.errors) >= COUNT_A);
      return !!finalFrame;
    }, { timeout: 60_000, interval: 300, timeoutMsg: 'archive-progress never reported completion for batch A' });

    // (a) operation + camelCase, on every frame this run emitted - not just
    // the final one, so a mid-run snake_case regression would still be caught.
    const own = (await rawEvents('archive-progress')).filter((e) =>
      e.payload.accountId === yodaId && e.payload.mailbox === 'INBOX' && e.payload.operation === 'archive');
    expect(own.length).toBeGreaterThan(0);
    for (const { payload } of own) {
      expect(payload.operation).toBe('archive');
      expect(Object.prototype.hasOwnProperty.call(payload, 'accountId')).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(payload, 'mailbox')).toBe(true);
      // The old shape's one explicitly-renamed field, kept snake_case
      // everywhere else pre-3.3 - must be entirely gone now.
      expect(Object.prototype.hasOwnProperty.call(payload, 'last_uid')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(payload, 'account_id')).toBe(false);
    }
    expect(finalFrame.payload.completed).toBe(COUNT_A);
    expect(finalFrame.payload.errors).toBe(0);

    // (b) the .eml files are really on disk...
    const uids = batchA.map((m) => m.uid);
    await browser.waitUntil(() => eachEmlExists(uids), {
      timeout: 30_000, interval: 300, timeoutMsg: `not every batch-A uid reached ${curDir()}`,
    });

    // ...and custody rows exist for them, appended by the DAEMON's own
    // in-process custody write (Task 3.4), read back through the same
    // `local_index_read` route `custody.rs` backs with
    // `mailvault_core::custody::entries` - not re-derived from disk here.
    const idx = await daemonRpc('local_index_read', { accountId: yodaId, mailbox: 'INBOX' });
    if (!idx.ok) throw new Error(`local_index_read failed: ${idx.__error}`);
    const entries = idx.v ? JSON.parse(idx.v) : [];
    for (const { uid, subject } of batchA) {
      const row = entries.find((e) => Number(e.uid) === uid);
      if (!row) throw new Error(`custody has no row for uid ${uid} ("${subject}"): ${JSON.stringify(entries)}`);
      expect(row.subject).toBe(subject);
    }
  });

  it('(c): cancel_archive, clicked through the UI, genuinely stops an in-flight archive', async function () {
    // Batch A's own run (previous test) already left a final `active:false`
    // frame for this same accountId/mailbox/operation in the shared capture
    // array - mark "now" on the page's own clock so this test only looks at
    // frames its own run produced.
    const since = await browser.execute(() => Date.now());

    // Fires the instant the first real completion (or error) for THIS run
    // reaches the page - inside the browser's own event loop, no WebDriver
    // round trip on the critical path. With COUNT_C (10) > the daemon's
    // 5-permit semaphore, several uids are still queued on a permit at that
    // instant, which is exactly what a naive un-cancellable run would race
    // past and this cancel must catch.
    await browser.executeAsync((accountId, mailbox, done) => {
      window.__ARCHIVE_C_CANCELLED__ = false;
      window.__TAURI__.event.listen('archive-progress', (e) => {
        const p = e.payload;
        if (p.operation !== 'archive' || p.accountId !== accountId || p.mailbox !== mailbox) return;
        if (window.__ARCHIVE_C_CANCELLED__) return;
        if (p.completed >= 1 || p.errors >= 1) {
          window.__ARCHIVE_C_CANCELLED__ = true;
          window.__MAIL_STORE__.getState().cancelArchive();
        }
      }).then(() => done(true), () => done(false));
    }, yodaId, 'INBOX');

    await selectSubjects(batchC.map((m) => m.subject));
    expect(await selectedCount()).toBe(COUNT_C);
    await clickArchiveSelected();

    let finalFrame = null;
    await browser.waitUntil(async () => {
      const events = await rawEvents('archive-progress');
      finalFrame = events.find((e) =>
        e.at >= since && e.payload.operation === 'archive' && e.payload.accountId === yodaId
        && e.payload.mailbox === 'INBOX' && e.payload.active === false);
      return !!finalFrame;
    }, { timeout: 60_000, interval: 300, timeoutMsg: 'archive-progress never reported a final frame for batch C' });

    // The anti-vacuity half: it must have done SOME real work before the
    // cancel landed, or "fewer than the batch" would be true trivially.
    expect(finalFrame.payload.completed).toBeGreaterThan(0);
    expect(finalFrame.payload.completed + finalFrame.payload.errors).toBeLessThan(COUNT_C);
  });

  it('(d): THE KEY REGRESSION TEST - cancel_archive does not stop a concurrent bulk delete (N4, fixed in Task 3.4/3.5)', async function () {
    await selectSubjects(batchD.map((m) => m.subject));
    expect(await selectedCount()).toBe(COUNT_D);
    await runBulkDeleteOnSelection();

    // Confirm the delete is genuinely in flight (STORE already landed,
    // EXPUNGE stalling yoda's mock 4s per uid) before touching cancel_archive.
    await browser.waitUntil(async () => (await rawEvents('bulk-operation-progress'))
      .some((e) => e.payload.phase === 'delete' && e.payload.total === COUNT_D && e.payload.active === true), {
      timeout: 30_000, interval: 200, timeoutMsg: 'bulk-operation-progress never reported the delete as active',
    });

    // No archive is running right now, so there is no Cancel button on
    // screen to click for it (`BulkSaveProgress` renders nothing without an
    // active `bulkSaveProgress`) - `accountSlice.cancelArchive` is the exact
    // function the UI's own Cancel button calls in test (c) above; invoking
    // it directly here still goes through `send('cancel_archive')` and the
    // real daemon RPC, which is what this test is actually checking.
    const cancelled = await browser.execute(() => {
      window.__MAIL_STORE__.getState().cancelArchive();
      return true;
    });
    expect(cancelled).toBe(true);

    let finalFrame = null;
    await browser.waitUntil(async () => {
      const events = await rawEvents('bulk-operation-progress');
      finalFrame = events.find((e) => e.payload.phase === 'delete' && e.payload.total === COUNT_D && e.payload.active === false);
      return !!finalFrame;
    }, { timeout: 60_000, interval: 300, timeoutMsg: 'bulk-operation-progress never reported the delete as finished' });

    // The regression signature: a conflated single-slot cancel shows up as
    // fewer completed than total with ZERO errors - a task cancel skips
    // before it can either succeed or fail, it does not count as either.
    expect(finalFrame.payload.completed).toBe(COUNT_D);
    expect(finalFrame.payload.errors).toBe(0);

    // The messages are really gone from the server, not just "reported done".
    await browser.waitUntil(async () => {
      const remaining = await withYoda(async (client) => {
        const lock = await client.getMailboxLock('INBOX');
        try { return await uidsForSubjects(client, batchD.map((m) => m.subject)); } finally { lock.release(); }
      });
      return remaining.length === 0;
    }, { timeout: 30_000, interval: 500, timeoutMsg: "batch D's messages never left yoda's INBOX on the server" });
  });

  it('(e): daemon.pid never changed across the whole run', async function () {
    const pidAfter = daemonPid(browser.testDataDir);
    expect(pidAfter).toBeGreaterThan(0);
    expect(pidAfter).toBe(pidBefore);
  });
});
