// A daemon call that needed an OAuth2 token the daemon could not produce says
// why with a stable code (src-daemon/src/oauth_tokens.rs): the account needs
// a new sign-in, or the keychain could not be read. The app shows the state it
// already has for each instead of an opaque "Missing accessToken".
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

const { oauthErrorState } = await import('../authUtils.js');

const SIGN_IN = 'E_OAUTH_SIGN_IN_NEEDED: Sign in to this account again under Settings, Accounts.';
const KEYCHAIN = 'E_OAUTH_KEYCHAIN_UNAVAILABLE: The keychain could not be read for this account.';

describe('oauthErrorState', () => {
  it('a missing sign-in is the sign-in-required state', () => {
    expect(oauthErrorState(new Error(SIGN_IN))).toMatchObject({ errorType: 'oauthExpired' });
    expect(oauthErrorState(SIGN_IN).errorMessage).toContain('Sign in');
  });

  it('an unreadable keychain is the credentials-unavailable state', () => {
    expect(oauthErrorState(new Error(KEYCHAIN))).toMatchObject({ errorType: 'passwordMissing' });
  });

  it('anything else is left to the caller', () => {
    expect(oauthErrorState(new Error('Graph list_folders failed (500)'))).toBeNull();
    expect(oauthErrorState(undefined)).toBeNull();
  });

  it('both codes are catalog keys in every locale', () => {
    const dir = 'src/i18n/locales';
    for (const file of readdirSync(dir).filter(f => /^[a-z]{2}(-[A-Za-z]+)?\.json$/.test(f))) {
      const catalog = JSON.parse(readFileSync(`${dir}/${file}`, 'utf8'));
      for (const key of ['errors.E_OAUTH_SIGN_IN_NEEDED', 'errors.E_OAUTH_KEYCHAIN_UNAVAILABLE']) {
        expect(catalog[key], `${file} ${key}`).toBeTruthy();
      }
    }
  });

  it('the Graph and IMAP load paths use it', () => {
    for (const path of ['src/services/workflows/loadEmails.js', 'src/services/workflows/activateAccount.js']) {
      expect(readFileSync(path, 'utf8'), path).toMatch(/oauthErrorState\(/);
    }
  });
});
