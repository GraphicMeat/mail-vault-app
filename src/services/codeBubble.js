import { htmlToPlainText } from '../utils/emailParser';
import { useCodeBubbleStore } from '../stores/codeBubbleStore';
import { isGraphAccount, graphMessageToEmail } from './graphConfig';
import { ensureFreshToken } from './authUtils';

/**
 * The message's body, read the way the reader's prefetch reads it: an IMAP
 * message through the daemon's light fetch (which keeps the body as the
 * message's own copy), an Outlook message signed in with Microsoft through
 * Graph. `null` when there is nothing to read it with: an account removed
 * since the arrival, or a Graph message the list has not mapped yet.
 *
 * The store, the API and the id map are loaded late: the mail store sits on
 * top of the scheduler this is called from, and nothing here is needed before
 * an arrival.
 */
export async function fetchArrivalBody(accountId, uid, mailbox) {
  const [{ useMailStore }, api] = await Promise.all([import('../stores/mailStore'), import('./api')]);
  const account = useMailStore.getState().accounts.find(a => a.id === accountId);
  if (!account) return null;
  if (!isGraphAccount(account)) return api.fetchEmailLight(account, uid, mailbox, accountId, { background: true });
  const { getGraphMessageId } = await import('./cacheManager');
  const graphId = getGraphMessageId(accountId, mailbox, uid);
  if (!graphId) return null;
  const fresh = await ensureFreshToken(account);
  return graphMessageToEmail(await api.graphGetMessage(fresh.oauth2AccessToken, graphId), uid);
}

// The daemon reads the code (`message.code`, src-core/src/verification_code.rs).
async function codeIn(subject, text) {
  const api = await import('./api');
  return api.messageCode(subject, text);
}

/**
 * An arrival's newest header, from the change feed: offer its one-time code
 * in the corner bubble. A code in the subject costs nothing; a subject that
 * only announces a code ("Sign in to Acme") costs one body read. Anything
 * else is left alone.
 */
export async function offerCodeFromArrival(accountId, mailbox, header, { fetchBody = fetchArrivalBody } = {}) {
  if (!header || header.uid == null || mailbox !== 'INBOX') return;
  const subject = header.subject || '';
  let code;
  try {
    const first = await codeIn(subject, header.snippet || '');
    code = first?.code || null;
    if (!code && first?.needsBody) {
      let body;
      try {
        body = await fetchBody(accountId, header.uid, mailbox);
      } catch (e) {
        console.warn('[codeBubble] Could not read the body for a code:', e);
        return;
      }
      code = (await codeIn(subject, body?.text || htmlToPlainText(body?.html || '')))?.code || null;
    }
  } catch (e) {
    console.warn('[codeBubble] Could not read the mail for a code:', e);
    return;
  }
  if (!code) return;
  const from = typeof header.from === 'string' ? { address: header.from } : (header.from || {});
  useCodeBubbleStore.getState().offer({
    accountId, mailbox, uid: header.uid, code,
    sender: from.name || from.address || '',
    subject,
  });
}
