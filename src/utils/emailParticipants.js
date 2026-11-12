import { isOwnAddress } from './ownAddresses';

const ROLES = [['from', (e) => (e.from ? [e.from] : [])], ['to', (e) => e.to], ['cc', (e) => e.cc]];

/**
 * Who is on an email: sender, then recipients, then cc, one entry per address
 * (first role wins), the user's own addresses dropped. `own` is a list of addresses.
 */
export function emailParticipants(email, own = []) {
  if (!email) return [];
  const seen = new Set();
  const out = [];
  for (const [role, pick] of ROLES) {
    for (const p of (pick(email) ?? []).filter(Boolean)) {
      const address = String(p.address || '').trim();
      const key = address.toLowerCase();
      if (!address || seen.has(key) || isOwnAddress(address, own)) continue;
      seen.add(key);
      out.push({ address, name: p.name || '', role });
    }
  }
  return out;
}
