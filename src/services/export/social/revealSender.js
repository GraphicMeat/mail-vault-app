import { ownAddresses } from '../../../utils/ownAddresses';
import { normalizeEmailIdentity } from '../../../utils/emailIdentity';

/**
 * What a redacted social image may still show of a spam message: the sender's
 * exact From address and name and the Reply-To addresses, so a screenshot names
 * the spammer. EXACT values only, lowercased and trimmed; the people the mail
 * was sent to, and the user's own identities, are never in it. A name is never
 * taken out of the name dictionary: a display name that contains a contact's
 * name must not unmask that contact in the body.
 */
const lower = (v) => String(v ?? '').trim().toLowerCase();
const listOf = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

// A party is {name, address}, or the "Name <addr>" / bare-address string some fixtures use.
function partyParts(p) {
  if (p && typeof p === 'object') return { name: lower(p.name), address: lower(p.address) };
  const s = String(p ?? '').trim();
  const m = /^\s*"?(.*?)"?\s*<([^>]+)>\s*$/.exec(s);
  if (m) return { name: lower(m[1]), address: lower(m[2]) };
  return s.includes('@') ? { name: '', address: lower(s) } : { name: lower(s), address: '' };
}

/**
 * `message`: the dated message; `accounts`, `sendAsAddresses`, `aliases`: every
 * account the app holds and its own addresses (login, default From, aliases),
 * not only the one on screen.
 */
export function buildRevealSet(message, { accounts = [], sendAsAddresses = {}, aliases = {}, displayNames = {} } = {}) {
  const own = new Set();
  const ownNames = new Set();
  for (const account of accounts || []) {
    for (const a of ownAddresses({ account, sendAsAddress: sendAsAddresses?.[account.id], aliases: aliases?.[account.id] })) {
      own.add(normalizeEmailIdentity(a));
    }
    if (account?.name) ownNames.add(lower(account.name));
  }
  for (const n of Object.values(displayNames || {})) if (n) ownNames.add(lower(n));

  const recipients = [...listOf(message?.to), ...listOf(message?.cc), ...listOf(message?.bcc)].map(partyParts);
  const isOwnAddress = (a) => !!a && (own.has(normalizeEmailIdentity(a)) || recipients.some(r => r.address && normalizeEmailIdentity(r.address) === normalizeEmailIdentity(a)));
  const recipientNames = new Set(recipients.map(r => r.name).filter(Boolean));

  const reveal = new Set();
  const from = partyParts(message?.from);
  // A From that is you or someone it was sent to is not a spammer to name.
  if (from.address && !isOwnAddress(from.address)) {
    reveal.add(from.address);
    // A spoofed name is often the victim's own: that stays masked.
    if (from.name && !ownNames.has(from.name) && !recipientNames.has(from.name)) reveal.add(from.name);
  }
  for (const p of listOf(message?.replyTo)) {
    const { address } = partyParts(p);
    if (address && !isOwnAddress(address)) reveal.add(address);
  }
  return reveal;
}
