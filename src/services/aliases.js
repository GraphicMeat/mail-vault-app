/**
 * Send-as aliases: thin bindings to the daemon's `aliases.*` RPCs
 * (src-daemon/src/handlers/alias_store.rs, rules in
 * src-core/src/aliases/list.rs). The daemon keeps every account's list in
 * the settings document, looks an account up with the credentials it holds
 * itself (no token goes from here), and runs the automatic lookup once per
 * account, a while after it is asked for.
 *
 * The settings store writes its saved blob whole, so every list the daemon
 * answers is put into the store here: its next write then carries what the
 * daemon wrote instead of the list it held before. And before asking for a
 * change, what the store has not written yet (an alias renamed a moment ago)
 * is written first, so the daemon's read of the lists holds it.
 */

import { send } from './transport.js';
import { useSettingsStore } from '../stores/settingsStore';
import { flushSafeStorage } from '../stores/safeStorage';

const FAILED = () => ({ added: [], suggestions: [], providerStatus: 'error' });

/** Put the lists one answer left behind into the settings store. */
function keep(accountId, reply) {
  if (!accountId || !reply || typeof reply !== 'object') return;
  const patch = {};
  const state = useSettingsStore.getState();
  if (Array.isArray(reply.aliases)) patch.aliases = { ...state.aliases, [accountId]: reply.aliases };
  if (Array.isArray(reply.dismissed)) patch.dismissedAliases = { ...state.dismissedAliases, [accountId]: reply.dismissed };
  if (typeof reply.displayName === 'string' && reply.displayName) patch.displayNames = { ...state.displayNames, [accountId]: reply.displayName };
  if (reply.defaultFromCleared) patch.sendAsAddresses = { ...state.sendAsAddresses, [accountId]: '' };
  if (Object.keys(patch).length) useSettingsStore.setState(patch);
}

const ids = account => ({ accountId: account?.id, loginEmail: account?.email || '' });

/** The store's pending write, done; a failed one is retried by the store. */
const flushed = () => flushSafeStorage().catch(() => {});

/**
 * Look the account up now and keep what is found. Resolves with
 * `{ added, suggestions, providerStatus }`; never rejects (a failure is
 * `providerStatus: 'error'`). A lookup can take ~12s under load; a second
 * call while one runs shares it (the daemon's).
 */
export async function refreshAliases(account) {
  if (!account?.id) return FAILED();
  try {
    await flushed();
    const reply = await send('aliases.refresh', ids(account));
    keep(account.id, reply);
    return {
      added: reply?.added || [],
      suggestions: reply?.suggestions || [],
      providerStatus: reply?.providerStatus || 'error',
    };
  } catch (err) {
    console.warn('[aliases] lookup failed:', err?.message || err);
    return FAILED();
  }
}

/**
 * The automatic lookup: the daemon runs it once per account per daemon run,
 * after the first paint and sync, one account at a time. Fire-and-forget.
 */
export function scheduleAliasRefresh(account) {
  if (!account?.id) return;
  send('aliases.refresh', { ...ids(account), auto: true })
    .catch(err => console.warn('[aliases] automatic lookup not scheduled:', err?.message || err));
}

/** Every visible account; the daemon spaces the lookups apart. */
export function scheduleAliasRefreshAll(accounts) {
  (accounts || []).forEach(scheduleAliasRefresh);
}

/**
 * Add one alias. Resolves with `{ ok: true, alias }` or `{ ok: false, reason }`:
 * 'invalid', 'login', 'duplicate', or the catalog key of a write that failed.
 */
export async function addAlias(account, { address, name = '', source = 'manual' } = {}) {
  if (!account?.id) return { ok: false, reason: 'invalid' };
  try {
    await flushed();
    const reply = await send('aliases.add', { ...ids(account), address: address || '', name: name || '', source });
    if (!reply?.ok) return { ok: false, reason: reply?.reason || 'invalid' };
    keep(account.id, reply);
    return { ok: true, alias: reply.alias };
  } catch (err) {
    return { ok: false, reason: err?.message || String(err) };
  }
}

/**
 * Remove one alias for good: discovery skips it from now on, and a default
 * From that pointed at it falls back to the login. Resolves true once kept.
 */
export async function removeAlias(account, address) {
  if (!account?.id || !address) return false;
  try {
    await flushed();
    keep(account.id, await send('aliases.remove', { ...ids(account), address }));
    return true;
  } catch (err) {
    console.warn('[aliases] remove failed:', err?.message || err);
    return false;
  }
}
