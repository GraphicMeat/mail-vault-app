// Which Google app a Gmail sign-in goes through. The daemon owns the choice
// (src-core/src/oauth2.rs); this is the app's side of it: reading what the
// build offers, telling which app an account's stamp names, and the catalog
// text for the daemon's refusal.

export const GOOGLE_CLIENT_THUNDERBIRD = 'thunderbird';
export const GOOGLE_CLIENT_MAILVAULT = 'mailvault';

/** The daemon's refusal code (src-core oauth2::OWN_GOOGLE_CLIENT_UNAVAILABLE). */
export const E_GOOGLE_OWN_CLIENT_UNAVAILABLE = 'E_GOOGLE_OWN_CLIENT_UNAVAILABLE';
const OWN_UNAVAILABLE_KEY = 'googleClient.ownUnavailable';

/**
 * The app an account's refresh token was issued by, from its `oauth2ClientId`
 * stamp and the ids the daemon reports. No stamp is an account from before
 * stamps existed, i.e. Thunderbird. Thunderbird's own id is Thunderbird;
 * anything else is MailVault's.
 */
export function googleClientFromStamp(stamp, clients) {
  const id = typeof stamp === 'string' ? stamp.trim() : '';
  if (!id) return GOOGLE_CLIENT_THUNDERBIRD;
  if (clients?.thunderbirdClientId && id === clients.thunderbirdClientId) return GOOGLE_CLIENT_THUNDERBIRD;
  return GOOGLE_CLIENT_MAILVAULT;
}

/**
 * Catalog text for a sign-in error, or `fallback` for any other. The daemon's
 * refusal starts with its `E_*` code, like every other service-layer error that
 * reaches the UI.
 */
export function googleClientErrorText(error, t, fallback) {
  const message = String(error?.message ?? error ?? '');
  if (message.startsWith(E_GOOGLE_OWN_CLIENT_UNAVAILABLE)) return t(OWN_UNAVAILABLE_KEY);
  return fallback ?? message;
}

/** What this build offers; never throws (a build or test with no daemon offers only Thunderbird's). */
export async function loadGoogleClients() {
  try {
    const { getGoogleClients } = await import('./api');
    const clients = await getGoogleClients();
    return clients && typeof clients === 'object' ? clients : { mailvault: false };
  } catch {
    return { mailvault: false };
  }
}
