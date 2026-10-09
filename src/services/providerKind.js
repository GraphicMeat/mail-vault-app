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
