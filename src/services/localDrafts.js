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
    // Both threading headers, because both have to come back: the .eml
    // carries them, but neither survives the vault parse into the app
    // (`ParsedEmail` has no In-Reply-To and no References), so the index
    // is the only place a reopen can read them from.
    in_reply_to: payload.inReplyTo || null,
    references: payload.references || null,
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

// ── Reopening a saved draft ──
//
// A draft row is not a message to read: it is the message the user was
// writing. Clicking it has to put the text back into a compose window, and
// into the SAME vault draft — continuing where they left off must update that
// draft, not stand a second one beside it.

// App owns the compose windows, and a service cannot reach React state. It
// registers the opener once; nothing else in the app opens a draft.
let _composeOpener = null;

/** @param {((initialData: object) => void) | null} fn */
export function setComposeOpener(fn) { _composeOpener = fn; }

const _addressList = (list) => (list || []).map(a => a?.address).filter(Boolean).join(', ');

const _escapeHtml = (s) => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/**
 * Compose `initialData` for a draft read back out of the vault.
 *
 * `entry` is the raw local-index row, `eml` the parsed .eml — the two halves of
 * one draft, because neither alone holds all of it.
 *
 * A reply's quote was folded into the body when the draft was written and
 * comes back as part of it. Nothing is lost; it is simply no longer behind the
 * collapsible toggle, and the send path will not append it a second time.
 */
export function draftToInitialData({ accountId, mailbox, uid, entry, eml }) {
  // Every draft this app writes is multipart with an HTML part, so the text
  // branch is a floor, not a path: it exists so a draft whose HTML part is
  // somehow unreadable reopens with the user's words in it rather than blank.
  const body = eml.html || (eml.text ? _escapeHtml(eml.text).replace(/\r?\n/g, '<br>') : '');
  return {
    to: _addressList(eml.to),
    cc: _addressList(eml.cc),
    bcc: _addressList(eml.bcc),
    subject: eml.subject || '',
    body,
    inReplyTo: entry?.in_reply_to || '',
    references: entry?.references || '',
    // ponytail: inline pictures are data: URIs inside `body` for a local draft
    // (saveLocalDraft never converts them to cid: parts), so everything the
    // parse calls an attachment here is a file the user actually attached.
    attachments: (eml.attachments || []).map(att => ({
      filename: att.filename,
      contentType: att.contentType,
      size: att.size,
      content: att.content,
    })),
    _accountId: accountId,
    _fromAddress: entry?.from?.address || eml.from?.address || '',
    // What makes this the same draft: the window adopts the uid and mailbox it
    // was read from, so its autosaves REPLACE this draft instead of allocating
    // a new one and leaving the old row behind.
    _draftUid: uid,
    _draftMailbox: mailbox,
  };
}

/**
 * Open (accountId, mailbox, uid) in compose if it is a draft this app wrote.
 *
 * Returns false for every other row — including a message archived FROM a
 * server, which shares the same 'local' render source and must still open in
 * the viewer. The caller carries on as usual when it gets false.
 */
export async function openLocalDraft(accountId, mailbox, uid) {
  if (!_composeOpener) return false;
  const entry = await db.getLocalIndexEntry(accountId, mailbox, uid);
  if (entry?.source !== 'local_draft') return false;
  const eml = await db.getLocalEmailFull(accountId, mailbox, uid);
  // Indexed as a draft, but the vault has no bytes: there is nothing to
  // continue, and the viewer's own missing-body path reports that better than
  // an empty compose window pretending the draft was always blank.
  if (!eml) {
    console.warn('[localDrafts] Draft indexed but not in the vault:', { accountId, mailbox, uid });
    return false;
  }
  _composeOpener(draftToInitialData({ accountId, mailbox, uid, entry, eml }));
  return true;
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
