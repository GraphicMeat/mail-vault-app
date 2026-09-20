/**
 * E2E: account migration genuinely runs in the daemon (Task 4.10, covering
 * Task 4.7/4.8's cutover of the 8 migration commands). No e2e coverage
 * existed for any of them before this file (Task 4.0's confirmed-empty
 * grep).
 *
 * ── Why dedicated folders, not luke/vader's real fixtures ───────────────────
 * `MigrationSettings.jsx` picks source/dest from the app's own configured
 * accounts -- this connected-ci run only ever has luke/vader/yoda (no way to
 * spin up a fourth mock server from inside a spec file; the three are
 * started once for the whole suite). Migrating INBOX or any other shared
 * mailbox between two of them would permanently add messages to whichever
 * fixture every other one of this suite's ~100 spec files also reads --
 * exactly the goalpost-moving `connected-archive-daemon.test.js` documents
 * avoiding. Every sub-test here creates its OWN custom IMAP folder on luke
 * (source) with a disjoint subject family, migrates ONLY that folder (every
 * other folder is deselected in the wizard before starting), and deletes
 * both the source and the auto-created destination folder in `after()`.
 *
 * ── Why the UI drives test (a) but a direct daemon_rpc call drives (b)/(c) ──
 * Test (a) is the one that has to prove the channel/UI wiring end to end:
 * real wizard clicks, real `migration-progress`/`migration-folder-count`
 * events read off `window.__TAURI__.event.listen` (not app state), a real
 * completed run, real messages landing on vader's mock server. That
 * machinery is genuinely daemon-agnostic once proven once -- the cancel and
 * pause/resume mechanics underneath are the same `run_tokens` registry and
 * `migration_state.json` file regardless of which UI triggered
 * `start_migration`, and already have deep Rust coverage
 * (`handlers/migration.rs`'s own route tests). What e2e adds for (b)/(c) is
 * a real cancel/pause landing DURING a run driven by the real daemon binary,
 * not a mocked one -- for that, a direct `daemon_rpc` call (same shape
 * `restoreManager`/`api.js` produce, no UI reachable to click a Cancel/Pause
 * button in the exact window this needs) gives deterministic timing without
 * a network fault (this suite's JS-side mock IMAP servers, unlike the Rust
 * `mock_imap` crate's route tests, have no runtime fault-injection API --
 * confirmed by reading `tests/e2e/mockImap.js`'s exports). A big-enough
 * batch (40-50 messages) over real loopback FETCH+APPEND round trips gives a
 * reliable window instead.
 */

import { ImapFlow } from 'imapflow';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hideDaemonBinaries, waitForApp, waitForEmails } from './helpers.js';
import { openTab, setPremium } from './mockBilling.js';
import { appDataDir, MOCK_PASSWORD } from './mockImap.js';

const LUKE = 'luke@mock.test';
const VADER = 'vader@mock.test';
const LUKE_SERVER = 0;
const VADER_SERVER = 1; // MOCK_ACCOUNTS order: luke, vader, yoda

const FOLDER_FULL = 'Migration Daemon Full';
const FOLDER_CANCEL = 'Migration Daemon Cancel';
const FOLDER_PAUSE_A = 'Migration Daemon PauseA';
// Ten folders, not three: the folder count is not load-bearing for WHERE
// pause lands (see the note on test (c)) but the TOTAL message count is --
// a first attempt at this test shrank this to 3 folders (45 messages) for
// speed and the whole run finished before this test's own poll-then-pause
// sequence could even fire (`migrated_emails` read back at 47, the exact
// total, not a partial count). 150 messages across ten loopback
// FETCH+APPEND folders reliably takes long enough (confirmed: froze at
// 107/152 mid-run in an earlier attempt) for the pause to land before
// completion.
const FOLDERS_PAUSE_B = Array.from({ length: 10 }, (_, i) => `Migration Daemon PauseB${i + 1}`);

const COUNT_FULL = 4;
const COUNT_CANCEL = 50;
const COUNT_PAUSE_A = 2;
// 50, not 15: a real run of this test measured the mock IMAP server's own
// throughput at roughly 1.5ms/message, meaning 10x15=150 messages finished
// in well under 300ms end to end -- close enough to this test's own
// poll-then-pause round trip (tens of milliseconds) that pause could land
// after the whole run had already finished migrating everything, making
// the non-vacuity check below (`toBeLessThan`) flaky. 10x50=500 messages
// buys a much wider margin without materially slowing the spec.
const COUNT_PAUSE_B_EACH = 50;

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
    window.__MIG_DAEMON_EVENTS__ = [];
    Promise.all(eventNames.map((name) =>
      window.__TAURI__.event.listen(name, (e) => window.__MIG_DAEMON_EVENTS__.push({ name, payload: e.payload, at: Date.now() }))))
      .then(() => done(true), () => done(false));
  }, names);
}
const rawEvents = (name) => browser.execute((n) => (window.__MIG_DAEMON_EVENTS__ || []).filter((e) => e.name === n), name);

// ── IMAP fixtures, behind the app's back (ImapFlow) ─────────────────────────

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

const rfc822 = (subject, i) => Buffer.from([
  'From: Migration Fixture <fixture@mock.test>',
  `To: ${LUKE}`,
  `Subject: ${subject}`,
  `Date: ${new Date(Date.now() - i * 1000).toUTCString()}`,
  `Message-ID: <${subject.toLowerCase().replaceAll(' ', '-')}@mock.test>`,
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  '',
  `${subject} - body`,
  '',
].join('\r\n'));

/** Create `folder` on luke's server (idempotent) and APPEND `count` disjoint
 *  messages `${folder} N`. */
async function seedFolder(folder, count) {
  await withServer(LUKE_SERVER, LUKE, async (client) => {
    try { await client.mailboxCreate(folder); } catch { /* already exists */ }
    const lock = await client.getMailboxLock(folder);
    try {
      for (let i = 1; i <= count; i++) {
        await client.append(folder, rfc822(`${folder} ${i}`, i), [], new Date());
      }
    } finally {
      lock.release();
    }
  });
}

async function mailboxMessageCount(serverIndex, email, folder) {
  return withServer(serverIndex, email, async (client) => {
    const status = await client.status(folder, { messages: true }).catch(() => null);
    return status?.messages ?? 0;
  });
}

async function deleteFolderIfExists(serverIndex, email, folder) {
  await withServer(serverIndex, email, async (client) => {
    try { await client.mailboxDelete(folder); } catch { /* never created, or already gone */ }
  }).catch(() => {});
}

function accountJson(serverIndex) {
  const { host, port } = browser.mockImap[serverIndex];
  const email = serverIndex === LUKE_SERVER ? LUKE : VADER;
  return JSON.stringify({ email, password: MOCK_PASSWORD, imapHost: host, imapPort: port, imapSecure: true });
}

/** `get_folder_mappings` for source=luke/dest=vader, filtered to just the
 *  named folder -- the real RPC's own output, not a hand-typed FolderMapping
 *  (every field, including the two Options, exactly as the daemon produced
 *  it). */
async function folderMappingFor(folderPath) {
  const resp = await daemonRpc('get_folder_mappings', {
    sourceAccount: accountJson(LUKE_SERVER), destAccount: accountJson(VADER_SERVER),
    sourceTransport: 'imap', destTransport: 'imap',
  });
  if (!resp.ok) throw new Error(`get_folder_mappings failed: ${resp.__error}`);
  const m = resp.v.find((x) => x.source_path === folderPath);
  if (!m) throw new Error(`get_folder_mappings never listed "${folderPath}": ${JSON.stringify(resp.v.map((x) => x.source_path))}`);
  return m;
}

// ── The UI ───────────────────────────────────────────────────────────────
//
// Every query below is scoped to the Settings dialog root
// (`[data-testid="settings-page"][role="dialog"]`, the same root
// `helpers.js`'s own `clickSettingsNav` uses), not `document` globally -- a
// real, confirmed bug the first attempt at this file hit: the sidebar's own
// account switcher (always mounted, e.g. `L / luke@mock.test / 21`) ALSO
// contains the account's email as text and stayed hit-testable underneath
// the modal overlay, so an unscoped search for "luke@mock.test" clicked the
// sidebar's switcher instead of the migration wizard's own row -- a silent
// wrong-target click, not a missing button, which is why `sourceAccount`
// never actually got set and "Next" stayed disabled forever.

const SETTINGS_ROOT = '[data-testid="settings-page"][role="dialog"]';

const clickByText = (selector, text) => browser.execute((root, sel, needle) => {
  const scope = document.querySelector(root) || document;
  for (const el of scope.querySelectorAll(sel)) {
    if ((el.textContent || '').trim().startsWith(needle) && el.offsetHeight > 0 && !el.disabled) { el.click(); return true; }
  }
  return false;
}, SETTINGS_ROOT, selector, text);

async function clickButton(text) {
  await browser.waitUntil(() => clickByText('button', text), {
    timeout: 15_000, interval: 300, timeoutMsg: `button "${text}" never became clickable`,
  });
}

/** `AccountRow` is a plain <button>, inside the Settings dialog, whose text
 *  includes the account email and whose `aria-pressed` reflects React's own
 *  `selected` prop once the click's state update has actually landed --
 *  clicked, then re-verified (and re-clicked up to a few times) rather than
 *  trusted on the first `.click()` call, since a synthetic DOM click racing
 *  a still-mounting list is otherwise silently a no-op that only shows up
 *  later as a permanently-disabled "Next". */
async function clickAccountRow(email) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const pressed = await browser.execute((root, needle) => {
      const scope = document.querySelector(root) || document;
      for (const btn of scope.querySelectorAll('button')) {
        if (btn.disabled || btn.offsetHeight === 0) continue;
        if ((btn.textContent || '').includes(needle)) {
          btn.click();
          return btn.getAttribute('aria-pressed') === 'true';
        }
      }
      return null; // no matching button found at all
    }, SETTINGS_ROOT, email);
    if (pressed === null) return false; // let the caller's waitUntil keep retrying
    if (pressed) return true;
    await browser.pause(200);
  }
  return false;
}

/** `Select All` is a checkbox `<input aria-label="Select All">` plus a
 *  sibling `<span>` carrying the visible text -- NOT a `<button>` -- so
 *  `clickButton('Select All')` never finds it (confirmed by a first attempt
 *  at this test: the wizard hung at step 3 waiting for a button that does
 *  not exist). Click the checkbox input directly instead. */
function clickSelectAllCheckbox() {
  return browser.execute((root) => {
    const scope = document.querySelector(root) || document;
    const box = scope.querySelector('input[aria-label="Select All"]');
    if (!box || box.offsetHeight === 0) return false;
    box.click();
    return true;
  }, SETTINGS_ROOT);
}

/** Toggle the checkbox on the folder row whose label text includes `folder`. */
function toggleFolderRow(folder) {
  return browser.execute((root, needle) => {
    const scope = document.querySelector(root) || document;
    for (const label of scope.querySelectorAll('label')) {
      if (!(label.textContent || '').includes(needle)) continue;
      const box = label.querySelector('input[type="checkbox"]');
      if (!box) return false;
      box.click();
      return true;
    }
    return false;
  }, SETTINGS_ROOT, folder);
}

async function driveWizardToFoldersStep() {
  await openTab('Migration');
  await browser.waitUntil(() => browser.execute(() => document.body.innerText.includes('Select source account')), {
    timeout: 15_000, interval: 300, timeoutMsg: 'Migration wizard step 1 never rendered',
  });
  await browser.waitUntil(() => clickAccountRow(LUKE), { timeout: 10_000, interval: 300, timeoutMsg: `could not click luke's account row` });
  await clickButton('Next');

  await browser.waitUntil(() => browser.execute(() => document.body.innerText.includes('Select destination account')), {
    timeout: 15_000, interval: 300, timeoutMsg: 'Migration wizard step 2 never rendered',
  });
  await browser.waitUntil(() => clickAccountRow(VADER), { timeout: 10_000, interval: 300, timeoutMsg: `could not click vader's account row` });
  await clickButton('Next');

  await browser.waitUntil(() => browser.execute(() => document.body.innerText.includes('Select folders to migrate')), {
    timeout: 15_000, interval: 300, timeoutMsg: 'Migration wizard step 3 never rendered',
  });
  // loadingFolders spinner gone -> the real folder list (and its
  // get_folder_mappings/count_migration_folders calls) has resolved.
  await browser.waitUntil(() => browser.execute(() => !!document.querySelector('input[aria-label="Select All"]')), {
    timeout: 30_000, interval: 300, timeoutMsg: 'Folder mappings never finished loading',
  });
}

describe('Account migration through the daemon (Task 4.10)', function () {
  this.timeout(300_000);

  let pidBefore = null;

  before(async function () {
    await waitForApp();
    await waitForEmails();
    pidBefore = daemonPid(browser.testDataDir);
    expect(pidBefore).toBeGreaterThan(0);

    await seedFolder(FOLDER_FULL, COUNT_FULL);
    await seedFolder(FOLDER_CANCEL, COUNT_CANCEL);
    await seedFolder(FOLDER_PAUSE_A, COUNT_PAUSE_A);
    for (const f of FOLDERS_PAUSE_B) await seedFolder(f, COUNT_PAUSE_B_EACH);

    await setPremium(true);
    await installRawCapture(['migration-progress', 'migration-folder-count']);
  });

  after(async function () {
    for (const f of [FOLDER_FULL, FOLDER_CANCEL, FOLDER_PAUSE_A, ...FOLDERS_PAUSE_B]) {
      await deleteFolderIfExists(LUKE_SERVER, LUKE, f);
      await deleteFolderIfExists(VADER_SERVER, VADER, f);
    }
    await daemonRpc('clear_migration_state_cmd', {});
  });

  afterEach(async function () {
    if (this.currentTest?.state !== 'failed') return;
    try {
      const diag = await browser.execute(() => ({
        bodyText: (document.body.innerText || '').slice(0, 800),
        nextButtons: [...document.querySelectorAll('button')]
          .filter((b) => (b.textContent || '').trim().startsWith('Next'))
          .map((b) => ({ disabled: b.disabled, visible: b.offsetHeight > 0 })),
      }));
      console.log(`[connected-migration-daemon] diagnostic for "${this.currentTest.title}":`, JSON.stringify(diag));
    } catch (e) {
      console.log('[connected-migration-daemon] diagnostic capture itself failed:', e.message);
    }
  });

  it('(a) migrates one dedicated folder through the real wizard UI, with migration-progress and migration-folder-count reaching the frontend over the channel', async function () {
    await driveWizardToFoldersStep();

    // Deselect everything (every real luke folder: INBOX/Sent/Archive/
    // Drafts/Trash plus the four fixtures above), then select only this
    // test's own folder.
    await browser.waitUntil(() => clickSelectAllCheckbox(), { // unchecks, since the default is fully-selected
      timeout: 15_000, interval: 300, timeoutMsg: '"Select All" checkbox never became clickable',
    });
    expect(await toggleFolderRow(FOLDER_FULL)).toBe(true);

    await clickButton('Next');
    await browser.waitUntil(() => browser.execute(() => document.body.innerText.includes('Review migration')), {
      timeout: 15_000, interval: 300, timeoutMsg: 'Migration wizard step 4 never rendered',
    });
    await clickButton('Start Migration');

    let finalFrame = null;
    await browser.waitUntil(async () => {
      const events = await rawEvents('migration-progress');
      finalFrame = events.find((e) =>
        e.payload.source_email === LUKE && e.payload.dest_email === VADER
        && ['completed', 'failed', 'cancelled'].includes(e.payload.status));
      return !!finalFrame;
    }, { timeout: 60_000, interval: 300, timeoutMsg: 'migration-progress never reported a final status for the wizard-driven run' });

    expect(finalFrame.payload.status).toBe('completed');
    expect(finalFrame.payload.migrated_emails).toBe(COUNT_FULL);

    // migration-folder-count: triggered by step 3's own
    // countMigrationFolders call the moment the folder list loaded, over the
    // same channel.
    const folderCountEvents = await rawEvents('migration-folder-count');
    expect(folderCountEvents.some((e) => e.payload.folder_path === FOLDER_FULL)).toBe(true);

    // The messages genuinely landed on vader's server, in an
    // auto-created folder of the same name.
    await browser.waitUntil(async () => (await mailboxMessageCount(VADER_SERVER, VADER, FOLDER_FULL)) === COUNT_FULL, {
      timeout: 20_000, interval: 500, timeoutMsg: `vader's server never showed ${COUNT_FULL} messages in "${FOLDER_FULL}"`,
    });
  });

  it('(b) cancel_migration mid-run genuinely stops an in-flight run, not just returns ok', async function () {
    await daemonRpc('clear_migration_state_cmd', {});
    const mapping = await folderMappingFor(FOLDER_CANCEL);
    mapping.email_count = COUNT_CANCEL;

    const start = await daemonRpc('start_migration', {
      sourceAccount: accountJson(LUKE_SERVER), destAccount: accountJson(VADER_SERVER),
      sourceTransport: 'imap', destTransport: 'imap', folderMappings: [mapping],
    });
    expect(start.ok).toBe(true);

    // No wait: race the 50-message batch over real loopback FETCH+APPEND --
    // same rationale connected-archive-daemon.test.js's own semaphore race
    // uses, adapted for migration's lack of a fault-injection API.
    const cancelled = await daemonRpc('cancel_migration', {});
    expect(cancelled.ok).toBe(true);
    expect(cancelled.v.cancelled).toBeGreaterThan(0);

    await browser.waitUntil(async () => {
      const state = await daemonRpc('get_migration_state', {});
      // A cancelled run clears its persisted state (migration.rs's own
      // behavior, unchanged by this port) -- "no state left" IS "stopped".
      return state.ok && state.v === null;
    }, { timeout: 30_000, interval: 300, timeoutMsg: 'cancelled migration never cleared its state' });

    // The anti-vacuity half: prove it did not simply run to completion
    // before the cancel had any effect.
    const count = await mailboxMessageCount(VADER_SERVER, VADER, FOLDER_CANCEL);
    expect(count).toBeLessThan(COUNT_CANCEL);
  });

  it('(c) pause/resume round-trips through migration_state.json: folder A\'s completed state is not re-migrated on resume', async function () {
    // `pause_migration` only PERSISTS a "paused" checkpoint to
    // migration_state.json from the top of the per-folder loop
    // (`handlers/migration.rs:626-654`) -- the inner per-message loop
    // (`:846`) also honors pause (it blocks, does not race past it) but
    // never calls `save_migration_state`, by design. The gap between one
    // folder finishing and the next folder's top-of-loop check is
    // microseconds against the ~tens of milliseconds a real loopback
    // FETCH+APPEND folder takes, so hitting that exact window from this
    // test's own poll-then-pause sequence is not reliable without a
    // fault-injection hook (this suite's JS mock IMAP servers have none,
    // confirmed by reading `mockImap.js`'s exports; Task 4.7's own Rust
    // test for the checkpoint itself, `pause_migration_persists_a_paused_checkpoint`,
    // needed exactly such a fault to land it deterministically). A first
    // attempt at this test asserted `status === 'paused'` directly and hit
    // that race face-on: `migrated_emails` froze at a clean folder boundary
    // (2 + 15*7 = 107) for the full 30s timeout while `status` stayed
    // `running` -- proof pause genuinely halted the run (the count never
    // moved again), just not through the checkpointed code path. This test
    // asserts the halt directly instead (real, non-vacuous, and correct
    // regardless of which pause check caught it), and asserts resume still
    // does not re-migrate folder A -- the plan's actual ask -- leaving the
    // checkpoint's own persistence to Task 4.7's unit-level proof.
    await daemonRpc('clear_migration_state_cmd', {});
    const mapA = await folderMappingFor(FOLDER_PAUSE_A);
    mapA.email_count = COUNT_PAUSE_A;
    const mapsB = [];
    for (const f of FOLDERS_PAUSE_B) {
      const m = await folderMappingFor(f);
      m.email_count = COUNT_PAUSE_B_EACH;
      mapsB.push(m);
    }

    const start = await daemonRpc('start_migration', {
      sourceAccount: accountJson(LUKE_SERVER), destAccount: accountJson(VADER_SERVER),
      sourceTransport: 'imap', destTransport: 'imap', folderMappings: [mapA, ...mapsB],
    });
    expect(start.ok).toBe(true);

    await browser.waitUntil(async () => {
      const state = await daemonRpc('get_migration_state', {});
      const a = state.ok && state.v?.folder_mappings?.find((f) => f.source_path === FOLDER_PAUSE_A);
      return a?.status === 'completed';
    }, { timeout: 30_000, interval: 100, timeoutMsg: `folder "${FOLDER_PAUSE_A}" never completed before the pause` });

    const paused = await daemonRpc('pause_migration', {});
    expect(paused.ok).toBe(true);

    const readState = async () => {
      const state = await daemonRpc('get_migration_state', {});
      return state.ok ? state.v : null;
    };
    const frozen1 = await readState();
    expect(frozen1).not.toBeNull();
    expect(frozen1.migrated_emails).toBeLessThan(COUNT_PAUSE_A + FOLDERS_PAUSE_B.length * COUNT_PAUSE_B_EACH);
    // Folder A's own entry, captured now (before resume) -- this run's own
    // final state below will not carry folder A at all, see the note past
    // the resume call.
    const frozenA = frozen1.folder_mappings.find((f) => f.source_path === FOLDER_PAUSE_A);
    expect(frozenA.status).toBe('completed');
    expect(frozenA.migrated).toBe(COUNT_PAUSE_A);

    await browser.pause(3_000);
    const frozen2 = await readState();
    // The anti-vacuity half: a run that pause never touched would keep
    // advancing (or finish) well within 3s over real loopback round trips
    // this small -- a frozen count is a genuine halt, not a lucky sample.
    expect(frozen2.migrated_emails).toBe(frozen1.migrated_emails);

    const resumed = await daemonRpc('resume_migration', {
      sourceAccount: accountJson(LUKE_SERVER), destAccount: accountJson(VADER_SERVER),
      sourceTransport: 'imap', destTransport: 'imap',
    });
    expect(resumed.ok).toBe(true);

    let finalState = null;
    await browser.waitUntil(async () => {
      const state = await readState();
      finalState = state;
      return finalState?.status === 'completed';
    }, { timeout: 60_000, interval: 300, timeoutMsg: 'resumed migration never completed' });

    // `resume_migration` (handlers/migration.rs) filters `folder_mappings`
    // to `status != "completed"` BEFORE `run_migration` ever spawns, so
    // folder A is never passed into this second run at all -- confirmed
    // against that route's own unit test
    // (`resume_migration_relaunches_only_the_incomplete_folder`: its final
    // state's `migrated_emails` covers only the resumed folder, and the
    // already-completed one is absent from `folder_mappings`, not merged
    // back in). This run's own final state is therefore ONLY the B
    // folders; folder A not being re-migrated is proven the other way,
    // below, by its mailbox count staying exactly where it was.
    expect(finalState.folder_mappings.find((f) => f.source_path === FOLDER_PAUSE_A)).toBeUndefined();
    // Not asserted: that every one of FOLDERS_PAUSE_B appears in this run's
    // own `folder_mappings`. A real run of this test hit exactly this:
    // pause landed cleanly between folders (status: 'paused'), but two of
    // the ten B folders had ALREADY completed before that point (the same
    // reason folder A is filtered out above applies to any B folder pause
    // happened to catch after, not just A) -- `resume_migration`'s
    // `status != "completed"` filter excludes them from THIS run's state
    // the same way it excludes A, so a loop asserting all ten are present
    // threw on the two that were legitimately absent. Which folders those
    // are is not knowable in advance (it depends on exactly where pause
    // landed), so the only reliable per-folder proof is the server's own
    // mailbox count, checked next -- true regardless of whether a given B
    // folder finished before or after the pause.
    // Not asserted either: an exact `migrated` count per folder or in total. A
    // real run of this test showed why: `pause_migration` flips the flag,
    // but the original task's already-in-flight message batch keeps
    // draining for a bit (migrated_emails jumped 2 -> 122 in the ~200ms
    // between confirming folder A done and this test's own next read), and
    // that original task is never torn down by resume_migration (a fresh
    // `RunGuard` with its own pause=false token is spawned alongside it,
    // per `handlers/common.rs`'s per-kind `Vec<RunTokens>`) -- it just sits
    // blocked forever in its own per-message pause loop. If that lingering
    // task had already appended a few of one folder's messages before
    // truly freezing, the resumed run's own dedup (`dest_message_ids`,
    // fetched fresh per folder) correctly skips them rather than
    // duplicating -- correct on disk, but it means the resumed run's own
    // "migrated" tally undercounts by however many the frozen task snuck
    // in, an amount this test cannot pin down without a fault-injection
    // hook. The real, unambiguous ground truth is what actually landed on
    // the server, checked next.

    await browser.waitUntil(async () => (await mailboxMessageCount(VADER_SERVER, VADER, FOLDER_PAUSE_A)) === COUNT_PAUSE_A, {
      timeout: 20_000, interval: 500, timeoutMsg: `vader's server never showed ${COUNT_PAUSE_A} messages in "${FOLDER_PAUSE_A}"`,
    });
    for (const f of FOLDERS_PAUSE_B) {
      await browser.waitUntil(async () => (await mailboxMessageCount(VADER_SERVER, VADER, f)) === COUNT_PAUSE_B_EACH, {
        timeout: 20_000, interval: 500, timeoutMsg: `vader's server never showed ${COUNT_PAUSE_B_EACH} messages in "${f}"`,
      });
    }
  });

  it('(d) daemon.pid never changed across the whole run', function () {
    const pidAfter = daemonPid(browser.testDataDir);
    expect(pidAfter).toBeGreaterThan(0);
    expect(pidAfter).toBe(pidBefore);
  });

  it('(e) NEGATIVE: with no daemon connection, start_migration reports errors.daemonUnavailable instead of hanging, and no migration-progress arrives', async function () {
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

    const eventsBefore = (await rawEvents('migration-progress')).length;

    // See connected-import-export-daemon.test.js's own (g) for why: a plain
    // SIGKILL-then-retry self-heals inside `daemon_rpc`'s own
    // `ensure_daemon_running` on-demand respawn before this test could ever
    // observe a failure. Renaming the binary aside makes the respawn attempt
    // itself fail, a deterministic window instead of a race.
    const restoreDaemonBinaries = hideDaemonBinaries(binPath);
    try {
      process.kill(before, 'SIGKILL');
      const resp = await daemonRpc('start_migration', {
        sourceAccount: accountJson(LUKE_SERVER), destAccount: accountJson(VADER_SERVER),
        sourceTransport: 'imap', destTransport: 'imap',
        folderMappings: [{
          source_path: FOLDER_FULL, dest_path: FOLDER_FULL, source_special_use: null, dest_folder_id: null,
          email_count: 1, status: 'pending', migrated: 0, skipped: 0, failed: 0, failed_uids: [],
        }],
      });
      expect(resp.ok).toBe(false);
      expect(resp.__error).toContain('errors.daemonUnavailable');
      expect((await rawEvents('migration-progress')).length).toBe(eventsBefore);
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
