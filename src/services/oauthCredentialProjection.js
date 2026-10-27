// Native credential completion owns persistence. This listener only refreshes
// the visible OAuth account copy from a fresh, quiet credential read.
let started = false;

const grant = account => JSON.stringify([
  account.email || '', account.authType || '', account.oauth2RefreshToken || '',
  account.oauth2ClientId || '', account.oauth2Transport || '',
  account.oauth2TenantId || '', account.oauth2CustomClientId || '',
]);
const snapshot = account => JSON.stringify([
  grant(account), account.oauth2AccessToken || '', account.oauth2ExpiresAt ?? null,
]);

async function project(ids) {
  const { useMailStore } = await import('../stores/mailStore');
  const before = new Map(useMailStore.getState().accounts
    .filter(account => ids === null || ids.has(account.id))
    .map(account => [account.id, snapshot(account)]));
  if (!before.size) return;

  const { readCurrentCredentials } = await import('./db/keychain.js');
  let fresh;
  try { fresh = await readCurrentCredentials(); } catch { return; }
  if (!fresh) return;

  useMailStore.setState(state => {
    let changed = false;
    const accounts = state.accounts.map(account => {
      if (account.authType !== 'oauth2' || !before.has(account.id)
        || snapshot(account) !== before.get(account.id)) return account;
      let stored;
      try { stored = JSON.parse(fresh[account.id]); } catch { return account; }
      // A different refresh token may be a rotation or a new sign-in. With
      // no lineage in this notification, leave it to the next account read.
      if (!stored || stored.id !== account.id || stored.authType !== 'oauth2'
        || grant(stored) !== grant(account)
        || typeof stored.oauth2AccessToken !== 'string' || !stored.oauth2AccessToken
        || !Number.isFinite(stored.oauth2ExpiresAt)
        || Number(stored.oauth2ExpiresAt) < Number(account.oauth2ExpiresAt || 0)) return account;
      if (stored.oauth2AccessToken === account.oauth2AccessToken
        && stored.oauth2ExpiresAt === account.oauth2ExpiresAt) return account;
      changed = true;
      return { ...account, oauth2AccessToken: stored.oauth2AccessToken,
        oauth2ExpiresAt: stored.oauth2ExpiresAt };
    });
    return changed ? { accounts } : state;
  });
}

export async function initOAuthCredentialProjection() {
  if (started) return;
  started = true;
  try {
    const { listen } = await import('@tauri-apps/api/event');
    await listen('credentials-changed', event => {
      const ids = event?.payload?.ids;
      if (Array.isArray(ids) && ids.every(id => typeof id === 'string')) {
        void project(new Set(ids));
      }
    });
    await listen('oauth2-tokens-refreshed', event => {
      const id = event?.payload?.accountId;
      if (typeof id === 'string') void project(new Set([id]));
    });
    await listen('daemon-reconnected', () => { void project(null); });
  } catch { /* web dev mode: no Tauri events */ }
}

export function __resetForTests() { started = false; }
