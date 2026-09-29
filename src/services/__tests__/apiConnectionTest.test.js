// A failed connection test comes back from the daemon as `success:false` with
// an `errorCode` (the daemon classifies, the app only maps the code to a
// message). Every caller (add account, update account, change server, the
// auto-detect loop) still expects a rejection, so api.js turns it back into
// one, carrying the code, host and port along.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSend = vi.fn();
vi.mock('../transport', () => ({ send: (...a) => mockSend(...a) }));

// api.js reads `window.__TAURI__` once, at import.
globalThis.window = { addEventListener: () => {}, removeEventListener: () => {}, ...(globalThis.window || {}), __TAURI__: {} };
const { testConnection, smtpTestConnection } = await import('../api.js');

const ACCOUNT = { email: 'me@example.test', imapHost: 'imap.example.test', imapPort: 993, smtpHost: 'smtp.example.test', smtpPort: 587 };

const FAILED = {
  success: false,
  error: 'TCP connect to imap.example.test:993 failed: operation timed out',
  errorCode: 'blocked_or_timeout',
  host: 'imap.example.test',
  port: 993,
};

beforeEach(() => mockSend.mockReset());

describe('connection tests that failed', () => {
  it('reject with the daemon\'s code, host and port, and keep its text', async () => {
    mockSend.mockResolvedValue(FAILED);
    const err = await testConnection(ACCOUNT).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe(FAILED.error);
    expect(err.errorCode).toBe('blocked_or_timeout');
    expect(err.host).toBe('imap.example.test');
    expect(err.port).toBe(993);
    expect(mockSend).toHaveBeenCalledWith('imap_test_connection', { account: ACCOUNT });
  });

  it('do the same for SMTP', async () => {
    mockSend.mockResolvedValue({ ...FAILED, errorCode: 'auth', error: 'Authentication failed for smtp.example.test:587', host: 'smtp.example.test', port: 587 });
    const err = await smtpTestConnection(ACCOUNT).catch(e => e);
    expect(err.errorCode).toBe('auth');
    expect(err.port).toBe(587);
  });

  it('pass a success straight through', async () => {
    mockSend.mockResolvedValue({ success: true, message: 'Connection successful' });
    await expect(testConnection(ACCOUNT)).resolves.toEqual({ success: true, message: 'Connection successful' });
  });

  // The add-account summary reads these off the pass: nothing in between may
  // drop them.
  it('pass a success\'s host, port, message count and send-as address through', async () => {
    const PASSED = {
      success: true,
      message: 'Connection successful',
      host: 'imap.example.test',
      port: 993,
      messageCount: 1204,
      fromAddress: 'me@example.test',
    };
    mockSend.mockResolvedValue(PASSED);
    await expect(testConnection(ACCOUNT)).resolves.toEqual(PASSED);
  });

  it('still reject when the daemon rejected (an older daemon, a bad argument)', async () => {
    mockSend.mockRejectedValue(new Error('Invalid params'));
    const err = await testConnection(ACCOUNT).catch(e => e);
    expect(err.message).toBe('Invalid params');
    expect(err.errorCode).toBeUndefined();
  });
});
