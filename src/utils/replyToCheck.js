/**
 * Reply-To domain mismatch detection.
 *
 * A common phishing signal: the email's Reply-To points at a domain that
 * isn't the same as (or a subdomain of) the From domain. Legit bulk senders
 * generally route replies to the same domain they send from — a mismatch
 * deserves a user-visible warning.
 *
 * Returns `{ fromDomain, replyToAddress, replyToDomain }` when a mismatch is
 * detected, or `null` when From/Reply-To are consistent (or data is missing).
 */

function extractReplyToAddress(replyTo) {
  if (!replyTo) return '';
  // Shapes we see in the wild:
  //   IMAP parser: single object { address, name }
  //   Full Email:  array of { address, name }
  //   Graph:       may come through as a string in some caches
  if (Array.isArray(replyTo)) return replyTo[0]?.address || '';
  if (typeof replyTo === 'string') return replyTo;
  return replyTo?.address || '';
}

function getDomain(address) {
  if (!address) return '';
  return address.toLowerCase().split('@')[1] || '';
}

/**
 * Return the mismatch descriptor for an email, or null.
 * Exported so messageListSlice, tests, and UI helpers stay in sync.
 */
export function detectReplyToMismatch(email) {
  if (!email) return null;
  const fromAddress = (email.from?.address || '').toLowerCase();
  const fromDomain = getDomain(fromAddress);
  if (!fromDomain) return null;

  const replyToAddress = extractReplyToAddress(email.replyTo);
  const replyToDomain = getDomain(replyToAddress);
  if (!replyToDomain) return null;

  if (replyToDomain === fromDomain) return null;
  // Treat subdomains as related, in either direction.
  if (fromDomain.endsWith('.' + replyToDomain)) return null;
  if (replyToDomain.endsWith('.' + fromDomain)) return null;

  return { fromDomain, replyToAddress, replyToDomain };
}
