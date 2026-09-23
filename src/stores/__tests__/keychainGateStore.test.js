// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDaemonCall = vi.fn();
vi.mock('../../services/daemonClient', () => ({
  daemonCall: (...args) => mockDaemonCall(...args),
  DaemonError: class DaemonError extends Error {},
}));
const mockGetAccounts = vi.fn();
const mockClearCache = vi.fn();
vi.mock('../../services/db', () => ({
  getAccounts: (...args) => mockGetAccounts(...args),
  clearCredentialsCache: (...args) => mockClearCache(...args),
}));
const mockRetry = vi.fn();
vi.mock('../../services/workflows/retryKeychainAccess', () => ({
  retryKeychainAccess: (...args) => mockRetry(...args),
}));
const mockNotify = vi.fn();
vi.mock('../focusStore', () => ({ notify: (...args) => mockNotify(...args) }));
const handlers = {};
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (name, cb) => { handlers[name] = cb; return () => {}; },
}));

const { useKeychainGateStore, initKeychainGate, __resetKeychainGateForTests } = await import('../keychainGateStore');
const gate = () => useKeychainGateStore.getState();

beforeEach(() => {
  __resetKeychainGateForTests();
  for (const m of [mockDaemonCall, mockGetAccounts, mockClearCache, mockRetry, mockNotify]) m.mockReset();
  for (const k of Object.keys(handlers)) delete handlers[k];
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
});

describe('keychainGateStore', () => {
  it('asks keychain.status at start and again on every daemon reconnect', async () => {
    mockDaemonCall.mockResolvedValue({ blocked: true, reason: 'locked', since: 1 });
    initKeychainGate();
    await vi.waitFor(() => expect(gate()).toMatchObject({ blocked: true, reason: 'locked' }));
    expect(mockDaemonCall).toHaveBeenCalledWith('keychain.status');

    mockDaemonCall.mockResolvedValue({ blocked: false });
    handlers['daemon-reconnected']();
    await vi.waitFor(() => expect(gate().blocked).toBe(false));
    expect(mockDaemonCall).toHaveBeenCalledTimes(2);
  });

  it('follows the keychain-status event both ways', async () => {
    mockDaemonCall.mockResolvedValue({ blocked: false });
    initKeychainGate();
    await vi.waitFor(() => expect(handlers['keychain-status']).toBeTypeOf('function'));
    handlers['keychain-status']({ payload: { blocked: true, reason: 'timeout' } });
    expect(gate()).toMatchObject({ blocked: true, reason: 'timeout' });
    handlers['keychain-status']({ payload: { blocked: false } });
    expect(gate()).toMatchObject({ blocked: false, reason: null });
  });

  it('posts a banner for a new block only while the window is in the background', () => {
    gate().apply({ blocked: true, reason: 'locked' }, { announce: true });
    expect(mockNotify).not.toHaveBeenCalled();

    gate().apply({ blocked: false });
    document.hasFocus.mockReturnValue(false);
    gate().apply({ blocked: true, reason: 'locked' }, { announce: true });
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify.mock.calls[0][0]).toBe('MailVault needs your keychain');

    // Still blocked: no transition, no second banner.
    gate().apply({ blocked: true, reason: 'timeout' }, { announce: true });
    expect(mockNotify).toHaveBeenCalledTimes(1);
  });

  it('never banners from a status poll: that is often the click on the daemon\'s own banner', () => {
    document.hasFocus.mockReturnValue(false);
    gate().apply({ blocked: true, reason: 'locked' });
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('reopens a dismissed dialog on the next block', () => {
    gate().apply({ blocked: true, reason: 'locked' });
    gate().dismiss();
    expect(gate().dismissed).toBe(true);
    gate().apply({ blocked: true, reason: 'locked' });
    expect(gate().dismissed).toBe(true);
    gate().apply({ blocked: false });
    gate().apply({ blocked: true, reason: 'denied' });
    expect(gate().dismissed).toBe(false);
  });

  it('unlocks with the app\'s own read first, then the daemon\'s, then re-activates', async () => {
    gate().apply({ blocked: true, reason: 'locked' });
    mockGetAccounts.mockResolvedValue([]);
    mockDaemonCall.mockResolvedValue({ ok: true });
    await gate().unlock();

    expect(mockClearCache).toHaveBeenCalled();
    expect(mockDaemonCall).toHaveBeenCalledWith('keychain.retry');
    expect(mockGetAccounts.mock.invocationCallOrder[0]).toBeLessThan(mockDaemonCall.mock.invocationCallOrder[0]);
    expect(mockRetry).toHaveBeenCalledTimes(1);
    expect(gate()).toMatchObject({ blocked: false, unlocking: false, error: null });
  });

  it('keeps the dialog up with the reason when the daemon still cannot read', async () => {
    gate().apply({ blocked: true, reason: 'locked' });
    mockGetAccounts.mockResolvedValue([]);
    mockDaemonCall.mockResolvedValue({ ok: false, reason: 'denied' });
    await gate().unlock();

    expect(gate()).toMatchObject({ blocked: true, unlocking: false, error: 'denied' });
    expect(mockRetry).not.toHaveBeenCalled();
  });

  it('reads a thrown call as a generic failure', async () => {
    gate().apply({ blocked: true, reason: 'locked' });
    mockGetAccounts.mockResolvedValue([]);
    mockDaemonCall.mockRejectedValue(new Error('daemon gone'));
    await gate().unlock();
    expect(gate()).toMatchObject({ blocked: true, unlocking: false, error: 'error' });
  });
});
