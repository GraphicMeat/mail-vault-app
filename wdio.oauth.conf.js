// The OAuth2 token-refresh conf: one Gmail-shaped account signed in with a
// token, against a mock token endpoint (tests/e2e/mockOAuth.js) that the app's
// debug build refreshes with, and mock IMAP, SMTP and Graph servers that accept
// only a token it issued and that has not expired. The seeded access token has
// expired, so the first use refreshes. Runs on the Mac mini
// (`wdio run wdio.oauth.conf.js`); every run signs in a new grant, so the spec
// can revoke it. Hand-test checklist: docs/plans/2026-10-20-token-refresh-hand-tests.md.
import { execFileSync } from 'node:child_process';
import { config as base, configureMockAccounts } from './wdio.conf.js';
import { buildMockOAuthServer, startMockOAuth, signIn, GOOGLE_SCOPE, THUNDERBIRD_CLIENT_ID } from './tests/e2e/mockOAuth.js';

export const OAUTH_ACCOUNT_ID = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';
export const OAUTH_EMAIL = 'oauth@mock.test';

let oauth = null;

export const config = {
  ...base,
  exclude: [],
  specs: ['./tests/e2e/oauth-*.test.js'],
  suites: { oauth: ['./tests/e2e/oauth-*.test.js'] },

  onPrepare: async function (...args) {
    buildMockOAuthServer();
    // One left behind by an aborted run. The shared hook's own sweep runs
    // after this one has started, so it must not list this name.
    if (process.platform !== 'win32') {
      try { execFileSync('pkill', ['-x', 'mock-oauth-server']); } catch { /* none running */ }
    }
    oauth = await startMockOAuth();
    const grant = await signIn(oauth.origin, { clientId: THUNDERBIRD_CLIENT_ID, scope: GOOGLE_SCOPE, expiresIn: 3600 });
    // Read by the Graph mock and the specs here, and inherited by tauri-wd and
    // so by the app and its daemon (debug builds only, loopback only).
    process.env.E2E_MOCK_OAUTH_ORIGIN = oauth.origin;
    process.env.MAILVAULT_GOOGLE_TOKEN_ENDPOINT = oauth.origin;
    process.env.MAILVAULT_MS_TOKEN_ENDPOINT = oauth.origin;
    // The automatic send-as lookup of a Gmail account goes here, not to
    // Google, so no mock token ever leaves the machine (debug builds only).
    process.env.MAILVAULT_GMAIL_API_BASE = oauth.origin;
    configureMockAccounts([{
      id: OAUTH_ACCOUNT_ID,
      email: OAUTH_EMAIL,
      inbox: 12,
      tokenCheckOrigin: oauth.origin,
      accountExtra: {
        password: null,
        authType: 'oauth2',
        oauth2Provider: 'google',
        oauth2ClientId: THUNDERBIRD_CLIENT_ID,
        // Issued by nobody: the mail servers refuse it, and its expiry is past.
        oauth2AccessToken: 'expired-seed-token',
        oauth2RefreshToken: grant.refreshToken,
        oauth2ExpiresAt: Date.now() - 60 * 60 * 1000,
      },
    }]);
    await base.onPrepare.apply(this, args);
  },

  onComplete: async function (...args) {
    try {
      await base.onComplete?.apply(this, args);
    } finally {
      oauth?.stop();
    }
  },
};
