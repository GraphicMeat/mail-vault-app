// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  listeners: new Map(), accounts: [], read: vi.fn(), send: vi.fn(),
  persist: vi.fn(), stateUpdates: 0,
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (name, callback) => {
    h.listeners.set(name, callback);
    return () => h.listeners.delete(name);
  },
}));
vi.mock('../../src/services/db/keychain.js', () => ({
  readCurrentCredentials: () => h.read(),
}));
vi.mock('../../src/services/db', () => ({
  updateOAuth2Tokens: (...args) => h.persist(...args),
}));
vi.mock('../../src/services/transport.js', () => ({
  send: (...args) => h.send(...args),
}));
vi.mock('../../src/stores/mailStore', () => ({
  useMailStore: {
    getState: () => ({ accounts: h.accounts }),
    setState: update => {
      h.stateUpdates += 1;
      const next = typeof update === 'function' ? update({ accounts: h.accounts }) : update;
      h.accounts = next.accounts || h.accounts;
    },
  },
}));

const projection = await import('../../src/services/oauthCredentialProjection.js');
const account = () => ({
  id: 'g1', email: 'me@gmail.test', authType: 'oauth2',
  oauth2ClientId: 'client-a', oauth2RefreshToken: 'grant-a',
  oauth2AccessToken: 'old-access', oauth2ExpiresAt: 100,
});
const blob = record => ({ g1: JSON.stringify(record) });
const notify = (name, payload) => h.listeners.get(name)({ payload });

beforeEach(() => {
  projection.__resetForTests();
  h.listeners.clear();
  h.accounts = [account()];
  h.read = vi.fn(async () => blob({ ...account(), oauth2AccessToken: 'new-access', oauth2ExpiresAt: 500 }));
  h.send = vi.fn();
  h.persist = vi.fn();
  h.stateUpdates = 0;
});

describe('native OAuth credential projection', () => {
  it('initializes without taking or writing a token pair', async () => {
    await projection.initOAuthCredentialProjection();
    expect([...h.listeners.keys()].sort()).toEqual([
      'credentials-changed', 'daemon-reconnected', 'oauth2-tokens-refreshed',
    ]);
    expect(h.read).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
    expect(h.persist).not.toHaveBeenCalled();
  });

  it('projects a completed native refresh from a fresh read without a renderer write', async () => {
    await projection.initOAuthCredentialProjection();
    notify('credentials-changed', { ids: ['g1'], version: 2 });
    await vi.waitFor(() => expect(h.accounts[0].oauth2AccessToken).toBe('new-access'));
    expect(h.accounts[0].oauth2ExpiresAt).toBe(500);
    expect(h.accounts[0].oauth2RefreshToken).toBe('grant-a');
    expect(h.send).not.toHaveBeenCalled();
    expect(h.persist).not.toHaveBeenCalled();
  });

  it('a newer UI sign-in defeats an older native read that finishes later', async () => {
    let finish;
    h.read = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    await projection.initOAuthCredentialProjection();
    notify('oauth2-tokens-refreshed', { accountId: 'g1' });
    await vi.waitFor(() => expect(h.read).toHaveBeenCalledTimes(1));
    h.accounts = [{ ...account(), oauth2ClientId: 'client-b',
      oauth2RefreshToken: 'grant-b', oauth2AccessToken: 'signed-in', oauth2ExpiresAt: 900 }];
    finish(blob({ ...account(), oauth2AccessToken: 'old-refresh', oauth2ExpiresAt: 500 }));
    await vi.waitFor(() => expect(h.stateUpdates).toBe(1));
    expect(h.accounts[0].oauth2AccessToken).toBe('signed-in');
    expect(h.accounts[0].oauth2RefreshToken).toBe('grant-b');
    expect(h.send).not.toHaveBeenCalled();
  });

  it('never resurrects a removed account or guesses that a rotated token is a new grant', async () => {
    await projection.initOAuthCredentialProjection();
    h.accounts = [];
    notify('credentials-changed', { ids: ['g1'], version: 3 });
    await Promise.resolve();
    expect(h.accounts).toEqual([]);
    expect(h.read).not.toHaveBeenCalled();

    h.accounts = [account()];
    h.read = vi.fn(async () => blob({ ...account(), oauth2RefreshToken: 'different-grant',
      oauth2AccessToken: 'other-access', oauth2ExpiresAt: 800 }));
    notify('credentials-changed', { ids: ['g1'], version: 4 });
    await vi.waitFor(() => expect(h.stateUpdates).toBe(1));
    expect(h.accounts[0]).toEqual(account());
    expect(h.send).not.toHaveBeenCalled();
  });

  it('reconnect reads current credentials but never retries a renderer writer', async () => {
    await projection.initOAuthCredentialProjection();
    notify('daemon-reconnected', {});
    await vi.waitFor(() => expect(h.accounts[0].oauth2AccessToken).toBe('new-access'));
    expect(h.read).toHaveBeenCalledTimes(1);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.persist).not.toHaveBeenCalled();
  });

  it('a failed fresh read changes no visible grant', async () => {
    h.read = vi.fn(async () => null);
    await projection.initOAuthCredentialProjection();
    notify('credentials-changed', { ids: ['g1'], version: 5 });
    await vi.waitFor(() => expect(h.read).toHaveBeenCalledTimes(1));
    expect(h.accounts[0]).toEqual(account());
    expect(h.send).not.toHaveBeenCalled();
  });

  it('a rejected fresh read is consumed without changing the visible grant', async () => {
    h.read = vi.fn(async () => { throw new Error('synthetic read failure'); });
    await projection.initOAuthCredentialProjection();
    notify('credentials-changed', { ids: ['g1'], version: 6 });
    await vi.waitFor(() => expect(h.read).toHaveBeenCalledTimes(1));
    expect(h.accounts[0]).toEqual(account());
    expect(h.send).not.toHaveBeenCalled();
  });
});
