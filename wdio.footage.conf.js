/**
 * Footage run for the app preview video - not a test suite.
 *
 * Boots the real app on the demo mailbox (the same three mock IMAP accounts the
 * marketing screenshots use, scripts/screenshots/demoData.js, patched and
 * optionally extended with a multi-year history by scripts/footage/lib/mailbox.js),
 * raises the window, and runs ONE spec from scripts/footage/scenes/. A spec
 * records one or more clips with video/capture/recorder and writes
 * <clip>.mov + <clip>.actions.json per clip.
 *
 *   FOOTAGE_SPEC=boot-a FOOTAGE_OUT=<dir> FOOTAGE_RECORDER=<bin> npx wdio run wdio.footage.conf.js
 *
 * scripts/footage/run.sh is the whole mini job (build, run, stream the results
 * back); use that rather than calling this directly.
 */

import { resolve, join } from 'path';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { spawn, execFileSync } from 'child_process';
import {
  buildMockServer,
  startMockImap,
  mockAccount,
  seedAccounts,
  appDataDir,
} from './tests/e2e/mockImap.js';
import { footageAccounts } from './scripts/footage/lib/mailbox.js';
import { PREMIUM_BILLING_PROFILE } from './scripts/screenshots/premiumSeed.js';
import { writeCorpus } from './scripts/screenshots/search50kCorpus.mjs';

// FOOTAGE_CORPUS_50K=1 adds the 50,000-message search vault the screenshot
// harness photographs (scripts/screenshots/search50kCorpus.mjs) to the work
// account before the app boots. FOOTAGE_CORPUS_DIR, when set, is a pre-built
// corpus to APFS-clone in instead of writing it here. Off by default.
const CORPUS_50K = process.env.FOOTAGE_CORPUS_50K === '1';

// FOOTAGE_SPEC picks the spec file (scripts/footage/scenes/<spec>.js); the
// older FOOTAGE_SCENE still works for a one-clip spec named after its clip.
const SPEC = process.env.FOOTAGE_SPEC || process.env.FOOTAGE_SCENE || 's4-search';
const THEME = process.env.FOOTAGE_THEME === 'light' ? 'light' : 'dark';
const DEMO_ACCOUNTS = footageAccounts();

const appBinary = process.env.TAURI_APP_BINARY || resolve(import.meta.dirname, 'target/debug/mailvault');

// The data dir becomes the app's HOME and the daemon's socket is
// `$HOME/.mailvault/mv.sock`: a macOS unix socket path is capped at 104 bytes,
// so the template stays short (see scripts/screenshots/run-all.sh).
const dataDir = process.env.FOOTAGE_DATA_DIR || mkdtempSync(join(tmpdir(), 'mvfoot'));

// Own port. The driver binary is the screenshot run's copy, which exists on the
// mini; nothing here pkills a shared name - a live driver makes the run refuse.
const driverBin = process.env.FOOTAGE_TAURI_WD || 'tauri-wd-shots';
const driverPort = Number(process.env.FOOTAGE_PORT || 4468);

let tauriWd;
let mockServers = [];

/**
 * The persisted front-end settings a take starts from: the marketing
 * screenshot seed (wdio.screenshots.conf.js) minus everything that paints
 * itself into every frame (the in-flight migration toast, cleanup rules,
 * tracker alerts), plus the search operators hint already seen.
 */
function seedFrontendSettings() {
  const path = join(appDataDir(dataDir), 'frontend-settings.json');
  writeFileSync(path, JSON.stringify({
    'mailvault-settings': {
      version: 5,
      state: {
        listPaneSize: Number(process.env.FOOTAGE_LIST_PANE || 500),
        onboardingComplete: true,
        searchIndexReindexOffer: false,
        sidebarCollapsed: false,
        appearanceOnboardingPromptSeen: true,
        searchOperatorsHintSeen: true,
        language: 'en',
        viewStyle: 'list',
        layoutMode: 'three-column',
        sidebarLayout: 'stacked',
        sidebarDensity: 'compact',
        sidebarBackupStatusLocation: 'avatar',
        emailListStyle: 'compact',
        threadMode: 'expandable',
        billingProfile: PREMIUM_BILLING_PROFILE,
        // Explorer opens on Date by month: its grouping control is a native
        // <select> the driver cannot open, so the take never has to touch it.
        explorerGrouping: 'date',
        explorerDateDepth: 'month',
        // Undo send needs a delay to have a window at all (the default is 0).
        sendDelay: 15,
        undoSendDelay: 15,
        undoSendEnabled: true,
      },
    },
    'mailvault-theme': { version: 0, state: { theme: THEME, palette: 'graphite' } },
  }, null, 2));
  console.log(`[footage] seeded ${path}`);
}

export const config = {
  runner: 'local',
  specs: [`./scripts/footage/scenes/${SPEC}.js`],
  maxInstances: 1,
  capabilities: [{
    browserName: 'wry',
    'tauri:options': { application: appBinary },
  }],
  // Same undici Content-Length workaround as wdio.screenshots.conf.js.
  transformRequest: (req) => { req.headers?.delete?.('content-length'); return req; },

  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: { ui: 'bdd', timeout: 600000 },
  connectionRetryCount: 15,

  onPrepare: async function () {
    console.log(`[footage] spec ${SPEC}, theme ${THEME}, HOME ${dataDir}, driver ${driverBin} on ${driverPort}`);
    let live = '';
    try { live = execFileSync('pgrep', ['-fl', 'tauri-wd'], { encoding: 'utf-8' }).trim(); } catch { /* none */ }
    if (live) throw new Error(`a tauri-wd driver is already running; one app instance at a time:\n${live}`);

    buildMockServer();
    mockServers = await Promise.all(DEMO_ACCOUNTS.map((a) => startMockImap(a.scenario())));
    const accounts = DEMO_ACCOUNTS.map((a, i) => mockAccount({
      id: a.id, email: a.email, name: a.name,
      port: mockServers[i].port, smtpPort: mockServers[i].smtpPort,
    }));
    const credentialsPath = seedAccounts(dataDir, accounts);
    seedFrontendSettings();
    if (CORPUS_50K) {
      const t0 = Date.now();
      const template = process.env.FOOTAGE_CORPUS_DIR;
      if (template) {
        const maildir = join(appDataDir(dataDir), 'Maildir');
        mkdirSync(maildir, { recursive: true });
        execFileSync('cp', ['-Rc', join(template, 'Maildir', accounts[0].id), maildir]);
      } else {
        // FOOTAGE_CORPUS_N: the corpus size, so corpus + the demo mail the
        // footage boot caches (68, not the screenshot run's 82) reads 50,000.
        const n = Number(process.env.FOOTAGE_CORPUS_N) || undefined;
        writeCorpus(appDataDir(dataDir), accounts[0].id, n);
      }
      console.log(`[footage] seeded the 50,000-message search vault for ${accounts[0].id} in ${Date.now() - t0} ms`);
    }

    // capture.js windowId() pins the capture to the window of this exact binary.
    process.env.SHOTS_APP_BINARY = appBinary;
    process.env.FOOTAGE_ACCOUNTS = JSON.stringify(accounts);
    process.env.FOOTAGE_DATA_DIR = dataDir;

    return new Promise((res) => {
      tauriWd = spawn(driverBin, ['--port', String(driverPort)], {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
        env: {
          ...process.env,
          HOME: dataDir,
          MAILVAULT_TEST_CREDENTIALS: credentialsPath,
          MAILVAULT_IMAP_PLAINTEXT: '1',
          MAILVAULT_DISABLE_EVICTION: '1',
          MAILVAULT_DISABLE_HOARDER: '1',
          // ph-tier2c c26 imports a throwaway OpenPGP key: a file in the run's
          // data dir (debug builds honour it), never the mini's keychain.
          ...(process.env.FOOTAGE_TIER2C === '1' ? { MAILVAULT_TEST_PGP_KEYS: join(dataDir, 'pgp-keys.json') } : {}),
          // ph-tier3a c35 verifies SMTP against the plaintext mock (loopback
          // only, as wdio.conf.js); off by default.
          ...(process.env.FOOTAGE_SMTP_PLAINTEXT === '1' ? { MAILVAULT_SMTP_PLAINTEXT: '1' } : {}),
        },
      });
      let started = false;
      const check = (d) => {
        const out = d.toString();
        console.log('[tauri-wd]', out.trim());
        if (!started && (out.includes('listening') || out.includes(String(driverPort)))) { started = true; res(); }
      };
      tauriWd.stdout.on('data', check);
      tauriWd.stderr.on('data', check);
      setTimeout(() => { if (!started) { started = true; res(); } }, 5000);
    });
  },

  before: function () {
    browser.demoAccounts = JSON.parse(process.env.FOOTAGE_ACCOUNTS || '[]');
    browser.footageDataDir = dataDir;
  },

  onComplete: function () {
    mockServers.forEach((s) => s.stop());
    if (tauriWd) {
      try { process.kill(-tauriWd.pid, 'SIGTERM'); } catch { /* gone */ }
    }
  },

  port: driverPort,
};
