/**
 * Check if a token string looks like a JWT (exactly two '.' separators).
 * This catches the common failure mode where a non-JWT string (e.g. a refresh
 * token or garbled value) is stored as the access token — which Graph rejects
 * with IDX14100 / InvalidAuthenticationToken.
 */
function isJwtShaped(token) {
  if (!token || typeof token !== 'string') return false;
  const dots = token.split('.').length - 1;
  return dots === 2;
}

/**
 * Check if a Graph account has a usable access token.
 * For Graph, a truthy string is not enough — the token must be JWT-shaped.
 */
export function hasUsableGraphToken(account) {
  if (!account) return false;
  return account.oauth2Transport === 'graph' && isJwtShaped(account.oauth2AccessToken);
}

/**
 * Check if an account has valid credentials (password or OAuth2).
 * Shared by mailStore, AccountPipeline, and EmailPipelineManager.
 *
 * Note: This checks for presence, not correctness. A non-empty token passes
 * even if it's expired or malformed. The resolver uses hasUsableGraphToken()
 * separately to decide whether a Graph token needs forced refresh.
 */
export function hasValidCredentials(account) {
  if (!account) return false;
  if (account.password) return true;
  if (account.authType !== 'oauth2') return false;
  return !!account.oauth2AccessToken;
}

const CREDENTIALS_UNAVAILABLE = 'Credentials unavailable — retry keychain access or re-enter in Settings > Accounts';

/**
 * Resolve a fully credentialed account ready for server operations.
 * Shared by mail loading, backup, backup verification, and any other
 * flow that needs to talk to IMAP/Graph with valid credentials.
 *
 * Resolution order:
 *   1. Start from in-memory store account
 *   2. If missing credentials, rehydrate from keychain via db.getAccount()
 *   3. For Graph: force-refresh if token is malformed (not JWT-shaped)
 *   4. Normal expiry-based token refresh via ensureFreshToken()
 *   5. Final validation
 *
 * @param {string} accountId
 * @param {object} [storeAccount] - current account from Zustand store (optional)
 * @returns {{ ok: true, account: object, source: string } | { ok: false, reason: string, message: string }}
 */
export async function resolveServerAccount(accountId, storeAccount) {
  let account = storeAccount;
  let source = 'store';
  const isGraph = account?.oauth2Transport === 'graph';

  _logTokenShape('store', account);

  // If the store copy lacks valid credentials, try the keychain
  let keychainFetched = false;
  if (!hasValidCredentials(account)) {
    try {
      const { getAccount } = await import('./db');
      const keychainAccount = await getAccount(accountId);
      keychainFetched = true;
      _logTokenShape('keychain', keychainAccount);

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

  // Re-evaluate Graph status after potential keychain rehydration
  const isGraphNow = account?.oauth2Transport === 'graph';

  // For Graph accounts: force refresh if the token is malformed even if not expired
  const hasMalformedGraphToken = isGraphNow && !hasUsableGraphToken(account);
  const needsForceRefresh = hasMalformedGraphToken && !!account?.oauth2RefreshToken;

  if (needsForceRefresh) {
    console.log(`[authUtils] Graph token malformed for ${accountId} — forcing refresh`);
    try {
      account = await _forceRefreshToken(account);
      source = 'refreshed';
      _logTokenShape('force-refreshed', account);
    } catch (e) {
      console.warn(`[authUtils] Forced refresh failed for ${accountId}:`, e);
    }
  }

  // Bail early if still no credentials — return granular internal reason
  if (!hasValidCredentials(account)) {
    let reason;
    if (keychainFetched && !account?.password && !account?.oauth2AccessToken) {
      reason = 'keychain_account_missing';
    } else if (hasMalformedGraphToken && !account?.oauth2RefreshToken) {
      reason = 'refresh_token_missing';
    } else if (hasMalformedGraphToken && needsForceRefresh) {
      reason = 'refreshed_token_invalid';
    } else if (hasMalformedGraphToken) {
      reason = 'malformed_access_token';
    } else {
      reason = 'missing_credentials';
    }
    console.warn(`[authUtils] resolveServerAccount failed for ${accountId}: reason=${reason}, source=${source}, isGraph=${isGraphNow}`);
    return { ok: false, reason, message: CREDENTIALS_UNAVAILABLE };
  }

  // Normal expiry-based refresh
  try {
    const before = account;
    account = await ensureFreshToken(account);
    if (account !== before) source = 'refreshed';
  } catch (e) {
    console.warn(`[authUtils] Token refresh failed for ${accountId}:`, e);
  }

  // Final validation — for Graph, re-check JWT shape after refresh
  if (!hasValidCredentials(account)) {
    console.warn(`[authUtils] resolveServerAccount failed post-refresh for ${accountId}: reason=refresh_failed, source=${source}`);
    return { ok: false, reason: 'refresh_failed', message: CREDENTIALS_UNAVAILABLE };
  }

  return { ok: true, account, source };
}

/** Backwards-compatible alias — backup code may import this name. */
export const resolveBackupAccount = resolveServerAccount;

/** Log token shape metadata for diagnostics without leaking the token value. */
function _logTokenShape(label, account) {
  if (!account) {
    console.log(`[authUtils] ${label}: account=null`);
    return;
  }
  const token = account.oauth2AccessToken;
  const isGraph = account.oauth2Transport === 'graph';
  if (!isGraph) return; // Only log Graph token diagnostics
  const present = !!token;
  const dots = present ? (token.split('.').length - 1) : 0;
  const len = present ? token.length : 0;
  const jwt = isJwtShaped(token);
  console.log(`[authUtils] ${label}: graph token present=${present} dots=${dots} len=${len} jwt=${jwt} refreshToken=${!!account.oauth2RefreshToken}`);
}

// Prevent concurrent refresh calls for the same account
const _refreshing = new Map();

// Buffer: refresh 5 minutes before actual expiry
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

/**
 * Force-refresh an OAuth2 token regardless of expiry time.
 * Used when the stored token is malformed (not JWT-shaped).
 */
async function _forceRefreshToken(account) {
  if (!account?.oauth2RefreshToken) return account;

  const { refreshOAuth2Token } = await import('./api');
  const { updateOAuth2Tokens } = await import('./db');
  const { useMailStore } = await import('../stores/mailStore');

  console.log(`[authUtils] Force-refreshing token for ${account.email}`);
  const tokens = await refreshOAuth2Token(
    account.oauth2RefreshToken,
    account.oauth2Provider,
    account.oauth2CustomClientId,
    account.oauth2TenantId,
    account.oauth2Transport === 'graph'
  );

  // Log token shape for diagnostics but always persist — Microsoft Graph can return
  // opaque tokens that don't look like JWTs but are still valid.
  if (account.oauth2Transport === 'graph' && !isJwtShaped(tokens.accessToken)) {
    console.warn(`[authUtils] Refresh returned non-JWT Graph token (dots=${(tokens.accessToken || '').split('.').length - 1}) — persisting anyway (Microsoft opaque tokens are valid)`);
  }

  if (!tokens.accessToken) {
    console.error(`[authUtils] Refresh returned empty access token — not persisting`);
    return account;
  }

  await updateOAuth2Tokens(account.id, tokens);

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

  const freshAccounts = useMailStore.getState().accounts;
  return freshAccounts.find(a => a.id === account.id) || account;
}

/**
 * Ensures the account's OAuth2 access token is fresh.
 * If the token expires within 5 minutes, refreshes it proactively,
 * persists new tokens to Keychain, and patches the Zustand store.
 * For Graph accounts, also refreshes if the token is malformed.
 * Returns the account object with a fresh token (or the original if not OAuth2).
 */
export async function ensureFreshToken(account) {
  if (!account || account.authType !== 'oauth2') return account;
  if (!account.oauth2RefreshToken) return account;

  // Check if refresh is needed: near expiry OR malformed Graph token
  const isGraph = account.oauth2Transport === 'graph';
  const malformed = isGraph && !isJwtShaped(account.oauth2AccessToken);
  const nearExpiry = account.oauth2ExpiresAt && Date.now() >= account.oauth2ExpiresAt - REFRESH_BUFFER_MS;

  if (!malformed && !nearExpiry) {
    return account; // Token is fresh and well-formed
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
      console.log(`[authUtils] Refreshing OAuth2 token for ${account.email} (provider: ${account.oauth2Provider || 'microsoft'}, reason: ${malformed ? 'malformed' : 'expiry'})`);

      const tokens = await refreshOAuth2Token(
        account.oauth2RefreshToken,
        account.oauth2Provider,
        account.oauth2CustomClientId,
        account.oauth2TenantId,
        account.oauth2Transport === 'graph'
      );

      // Log non-JWT Graph tokens for diagnostics but persist them —
      // Microsoft can return opaque access tokens that are still valid.
      if (isGraph && !isJwtShaped(tokens.accessToken)) {
        console.warn(`[authUtils] Refresh returned non-JWT Graph token — persisting (may be opaque)`);
      }

      if (!tokens.accessToken) {
        console.error(`[authUtils] Refresh returned empty access token — not persisting`);
        const freshAccounts = useMailStore.getState().accounts;
        return freshAccounts.find(a => a.id === account.id) || account;
      }

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
