import { resolve, join } from 'path';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { spawn, execFileSync } from 'child_process';
import {
  buildMockServer,
  startMockImap,
  scenario,
  slowCommand,
  slowCommandWith,
  dropNthCommandWith,
  unreadableBody,
  bodyFetchDropsAlways,
  unreachableMessage,
  vanishedMessage,
  mockAccount,
  seedAccounts,
  resetAppState,
  stopDaemon,
  appDataDir,
  seedLegacyVault,
  seedLegacyCustody,
  seedCorruptCustody,
  seedAttachmentSearchMessage,
  seedIndexBacklog,
  seedDamagedSearchIndex,
  MOCK_PASSWORD,
  SLOW_APPEND_MARKER,
} from './tests/e2e/mockImap.js';
import { startMockGraph } from './tests/e2e/mockGraph.js';

// App binary path (debug build with webdriver feature). Cargo builds into the
// workspace target dir, not src-tauri/target — the old path pointed at a binary
// nothing writes any more.
const appBinary = process.env.TAURI_APP_BINARY || resolve(
  import.meta.dirname,
  'target/debug/mailvault'
);

// tauri-wd's port, one source of truth. A parallel clone of this repo (the
// mac mini's mv-* runners, used for physical isolation because wdio needs a
// fixed unique port) used to need this literal sed'd in three separate spots
// here — miss one and two clones silently share a port (mv-bugs4 inherited
// mv-recov's 4498 this way until someone noticed). Set E2E_TAURI_WD_PORT once
// per clone instead.
const TAURI_WD_PORT = Number(process.env.E2E_TAURI_WD_PORT) || 4444;

// Isolated HOME for the app under test. Everything the app and its daemon touch
// — app_data_dir(), the Maildir, ~/.mailvault/mv.sock — hangs off HOME, so
// overriding it here is what actually keeps a run away from real app state.
// (The old MAILVAULT_DATA_DIR was read by nothing.)
const testDataDir = process.env.E2E_DATA_DIR || mkdtempSync(join(tmpdir(), 'mailvault-e2e-'));

const IS_WIN = process.platform === 'win32';

// Windows ignores HOME: the app and daemon resolve their dirs from USERPROFILE
// and LOCALAPPDATA (src-core/src/paths.rs, which also derives the daemon's pipe
// name from USERPROFILE). WebView2 keeps its profile beside the exe unless
// told otherwise; it lives outside the data dir resetAppState wipes, as
// WebKit's does on macOS.
const isolatedEnv = IS_WIN ? {
  HOME: testDataDir,
  USERPROFILE: testDataDir,
  LOCALAPPDATA: join(testDataDir, 'AppData', 'Local'),
  APPDATA: join(testDataDir, 'AppData', 'Roaming'),
  WEBVIEW2_USER_DATA_FOLDER: join(testDataDir, 'AppData', 'Local', 'EBWebView'),
} : { HOME: testDataDir };
// Known folders such as Downloads are stored as `%USERPROFILE%\Downloads`, so
// they follow the override too, but only if they exist: a missing one fails
// to resolve ("unknown path") instead of being created.
if (IS_WIN) {
  for (const dir of ['Downloads', 'Documents']) mkdirSync(join(testDataDir, dir), { recursive: true });
}

/**
 * Windows pids of `mailvault.exe` at this run's binary, or (with `underRepo`)
 * of any process whose executable sits under this checkout's `target/`, plus
 * `tauri-wd.exe` (no product shares that name). Never `mailvault.exe` by
 * image name: an installed MailVault is `mailvault.exe` too.
 */
function winPids({ underRepo = false } = {}) {
  const filter = underRepo
    ? `$_.Name -eq 'tauri-wd.exe' -or $_.ExecutablePath -like '${join(import.meta.dirname, 'target')}\\*'`
    : `$_.ExecutablePath -eq '${appBinaryExe()}'`;
  const out = execFileSync('powershell', ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process | Where-Object { ${filter} } | ForEach-Object { $_.ProcessId }`],
  { encoding: 'utf8', windowsHide: true });
  return out.split(/\s+/).filter(Boolean);
}

const appBinaryExe = () => resolve(appBinary.endsWith('.exe') ? appBinary : `${appBinary}.exe`);

function winKillTree(pid) {
  try { execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true }); } catch { /* already gone */ }
}

// Two mock IMAP accounts: connected-* specs cover account switching and the
// unified inbox, which need more than one, and separate servers keep their
// mailboxes distinguishable.
// Account 2's INBOX is deliberately larger than both load windows — the 500 the
// app paints from cache and the 200 it pages off the server — so specs have a
// mailbox that is genuinely partially loaded until something scrolls it.
// No FETCH delay: a fault here is paid by all eleven specs, and at 700 messages
// it starved the webview badly enough to stall unrelated suites.
const BIG_INBOX = 700;

// Account ids must be 36-char UUIDs, as the app's own `crypto.randomUUID()` ids
// are: db/emails.js parses the `accountId-mailbox-uid` local id with a 36-char
// prefix and silently no-ops when it doesn't match. Short readable ids made
// every local-Maildir delete (unarchive, export) a no-op in the suite only.
let MOCK_ACCOUNTS = [
  // Account 1 carries the one HTML message in the suite (newest in its INBOX):
  // plain-text bodies never reach the iframe render path that connected-html-render
  // asserts on.
  {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'luke@mock.test',
    subjectPrefix: 'Luke message',
    htmlQuoted: true,
    // connected-storage-matrix needs a bigger, differently-named Archive
    // fixture than the default 3 "Archived message" — confirmed no other
    // spec reads luke's Archive folder before repurposing it this way.
    archiveCount: 4,
    archiveSubjectPrefix: 'Luke archive',
    // A folder nothing else opens, carrying the one message whose body fetch
    // always dies with the socket — the 2026-08-30 report: "Server refused UID
    // FETCH 204: connection lost", where Try again worked on the FIRST press
    // because press two got a new connection (ImapPool::run_read).
    //
    // Permanent, not "dies once then works", and that is not a simplification:
    // an ordinal fault is global to the RUN (one mock server per account, alive
    // across all 58 spec files) and is spent by whoever fetches first —
    // AccountPipeline caches every body in an opened mailbox with a 3s retry
    // queue, and connected-archive-flow sweeps the whole account seven minutes
    // before this spec runs. The exact retry COUNT is pinned in Rust instead
    // (src-core/tests/imap_session.rs), where the server is the test's alone.
    //
    // 9302 is left unfaulted on purpose: same folder, same account, and it must
    // render — which is what makes 9301's failure a property of the message and
    // not of the folder.
    //
    // 9303 is connected-pgp's OpenPGP-encrypted message, parked here because
    // this folder is only ever read by subject: nothing counts its messages.
    extraMailbox: { name: 'Flaky', count: 2, subjectPrefix: 'Flaky message', uidStart: 9301, pgpUid: 9303 },
    // bson73's shape (discussion #1): five levels, and the leaf at the bottom
    // of two different branches has the same name. Parked on luke because it is
    // the only account no skipFolders spec counts folders through.
    //
    // "Project B" and its "Invoices" are deliberately NOT listed: a server may
    // LIST a leaf whose parents are not themselves mailboxes, and the tree has
    // to draw them anyway or the subtree is unreachable.
    nestedMailboxes: [
      'Kunden',
      'Kunden/Company XY',
      'Kunden/Company XY/Project A',
      'Kunden/Company XY/Project A/Invoices',
      'Kunden/Company XY/Project A/Invoices/erledigt',
      'Kunden/Company XY/Project B/Invoices/erledigt',
    ],
    faults: [
      ...bodyFetchDropsAlways(9301),
      // connected-sent-single-copy: one reply's Sent APPEND is stored only
      // after the client gave up on it, and answered after the old 30 s
      // compose listener. Scoped to that message by its Subject token.
      slowCommandWith('APPEND', SLOW_APPEND_MARKER, 40_000),
    ],
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    email: 'vader@mock.test',
    subjectPrefix: 'Vader message',
    inbox: BIG_INBOX,
    // Its INBOX total is asserted verbatim by connected-list-header.
    crossFolderThread: false,
    // connected-storage-matrix's own dedicated mailbox — see that file's
    // header comment for why it's safe (vader is never the active account
    // in a visual-regression screenshot, and this never touches vader's
    // INBOX or its Archive folder, the latter already permanently consumed
    // by connected-bulk-delete-everywhere.test.js).
    extraMailbox: { name: 'Matrix', count: 6, subjectPrefix: 'Vader matrix' },
  },
  // Account 3 exists to carry faults. Faults are per-account with no
  // per-mailbox scoping (src-mock-imap/src/scenario.rs), so slowing a server
  // command on luke or vader is paid by every spec that touches them — the
  // reason in-flight delete coverage was dropped once already. A third account
  // that nothing else reads makes that coverage free.
  //
  // Three properties, all deliberate:
  //   - MOVE and EXPUNGE stall 4s. Those are the two commands a server delete
  //     ends on (src-core/src/imap/mod.rs: UID MOVE to Trash when the server
  //     advertises MOVE, else COPY + STORE \Deleted + UID EXPUNGE), so a delete
  //     here stays genuinely in flight long enough to switch account, switch
  //     folder, or reload underneath it. Nothing else is slowed: SELECT and
  //     FETCH run at full speed, so browsing this account costs nothing.
  //   - Its UIDs start at 901, which (dates are derived from the UID — see
  //     mockImap.js `stamp`) makes its mail the NEWEST in the suite. The
  //     unified inbox sorts date-descending across accounts, and vader's 700
  //     INBOX messages otherwise fill every rendered row — no luke message can
  //     reach the visible window at all. This account's rows land at the top,
  //     which is what makes a unified-inbox assertion possible without
  //     scrolling a virtualized list past 600 rows.
  //   - Message 907's body fetch stalls 3s and then answers NO — that one
  //     message only. The fault matches the command's arguments, so header
  //     pages (`BODY.PEEK[HEADER.FIELDS …]`), every other uid, and the delete
  //     path above are untouched. connected-email-viewer reads it: the viewer
  //     has to show a loader while the body is on the wire and a named error
  //     with a retry when it never arrives, instead of quietly printing the
  //     subject line as if it were the body.
  //   - Message 908 is refused OUTRIGHT — its body fetch AND the `(UID)` probe
  //     that follows an empty one. That is what Gmail did to a real INBOX
  //     message on 2026-08-24, and because both refusals arrive as an empty
  //     stream with no error, the app called a message sitting in the list
  //     deleted. The viewer has to carry the server's own words instead.
  //   - Message 909 answers OK-with-no-rows to both, which is what a server
  //     says about a uid it does not have. The other half of the same
  //     2026-08-24 report: the message really had been deleted from the
  //     mailbox elsewhere, and its row sat at the top of the list erroring on
  //     every click. A proven absence has to take the row with it.
  //
  // Cost: the sidebar gains a third account avatar, which shifts every
  // visual-* baseline. Those specs are `local-manual` and never run in CI;
  // regenerating them is a developer-local step.
  {
    id: '33333333-3333-4333-8333-333333333333',
    email: 'yoda@mock.test',
    subjectPrefix: 'Yoda message',
    inbox: 9,
    inboxUidStart: 901,
    // uid 910: the PNG+PDF message connected-attachments opens. Newest in the
    // whole suite, so it heads All Inboxes without scrolling — which is the
    // view the 2026-09-04 "Failed to download" was reported from. Its subject
    // matches no other spec's `Yoda message \d+` pattern, and yoda's INBOX
    // count is asserted nowhere.
    withAttachments: true,
    crossFolderThread: false,
    // A folder name in IMAP modified UTF-7 (RFC 3501 §5.1.3) — "Bokelmühle"
    // exactly as bson73's server sends it (discussion #1). His server stores
    // the name decomposed, so only the combining diaeresis is escaped and the
    // plain "u" stays literal, which is why the app printed
    // "Bokelmu&Awg-hle". Parked on yoda: nothing else reads its folder list.
    //   - Its uids start at 9101 so a fault can name a message in THIS folder
    //     and nowhere else: faults match a uid with no mailbox scoping, and the
    //     default range (1..3) is also Sent's and Archive's.
    searchMailbox: { name: 'Search Missing', count: 0 },
    extraMailbox: { name: 'Bokelmu&Awg-hle', count: 3, subjectPrefix: 'Yoda umlaut', uidStart: 9101 },
    faults: [
      slowCommand('MOVE', 4000),
      slowCommand('EXPUNGE', 4000),
      // Only these search shapes are slowed/dropped, so unrelated specs using
      // yoda's otherwise-dedicated server do not pay for search race fixtures.
      slowCommandWith('SEARCH', 'TEXT "BODY"', 5000),
      slowCommandWith('SEARCH', 'TEXT "LUKE MESSAGE', 2500),
      dropNthCommandWith('SEARCH', 'TEXT "YODA SEARCH RETRY FIXTURE', 1),
      ...unreadableBody(907, 3000),
      ...unreachableMessage(908),
      ...vanishedMessage(909),
      // One message of the umlaut folder's three is refused outright. That
      // folder is LAST in yoda's LIST order, so connected-backup-partial-failure
      // can back it up alone (skipFolders: 6) and get a run that saves 2 of 3 —
      // the shape that used to notify "Backup failed - Unknown error".
      ...unreachableMessage(9102),
    ],
  },
];

// Dedicated suites may supply actual Scenario payloads without changing the
// default fixture accounts, server lifecycle or isolated-app cleanup.
export function configureMockAccounts(accounts) {
  if (!Array.isArray(accounts) || !accounts.length) throw new Error('Mock accounts are required');
  MOCK_ACCOUNTS = accounts;
}

let tauriWd;
let mockServers = [];
let mockGraph = null;
let credentialsPath;
let seededAccounts = [];

/**
 * Seed `onboardingComplete: true`, exactly as wdio.screenshots.conf.js's
 * seedFrontendSettings already does. Every spec except the one that tests
 * onboarding itself (connected-onboarding.test.js, which clears the flag at
 * runtime) then boots straight past the six-step tour and into the seeded
 * accounts — the tour no longer has a "Get Started" button for a helper to
 * click through, and 58 unrelated spec files should not pay for it anyway.
 *
 * `resetAppState` wipes the whole data dir first, so this has to run AFTER
 * it on every spec file, not just once in onPrepare.
 */
function seedOnboardingComplete(home) {
  writeFileSync(join(appDataDir(home), 'frontend-settings.json'), JSON.stringify({
    'mailvault-settings': {
      version: 4,
      state: {
        onboardingComplete: true,
        // New installs default to expandable threads and a radial row menu,
        // whose actions mount in a portal only while open. The specs were
        // written against grouped threads and find unarchived rows by the
        // row's inline `[data-quick-action="archive"]` button, which only the
        // favorite-menu layout renders, so the harness keeps both.
        threadMode: 'grouped',
        quickActions: { defaults: { row: { mode: 'favorite-menu' } } },
      },
    },
  }));
}

/**
 * WDIO's automatic `DELETE /session` between spec files is the only thing
 * that ends the previous spec's `mailvault` process (there is no per-spec
 * `afterEach`/`afterSession` hook in this file) — and tauri-wd answers that
 * DELETE before the app has actually exited, the same "replies before it's
 * true" shape already documented for `reload()` in tests/e2e/helpers.js:84.
 * Left unchecked, the next spec's fresh session launches on top of a still-
 * dying previous instance; each survivor then slows the next one's own
 * shutdown too, so a run's orphan count accelerates rather than staying flat
 * (observed: 9 orphans at ~4min, 49 at ~19min on one connected-ci run).
 * `beforeSession` is the one guaranteed boundary between specs, so poll here
 * and force it dead before the next app launches on the same data dir/socket.
 */
async function waitForStrayAppToDie(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  if (IS_WIN) {
    // tauri-wd ends a session with TerminateProcess, so there is no graceful
    // exit to wait for: anything still here is stuck.
    for (;;) {
      const pids = winPids();
      if (!pids.length) return;
      if (Date.now() > deadline) {
        console.warn(`[wdio] mailvault.exe ${pids.join(', ')} survived taskkill for 5s`);
        return;
      }
      pids.forEach(winKillTree);
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  for (;;) {
    try {
      execFileSync('pgrep', ['-x', 'mailvault'], { stdio: 'ignore' });
    } catch {
      return; // pgrep exits non-zero when nothing matches: fully dead
    }
    if (Date.now() > deadline) {
      console.warn('[wdio] mailvault still alive after 5s — force-killing before the next session');
      try { execFileSync('pkill', ['-9', '-x', 'mailvault']); } catch { /* already gone */ }
      return;
    }
    try { execFileSync('pkill', ['-x', 'mailvault']); } catch { /* none running, or already exiting */ }
    await new Promise((r) => setTimeout(r, 150));
  }
}

export const config = {
  runner: 'local',
  specs: ['./tests/e2e/**/*.test.js'],
  // These scenarios require the dedicated Insights accounts and mailbox data.
  // Keep broad/default suites on their existing Luke/Vader fixtures.
  // The graph-* specs need the German Outlook mailbox only wdio.graph.conf.js
  // loads into the mock, so they are never part of a default selection.
  exclude: [
    './tests/e2e/connected-insights.test.js',
    './tests/e2e/ui-insights.test.js',
    './tests/e2e/graph-*.test.js',
    // Measurement, not a test: 45 minutes of deliberate idling, asserts
    // nothing. wdio.ram.conf.js selects it by name.
    './tests/e2e/ram-*.test.js',
  ],
  suites: {
    // CI-safe: no accounts needed, works from empty/welcome state
    'ui-headless': ['./tests/e2e/ui-*.test.js'],
    // CI-safe: seeded mock-IMAP accounts, no real credentials or network
    'connected-ci': ['./tests/e2e/connected-*.test.js'],
    // Developer-only: backup, migration, visual, archive, native OS input
    'local-manual': [
      './tests/e2e/backup-*.test.js',
      './tests/e2e/migration-*.test.js',
      './tests/e2e/archive-*.test.js',
      './tests/e2e/visual-*.test.js',
      './tests/e2e/native-*.test.js',
    ],
  },
  maxInstances: 1,
  capabilities: [{
    browserName: 'wry',
    'tauri:options': {
      application: appBinary,
    },
  }],
  services: [
    ['visual', {
      baselineFolder: join(import.meta.dirname, 'tests/visual/baselines'),
      screenshotPath: join(import.meta.dirname, 'tests/visual/.tmp'),
      formatImageName: '{tag}-{width}x{height}',
      autoSaveBaseline: true,
    }],
  ],
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: {
    ui: 'bdd',
    timeout: 120000,
  },
  // Session init issues getWindowHandle immediately after tauri-wd reports the
  // plugin port, but the app (debug build, cold CI runner) can need tens of
  // seconds more before the main window exists. The default 3 retries give up
  // after ~1.5s; 15 retries back off to ~50s total, which covers the boot gap.
  // A freshly booted Windows box (WebView2 host spin-up, debug build, no prior
  // warm run) is just as cold as CI even outside CI: the very first worker of
  // a real (non-CI) Windows run reliably exhausted 3 retries in ~1.5s while
  // every later worker in the same run recovered after 1-2 (2026-09-24).
  connectionRetryCount: (process.env.CI || process.platform === 'win32') ? 15 : 3,
  specFileRetries: process.env.CI ? 1 : 0,
  specFileRetriesDelay: 5,
  specFileRetriesDeferred: true,

  // Start the mock IMAP servers and tauri-wd before tests
  onPrepare: async function () {
    console.log(`[wdio] Test HOME: ${testDataDir}`);

    // A locked screen occludes every window: the webview reports `hidden`,
    // WebKit suspends the page's timers, and anything that waits without
    // automation traffic (a directory poll, a pixel capture) stalls or reads
    // black. The DOM-driven specs still pass, so the run looks green and lies.
    // 2026-09-02: connected-export sat 87 s inside one rasterize this way.
    // A runner with no password on wake flags itself locked every time the
    // display sleeps; a user-activity assertion wakes it and clears the flag,
    // so try that once before refusing.
    if (process.platform === 'darwin' && !process.env.CI) {
      const screenLocked = () => {
        try {
          return execFileSync('sh', ['-c',
            'ioreg -n Root -d1 -a | plutil -extract IOConsoleUsers.0.CGSSessionScreenIsLocked raw -o - -'],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === 'true';
        } catch { return false; /* key absent = not locked */ }
      };
      if (screenLocked()) {
        try { execFileSync('caffeinate', ['-u', '-t', '2'], { stdio: 'ignore' }); } catch { /* no caffeinate */ }
        await new Promise((r) => setTimeout(r, 1500));
        if (screenLocked()) {
          throw new Error('The runner\'s screen is locked — WebKit suspends hidden pages, so results are not trustworthy. Unlock it and rerun.');
        }
        console.log('[wdio] runner display was asleep — woke it');
      }
    }

    // A tauri-wd (or the app it launched) left behind by an aborted run still
    // owns the port / the daemon socket, and every session then fails with
    // "App did not report plugin port in time". Mock servers from an aborted
    // run just squat on memory. All three names are ours alone.
    if (IS_WIN) {
      winPids({ underRepo: true }).forEach(winKillTree);
    } else {
      for (const name of ['tauri-wd', 'mailvault', 'mock-imap-server']) {
        try { execFileSync('pkill', ['-x', name]); } catch { /* none running */ }
      }
    }

    buildMockServer();
    mockServers = await Promise.all(
      MOCK_ACCOUNTS.map((a) => a.graph ? null : startMockImap(a.scenario || scenario({
        owner: a.email,
        subjectPrefix: a.subjectPrefix,
        inbox: a.inbox,
        inboxUidStart: a.inboxUidStart,
        htmlQuoted: a.htmlQuoted,
        withAttachments: a.withAttachments,
        crossFolderThread: a.crossFolderThread,
        faults: a.faults,
        archiveCount: a.archiveCount,
        archiveSubjectPrefix: a.archiveSubjectPrefix,
        searchMailbox: a.searchMailbox,
        extraMailbox: a.extraMailbox,
        nestedMailboxes: a.nestedMailboxes,
      }))),
    );
    // A Graph entry ({ graph: true, account }) carries its whole seeded account:
    // no IMAP server, no password, the token in the credentials file.
    seededAccounts = MOCK_ACCOUNTS.map((a, i) => a.graph ? a.account : mockAccount({
      ...a, port: mockServers[i].port, smtpPort: mockServers[i].smtpPort,
    }));
    credentialsPath = seedAccounts(testDataDir, seededAccounts);

    // Outlook accounts talk to Microsoft Graph, not IMAP. The backup specs for
    // them reach this stand-in through MAILVAULT_GRAPH_BASE (loopback only).
    mockGraph = await startMockGraph();

    // onPrepare runs in the launcher, before() runs in each worker — module state
    // does not cross that boundary, but the environment workers are spawned with does.
    //
    // testDataDir MUST be exported for the same reason, and for a long time it
    // was not. Each worker re-imports this file, re-runs the `mkdtempSync`
    // fallback, and gets its OWN empty directory. Two things followed, both
    // silent: `beforeSession`'s resetAppState wiped that decoy instead of the
    // app's real data dir — so spec files were never isolated from each other,
    // they all shared one accumulating HOME — and `browser.testDataDir` pointed
    // specs at a directory the app never writes to, which is why every on-disk
    // assertion in connected-storage-matrix (vault .eml files, header sidecars)
    // could only ever read back "not there".
    process.env.E2E_DATA_DIR = testDataDir;
    process.env.E2E_MOCK_ACCOUNTS = JSON.stringify(seededAccounts);
    process.env.E2E_MOCK_SERVERS = JSON.stringify(mockServers.map((s) => s ? { host: s.host, port: s.port, smtpPort: s.smtpPort } : null));
    process.env.E2E_MOCK_INBOX_SIZES = JSON.stringify(MOCK_ACCOUNTS.map((a) => a.inbox || 40));
    process.env.E2E_MOCK_GRAPH = JSON.stringify({ base: mockGraph.base, origin: mockGraph.origin });

    mockServers.forEach((s, i) => { if (s) console.log(`[wdio] Mock for ${MOCK_ACCOUNTS[i].email}: IMAP ${s.host}:${s.port}, SMTP ${s.host}:${s.smtpPort}`); });
    console.log(`[wdio] Mock Graph: ${mockGraph.base}`);

    return new Promise((resolve) => {
      // Trace level in CI: tauri-wd relays the app's stdout lines at
      // debug/trace, which is the only place frontend/daemon boot output
      // is visible on a headless runner.
      tauriWd = spawn('tauri-wd', ['--port', String(TAURI_WD_PORT), ...(process.env.CI ? ['--log-level', 'trace'] : [])], {
        stdio: ['ignore', 'pipe', 'pipe'],
        // Own process group: killing it takes the app (and its daemon) with it.
        // Windows has no groups (and detached would open a console window);
        // onComplete kills the process tree there instead.
        detached: !IS_WIN,
        windowsHide: true,
        env: {
          ...process.env,
          // Isolated app data + daemon socket (both derive from HOME; on
          // Windows from the variables in isolatedEnv)
          ...isolatedEnv,
          // Credentials come from a file, so the run never touches the real keychain
          MAILVAULT_TEST_CREDENTIALS: credentialsPath,
          // OpenPGP keys from a file too (connected-pgp imports one).
          MAILVAULT_TEST_PGP_KEYS: join(testDataDir, 'pgp-keys.json'),
          // Mock IMAP is plaintext; the app honors this for loopback only
          MAILVAULT_IMAP_PLAINTEXT: '1',
          // Same hatch for the mock SMTP listener, same loopback-only rule.
          // Without it lettre insists on STARTTLS and no send can ever succeed.
          MAILVAULT_SMTP_PLAINTEXT: '1',
          // Graph requests go to the loopback mock above. Read by debug builds
          // only (a release binary never looks at it), and even then honoured
          // only for a loopback base.
          MAILVAULT_GRAPH_BASE: mockGraph.base,
          // Debug daemons pause this long after every 500 indexed files, so an index
          // pass over a seeded backlog lasts long enough to see and to interrupt.
          // Vaults under 500 files never pause. Release builds ignore it.
          MAILVAULT_E2E_INDEX_BATCH_PAUSE_MS: '4000',
        },
      });

      let started = false;
      function checkOutput(data) {
        const output = data.toString();
        console.log(`[tauri-wd]`, output.trim());
        if (!started && (output.includes('listening') || output.includes(String(TAURI_WD_PORT)))) {
          started = true;
          resolve();
        }
      }
      tauriWd.stdout.on('data', checkOutput);
      tauriWd.stderr.on('data', checkOutput);

      setTimeout(() => {
        if (!started) { started = true; resolve(); }
      }, 5000);
    });
  },

  onComplete: function () {
    mockServers.forEach((s) => s?.stop());
    mockGraph?.stop();

    if (tauriWd && IS_WIN) {
      winKillTree(tauriWd.pid);
    } else if (tauriWd) {
      // Negative pid = whole group: tauri-wd plus the app it launched. Killing
      // only tauri-wd leaves the app (and the daemon it spawned) running, which
      // then blocks the next run's session.
      try { process.kill(-tauriWd.pid, 'SIGTERM'); } catch (_) { /* already dead */ }
      setTimeout(() => {
        try { process.kill(-tauriWd.pid, 'SIGKILL'); } catch (_) { /* already dead */ }
      }, 2000);
    }

    // The daemon detaches from the app, so it needs its own goodbye.
    stopDaemon(testDataDir);
  },

  // Each spec file gets a fresh app state — see resetAppState().
  beforeSession: async function (_config, _capabilities, specs) {
    // Must come before resetAppState: a still-dying previous instance can
    // still be writing to the data dir resetAppState is about to wipe.
    await waitForStrayAppToDie();
    const accounts = JSON.parse(process.env.E2E_MOCK_ACCOUNTS || '[]');
    if (accounts.length) {
      resetAppState(testDataDir, accounts);
      seedOnboardingComplete(testDataDir);
      // One spec needs a vault written before the `.eml` suffix, and it has to
      // exist before the app launches: the sweep runs once during setup.
      if ((specs || []).some((s) => s.includes('connected-vault-eml-migration'))) {
        seedLegacyVault(testDataDir, accounts[0].id);
      }
      if ((specs || []).some((s) => s.includes('connected-custody-migration'))) {
        seedLegacyCustody(testDataDir, accounts[0].id);
      }
      if ((specs || []).some((s) => s.includes('connected-custody-corrupt'))) {
        seedCorruptCustody(testDataDir);
      }
      // A message with a text-attachment, planted before boot for the same
      // reason as the seeds above: the search-index sweep that discovers it
      // runs during app setup.
      if ((specs || []).some((s) => s.includes('connected-attachment-search'))) {
        seedAttachmentSearchMessage(testDataDir, accounts[0].id);
      }
      if ((specs || []).some((s) => s.includes('connected-search-index.test'))) {
        seedDamagedSearchIndex(testDataDir, accounts[0].id);
      }
      // A real index backlog before boot (search index modal, destroy, resume).
      const backlog = { 'connected-search-index-modal': 2000, 'connected-search-index-destroy': 1500, 'connected-search-index-resume': 3000 };
      for (const [name, count] of Object.entries(backlog)) {
        if ((specs || []).some((s) => s.includes(name))) seedIndexBacklog(testDataDir, accounts[0].id, count);
      }
    }
  },

  // Make the mock accounts available to all tests. TEST_EMAIL* keeps the shape
  // specs already read; they just point at mock servers now.
  before: function () {
    const accounts = JSON.parse(process.env.E2E_MOCK_ACCOUNTS || '[]');
    browser.testEnv = {
      TEST_EMAIL: accounts[0]?.email,
      TEST_EMAIL2: accounts[1]?.email,
      TEST_PASSWORD: MOCK_PASSWORD,
    };
    browser.mockAccounts = accounts;
    browser.mockImap = JSON.parse(process.env.E2E_MOCK_SERVERS || '[]');
    browser.mockInboxSizes = JSON.parse(process.env.E2E_MOCK_INBOX_SIZES || '[]');
    browser.mockGraph = JSON.parse(process.env.E2E_MOCK_GRAPH || 'null');
    browser.hasCredentials = true;
    browser.testDataDir = testDataDir;
  },

  port: TAURI_WD_PORT,
};
