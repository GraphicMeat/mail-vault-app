// The connection state for a daemon call that could not get an OAuth2 token.
// Its own module, not authUtils: many tests mock authUtils, and a load path
// that classifies its failure must not trip over a mock that predates this.
import { tErr } from '../i18n/index.js';

/**
 * The connection state for a daemon call that needed an OAuth2 token the
 * daemon could not produce (src-daemon/src/oauth_tokens.rs): a new sign-in
 * (`oauthExpired`, the sidebar's sign-in-required notice) or an unreadable
 * keychain (`passwordMissing`, what a failed credentials read shows). `null`
 * for any other failure, which the caller classifies as before.
 */
export function oauthErrorState(error) {
  const raw = typeof error === 'string' ? error : error?.message;
  if (typeof raw !== 'string') return null;
  if (raw.startsWith('E_OAUTH_SIGN_IN_NEEDED')) return { errorType: 'oauthExpired', errorMessage: tErr(raw) };
  if (raw.startsWith('E_OAUTH_KEYCHAIN_UNAVAILABLE')) return { errorType: 'passwordMissing', errorMessage: tErr(raw) };
  return null;
}
