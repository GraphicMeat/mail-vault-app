// ── emailIdentity.js — is this the same mailbox, not the same bytes ──
//
// For checking whether two typed/claimed addresses point at the same inbox
// (Track B: does the Google account someone signed into match what they
// typed?), never for display or for actually addressing mail — sending
// still uses the address exactly as given.
//
// Gmail (and its legacy googlemail.com domain) ignores dots and anything
// after a `+` in the local part for delivery: "john.doe+news@gmail.com" and
// "johndoe@gmail.com" are the same inbox, and the id_token's `email` claim
// is always the canonical (dot-free) form regardless of how the user typed
// it. No other provider is known to fold addresses this way, so every other
// domain is normalized case-insensitively only — dots and plus-addressing
// are left alone there, since they may be meaningful.

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

export function normalizeEmailIdentity(email) {
  const trimmed = String(email || '').trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  if (at === -1) return trimmed;
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  if (!GMAIL_DOMAINS.has(domain)) return `${local}@${domain}`;
  const canonicalLocal = local.split('+')[0].replace(/\./g, '');
  return `${canonicalLocal}@gmail.com`;
}
