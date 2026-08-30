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
import { PREMIUM_BILLING_PROFILE } from './scripts/screenshots/premiumSeed.js';

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
 *
 * `accounts` (the mock accounts this run already created) lets the migration
 * fixture below point at real, resolvable email addresses instead of a made
 * up pair `MigrationSettings` could never look up.
 */
function seedFrontendSettings(accounts) {
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
        // Without this the run photographs the upsell card instead of the
        // feature: hasPremiumAccess() reads the persisted profile, and a
        // packaged build cannot use the dev override.
        billingProfile: PREMIUM_BILLING_PROFILE,
        // An unlocked premium screen is usually an empty one — seed what each
        // screen needs to look like a working feature instead of a blank panel.
        //
        // Auto-cleanup rules (Storage tab). Real shape per StorageSettings.jsx
        // (account/folder/age/unit/action, NOT the accountEmail/olderThan shape
        // cleanupEngine.js reads internally — that mismatch means a real rule
        // never actually fires today, so `enabled: true` here is safe: nothing
        // will archive or delete real demo mail in the background).
        cleanupRules: [
          { id: '11111111-1111-4111-8111-111111111111', account: 'all', folder: 'INBOX', age: 30, unit: 'days', action: 'archive-then-delete', enabled: true },
          { id: '22222222-2222-4222-8222-222222222222', account: 'all', folder: 'Trash', age: 90, unit: 'days', action: 'delete', enabled: true },
        ],
        // Automatic Backup Schedule (Backup tab): turns on the frequency
        // picker BackupSchedule.jsx only renders once this is true.
        backupGlobalEnabled: true,
        // Migration (Migration tab): a job already in flight, so the shot
        // shows real progress and a folder checklist instead of step 1 of an
        // empty wizard. Source/dest are two of this run's own mock accounts —
        // MigrationSettings.jsx resolves them by email to draw the avatars.
        activeMigration: {
          status: 'running',
          source_email: accounts[0].email,
          dest_email: accounts[1].email,
          migrated_emails: 128,
          total_emails: 240,
          skipped_emails: 4,
          failed_emails: 0,
          elapsed_seconds: 96,
          current_folder: 'INBOX',
          folders: [
            { source_path: 'INBOX', status: 'completed', total: 80, done: 80 },
            { source_path: 'Archive', status: 'in_progress', total: 160, done: 48 },
          ],
        },
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
    seedFrontendSettings(accounts);

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
