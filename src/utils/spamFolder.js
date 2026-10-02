import { resolveEmailLocation } from '../stores/slices/unifiedHelpers';
import { junkPathOf } from './quickActionFacts';

// Servers name the folder anything ("Junk E-mail", "Bulk Mail"); only the last
// path segment counts, so "INBOX.Spam" and "[Gmail]/Spam" both match.
const SPAM_NAME = /^(spam|junk|junk ?e-?mail|bulk ?mail)$/i;

/**
 * Whether a message sits in its account's spam folder: the folder the server
 * marks \Junk, else one named like it. `state` is the mail store state, which
 * places the message (resolveEmailLocation) and lists the account's folders.
 */
export function isSpamMessage(message, state) {
  const location = resolveEmailLocation(message, state);
  if (!location) return false;
  if (junkPathOf(state, location.accountId) === location.mailbox) return true;
  const last = String(location.mailbox).split(/[/.]/).pop().trim();
  return SPAM_NAME.test(last);
}
