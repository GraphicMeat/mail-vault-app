// ── localDrafts — the open compose window, kept in the vault while it is typed ──
//
// A compose window used to be the one place in the app where a message existed
// in RAM only: anything that unmounted it (a stray dismissal, a reload, a
// crash) took the text with it. This writes the message the user is typing
// into their account's Drafts folder in the local vault, 0.3s after they stop.
//
// Local only, by design for now — nothing here APPENDs to the server's Drafts
// mailbox, so it costs no network and works for an account that is offline.
//
// One compose window owns one draft uid for its whole life (threaded through
// minimize/restore as `_draftUid`), so every save REPLACES that draft rather
// than adding one per typing pause.

import * as api from './api';
import * as db from './db';
import { useMailStore } from '../stores/mailStore';
import { _resolveMailboxPath } from '../stores/slices/unifiedHelpers';

const invoke = () => window.__TAURI__?.core?.invoke;

// 'archived' does not mean "came from a server" — it means the raw .eml is in
// the vault, and it is what puts a local row in the list (deriveDisplayRows
// only shows local entries whose uid is in archivedEmailIds, which is
// `maildir_list requireFlag: 'archived'`). Provenance lives in the index's
// `source` field instead, where a delete can read it.
const DRAFT_FLAGS = ['archived', 'seen', 'draft'];

/**
 * The account's Drafts mailbox path, from the folder list we already hold.
 *
 * ponytail: no server-side ensure/CREATE tier, unlike the Sent resolver — this
 * stage never talks to a server. A vault folder literally called 'Drafts' is a
 * fine place to hold a draft for an account whose folder list has not landed.
 */
export async function resolveDraftsMailbox(accountId) {
  const { activeAccountId, mailboxes } = useMailStore.getState();
  const list = (activeAccountId === accountId && mailboxes?.length)
    ? mailboxes
    : await db.getCachedMailboxes(accountId).catch(() => null);
  return _resolveMailboxPath(list, 'Drafts') || 'Drafts';
}

/** A stable synthetic uid for one compose window. Same convention as the staged Sent copy. */
export const newDraftUid = () => Math.floor(Date.now() / 1000);

/**
 * Write the draft to disk and make it visible in the Drafts list.
 *
 * Returns the index entry that was written, or null when the MIME could not be
 * built — a save that cannot produce the real bytes writes nothing at all,
 * because a draft row that does not open the user's text is worse than no row.
 */
export async function saveLocalDraft({ account, accountId, mailbox, uid, fromAddress, displayName, payload, snippet, hasAttachments }) {
  const tauri = invoke();
  if (!tauri) return null;

  const sendAsEmail = fromAddress && fromAddress !== account.email ? fromAddress : '';
  const built = await api.buildDraftMime(
    { ...account, name: displayName, fromEmail: sendAsEmail || undefined },
    payload,
  );
  if (!built?.rawBase64) return null;

  await tauri('maildir_store', {
    accountId,
    mailbox,
    uid,
    rawSourceBase64: built.rawBase64,
    flags: DRAFT_FLAGS,
  });

  const entry = {
    uid,
    from: { address: fromAddress || account.email, name: displayName || '' },
    to: (payload.to || '').split(',').map(s => s.trim()).filter(Boolean).map(address => ({ address, name: '' })),
    subject: payload.subject || '',
    date: new Date().toISOString(),
    has_attachments: !!hasAttachments,
    message_id: built.messageId || null,
    in_reply_to: payload.inReplyTo || null,
    references: null,
    snippet: (snippet || '').slice(0, 200),
    flags: DRAFT_FLAGS,
    source: 'local_draft',
  };
  await api.appendLocalIndex(accountId, mailbox, [entry]);

  _showInList(accountId, mailbox, entry);
  return entry;
}

/** Drop the draft from the vault, its index, and the list. */
export async function deleteLocalDraft({ accountId, mailbox, uid }) {
  if (!accountId || !mailbox || !uid) return;
  const tauri = invoke();
  try {
    if (tauri) await tauri('maildir_delete', { accountId, mailbox, uid });
    await api.removeFromLocalIndex(accountId, mailbox, uid);
  } catch (err) {
    console.warn('[localDrafts] delete failed:', err);
  }
  _hideFromList(accountId, uid);
}

/**
 * Discard the vault draft a compose window owned, from its saved state.
 * No-ops for a window that never autosaved (nothing was ever typed).
 */
export function discardDraftFor(saved) {
  if (!saved?._draftUid || !saved?._draftMailbox) return Promise.resolve();
  return deleteLocalDraft({
    accountId: saved._accountId,
    mailbox: saved._draftMailbox,
    uid: saved._draftUid,
  });
}

// The row the user is looking at, without waiting for a folder reload. Mirrors
// exactly what `readLocalEmailIndex` would produce for this entry on the next
// load, so the optimistic row and the reloaded one are the same row.
function _showInList(accountId, mailbox, entry) {
  const s = useMailStore.getState();
  if (s.activeAccountId !== accountId || s.activeMailbox !== mailbox) return;
  const row = { ...entry, source: 'local', isLocal: true, isArchived: true, _accountId: accountId };
  useMailStore.setState(st => ({
    localEmails: [row, ...(st.localEmails || []).filter(e => e.uid !== entry.uid)],
    // A local row is only rendered when its uid is in this set — a new Set
    // instance, or the sorted-rows memo skips the recompute.
    archivedEmailIds: new Set([...(st.archivedEmailIds || []), entry.uid]),
    savedEmailIds: new Set([...(st.savedEmailIds || []), entry.uid]),
  }));
  useMailStore.getState().updateSortedEmails?.();
}

function _hideFromList(accountId, uid) {
  // Scoped to the account whose view is on screen: a uid is unique inside one
  // mailbox only, so dropping it from another account's sets would blank an
  // unrelated row.
  if (useMailStore.getState().activeAccountId !== accountId) return;
  useMailStore.setState(st => {
    const archived = new Set(st.archivedEmailIds || []);
    const saved = new Set(st.savedEmailIds || []);
    archived.delete(uid);
    saved.delete(uid);
    return {
      localEmails: (st.localEmails || []).filter(e => e.uid !== uid),
      emails: (st.emails || []).filter(e => e.uid !== uid),
      archivedEmailIds: archived,
      savedEmailIds: saved,
    };
  });
  useMailStore.getState().updateSortedEmails?.();
}
