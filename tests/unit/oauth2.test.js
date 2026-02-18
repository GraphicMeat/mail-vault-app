import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const TEST_PORT = 3098;
const BASE_URL = `http://localhost:${TEST_PORT}/api`;

let serverProcess;

beforeAll(async () => {
  const { spawn } = await import('child_process');
  serverProcess = spawn('node', ['server/index.js'], {
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      MAILVAULT_MS_CLIENT_ID: 'test-client-id-12345',
      MAILVAULT_MS_CLIENT_SECRET: 'test-client-secret',
    },
    stdio: 'pipe',
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server start timeout')), 10000);
    serverProcess.stdout.on('data', (data) => {
      if (data.toString().includes('running on')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    serverProcess.stderr.on('data', (data) => {
      console.error('[server stderr]', data.toString());
    });
    serverProcess.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
});

afterAll(async () => {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    await new Promise((resolve) => {
      serverProcess.on('close', resolve);
      setTimeout(resolve, 2000);
    });
  }
});

async function get(endpoint) {
  const res = await fetch(`${BASE_URL}${endpoint}`);
  return res.json();
}

async function post(endpoint, body = {}) {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

describe('OAuth2 Config', () => {
  it('oauth2Config exports correct Microsoft endpoints', async () => {
    const { MICROSOFT_OAUTH } = await import('../../server/oauth2Config.js');
    expect(MICROSOFT_OAUTH.authEndpoint).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
    expect(MICROSOFT_OAUTH.tokenEndpoint).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/token');
    expect(MICROSOFT_OAUTH.redirectUri).toBe('http://localhost:19876/callback');
    expect(MICROSOFT_OAUTH.callbackPort).toBe(19876);
  });

  it('oauth2Config includes required scopes', async () => {
    const { MICROSOFT_OAUTH } = await import('../../server/oauth2Config.js');
    expect(MICROSOFT_OAUTH.scopes).toContain('offline_access');
    expect(MICROSOFT_OAUTH.scopes.some(s => s.includes('IMAP'))).toBe(true);
    expect(MICROSOFT_OAUTH.scopes.some(s => s.includes('SMTP'))).toBe(true);
  });

  it('getMicrosoftCredentials reads from env vars', async () => {
    const originalId = process.env.MAILVAULT_MS_CLIENT_ID;
    const originalSecret = process.env.MAILVAULT_MS_CLIENT_SECRET;

    process.env.MAILVAULT_MS_CLIENT_ID = 'test-id';
    process.env.MAILVAULT_MS_CLIENT_SECRET = 'test-secret';

    const { getMicrosoftCredentials } = await import('../../server/oauth2Config.js');
    const creds = getMicrosoftCredentials();
    expect(creds.clientId).toBe('test-id');
    expect(creds.clientSecret).toBe('test-secret');

    // Restore
    process.env.MAILVAULT_MS_CLIENT_ID = originalId;
    process.env.MAILVAULT_MS_CLIENT_SECRET = originalSecret;
  });

  it('getMicrosoftCredentials falls back to Thunderbird client ID when env var is missing', async () => {
    const originalId = process.env.MAILVAULT_MS_CLIENT_ID;
    const originalSecret = process.env.MAILVAULT_MS_CLIENT_SECRET;
    delete process.env.MAILVAULT_MS_CLIENT_ID;
    delete process.env.MAILVAULT_MS_CLIENT_SECRET;

    // Re-import to get fresh module
    const mod = await import('../../server/oauth2Config.js?v=1');
    const creds = mod.getMicrosoftCredentials();
    // Should fall back to Thunderbird's public client ID
    expect(creds.clientId).toBe('9e5f94bc-e8a4-4e73-b8be-63364c29d753');
    expect(creds.clientSecret).toBeNull();

    process.env.MAILVAULT_MS_CLIENT_ID = originalId;
    process.env.MAILVAULT_MS_CLIENT_SECRET = originalSecret;
  });
});

describe('OAuth2 Auth URL Endpoint', () => {
  it('GET /api/oauth2/auth-url returns a valid auth URL', async () => {
    const data = await get('/oauth2/auth-url');
    expect(data.success).toBe(true);
    expect(data.authUrl).toBeDefined();
    expect(data.state).toBeDefined();
    expect(typeof data.state).toBe('string');
    expect(data.state.length).toBeGreaterThan(0);
  });

  it('auth URL contains required parameters', async () => {
    const data = await get('/oauth2/auth-url');
    const url = new URL(data.authUrl);

    expect(url.hostname).toBe('login.microsoftonline.com');
    expect(url.searchParams.get('client_id')).toBe('test-client-id-12345');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:19876/callback');
    expect(url.searchParams.get('state')).toBe(data.state);
    expect(url.searchParams.get('code_challenge')).toBeDefined();
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('auth URL includes all required scopes', async () => {
    const data = await get('/oauth2/auth-url');
    const url = new URL(data.authUrl);
    const scopes = url.searchParams.get('scope');

    expect(scopes).toContain('offline_access');
    expect(scopes).toContain('IMAP.AccessAsUser.All');
    expect(scopes).toContain('SMTP.Send');
  });

  it('each call returns a unique state', async () => {
    const data1 = await get('/oauth2/auth-url');
    const data2 = await get('/oauth2/auth-url');
    expect(data1.state).not.toBe(data2.state);
  });
});

describe('OAuth2 Exchange Endpoint', () => {
  it('POST /api/oauth2/exchange rejects invalid state', async () => {
    const data = await post('/oauth2/exchange', { state: 'nonexistent-state' });
    expect(data.success).toBe(false);
    expect(data.error).toContain('No pending OAuth flow');
  });
});

describe('OAuth2 Refresh Endpoint', () => {
  it('POST /api/oauth2/refresh rejects missing refresh token', async () => {
    const data = await post('/oauth2/refresh', {});
    expect(data.success).toBe(false);
    expect(data.error).toContain('Missing refresh token');
  });

  it('POST /api/oauth2/refresh fails gracefully with invalid token', async () => {
    const data = await post('/oauth2/refresh', { refreshToken: 'invalid-token' });
    expect(data.success).toBe(false);
    expect(data.error).toContain('Token refresh failed');
  });
});

describe('IMAP Auth Builder', () => {
  it('test-connection accepts oauth2 auth type', async () => {
    // This should fail with auth error (not crash) — validates the code path works
    const data = await post('/test-connection', {
      account: {
        email: 'test@outlook.com',
        imapHost: 'outlook.office.com',
        imapPort: 993,
        imapSecure: true,
        authType: 'oauth2',
        oauth2AccessToken: 'fake-token',
      }
    });
    // Should fail with auth error, not a crash
    expect(data.success).toBe(false);
    expect(data.error).toBeDefined();
  });

  it('test-connection still works with password auth type', async () => {
    const data = await post('/test-connection', {
      account: {
        email: 'test@outlook.com',
        imapHost: 'outlook.office.com',
        imapPort: 993,
        imapSecure: true,
        authType: 'password',
        password: 'fake-password',
      }
    });
    expect(data.success).toBe(false);
    expect(data.error).toBeDefined();
  });
});
