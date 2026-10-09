import { describe, it, expect, vi } from 'vitest';

// syncService.js imports both at module load; syncService.test.js mocks the
// same two so the import stays hermetic. graphConfig.js stays real:
// serverSavesSent needs the real isGraphAccount.
vi.mock('../daemonClient.js', () => ({ daemonCall: vi.fn().mockResolvedValue({}) }));
vi.mock('../../stores/settingsStore.js', () => ({
  useSettingsStore: { getState: () => ({ billingProfile: null }) },
  hasPremiumAccess: () => true,
}));

const { isJmapAccount, serverSavesSent } = await import('../providerKind.js');
const { toSyncAccount } = await import('../syncService.js');

describe('providerKind', () => {
  it('detects jmap by session url', () => {
    expect(isJmapAccount({ jmapSessionUrl: 'https://x/jmap/session' })).toBe(true);
    expect(isJmapAccount({ imapHost: 'imap.x' })).toBe(false);
  });

  it('a blank session url or no account at all is not jmap', () => {
    expect(isJmapAccount({ jmapSessionUrl: '' })).toBe(false);
    expect(isJmapAccount({ jmapSessionUrl: '   ' })).toBe(false);
    expect(isJmapAccount(null)).toBe(false);
    expect(isJmapAccount(undefined)).toBe(false);
  });

  it('server saves sent for graph and jmap only', () => {
    expect(serverSavesSent({ oauth2Transport: 'graph' })).toBe(true);
    expect(serverSavesSent({ jmapSessionUrl: 'https://x' })).toBe(true);
    expect(serverSavesSent({ imapHost: 'imap.x' })).toBe(false);
  });

  it('toSyncAccount carries the jmap fields to the daemon', () => {
    const s = toSyncAccount({ id: '1', email: 'a@x', imapHost: 'x', jmapSessionUrl: 'https://x/s', jmapAuth: 'bearer', password: 't' });
    expect(s.imapConfig.jmapSessionUrl).toBe('https://x/s');
    expect(s.imapConfig.jmapAuth).toBe('bearer');
  });

  it('toSyncAccount carries jmapUsername and still never the secret', () => {
    const s = toSyncAccount({
      id: '1', email: 'a@x', imapHost: 'x', jmapSessionUrl: 'https://x/s', jmapAuth: 'basic', jmapUsername: 'alice', password: 'pw',
    });
    expect(s.imapConfig.jmapUsername).toBe('alice');
    expect(s.imapConfig).not.toHaveProperty('password');
  });
});
