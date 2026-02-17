// Microsoft OAuth2 configuration for XOAUTH2 IMAP/SMTP access
// Uses Thunderbird's public client registration (well-known, pre-approved for IMAP/SMTP OAuth2)
export const MICROSOFT_OAUTH = {
  authEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
  tokenEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  // Thunderbird's public client ID — pre-registered with correct Exchange Online permissions
  thunderbirdClientId: '9e5f94bc-e8a4-4e73-b8be-63364c29d753',
  scopes: [
    'offline_access',
    'https://outlook.office.com/IMAP.AccessAsUser.All',
    'https://outlook.office.com/SMTP.Send',
  ],
  redirectUri: 'http://localhost:19876/callback',
  callbackPort: 19876,
};

// Get Microsoft OAuth2 credentials
// Uses Thunderbird's public client ID by default (no secret needed)
// Can be overridden with env vars for custom Azure app registration
export function getMicrosoftCredentials() {
  const envId = process.env.MAILVAULT_MS_CLIENT_ID;
  const envSecret = process.env.MAILVAULT_MS_CLIENT_SECRET;
  const clientId = (envId && envId !== 'undefined') ? envId : MICROSOFT_OAUTH.thunderbirdClientId;
  const clientSecret = (envSecret && envSecret !== 'undefined') ? envSecret : null;

  return { clientId, clientSecret };
}
