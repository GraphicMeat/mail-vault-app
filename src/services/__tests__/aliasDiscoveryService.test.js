// The alias discovery service: token, daemon call, merge into settings. It
// never throws, and one account never has two lookups running at once.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const discoverAliases = vi.fn();
const ensureFreshToken = vi.fn();
const applyDiscovery = vi.fn();
const mail = { accounts: [] };

vi.mock('../api', () => ({ discoverAliases: (...a) => discoverAliases(...a) }));
vi.mock('../authUtils', () => ({ ensureFreshToken: (...a) => ensureFreshToken(...a) }));
vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: { getState: () => ({ applyDiscovery: (...a) => applyDiscovery(...a) }) },
}));
vi.mock('../../stores/mailStore', () => ({ useMailStore: { getState: () => mail } }));

const { refreshAliases, scheduleAliasRefresh, _resetAliasDiscovery } = await import('../aliasDiscovery');

const ACCOUNT = { id: 'a1', email: 'me@example.test', authType: 'oauth2', oauth2AccessToken: 'test-old' };
const FRESH = { ...ACCOUNT, oauth2AccessToken: 'test-fresh' };
const ANSWER = { provider: { status: 'ok', aliases: [] }, detected: [] };
const MERGED = { added: [{ address: 'desk@example.test', name: '', source: 'provider' }], suggestions: [], providerStatus: 'ok' };
const FAILED = { added: [], suggestions: [], providerStatus: 'error' };

beforeEach(() => {
  _resetAliasDiscovery();
  discoverAliases.mockReset().mockResolvedValue(ANSWER);
  ensureFreshToken.mockReset().mockImplementation(async () => FRESH);
  applyDiscovery.mockReset().mockReturnValue(MERGED);
  mail.accounts = [ACCOUNT];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('refreshAliases', () => {
  it('refreshes the token, asks the daemon with the full account, and merges the answer', async () => {
    await expect(refreshAliases(ACCOUNT)).resolves.toEqual(MERGED);
    expect(ensureFreshToken).toHaveBeenCalledWith(ACCOUNT);
    expect(discoverAliases).toHaveBeenCalledWith(FRESH, 'a1');
    expect(applyDiscovery).toHaveBeenCalledWith('a1', 'me@example.test', ANSWER);
  });

  it('answers an error instead of throwing when the daemon fails', async () => {
    discoverAliases.mockRejectedValue(new Error('daemon down'));
    await expect(refreshAliases(ACCOUNT)).resolves.toEqual(FAILED);
    expect(applyDiscovery).not.toHaveBeenCalled();
  });

  it('answers an error instead of throwing when the token refresh fails', async () => {
    ensureFreshToken.mockRejectedValue(new Error('offline'));
    await expect(refreshAliases(ACCOUNT)).resolves.toEqual(FAILED);
    expect(discoverAliases).not.toHaveBeenCalled();
  });

  it('asks nothing for no account', async () => {
    await expect(refreshAliases(null)).resolves.toEqual(FAILED);
    expect(discoverAliases).not.toHaveBeenCalled();
  });

  it('shares one running lookup between callers of the same account', async () => {
    let release;
    discoverAliases.mockImplementation(() => new Promise(resolve => { release = () => resolve(ANSWER); }));
    const first = refreshAliases(ACCOUNT);
    const second = refreshAliases(ACCOUNT);
    await vi.waitFor(() => expect(discoverAliases).toHaveBeenCalledTimes(1));
    release();
    await expect(first).resolves.toEqual(MERGED);
    await expect(second).resolves.toEqual(MERGED);

    // Once it has settled, the next call asks again.
    discoverAliases.mockResolvedValue(ANSWER);
    await refreshAliases(ACCOUNT);
    expect(discoverAliases).toHaveBeenCalledTimes(2);
  });
});

describe('scheduleAliasRefresh', () => {
  it('runs once per account per session, after a delay, with the account as it is by then', async () => {
    vi.useFakeTimers();
    scheduleAliasRefresh(ACCOUNT, { delayMs: 5000 });
    scheduleAliasRefresh(ACCOUNT, { delayMs: 5000 });
    await vi.advanceTimersByTimeAsync(4999);
    expect(discoverAliases).not.toHaveBeenCalled();

    const renewed = { ...ACCOUNT, oauth2AccessToken: 'test-renewed' };
    mail.accounts = [renewed];
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(discoverAliases).toHaveBeenCalledTimes(1));
    expect(ensureFreshToken).toHaveBeenCalledWith(renewed);

    scheduleAliasRefresh(ACCOUNT, { delayMs: 0 });
    await vi.advanceTimersByTimeAsync(10);
    expect(discoverAliases).toHaveBeenCalledTimes(1);
  });

  it('skips an account removed before its turn came', async () => {
    vi.useFakeTimers();
    scheduleAliasRefresh(ACCOUNT, { delayMs: 100 });
    mail.accounts = [];
    await vi.advanceTimersByTimeAsync(200);
    await vi.dynamicImportSettled();
    expect(discoverAliases).not.toHaveBeenCalled();
  });

  it('gives the turn back to an OAuth account whose tokens are not loaded yet', async () => {
    vi.useFakeTimers();
    mail.accounts = [{ id: 'a1', email: 'me@example.test', authType: 'oauth2' }];
    scheduleAliasRefresh(ACCOUNT, { delayMs: 100 });
    await vi.advanceTimersByTimeAsync(200);
    await vi.dynamicImportSettled();
    expect(discoverAliases).not.toHaveBeenCalled();

    // Opening the account later schedules it again, and this time it asks.
    mail.accounts = [ACCOUNT];
    scheduleAliasRefresh(ACCOUNT, { delayMs: 100 });
    await vi.advanceTimersByTimeAsync(200);
    await vi.waitFor(() => expect(discoverAliases).toHaveBeenCalledTimes(1));
  });
});
