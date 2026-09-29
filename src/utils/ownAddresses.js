// ── ownAddresses: every address that is "you", and one way to ask ──
//
// An account is more than its login: it has a default From (the send-as
// pointer) and every alias it holds. Anything that decides whether an address
// is the user (chat sides, Reply All, sender grouping, contacts, insights)
// asks here, so an alias counts everywhere or nowhere.
//
// The comparison is an identity check, never a display one: case-insensitive,
// and for Gmail dot- and plus-folded (normalizeEmailIdentity), because a
// header written as jdoe@gmail.com is the same inbox as a login typed
// j.doe@gmail.com. Addresses are still shown and sent exactly as stored.

import { normalizeEmailIdentity } from './emailIdentity.js';

/**
 * One account's own addresses: the login, the default From, then every alias.
 * First spelling wins; case-insensitive dedupe; blanks dropped.
 *
 * @param {{ account?: {email?: string}, aliases?: {address: string}[], sendAsAddress?: string }} input
 * @returns {string[]}
 */
export function ownAddresses({ account, aliases, sendAsAddress } = {}) {
  const out = [];
  const seen = new Set();
  for (const raw of [account?.email, sendAsAddress, ...(aliases || []).map(a => a?.address)]) {
    const address = typeof raw === 'string' ? raw.trim() : '';
    if (!address || seen.has(address.toLowerCase())) continue;
    seen.add(address.toLowerCase());
    out.push(address);
  }
  return out;
}

/**
 * The identity-normalized Set of an address or a list of them. A Set passed in
 * is taken as one this function already built.
 */
export function ownAddressSet(list) {
  if (list instanceof Set) return list;
  const values = Array.isArray(list) ? list : [list];
  return new Set(values
    .map(v => (typeof v === 'string' ? normalizeEmailIdentity(v) : ''))
    .filter(Boolean));
}

/** Is `address` one of `list` (an address, a list, or an ownAddressSet)? */
export function isOwnAddress(address, list) {
  if (typeof address !== 'string') return false;
  const id = normalizeEmailIdentity(address);
  return !!id && ownAddressSet(list).has(id);
}
