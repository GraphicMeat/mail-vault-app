import { resolve, join } from 'path';
import { readFileSync } from 'fs';
import { spawn } from 'child_process';

// Load test credentials from .env.test
const envPath = resolve(import.meta.dirname, '.env.test');
const envContent = readFileSync(envPath, 'utf-8');
const env = Object.fromEntries(
  envContent
    .split('\n')
    .filter((line) => line.trim() && !line.startsWith('#'))
    .map((line) => {
      const [key, ...rest] = line.split('=');
      return [key.trim(), rest.join('=').trim()];
    })
);

// App binary path (debug build with webdriver feature)
const appBinary = process.env.TAURI_APP_BINARY || resolve(
  import.meta.dirname,
  'src-tauri/target/debug/MailVault'
);

let tauriWd;

export const config = {
  runner: 'local',
  specs: ['./tests/e2e/**/*.test.js'],
  suites: {
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
    return new Promise((resolve, reject) => {
      tauriWd = spawn('tauri-wd', ['--port', '4444'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let started = false;
      function checkOutput(data, stream) {
        const output = data.toString();
        console.log(`[tauri-wd]`, output.trim());
        if (!started && (output.includes('listening') || output.includes('4444'))) {
          started = true;
          resolve();
        }
      }
      tauriWd.stdout.on('data', (data) => checkOutput(data, 'stdout'));
      tauriWd.stderr.on('data', (data) => checkOutput(data, 'stderr'));

      // Fallback resolve after 5s
      setTimeout(() => {
        if (!started) {
          started = true;
          resolve();
        }
      }, 5000);
    });
  },

  onComplete: function () {
    if (tauriWd) {
      tauriWd.kill('SIGTERM');
      // Give it a moment, then force-kill
      setTimeout(() => {
        try { tauriWd.kill('SIGKILL'); } catch (_) { /* already dead */ }
      }, 2000);
    }
  },

  // Make env available to all tests
  before: function () {
    browser.testEnv = env;
  },

  port: 4444,
};
