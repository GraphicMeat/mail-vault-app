/// A view's sender rules: an address (`bills@servico.lt`) or a domain
/// (`servico.lt`, which takes its subdomains). The daemon decides what a view
/// finds; this only says where a sender stands so the builder can show it.

/// A rule in the form the index compares: lowercase, no padding, no leading
/// `@` on a domain. Blank is no rule.
export const normalizeSender = value => String(value ?? '').trim().replace(/^@+/, '').toLowerCase();

/// Does `rule` name `address`? A whole address, or a domain it sits on. Never
/// a piece of either: `ervico.lt` is nobody.
export function senderMatches(rule, address) {
  const wanted = normalizeSender(rule);
  const from = normalizeSender(address);
  if (!wanted || !from) return false;
  if (wanted.includes('@')) return from === wanted;
  return from.endsWith(`@${wanted}`) || from.endsWith(`.${wanted}`);
}

/// Where a sender stands in a view: `blocked` (a block names it, and wins),
/// `allowed` (an allowance names it), `outside` (the view allows others only,
/// so this one never shows) or `open` (no rule has a say).
export function senderState(def, address) {
  if ((def?.excludeSenders || []).some(rule => senderMatches(rule, address))) return 'blocked';
  const allowed = def?.senders || [];
  if (allowed.some(rule => senderMatches(rule, address))) return 'allowed';
  return allowed.length ? 'outside' : 'open';
}

/// Mail providers: allowing `gmail.com` would let in the world.
const MAIL_PROVIDERS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'icloud.com', 'me.com',
  'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'gmx.net', 'mail.com', 'yandex.com', 'zoho.com', 'fastmail.com',
]);

/// What the builder offers to allow for one email's sender: the address, and
/// its domain unless that is a mail provider's. Nothing for a row with no
/// address.
export function senderChoices(address) {
  const from = normalizeSender(address);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(from)) return [];
  const domain = from.slice(from.indexOf('@') + 1);
  return MAIL_PROVIDERS.has(domain) ? [from] : [from, domain];
}
