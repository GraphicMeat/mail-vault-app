// ── aliasDiscovery: ask the daemon which addresses an account can send as ──
//
// The daemon's `aliases.discover` does the work (the provider's send-as list,
// and the account's own Sent and delivery headers, read at background QoS);
// the rules for keeping its answer are utils/aliasDiscovery.js, applied by the
// settings store. This module only gets a fresh token, asks, and hands the
// answer over. A lookup can take ~12s under load, so callers show a spinner
// and never wait on it for anything else.

import * as api from './api';
import { ensureFreshToken } from './authUtils';
import { useSettingsStore } from '../stores/settingsStore';

const FAILED = () => ({ added: [], suggestions: [], providerStatus: 'error' });
// Long enough that the first paint and the first sync are done first.
const AUTO_DELAY_MS = 8000;

/** accountId -> the lookup running for it: one per account at a time. */
const running = new Map();
/** Accounts already given their automatic lookup this session. */
const scheduled = new Set();

/**
 * Discover and keep one account's aliases. Resolves with
 * `{ added, suggestions, providerStatus }` (see settingsStore.applyDiscovery);
 * never rejects: a failure is `providerStatus: 'error'` with nothing added.
 * A second call while one runs for the account shares it.
 */
export function refreshAliases(account) {
  if (!account?.id) return Promise.resolve(FAILED());
  const current = running.get(account.id);
  if (current) return current;
  const lookup = (async () => {
    try {
      // Gmail answers `denied` to a stale token, so it is refreshed first.
      const fresh = await ensureFreshToken(account);
      const result = await api.discoverAliases(fresh || account, account.id);
      return useSettingsStore.getState().applyDiscovery(account.id, account.email, result);
    } catch (err) {
      console.warn('[aliasDiscovery] lookup failed:', err?.message || err);
      return FAILED();
    } finally {
      running.delete(account.id);
    }
  })();
  running.set(account.id, lookup);
  return lookup;
}

/**
 * The automatic lookup: once per account per app session, `delayMs` after
 * it is asked for, fire-and-forget. It reads the account again when its turn
 * comes (a token refreshed meanwhile, or the account removed).
 */
export function scheduleAliasRefresh(account, { delayMs = AUTO_DELAY_MS } = {}) {
  if (!account?.id || scheduled.has(account.id)) return;
  scheduled.add(account.id);
  setTimeout(async () => {
    try {
      const { useMailStore } = await import('../stores/mailStore');
      const latest = (useMailStore.getState().accounts || []).find(a => a.id === account.id);
      if (!latest) return;
      // An OAuth account whose tokens are not loaded yet would only hear
      // `denied`: give the turn back, so opening the account asks again.
      if (latest.authType === 'oauth2' && !latest.oauth2AccessToken && !latest.oauth2RefreshToken) {
        scheduled.delete(account.id);
        return;
      }
      await refreshAliases(latest);
    } catch (err) {
      console.warn('[aliasDiscovery] automatic lookup failed:', err?.message || err);
    }
  }, delayMs);
}

/** Every visible account, one after another a few seconds apart. */
export function scheduleAliasRefreshAll(accounts, { delayMs = AUTO_DELAY_MS, spacingMs = 3000 } = {}) {
  (accounts || []).forEach((account, index) => scheduleAliasRefresh(account, { delayMs: delayMs + index * spacingMs }));
}

/** Test seam: forget running lookups and this session's schedule. */
export function _resetAliasDiscovery() {
  running.clear();
  scheduled.clear();
}
