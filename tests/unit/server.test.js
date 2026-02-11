import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const TEST_PORT = 3099;
const BASE_URL = `http://localhost:${TEST_PORT}/api`;

let serverProcess;

beforeAll(async () => {
  // Start the server on a test port as a child process
  const { spawn } = await import('child_process');
  serverProcess = spawn('node', ['server/index.js'], {
    env: { ...process.env, PORT: String(TEST_PORT) },
    stdio: 'pipe',
    cwd: import.meta.dirname ? undefined : process.cwd()
  });

  // Wait for server to be ready
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server start timeout')), 10000);
    serverProcess.stdout.on('data', (data) => {
      if (data.toString().includes('running on port')) {
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

async function post(endpoint, body = {}) {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: res.status, data: await res.json() };
}

// ── Health Check ─────────────────────────────────────────────────────

describe('Health Check', () => {
  it('GET /api/health returns ok', async () => {
    const res = await fetch(`${BASE_URL}/health`);
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.status).toBe('ok');
    expect(data).toHaveProperty('connections');
    expect(typeof data.connections).toBe('number');
  });
});

// ── Mailboxes ────────────────────────────────────────────────────────

describe('POST /api/mailboxes', () => {
  it('returns 500 with error for invalid credentials', async () => {
    const { status, data } = await post('/mailboxes', {
      account: {
        email: 'nonexistent@invalid-host-xyz.com',
        password: 'wrong',
        imapHost: 'imap.invalid-host-xyz.com',
        imapPort: 993
      }
    });
    expect(status).toBe(500);
    expect(data.success).toBe(false);
    expect(data.error).toBeDefined();
  });
});

// ── Emails ───────────────────────────────────────────────────────────

describe('POST /api/emails', () => {
  it('returns 500 with error for invalid credentials', async () => {
    const { status, data } = await post('/emails', {
      account: {
        email: 'nonexistent@invalid-host-xyz.com',
        password: 'wrong',
        imapHost: 'imap.invalid-host-xyz.com',
        imapPort: 993
      },
      mailbox: 'INBOX',
      page: 1,
      limit: 10
    });
    expect(status).toBe(500);
    expect(data.success).toBe(false);
    expect(data.error).toBeDefined();
  });
});

// ── Emails Range ─────────────────────────────────────────────────────

describe('POST /api/emails-range', () => {
  it('returns 500 with error for invalid credentials', async () => {
    const { status, data } = await post('/emails-range', {
      account: {
        email: 'nonexistent@invalid-host-xyz.com',
        password: 'wrong',
        imapHost: 'imap.invalid-host-xyz.com',
        imapPort: 993
      },
      mailbox: 'INBOX',
      startIndex: 0,
      endIndex: 10
    });
    expect(status).toBe(500);
    expect(data.success).toBe(false);
  });
});

// ── Fetch Single Email ──────────────────────────────────────────────

describe('POST /api/email/:uid', () => {
  it('returns 500 for invalid credentials', async () => {
    const { status, data } = await post('/email/123', {
      account: {
        email: 'nonexistent@invalid-host-xyz.com',
        password: 'wrong',
        imapHost: 'imap.invalid-host-xyz.com',
        imapPort: 993
      },
      mailbox: 'INBOX'
    });
    expect(status).toBe(500);
    expect(data.success).toBe(false);
  });
});

// ── Flags ────────────────────────────────────────────────────────────

describe('POST /api/email/:uid/flags', () => {
  it('returns 500 for invalid credentials', async () => {
    const { status, data } = await post('/email/123/flags', {
      account: {
        email: 'nonexistent@invalid-host-xyz.com',
        password: 'wrong',
        imapHost: 'imap.invalid-host-xyz.com',
        imapPort: 993
      },
      mailbox: 'INBOX',
      flags: ['\\Seen'],
      action: 'add'
    });
    expect(status).toBe(500);
    expect(data.success).toBe(false);
  });
});

// ── Delete ───────────────────────────────────────────────────────────

describe('POST /api/email/:uid/delete', () => {
  it('returns 500 for invalid credentials', async () => {
    const { status, data } = await post('/email/123/delete', {
      account: {
        email: 'nonexistent@invalid-host-xyz.com',
        password: 'wrong',
        imapHost: 'imap.invalid-host-xyz.com',
        imapPort: 993
      },
      mailbox: 'INBOX'
    });
    expect(status).toBe(500);
    expect(data.success).toBe(false);
  });
});

// ── Send Email ──────────────────────────────────────────────────────

describe('POST /api/send', () => {
  it('returns 500 for invalid SMTP credentials', async () => {
    const { status, data } = await post('/send', {
      account: {
        email: 'nonexistent@invalid-host-xyz.com',
        password: 'wrong',
        smtpHost: 'smtp.invalid-host-xyz.com',
        smtpPort: 587
      },
      email: {
        to: 'test@example.com',
        subject: 'Test',
        text: 'Test body'
      }
    });
    expect(status).toBe(500);
    expect(data.success).toBe(false);
    expect(data.error).toBeDefined();
  });
});

// ── Search ───────────────────────────────────────────────────────────

describe('POST /api/search', () => {
  it('returns empty results when no query or filters provided', async () => {
    const { status, data } = await post('/search', {
      account: {
        email: 'test@example.com',
        password: 'pass',
        imapHost: 'imap.example.com',
        imapPort: 993
      },
      mailbox: 'INBOX',
      query: '',
      filters: {}
    });
    expect(status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.emails).toEqual([]);
    expect(data.total).toBe(0);
  });

  it('returns 500 for invalid credentials with a real query', async () => {
    const { status, data } = await post('/search', {
      account: {
        email: 'nonexistent@invalid-host-xyz.com',
        password: 'wrong',
        imapHost: 'imap.invalid-host-xyz.com',
        imapPort: 993
      },
      mailbox: 'INBOX',
      query: 'test search'
    });
    expect(status).toBe(500);
    expect(data.success).toBe(false);
  });
});

// ── Test Connection ──────────────────────────────────────────────────

describe('POST /api/test-connection', () => {
  it('returns 400 for invalid host', async () => {
    const { status, data } = await post('/test-connection', {
      account: {
        email: 'nonexistent@invalid-host-xyz.com',
        password: 'wrong',
        imapHost: 'imap.invalid-host-xyz.com',
        imapPort: 993
      }
    });
    expect(status).toBe(400);
    expect(data.success).toBe(false);
    expect(data.error).toBeDefined();
  });
});

// ── Disconnect ───────────────────────────────────────────────────────

describe('POST /api/disconnect', () => {
  it('returns success even for unknown account', async () => {
    const { status, data } = await post('/disconnect', {
      account: {
        email: 'nobody@example.com',
        imapHost: 'imap.example.com'
      }
    });
    expect(status).toBe(200);
    expect(data.success).toBe(true);
  });
});
