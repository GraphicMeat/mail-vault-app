/**
 * Marketing screenshot run — not a test suite.
 *
 * Boots the real app against three mock IMAP accounts holding the demo mailbox
 * (`scripts/screenshots/demoData.js`), then drives it through every screen the
 * README and the website show and captures the native window each time.
 *
 *   npx wdio run wdio.screenshots.conf.js
 *
 * Needs a HiDPI display attached to whatever machine runs it, or the captures
 * come out at 1x. See scripts/screenshots/capture.js.
 */

import { resolve, join } from 'path';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { spawn, execFileSync } from 'child_process';
import { writeFileSync } from 'fs';
import {
  buildMockServer,
  startMockImap,
  mockAccount,
  seedAccounts,
  appDataDir,
  MOCK_PASSWORD,
} from './tests/e2e/mockImap.js';
import { demoScenarios } from './scripts/screenshots/demoData.js';
import { appCode } from './scripts/screenshots/locales.js';

// SHOTS_LOCALE is a website directory name (`de`, `pt-br`, `zh`). It picks the
// app language, the demo mailbox and the output directory together — one knob,
// so the three can never disagree.
const LOCALE_DIR = process.env.SHOTS_LOCALE || 'en';
const APP_LOCALE = appCode(LOCALE_DIR);

const { DEMO_ACCOUNTS } = demoScenarios(APP_LOCALE);

const appBinary = process.env.TAURI_APP_BINARY
  || resolve(import.meta.dirname, 'target/debug/mailvault');

const dataDir = process.env.SHOTS_DATA_DIR || mkdtempSync(join(tmpdir(), 'mailvault-shots-'));

// The E2E suite is single-tenant on tauri-wd/4444 and its onPrepare runs
// `pkill -x tauri-wd`. A screenshot run must not be collateral damage of one,
// nor cause one: own driver binary, own port, and no pkill of shared names.
const driverBin = process.env.SHOTS_TAURI_WD || 'tauri-wd-shots';
const driverPort = Number(process.env.SHOTS_PORT || 4466);

let tauriWd;
let mockServers = [];

/**
 * Front-end settings live in a Tauri-written JSON file, not localStorage
 * (src/stores/safeStorage.js — WKWebView's localStorage throws under the App
 * Sandbox). Seeding it is the only way to start a run with a mailbox that
 * photographs well: a 350px list pane truncates every subject to "Invoic…".
 */
function seedFrontendSettings() {
  const path = join(appDataDir(dataDir), 'frontend-settings.json');
  writeFileSync(path, JSON.stringify({
    'mailvault-settings': {
      version: 4,
      state: {
        listPaneSize: 470,
        onboardingComplete: true,
        sidebarCollapsed: false,
        // `src/main.jsx` applies the persisted language before first paint, so
        // seeding it here IS "run the app in German" — no handle to drive, no
        // catalog to swap after boot, nothing for the first shot to race.
        language: APP_LOCALE,
      },
    },
  }, null, 2));
  console.log(`[shots] seeded ${path}`);
}

export const config = {
  runner: 'local',
  specs: ['./scripts/screenshots/shots.js'],
  maxInstances: 1,
  capabilities: [{
    browserName: 'wry',
    'tauri:options': { application: appBinary },
  }],
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: { ui: 'bdd', timeout: 300000 },
  connectionRetryCount: 15,

  onPrepare: async function () {
    console.log(`[shots] locale: ${LOCALE_DIR} (app ${APP_LOCALE}), HOME: ${dataDir}, driver: ${driverBin} on ${driverPort}`);
    try { execFileSync('pkill', ['-x', driverBin]); } catch { /* none running */ }

    buildMockServer();
    mockServers = await Promise.all(DEMO_ACCOUNTS.map((a) => startMockImap(a.scenario())));
    const accounts = DEMO_ACCOUNTS.map((a, i) => mockAccount({
      id: a.id, email: a.email, name: a.name, port: mockServers[i].port,
    }));
    const credentialsPath = seedAccounts(dataDir, accounts);
    seedFrontendSettings();

    process.env.SHOTS_ACCOUNTS = JSON.stringify(accounts);
    process.env.SHOTS_DATA_DIR = dataDir;
    mockServers.forEach((s, i) => console.log(`[shots] mock IMAP ${DEMO_ACCOUNTS[i].email}: ${s.port}`));

    return new Promise((res) => {
      tauriWd = spawn(driverBin, ['--port', String(driverPort)], {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
        env: {
          ...process.env,
          HOME: dataDir,
          MAILVAULT_TEST_CREDENTIALS: credentialsPath,
          MAILVAULT_IMAP_PLAINTEXT: '1',
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
    browser.demoAccounts = JSON.parse(process.env.SHOTS_ACCOUNTS || '[]');
    browser.shotsDataDir = dataDir;
  },

  onComplete: function () {
    mockServers.forEach((s) => s.stop());
    if (tauriWd) {
      try { process.kill(-tauriWd.pid, 'SIGTERM'); } catch { /* gone */ }
    }
  },

  port: driverPort,
};
