// ── oauthTokenSync: save the OAuth2 tokens the daemon refreshed ──
//
// The daemon owns token freshness (src-daemon/src/oauth_tokens.rs): it
// refreshes an account's access token when it is due and sends it on every
// request itself. The app stays the one writer of the credentials blob, so
// what the daemon refreshed is saved here, through `updateOAuth2Tokens`, the
// same path a refresh in the app used to take:
//
//   - `oauth2-tokens-refreshed` ({ accountId } only) says there is a pair to
//     save; `oauth2.take_refreshed` hands over every pair not saved yet;
//   - after every credentials write the app says so
//     (`oauth2.credentials_changed`), so the daemon reads the store again
//     before trusting what it holds (a new sign-in, a removed account) and
//     stops offering the pairs it now sees saved.
//
// A pair whose save failed stays on offer and is taken again with the next
// event, reconnect or launch. No token is ever logged here.
import { send } from './transport.js';

let started = false;
let running = null;
let again = false;

const code = (error) => error?.code || error?.name || 'error';

async function takeAndSave() {
  let reply;
  try {
    reply = await send('oauth2.take_refreshed', {});
  } catch (error) {
    console.warn('[oauthTokenSync] the daemon did not hand over refreshed tokens:', code(error));
    return 0;
  }
  const pairs = Array.isArray(reply?.tokens) ? reply.tokens : [];
  if (!pairs.length) return 0;
  const [{ updateOAuth2Tokens }, { useMailStore }] = await Promise.all([import('./db'), import('../stores/mailStore')]);
  let saved = 0;
  for (const { accountId, accessToken, refreshToken, expiresAt } of pairs) {
    if (!accountId || !accessToken) continue;
    try {
      // Undefined: the keychain holds no such account any more.
      const stored = await updateOAuth2Tokens(accountId, { accessToken, refreshToken, expiresAt });
      if (!stored) continue;
      saved += 1;
      useMailStore.setState(state => ({
        accounts: state.accounts.map(a => (a.id === accountId
          ? { ...a, oauth2AccessToken: accessToken, oauth2RefreshToken: refreshToken || a.oauth2RefreshToken, oauth2ExpiresAt: expiresAt }
          : a)),
      }));
    } catch (error) {
      console.warn('[oauthTokenSync] could not save the refreshed token of', accountId, code(error));
    }
  }
  return saved;
}

/**
 * Save every pair the daemon refreshed and the store does not hold yet.
 * Resolves with how many were saved; never rejects. A call while one runs
 * runs once more after it, so a refresh announced meanwhile is not missed.
 */
export function saveRefreshedTokens() {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    let saved = 0;
    do {
      again = false;
      saved += await takeAndSave();
    } while (again);
    return saved;
  })().finally(() => { running = null; });
  return running;
}

/** The app wrote the credentials blob. Never rejects: the daemon may be down. */
export async function credentialsChanged() {
  try {
    await send('oauth2.credentials_changed', {});
  } catch (error) {
    console.warn('[oauthTokenSync] could not tell the daemon the credentials changed:', code(error));
  }
}

/** Once, from the main window: listen, then take what is already waiting. */
export async function initOAuthTokenSync() {
  if (started) return;
  started = true;
  try {
    const { listen } = await import('@tauri-apps/api/event');
    await listen('oauth2-tokens-refreshed', () => saveRefreshedTokens());
    await listen('daemon-reconnected', () => saveRefreshedTokens());
  } catch { /* web dev mode: no Tauri events */ }
  await saveRefreshedTokens();
}

/** For tests: forget what `initOAuthTokenSync` set up. */
export function __resetForTests() {
  started = false;
  running = null;
  again = false;
}
