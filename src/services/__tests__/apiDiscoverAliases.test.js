// Alias discovery is the daemon's (`aliases.discover`); api.js only forwards
// the account and its id and hands back the answer as it came.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSend = vi.fn();
vi.mock('../transport', () => ({ send: (...a) => mockSend(...a) }));

// api.js reads `window.__TAURI__` once, at import.
globalThis.window = { addEventListener: () => {}, removeEventListener: () => {}, ...(globalThis.window || {}), __TAURI__: {} };
const { discoverAliases } = await import('../api.js');

const ACCOUNT = { email: 'me@gmail.com', imapHost: 'imap.gmail.com', imapPort: 993, authType: 'oauth2', oauth2Provider: 'google', oauth2AccessToken: 'test-token' };

const ANSWER = {
  provider: { status: 'ok', aliases: [{ address: 'work@example.test', name: 'Work', isPrimary: false, verified: true }] },
  detected: [{ address: 'shop@example.test', name: '', count: 3, source: 'delivered_to' }],
};

beforeEach(() => mockSend.mockReset());

describe('discoverAliases', () => {
  it('asks the daemon with the account and its id, and returns its answer unchanged', async () => {
    mockSend.mockResolvedValue(ANSWER);
    await expect(discoverAliases(ACCOUNT, 'acc-1')).resolves.toEqual(ANSWER);
    expect(mockSend).toHaveBeenCalledWith('aliases.discover', { account: ACCOUNT, accountId: 'acc-1' });
  });

  it('rejects when the daemon does (an older daemon without the method)', async () => {
    mockSend.mockRejectedValue(new Error('Unknown method: aliases.discover'));
    await expect(discoverAliases(ACCOUNT, 'acc-1')).rejects.toThrow('Unknown method');
  });
});
