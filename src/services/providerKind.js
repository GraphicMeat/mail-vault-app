// Which protocol an account speaks, read off its stored fields. One place, so
// no view re-derives it from hostnames. Rust mirrors these on ImapConfig
// (`uses_graph`, `uses_jmap`).
import { isGraphAccount } from './graphConfig.js';

/**
 * A JMAP account: its add-account flow stored the session URL. A blank URL is
 * not one, matching ImapConfig::uses_jmap.
 * @param {object|null|undefined} account
 * @returns {boolean}
 */
export function isJmapAccount(account) {
  const url = account?.jmapSessionUrl;
  return typeof url === 'string' && url.trim() !== '';
}

/**
 * The server files its own copy of sent mail (Graph sendMail, JMAP
 * EmailSubmission), so the app must not save a second one to Sent.
 * @param {object|null|undefined} account
 * @returns {boolean}
 */
export function serverSavesSent(account) {
  return isGraphAccount(account) || isJmapAccount(account);
}

/**
 * The host a JMAP account is keyed by (`imapHost`, so `accountLogicalKey`
 * needs no JMAP branch): the session URL's hostname, lowercased. '' for
 * anything but an https URL, so a typo or a plain-http URL never becomes an
 * account. The port is not part of it, as `JmapClient` trusts hosts, not ports.
 * @param {string|null|undefined} url
 * @returns {string}
 */
export function jmapSessionHost(url) {
  try {
    const parsed = new URL(String(url ?? '').trim());
    return parsed.protocol === 'https:' ? parsed.hostname.toLowerCase() : '';
  } catch {
    return '';
  }
}
