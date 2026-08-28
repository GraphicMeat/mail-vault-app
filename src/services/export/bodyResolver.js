import * as db from '../db';
import * as api from '../api';
import { ensureFreshToken } from '../authUtils';
import { hydrateInlineImages } from '../attachmentUtils';
import { getGraphMessageId, graphMessageToEmail } from '../../stores/mailStore';
import { resolveEmailLocation, bodyMatchesHeader } from '../../stores/slices/unifiedHelpers';

// Extracted from useChatBodyLoader.fetchOne so the export and the reading pane
// resolve a body the same way. The guards are the point: the vault is keyed
// (accountId, mailbox, uid) with no generation proof, so a uid archived under
// an older UIDVALIDITY names a different message.
//
// The hook keeps what is the hook's — concurrency, retry, per-bubble notify.
// What lives here is the sequence: locate, read the vault, check custody
// against the header, fall back to the server on the account's own transport,
// re-check, hydrate.
export async function resolveMessageBody(header, store) {
  const loc = resolveEmailLocation(header, store);
  if (!loc) return { ok: false, reason: 'location unknown' };

  const { accountId, mailbox } = loc;

  let local = null;
  try {
    local = await db.getLocalEmailLight(accountId, mailbox, header.uid);
  } catch (err) {
    local = null;
  }

  // The vault's copy answering for a different Message-ID is the wrong
  // message, not a dead end. Discard it and ask the server, which owns the uid
  // the header was built from. Treating it as a dead end printed the row's
  // subject where its body belongs.
  if (local && !bodyMatchesHeader(header, local)) local = null;
  if (local) {
    const hydrated = await hydrateInlineImages(local, accountId, mailbox);
    return { ok: true, email: { ...hydrated, _accountId: accountId } };
  }

  const account = store.accounts.find(a => a.id === accountId) || null;
  if (!account) return { ok: false, reason: 'account unavailable' };

  let fresh = account;
  try { fresh = await ensureFreshToken(account); } catch (_) { /* stale token still worth a try */ }

  let remote = null;
  try {
    // A Graph account has no IMAP uid to fetch by. A helper that knows only
    // the IMAP path hands every Outlook user an empty body in silence.
    if (fresh.oauth2Transport === 'graph') {
      const graphId = getGraphMessageId(accountId, mailbox, header.uid);
      if (graphId) {
        const message = await api.graphGetMessage(fresh.oauth2AccessToken, graphId);
        remote = graphMessageToEmail(message, header.uid);
        api.graphCacheMime(fresh.oauth2AccessToken, graphId, accountId, mailbox, header.uid).catch(() => {});
      }
    } else {
      remote = await api.fetchEmailLight(fresh, header.uid, mailbox, accountId);
    }
  } catch (err) {
    return { ok: false, reason: `fetch failed: ${err.message || err}` };
  }

  // Last line of defence: this is the server's own answer for this uid, so a
  // retry only asks the same blind question again.
  if (!remote) return { ok: false, reason: 'not found' };
  if (!bodyMatchesHeader(header, remote)) return { ok: false, reason: 'Message-ID mismatch' };

  const hydrated = await hydrateInlineImages(remote, accountId, mailbox);
  return { ok: true, email: { ...hydrated, _accountId: accountId } };
}
