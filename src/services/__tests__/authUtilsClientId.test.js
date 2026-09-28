import { describe, it, expect, vi, beforeEach } from 'vitest';

// A Google refresh token only works with the OAuth client that issued it, so
// the account records that client (`oauth2ClientId`): a finished sign-in
// stamps it next to the new refresh token, and every refresh sends it back.

const mockUpdateOAuth2Tokens = vi.fn();
vi.mock('../db', () => ({
  getAccount: vi.fn(),
  updateOAuth2Tokens: (...a) => mockUpdateOAuth2Tokens(...a),
}));

let mockAccounts = [];
vi.mock('../../stores/mailStore', () => ({
  useMailStore: {
    getState: () => ({ accounts: mockAccounts }),
    setState: (fn) => { mockAccounts = fn({ accounts: mockAccounts }).accounts; },
    subscribe: () => () => {},
  },
}));

const mockRefreshOAuth2Token = vi.fn();
vi.mock('../api', () => ({
  refreshOAuth2Token: (...a) => mockRefreshOAuth2Token(...a),
}));

const { withOAuth2Exchange, ensureFreshToken, resolveServerAccount } = await import('../authUtils');

const OLD = 'thunderbird.apps.googleusercontent.com';
const NEW = 'own.apps.googleusercontent.com';

describe('withOAuth2Exchange', () => {
  it('stamps the client the exchange reports next to the new refresh token', () => {
    const next = withOAuth2Exchange(
      { id: 'a1', email: 'u@gmail.com', oauth2Provider: 'google' },
      { accessToken: 'at', refreshToken: 'rt', expiresAt: 42, clientId: NEW },
    );
    expect(next).toMatchObject({
      id: 'a1', email: 'u@gmail.com', oauth2Provider: 'google',
      oauth2AccessToken: 'at', oauth2RefreshToken: 'rt', oauth2ExpiresAt: 42, oauth2ClientId: NEW,
    });
  });

  it('overrides an old stamp carried in by the spread of an existing account (Reconnect)', () => {
    const account = { id: 'a1', oauth2Provider: 'google', oauth2RefreshToken: 'old-rt', oauth2ClientId: OLD };
    const next = withOAuth2Exchange(account, { accessToken: 'at', refreshToken: 'rt', expiresAt: 1, clientId: NEW });
    expect(next.oauth2ClientId).toBe(NEW);
    expect(next.oauth2RefreshToken).toBe('rt');
  });

  it('gives a legacy (unstamped) account the new client with its new token', () => {
    const next = withOAuth2Exchange({ id: 'a1' }, { accessToken: 'at', refreshToken: 'rt', expiresAt: 1, clientId: NEW });
    expect(next.oauth2ClientId).toBe(NEW);
  });

  it('stores no stamp when the exchange reported none, never keeping the old client next to a new token', () => {
    const account = { id: 'a1', oauth2ClientId: NEW };
    const next = withOAuth2Exchange(account, { accessToken: 'at', refreshToken: 'rt', expiresAt: 1 });
    expect(next.oauth2ClientId).toBeUndefined();
    expect('oauth2ClientId' in next).toBe(true); // present as undefined, so it overrides rather than inherits
    expect(JSON.parse(JSON.stringify(next))).not.toHaveProperty('oauth2ClientId');
  });

  it('does not mutate the account it was given', () => {
    const account = { id: 'a1', oauth2ClientId: OLD };
    withOAuth2Exchange(account, { accessToken: 'at', refreshToken: 'rt', expiresAt: 1, clientId: NEW });
    expect(account.oauth2ClientId).toBe(OLD);
  });
});

describe('refresh callers pass account.oauth2ClientId', () => {
  beforeEach(() => {
    mockRefreshOAuth2Token.mockReset().mockResolvedValue({
      accessToken: 'new-at', refreshToken: 'new-rt', expiresAt: Date.now() + 3600_000,
    });
    mockUpdateOAuth2Tokens.mockReset();
  });

  function googleAccount(extra = {}) {
    const a = {
      id: 'g1', email: 'u@gmail.com', authType: 'oauth2', oauth2Provider: 'google',
      oauth2AccessToken: 'old-at', oauth2RefreshToken: 'old-rt', oauth2ExpiresAt: Date.now() - 1000,
      ...extra,
    };
    mockAccounts = [a];
    return a;
  }

  it('the expiry refresh sends the stamped client as the last argument', async () => {
    await ensureFreshToken(googleAccount({ oauth2ClientId: NEW }));
    expect(mockRefreshOAuth2Token).toHaveBeenCalledTimes(1);
    const args = mockRefreshOAuth2Token.mock.calls[0];
    expect(args[0]).toBe('old-rt');
    expect(args[1]).toBe('google');
    expect(args[5]).toBe(NEW);
  });

  it('the expiry refresh sends nothing for a legacy account, which the daemon reads as Thunderbird', async () => {
    await ensureFreshToken(googleAccount());
    expect(mockRefreshOAuth2Token).toHaveBeenCalledTimes(1);
    expect(mockRefreshOAuth2Token.mock.calls[0][5]).toBeUndefined();
  });

  it('the forced refresh of a malformed Graph token sends the account stamp too', async () => {
    const account = {
      id: 'm1', email: 'u@outlook.com', authType: 'oauth2', oauth2Provider: 'microsoft',
      oauth2Transport: 'graph', oauth2AccessToken: 'not-a-jwt', oauth2RefreshToken: 'old-rt',
      oauth2ExpiresAt: Date.now() + 3600_000, oauth2ClientId: OLD,
    };
    mockAccounts = [account];
    mockRefreshOAuth2Token.mockResolvedValue({ accessToken: 'a.b.c', refreshToken: 'new-rt', expiresAt: Date.now() + 3600_000 });
    await resolveServerAccount('m1', account);
    expect(mockRefreshOAuth2Token).toHaveBeenCalled();
    expect(mockRefreshOAuth2Token.mock.calls[0][5]).toBe(OLD);
  });

  it('a refresh never rewrites the stamp on the account', async () => {
    await ensureFreshToken(googleAccount({ oauth2ClientId: OLD }));
    expect(mockAccounts[0].oauth2ClientId).toBe(OLD);
  });
});
