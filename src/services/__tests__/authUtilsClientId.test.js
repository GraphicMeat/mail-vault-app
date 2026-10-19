import { describe, it, expect } from 'vitest';

// A Google refresh token only works with the OAuth client that issued it, so
// the account records that client (`oauth2ClientId`): a finished sign-in
// stamps it next to the new refresh token, and every refresh sends it back.

const { withOAuth2Exchange } = await import('../authUtils');

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

// The refresh side of the stamp is the daemon's now (src-daemon/src/oauth_tokens.rs:
// a refresh posts the record's own client and never writes the stamp back).
