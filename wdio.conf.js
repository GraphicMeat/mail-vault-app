import { resolve } from 'path';
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
const appBinary = resolve(
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
  },
  maxInstances: 1,
  capabilities: [{
    browserName: 'wry',
    'tauri:options': {
      application: appBinary,
    },
  }],
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: {
    ui: 'bdd',
    timeout: 120000,
  },

  // Start tauri-wd before tests
  onPrepare: function () {
    return new Promise((resolve, reject) => {
      tauriWd = spawn('tauri-wd', ['--port', '4444'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let started = false;
      tauriWd.stdout.on('data', (data) => {
        const output = data.toString();
        console.log('[tauri-wd]', output.trim());
        if (!started && (output.includes('listening') || output.includes('4444'))) {
          started = true;
          resolve();
        }
      });
      tauriWd.stderr.on('data', (data) => {
        console.error('[tauri-wd]', data.toString().trim());
      });

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
      tauriWd.kill();
    }
  },

  // Make env available to all tests
  before: function () {
    browser.testEnv = env;
  },

  port: 4444,
};
