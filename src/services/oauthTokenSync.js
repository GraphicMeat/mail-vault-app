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

/**
 * A stored record's grant, named the way the daemon names the grants of a
 * pair it offers (`chain`, `Grant::fingerprint` in oauth_tokens.rs): SHA-256
 * of the refresh token with the client, transport, tenant and custom client
 * it belongs to. No token leaves this function.
 */
export async function grantFingerprint(record) {
  const named = JSON.stringify([
    record?.oauth2RefreshToken || '',
    record?.oauth2ClientId || '',
    record?.oauth2Transport === 'graph' ? 'graph' : '',
    record?.oauth2TenantId || '',
    record?.oauth2CustomClientId || '',
  ]);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(named));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

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
  const [{ updateOAuth2Tokens, getAccount }, { useMailStore }] = await Promise.all([import('./db'), import('../stores/mailStore')]);
  let saved = 0;
  for (const { accountId, accessToken, refreshToken, expiresAt, chain } of pairs) {
    if (!accountId || !accessToken) continue;
    try {
      // A sign-in saved since the daemon refreshed (Reconnect, a switch of
      // the Google sign-in app or of transport) is another grant: its record
      // is never written over with this one's pair, whatever the expiries.
      // Within one grant the later expiry wins, as it does in the daemon.
      const current = await getAccount(accountId);
      if (!current?.oauth2RefreshToken) continue;
      if (Array.isArray(chain) && !chain.includes(await grantFingerprint(current))) continue;
      if (current.oauth2AccessToken && current.oauth2AccessToken !== accessToken
        && Number(current.oauth2ExpiresAt) > Number(expiresAt)) continue;
      // Undefined: the keychain holds no such account any more.
      const stored = await updateOAuth2Tokens(accountId, { accessToken, refreshToken, expiresAt, chain });
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
