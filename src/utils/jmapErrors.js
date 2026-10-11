// The daemon's JMAP failures, as the catalog keys the app shows them by.
//
// A JMAP error reaches the app in one of two shapes:
// - a failed connection test carries `errorCode` (JmapError::code(), e.g.
//   "E_JMAP_AUTH"), next to the message;
// - everything else is a message that starts with the code: "E_JMAP_NO_TRASH:
//   …", "E_JMAP_SUBMIT:forbiddenFrom: …", "E_JMAP_METHOD: mailboxHasEmail: …".
// Both go through jmapErrorKey. No imports here: i18n/index.js reads this file
// (tErr), and connectionError.js does too.

/** `E_JMAP_<CODE>` -> catalog key. A code not listed here keeps the generic paths. */
export const JMAP_BY_CODE = {
  E_JMAP_AUTH: 'errors.jmapAuthFailed',
  E_JMAP_TRANSPORT: 'errors.jmapConnect',
  E_JMAP_FOREIGN_HOST: 'errors.jmapForeignHost',
  E_JMAP_NO_TRASH: 'errors.jmapNoTrash',
  E_JMAP_NO_IDENTITY: 'errors.jmapNoIdentity',
  E_JMAP_NO_SUBMISSION: 'errors.jmapNoSubmission',
  E_JMAP_TOO_LARGE: 'errors.jmapTooLarge',
  // A daemon path that has no JMAP arm yet: bridge (UNSUPPORTED) or the
  // IMAP pool's refusal of a JMAP account (NOT_IMAP). Same words to the user.
  E_JMAP_UNSUPPORTED: 'errors.jmapUnsupported',
  E_JMAP_NOT_IMAP: 'errors.jmapUnsupported',
  // A throttled server is the provider limiting this account (the words the
  // IMAP connection check already uses).
  E_JMAP_RATE: 'errors.conn.problem.providerThrottling',
  // The server broke the protocol, or lost the state a sync stood on: one
  // fault in words, nothing for the user to fix but trying again.
  E_JMAP_PROTOCOL: 'errors.jmapServerFault',
  E_JMAP_CHANGES: 'errors.jmapServerFault',
};

// `E_JMAP_SUBMIT:<SetError type>` (RFC 8621 §7.5): a From the server will not
// send as is the identity problem; every other refusal is about the message.
const SUBMIT_BY_KIND = {
  forbiddenFrom: 'errors.jmapNoIdentity',
  forbiddenMailFrom: 'errors.jmapNoIdentity',
  tooLarge: 'errors.jmapTooLarge',
};

// `E_JMAP_METHOD: <SetError type>: …` kinds worth their own words; any other
// kind is a server fault.
const METHOD_BY_KIND = {
  mailboxHasEmail: 'errors.jmapFolderNotEmpty',
};

const CODE = /^(E_JMAP_[A-Z_]+)(?::\s*([A-Za-z]+))?/;

/**
 * The catalog key for a JMAP failure, or null when it is not one this app
 * words itself.
 * @param {unknown} input  an `errorCode`, a message, or an Error carrying either
 * @returns {string|null}
 */
export function jmapErrorKey(input) {
  const raw = typeof input === 'string' ? input : input?.errorCode || input?.message || '';
  const m = CODE.exec(String(raw).trim());
  if (!m) return null;
  const [, code, kind] = m;
  if (code === 'E_JMAP_SUBMIT') return SUBMIT_BY_KIND[kind] || 'errors.jmapSendRefused';
  if (code === 'E_JMAP_METHOD') return METHOD_BY_KIND[kind] || 'errors.jmapServerFault';
  return JMAP_BY_CODE[code] || null;
}
