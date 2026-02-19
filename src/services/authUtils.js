/**
 * Check if an account has valid credentials (password or OAuth2).
 * Shared by mailStore, AccountPipeline, and EmailPipelineManager.
 */
export function hasValidCredentials(account) {
  if (!account) return false;
  return !!(account.password || (account.authType === 'oauth2' && account.oauth2AccessToken));
}
