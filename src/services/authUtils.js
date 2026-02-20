/**
 * Check if an account has valid credentials (password or OAuth2).
 * Shared by mailStore, AccountPipeline, and EmailPipelineManager.
 */
export function hasValidCredentials(account) {
  if (!account) return false;
  return !!(account.password || (account.authType === 'oauth2' && account.oauth2AccessToken));
}

// Prevent concurrent refresh calls for the same account
const _refreshing = new Map();

// Buffer: refresh 5 minutes before actual expiry
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

/**
 * Ensures the account's OAuth2 access token is fresh.
 * If the token expires within 5 minutes, refreshes it proactively,
 * persists new tokens to Keychain, and patches the Zustand store.
 * Returns the account object with a fresh token (or the original if not OAuth2).
 */
export async function ensureFreshToken(account) {
  if (!account || account.authType !== 'oauth2') return account;
  if (!account.oauth2RefreshToken) return account;
  if (!account.oauth2ExpiresAt) return account;

  // Token still fresh — no refresh needed
  if (Date.now() < account.oauth2ExpiresAt - REFRESH_BUFFER_MS) {
    return account;
  }

  // Deduplicate BEFORE any await — register synchronously so concurrent callers see it
  const existing = _refreshing.get(account.id);
  if (existing) {
    await existing;
    const { useMailStore } = await import('../stores/mailStore');
    const freshAccounts = useMailStore.getState().accounts;
    return freshAccounts.find(a => a.id === account.id) || account;
  }

  // Register the refresh promise synchronously (before any await)
  let resolveRefresh;
  const dedupePromise = new Promise(resolve => { resolveRefresh = resolve; });
  _refreshing.set(account.id, dedupePromise);

  try {
    // Lazy imports to avoid circular dependency and `window` reference in test environments
    const { refreshOAuth2Token } = await import('./api');
    const { updateOAuth2Tokens } = await import('./db');
    const { useMailStore } = await import('../stores/mailStore');

    try {
      console.log(`[authUtils] Refreshing OAuth2 token for ${account.email} (provider: ${account.oauth2Provider || 'microsoft'})`);

      const tokens = await refreshOAuth2Token(
        account.oauth2RefreshToken,
        account.oauth2Provider
      );

      // Persist to Keychain
      await updateOAuth2Tokens(account.id, tokens);

      // Patch the Zustand store so all consumers get the fresh token
      useMailStore.setState(state => ({
        accounts: state.accounts.map(a =>
          a.id === account.id
            ? {
                ...a,
                oauth2AccessToken: tokens.accessToken,
                oauth2RefreshToken: tokens.refreshToken || a.oauth2RefreshToken,
                oauth2ExpiresAt: tokens.expiresAt,
              }
            : a
        ),
      }));

      console.log(`[authUtils] Token refreshed for ${account.email}, expires at ${new Date(tokens.expiresAt).toISOString()}`);
    } catch (error) {
      console.error(`[authUtils] Token refresh failed for ${account.email}:`, error.message || error);
      // Don't throw — let the caller proceed with the old token;
      // the IMAP call will fail and surface the auth error to the user
    }

    // Return the updated account from the store
    const freshAccounts = useMailStore.getState().accounts;
    return freshAccounts.find(a => a.id === account.id) || account;
  } finally {
    resolveRefresh();
    _refreshing.delete(account.id);
  }
}
