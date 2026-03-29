import { resolve, join } from 'path';
import { readFileSync, existsSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { spawn } from 'child_process';

// Load test credentials from .env.test (optional — UI-only suites don't need it)
let env = {};
const envPath = resolve(import.meta.dirname, '.env.test');
if (existsSync(envPath)) {
  try {
    const envContent = readFileSync(envPath, 'utf-8');
    env = Object.fromEntries(
      envContent
        .split('\n')
        .filter((line) => line.trim() && !line.startsWith('#'))
        .map((line) => {
          const [key, ...rest] = line.split('=');
          return [key.trim(), rest.join('=').trim()];
        })
    );
  } catch { /* non-fatal — credentials just won't be available */ }
}

const hasCredentials = !!(env.TEST_EMAIL && env.TEST_PASSWORD);

// App binary path (debug build with webdriver feature)
const appBinary = process.env.TAURI_APP_BINARY || resolve(
  import.meta.dirname,
  'src-tauri/target/debug/MailVault'
);

// Isolated test data directory — prevents test runs from affecting real app state
const testDataDir = process.env.E2E_DATA_DIR || mkdtempSync(join(tmpdir(), 'mailvault-e2e-'));

let tauriWd;

export const config = {
  runner: 'local',
  specs: ['./tests/e2e/**/*.test.js'],
  suites: {
    // CI-safe: no accounts needed, works from empty/welcome state
    'ui-headless': ['./tests/e2e/ui-*.test.js'],
    // Needs real IMAP credentials + secrets
    'connected-ci': ['./tests/e2e/connected-*.test.js'],
    // Developer-only: backup, migration, visual, archive
    'local-manual': [
      './tests/e2e/backup-*.test.js',
      './tests/e2e/migration-*.test.js',
      './tests/e2e/archive-*.test.js',
      './tests/e2e/visual-*.test.js',
    ],
    // Legacy aliases
    ui: ['./tests/e2e/ui-*.test.js'],
    connected: ['./tests/e2e/connected-*.test.js'],
    perf: ['./tests/e2e/connected-performance.test.js'],
    coldstart: ['./tests/e2e/connected-cold-start.test.js'],
    backup: ['./tests/e2e/backup-*.test.js'],
    migration: ['./tests/e2e/migration-*.test.js'],
    visual: ['./tests/e2e/visual-*.test.js'],
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
  specFileRetries: process.env.CI ? 1 : 0,
  specFileRetriesDelay: 5,
  specFileRetriesDeferred: true,

  // Start tauri-wd before tests
  onPrepare: function () {
    console.log(`[wdio] Test data dir: ${testDataDir}`);
    console.log(`[wdio] Credentials available: ${hasCredentials}`);

    return new Promise((resolve) => {
      tauriWd = spawn('tauri-wd', ['--port', '4444'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          // Tell the app to use isolated test data directory
          MAILVAULT_DATA_DIR: testDataDir,
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
    if (tauriWd) {
      tauriWd.kill('SIGTERM');
      setTimeout(() => {
        try { tauriWd.kill('SIGKILL'); } catch (_) { /* already dead */ }
      }, 2000);
    }
  },

  // Make env and config available to all tests
  before: function () {
    browser.testEnv = env;
    browser.hasCredentials = hasCredentials;
    browser.testDataDir = testDataDir;
  },

  port: 4444,
};
