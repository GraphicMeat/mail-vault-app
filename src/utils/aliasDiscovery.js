// ── aliasDiscovery: the pure rules for an account's alias list ──
//
// An alias is `{ address, name, source }`, source being where it came from:
// 'provider' (Gmail's send-as list), 'detected' (the account has sent as it)
// or 'manual' (the user typed it). The list never holds the login itself,
// and never two spellings of one address (case-insensitive).
//
// What the daemon's `aliases.discover` answers is merged here; the settings
// store only keeps the result. Plain data in, plain data out.

const key = (address) => (typeof address === 'string' ? address.trim().toLowerCase() : '');
const clean = (value) => (typeof value === 'string' ? value.trim() : '');

// One plain address: no display name, no brackets, no spaces, a dot in the
// domain. The server decides whether it will send as it.
const ADDRESS = /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[^\s@<>()[\],;:"]+$/;

export function isValidAliasAddress(address) {
  return typeof address === 'string' && ADDRESS.test(address.trim());
}

/**
 * Add one alias to a list, or say why not: 'invalid' (not an address),
 * 'login' (the account's own login) or 'duplicate' (already there).
 *
 * @returns {{ ok: true, alias: object, aliases: object[] } | { ok: false, reason: string }}
 */
export function addAliasToList({ aliases = [], loginEmail = '', alias }) {
  const address = clean(alias?.address);
  if (!isValidAliasAddress(address)) return { ok: false, reason: 'invalid' };
  if (key(address) === key(loginEmail)) return { ok: false, reason: 'login' };
  if (aliases.some(a => key(a?.address) === key(address))) return { ok: false, reason: 'duplicate' };
  const entry = { address, name: clean(alias?.name), source: alias?.source || 'manual' };
  return { ok: true, alias: entry, aliases: [...aliases, entry] };
}

/**
 * Merge one `aliases.discover` answer into an account's aliases.
 *
 * - Provider aliases (status 'ok'): every non-primary one not marked
 *   unverified is added as 'provider', with the provider's name.
 * - The provider's primary entry names the account (`displayName`) only when
 *   the account has no name yet.
 * - Detected `sent_from` addresses are proven senders: added as 'detected'.
 * - Detected `delivered_to` addresses are only suggestions: returned, never
 *   stored.
 * - A dismissed, existing or login address is never added or suggested. An
 *   existing alias keeps the name it has; one with no name takes the name
 *   discovery found. Aliases the provider stopped listing are kept.
 *
 * @returns {{ aliases: object[], added: object[], suggestions: object[], providerStatus: string, displayName: string|null }}
 */
export function mergeDiscovery({ aliases = [], dismissed = [], loginEmail = '', displayName = '', result }) {
  const login = key(loginEmail);
  const gone = new Set((dismissed || []).map(key));
  // Nothing may hold the login; a default From saved before aliases existed
  // can have become one on upgrade.
  const next = (aliases || []).filter(a => a && key(a.address) && key(a.address) !== login);
  if (!result || typeof result !== 'object') {
    return { aliases: aliases || [], added: [], suggestions: [], providerStatus: 'error', displayName: null };
  }
  const providerStatus = result.provider?.status || 'error';
  const added = [];
  let seededName = null;

  const take = (address, name, source) => {
    const k = key(address);
    if (!isValidAliasAddress(address) || k === login || gone.has(k)) return;
    const index = next.findIndex(a => key(a.address) === k);
    if (index >= 0) {
      if (!clean(next[index].name) && clean(name)) next[index] = { ...next[index], name: clean(name) };
      return;
    }
    const entry = { address: clean(address), name: clean(name), source };
    next.push(entry);
    added.push(entry);
  };

  if (providerStatus === 'ok') {
    for (const alias of result.provider?.aliases || []) {
      if (alias?.isPrimary) {
        if (!clean(displayName) && clean(alias.name) && seededName === null) seededName = clean(alias.name);
        continue;
      }
      if (alias?.verified === false) continue;
      take(alias?.address, alias?.name, 'provider');
    }
  }

  const detected = Array.isArray(result.detected) ? result.detected : [];
  for (const entry of detected) {
    if (entry?.source === 'sent_from') take(entry.address, entry.name, 'detected');
  }

  const suggestions = [];
  const suggested = new Set();
  for (const entry of detected) {
    if (entry?.source !== 'delivered_to') continue;
    const k = key(entry.address);
    if (!isValidAliasAddress(entry.address) || k === login || gone.has(k) || suggested.has(k)
      || next.some(a => key(a.address) === k)) continue;
    suggested.add(k);
    suggestions.push(entry);
  }

  return { aliases: next, added, suggestions, providerStatus, displayName: seededName };
}
