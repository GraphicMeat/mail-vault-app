import { ownAddresses } from '../../../utils/ownAddresses';
import { normalizeEmailIdentity } from '../../../utils/emailIdentity';
import { findPii, buildNameDictionary, EMPTY_DICTIONARY } from '../../../utils/privacy/piiDetector';

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
 * The display name is the spammer's to choose, so it is revealed only when it
 * names nobody: no address, phone or postal address in it, none of the user's
 * or the recipients' names (whole, in part, or as an address's local part: "Own
 * Name via DocuSign", "Own, your parcel"). A spoofed contact's name is still
 * revealed: on a card it is only what this spam claims. The app window shot
 * reveals addresses only (`revealAddressesOnly`), where a name would unmask that
 * contact's real rows too. The host dictionary cannot tell them apart: it holds
 * every loaded sender, the spammer included.
 *
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

  // Names whose appearance in a display name makes it the user's or a recipient's: theirs,
  // and the local parts of their addresses ("rokas.ambrazevicius@...").
  const localPart = (a) => String(a).split('@')[0];
  const mine = buildNameDictionary({
    names: [...ownNames, ...recipientNames, ...[...own, ...recipients.map(r => r.address)].filter(Boolean).map(localPart)],
  });
  // The detector wants capitals on names and the From name arrives lowercased: look at both.
  const probes = (name) => [name, name.replace(/(^|[^\p{L}])(\p{L})/gu, (_, sep, c) => sep + c.toUpperCase())];
  const safeName = (name) => {
    if (findPii(name, EMPTY_DICTIONARY).length) return false;
    // Names only: the title-cased probe would read "Via Parcel" as a street.
    return !probes(name).some(p => findPii(p, mine).some(span => span.kind === 'name'));
  };

  const reveal = new Set();
  const from = partyParts(message?.from);
  // A From that is you or someone it was sent to is not a spammer to name.
  if (from.address && !isOwnAddress(from.address)) {
    reveal.add(from.address);
    // A spoofed name is often the victim's own, or carries it: that stays masked.
    if (from.name && safeName(from.name)) reveal.add(from.name);
  }
  for (const p of listOf(message?.replyTo)) {
    const { address } = partyParts(p);
    if (address && !isOwnAddress(address)) reveal.add(address);
  }
  return reveal;
}

/** The addresses of a reveal set, without the name: what the app window shot may show. */
export const revealAddressesOnly = (reveal) => (reveal?.size ? new Set([...reveal].filter(v => v.includes('@'))) : reveal);
