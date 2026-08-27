import { resolve, join } from 'path';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { spawn, execFileSync } from 'child_process';
import {
  buildMockServer,
  startMockImap,
  scenario,
  slowCommand,
  unreadableBody,
  unreachableMessage,
  vanishedMessage,
  mockAccount,
  seedAccounts,
  resetAppState,
  stopDaemon,
  MOCK_PASSWORD,
} from './tests/e2e/mockImap.js';

// App binary path (debug build with webdriver feature). Cargo builds into the
// workspace target dir, not src-tauri/target — the old path pointed at a binary
// nothing writes any more.
const appBinary = process.env.TAURI_APP_BINARY || resolve(
  import.meta.dirname,
  'target/debug/mailvault'
);

// Isolated HOME for the app under test. Everything the app and its daemon touch
// — app_data_dir(), the Maildir, ~/.mailvault/mv.sock — hangs off HOME, so
// overriding it here is what actually keeps a run away from real app state.
// (The old MAILVAULT_DATA_DIR was read by nothing.)
const testDataDir = process.env.E2E_DATA_DIR || mkdtempSync(join(tmpdir(), 'mailvault-e2e-'));

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
const MOCK_ACCOUNTS = [
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
    crossFolderThread: false,
    // A folder name in IMAP modified UTF-7 (RFC 3501 §5.1.3) — "Bokelmühle"
    // exactly as bson73's server sends it (discussion #1). His server stores
    // the name decomposed, so only the combining diaeresis is escaped and the
    // plain "u" stays literal, which is why the app printed
    // "Bokelmu&Awg-hle". Parked on yoda: nothing else reads its folder list.
    //   - Its uids start at 9101 so a fault can name a message in THIS folder
    //     and nowhere else: faults match a uid with no mailbox scoping, and the
    //     default range (1..3) is also Sent's and Archive's.
    extraMailbox: { name: 'Bokelmu&Awg-hle', count: 3, subjectPrefix: 'Yoda umlaut', uidStart: 9101 },
    faults: [
      slowCommand('MOVE', 4000),
      slowCommand('EXPUNGE', 4000),
      ...unreadableBody(907, 3000),
      ...unreachableMessage(908),
      ...vanishedMessage(909),
      // One message of the umlaut folder's three is refused outright. That
      // folder is LAST in yoda's LIST order, so connected-backup-partial-failure
      // can back it up alone (skipFolders: 5) and get a run that saves 2 of 3 —
      // the shape that used to notify "Backup failed - Unknown error".
      ...unreachableMessage(9102),
    ],
  },
];

let tauriWd;
let mockServers = [];
let credentialsPath;
let seededAccounts = [];

export const config = {
  runner: 'local',
  specs: ['./tests/e2e/**/*.test.js'],
  suites: {
    // CI-safe: no accounts needed, works from empty/welcome state
    'ui-headless': ['./tests/e2e/ui-*.test.js'],
    // CI-safe: seeded mock-IMAP accounts, no real credentials or network
    'connected-ci': ['./tests/e2e/connected-*.test.js'],
    // Developer-only: backup, migration, visual, archive
    'local-manual': [
      './tests/e2e/backup-*.test.js',
      './tests/e2e/migration-*.test.js',
      './tests/e2e/archive-*.test.js',
      './tests/e2e/visual-*.test.js',
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
  connectionRetryCount: process.env.CI ? 15 : 3,
  specFileRetries: process.env.CI ? 1 : 0,
  specFileRetriesDelay: 5,
  specFileRetriesDeferred: true,

  // Start the mock IMAP servers and tauri-wd before tests
  onPrepare: async function () {
    console.log(`[wdio] Test HOME: ${testDataDir}`);

    // A tauri-wd left behind by an aborted run still owns port 4444, and every
    // session then fails with "App did not report plugin port in time". Mock
    // servers from an aborted run just squat on memory. Both names are ours alone.
    for (const name of ['tauri-wd', 'mock-imap-server']) {
      try { execFileSync('pkill', ['-x', name]); } catch { /* none running */ }
    }

    buildMockServer();
    mockServers = await Promise.all(
      MOCK_ACCOUNTS.map((a) => startMockImap(scenario({
        owner: a.email,
        subjectPrefix: a.subjectPrefix,
        inbox: a.inbox,
        inboxUidStart: a.inboxUidStart,
        htmlQuoted: a.htmlQuoted,
        crossFolderThread: a.crossFolderThread,
        faults: a.faults,
        archiveCount: a.archiveCount,
        archiveSubjectPrefix: a.archiveSubjectPrefix,
        extraMailbox: a.extraMailbox,
      }))),
    );
    seededAccounts = MOCK_ACCOUNTS.map((a, i) => mockAccount({ ...a, port: mockServers[i].port }));
    credentialsPath = seedAccounts(testDataDir, seededAccounts);

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
    process.env.E2E_MOCK_SERVERS = JSON.stringify(mockServers.map(({ host, port }) => ({ host, port })));
    process.env.E2E_MOCK_INBOX_SIZES = JSON.stringify(MOCK_ACCOUNTS.map((a) => a.inbox || 40));

    mockServers.forEach((s, i) => console.log(`[wdio] Mock IMAP for ${MOCK_ACCOUNTS[i].email}: ${s.host}:${s.port}`));

    return new Promise((resolve) => {
      // Trace level in CI: tauri-wd relays the app's stdout lines at
      // debug/trace, which is the only place frontend/daemon boot output
      // is visible on a headless runner.
      tauriWd = spawn('tauri-wd', ['--port', '4444', ...(process.env.CI ? ['--log-level', 'trace'] : [])], {
        stdio: ['ignore', 'pipe', 'pipe'],
        // Own process group: killing it takes the app (and its daemon) with it.
        detached: true,
        env: {
          ...process.env,
          // Isolated app data + daemon socket (both derive from HOME)
          HOME: testDataDir,
          // Credentials come from a file, so the run never touches the real keychain
          MAILVAULT_TEST_CREDENTIALS: credentialsPath,
          // Mock IMAP is plaintext; the app honors this for loopback only
          MAILVAULT_IMAP_PLAINTEXT: '1',
        },
      });

      let started = false;
      function checkOutput(data) {
        const output = data.toString();
        console.log(`[tauri-wd]`, output.trim());
        if (!started && (output.includes('listening') || output.includes('4444'))) {
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
    mockServers.forEach((s) => s.stop());

    if (tauriWd) {
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
  beforeSession: function () {
    const accounts = JSON.parse(process.env.E2E_MOCK_ACCOUNTS || '[]');
    if (accounts.length) resetAppState(testDataDir, accounts);
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
    browser.hasCredentials = true;
    browser.testDataDir = testDataDir;
  },

  port: 4444,
};
