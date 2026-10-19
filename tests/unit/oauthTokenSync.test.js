// @vitest-environment jsdom
/**
 * The app's side of daemon-owned OAuth2 tokens (`services/oauthTokenSync.js`):
 * the daemon refreshes, the app saves what it refreshed through its one
 * credentials writer (`updateOAuth2Tokens`), and says when it wrote.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const h = vi.hoisted(() => ({
  send: vi.fn(),
  update: vi.fn(),
  listeners: new Map(),
  accounts: [],
}));

vi.mock('../../src/services/transport.js', () => ({ send: (...args) => h.send(...args) }));
vi.mock('../../src/services/db', () => ({ updateOAuth2Tokens: (...args) => h.update(...args) }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (name, cb) => {
    h.listeners.set(name, cb);
    return () => h.listeners.delete(name);
  },
}));
vi.mock('../../src/stores/mailStore', () => {
  const state = { get accounts() { return h.accounts; } };
  return {
    useMailStore: {
      getState: () => state,
      setState: (fn) => { h.accounts = (typeof fn === 'function' ? fn(state) : fn).accounts ?? h.accounts; },
    },
  };
});

const sync = await import('../../src/services/oauthTokenSync.js');

const PAIR = { accountId: 'g1', accessToken: 'ya29.SECRET-NEW', refreshToken: '1//SECRET-RT', expiresAt: 4_000_000_000_000 };
const calls = (method) => h.send.mock.calls.filter(([m]) => m === method);

beforeEach(() => {
  h.listeners.clear();
  h.accounts = [{ id: 'g1', email: 'me@gmail.test', authType: 'oauth2', oauth2AccessToken: 'old', oauth2RefreshToken: 'old-rt' }];
  h.send = vi.fn(async (method) => (method === 'oauth2.take_refreshed' ? { tokens: [PAIR] } : { ok: true }));
  h.update = vi.fn(async (id) => ({ id }));
  sync.__resetForTests();
});
afterEach(() => vi.restoreAllMocks());

describe('saving what the daemon refreshed', () => {
  it('takes the refreshed pairs and saves each through updateOAuth2Tokens', async () => {
    expect(await sync.saveRefreshedTokens()).toBe(1);
    expect(calls('oauth2.take_refreshed')).toHaveLength(1);
    expect(h.update).toHaveBeenCalledWith('g1', { accessToken: PAIR.accessToken, refreshToken: PAIR.refreshToken, expiresAt: PAIR.expiresAt });
    expect(h.accounts[0]).toMatchObject({ oauth2AccessToken: PAIR.accessToken, oauth2RefreshToken: PAIR.refreshToken, oauth2ExpiresAt: PAIR.expiresAt });
  });

  it('saves on the daemon event and on a reconnect, and once at start', async () => {
    await sync.initOAuthTokenSync();
    expect(calls('oauth2.take_refreshed')).toHaveLength(1);
    await h.listeners.get('oauth2-tokens-refreshed')({ payload: { accountId: 'g1' } });
    await h.listeners.get('daemon-reconnected')();
    await vi.waitFor(() => expect(calls('oauth2.take_refreshed')).toHaveLength(3));
  });

  it('a save that fails is left for the next take, and nothing logs a token', async () => {
    const logs = ['log', 'info', 'warn', 'error', 'debug'].map(level => vi.spyOn(console, level).mockImplementation(() => {}));
    h.update = vi.fn(async () => { throw new Error(`keychain refused ${PAIR.accessToken}`); });
    expect(await sync.saveRefreshedTokens()).toBe(0);
    h.send = vi.fn(async () => { throw new Error(`daemon said ${PAIR.refreshToken}`); });
    expect(await sync.saveRefreshedTokens()).toBe(0);
    for (const spy of logs) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain('SECRET');
    }
  });

  it('an account the store no longer has is not written', async () => {
    h.update = vi.fn(async () => undefined);
    expect(await sync.saveRefreshedTokens()).toBe(0);
    expect(h.accounts[0].oauth2AccessToken).toBe('old');
  });
});

describe('telling the daemon the app wrote credentials', () => {
  it('sends a payload-free credentials_changed and never throws', async () => {
    await sync.credentialsChanged();
    expect(calls('oauth2.credentials_changed')).toEqual([['oauth2.credentials_changed', {}]]);
    h.send = vi.fn(async () => { throw new Error('daemon down'); });
    await expect(sync.credentialsChanged()).resolves.toBeUndefined();
  });

  it('is what a successful keychain write ends with', () => {
    const keychain = readFileSync('src/services/db/keychain.js', 'utf8');
    const write = keychain.slice(keychain.indexOf("await invoke('store_credentials'"), keychain.indexOf('latest.resolve();'));
    expect(write).toMatch(/credentialsChanged\(\)/);
  });
});
