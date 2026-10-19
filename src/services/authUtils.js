// OAuth2 access tokens are the daemon's (src-daemon/src/oauth_tokens.rs): it
// refreshes them when due and puts the account's own token into every
// request. What is left here is the sign-in's half (the fields a finished
// exchange sets) and the checks the app makes before it asks the daemon for
// anything: whether an account has credentials at all, and loading them from
// the keychain when the store's copy has none.

/**
 * The account fields a finished OAuth2 sign-in sets, laid over `base`.
 *
 * A refresh token only works with the client that issued it, so the client
 * (`tokenData.clientId`, reported by the exchange) is recorded in the SAME
 * object as the refresh token. It is always assigned, even when absent, so an
 * account that already carries a stamp cannot keep the old client's id next
 * to a new client's token. Absent means the daemon reported no client, i.e.
 * Thunderbird's, which is what an unstamped account already means.
 */
export function withOAuth2Exchange(base, tokenData) {
  return {
    ...base,
    oauth2AccessToken: tokenData.accessToken,
    oauth2RefreshToken: tokenData.refreshToken,
    oauth2ExpiresAt: tokenData.expiresAt,
    oauth2ClientId: tokenData.clientId || undefined,
  };
}

/**
 * Check if an account has valid credentials (password or OAuth2).
 * Shared by mailStore, AccountPipeline, and EmailPipelineManager.
 *
 * Note: This checks for presence, not correctness. A non-empty token passes
 * even if it has expired: renewing it is the daemon's job.
 */
export function hasValidCredentials(account) {
  if (!account) return false;
  if (account.password) return true;
  if (account.authType !== 'oauth2') return false;
  return !!account.oauth2AccessToken;
}

const CREDENTIALS_UNAVAILABLE = 'Credentials unavailable: retry keychain access or re-enter in Settings > Accounts';

/**
 * Resolve an account whose credentials the daemon can sign in with.
 * Shared by mail loading, backup, backup verification, and any other
 * flow that needs to talk to IMAP/Graph.
 *
 * Resolution order:
 *   1. Start from in-memory store account
 *   2. If missing credentials, rehydrate from keychain via db.getAccount()
 *   3. Final validation. An OAuth2 account with a refresh token passes even
 *      without an access token: the daemon renews it before the request.
 *
 * @param {string} accountId
 * @param {object} [storeAccount] - current account from Zustand store (optional)
 * @returns {{ ok: true, account: object, source: string } | { ok: false, reason: string, message: string }}
 */
export async function resolveServerAccount(accountId, storeAccount) {
  let account = storeAccount;
  let source = 'store';

  // If the store copy lacks valid credentials, try the keychain
  let keychainFetched = false;
  if (!hasValidCredentials(account)) {
    try {
      const { getAccount } = await import('./db');
      const keychainAccount = await getAccount(accountId);
      keychainFetched = true;

      // Accept the keychain account if it is either already valid OR recoverable.
      // "Recoverable" = OAuth account with a refresh token (even if access token is bad).
      const isValid = keychainAccount && hasValidCredentials(keychainAccount);
      const isRecoverable = keychainAccount
        && keychainAccount.authType === 'oauth2'
        && !!keychainAccount.oauth2RefreshToken;

      if (isValid || isRecoverable) {
        account = keychainAccount;
        source = 'keychain';
        const { useMailStore } = await import('../stores/mailStore');
        useMailStore.setState(state => ({
          accounts: state.accounts.map(a => a.id === accountId ? { ...a, ...keychainAccount } : a),
        }));
      }
    } catch (e) {
      console.warn(`[authUtils] Keychain fetch failed for ${accountId}:`, e);
    }
  }

  const renewable = account?.authType === 'oauth2' && !!account?.oauth2RefreshToken;
  if (!hasValidCredentials(account) && !renewable) {
    const reason = keychainFetched && !account?.password && !account?.oauth2AccessToken
      ? 'keychain_account_missing'
      : 'missing_credentials';
    console.warn(`[authUtils] resolveServerAccount failed for ${accountId}: reason=${reason}, source=${source}`);
    return { ok: false, reason, message: CREDENTIALS_UNAVAILABLE };
  }

  return { ok: true, account, source };
}
