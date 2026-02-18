import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { execSync, spawn } from 'child_process';
import { readFileSync } from 'fs';

const ROOT = resolve(import.meta.dirname, '../..');
const APP_BUNDLE = resolve(ROOT, 'src-tauri/target/release/bundle/macos/MailVault.app');
const SIDECAR_BIN = resolve(APP_BUNDLE, 'Contents/MacOS/mailvault-server');
const TEST_PORT = 3098;
const BASE_URL = `http://localhost:${TEST_PORT}`;

// Load .env.test
const envPath = resolve(ROOT, '.env.test');
let env = {};
if (existsSync(envPath)) {
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
}

const bundleExists = existsSync(APP_BUNDLE);
const sidecarExists = existsSync(SIDECAR_BIN);

async function waitForServer(url, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
    } catch {
      // server not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Server did not respond at ${url} within ${timeoutMs}ms`);
}

describe('Post-Build DMG Smoke Tests', () => {
  let serverProcess;

  beforeAll(async () => {
    if (!bundleExists || !sidecarExists) return;

    serverProcess = spawn(SIDECAR_BIN, [], {
      env: { ...process.env, PORT: String(TEST_PORT) },
      stdio: 'pipe',
    });

    serverProcess.stderr.on('data', (data) => {
      // Uncomment for debugging: console.error('[sidecar]', data.toString());
    });

    await waitForServer(`${BASE_URL}/api/health`);
  }, 30000);

  afterAll(() => {
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      setTimeout(() => {
        if (serverProcess && !serverProcess.killed) {
          serverProcess.kill('SIGKILL');
        }
      }, 3000);
    }
  });

  it('app bundle exists and is signed', () => {
    if (!bundleExists) {
      console.log('Skipping: app bundle not found — run build-developer-id.sh first');
      return;
    }
    expect(existsSync(APP_BUNDLE)).toBe(true);
    const result = execSync(`codesign -v --strict "${APP_BUNDLE}" 2>&1`, {
      encoding: 'utf-8',
    });
    // codesign -v outputs nothing on success, throws on failure
    expect(result.trim()).toBe('');
  });

  it('sidecar binary exists and is signed', () => {
    if (!sidecarExists) {
      console.log('Skipping: sidecar binary not found — run build-developer-id.sh first');
      return;
    }
    expect(existsSync(SIDECAR_BIN)).toBe(true);
    const result = execSync(`codesign -v --strict "${SIDECAR_BIN}" 2>&1`, {
      encoding: 'utf-8',
    });
    expect(result.trim()).toBe('');
  });

  it('health check returns ok', async () => {
    if (!sidecarExists) {
      console.log('Skipping: sidecar not running');
      return;
    }
    const res = await fetch(`${BASE_URL}/api/health`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('ok');
  });

  it('test connection succeeds with real IMAP credentials', async () => {
    if (!sidecarExists) {
      console.log('Skipping: sidecar not running');
      return;
    }
    if (!env.TEST_EMAIL || !env.TEST_PASSWORD || env.TEST_EMAIL === 'your-email@example.com') {
      console.log('Skipping: no test credentials in .env.test');
      return;
    }

    const res = await fetch(`${BASE_URL}/api/test-connection`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        account: {
          email: env.TEST_EMAIL,
          password: env.TEST_PASSWORD,
          imapHost: env.IMAP_HOST,
          imapPort: Number(env.IMAP_PORT) || 993,
          imapSecure: true,
        },
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  }, 30000);

  it('test connection fails gracefully for bad credentials', async () => {
    if (!sidecarExists) {
      console.log('Skipping: sidecar not running');
      return;
    }

    const res = await fetch(`${BASE_URL}/api/test-connection`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        account: {
          email: 'nonexistent@invalid.example.com',
          password: 'wrongpassword',
          imapHost: 'imap.invalid.example.com',
          imapPort: 993,
          imapSecure: true,
        },
      }),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.success).toBe(false);
  }, 30000);
}, 60000);
