// Thin native draft RPC and compose/list presentation adapter.
import { bareContentId, htmlReferencesCid } from '../utils/cidRefs';
import * as db from './db';
import { useMailStore } from '../stores/mailStore';
import { _resolveMailboxPath } from '../stores/slices/unifiedHelpers';
import { getArchivedGroup, setArchivedGroup } from '../stores/slices/messageListSlice';
import { getDraftProjection, observeDraftOutcome, projectDraftRows, projectDraftUids, draftProjectionGroups, projectDraftKeyedUids } from './draftProjection';
import { send } from './transport';
import { getAccountCacheMailboxes } from './cacheManager';
import { getRealAttachments, replaceCidUrls } from './attachmentUtils';
import { splitWireHtml } from '../utils/quoteWire';

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

/**
 * Legacy component helper retained only until the stop 2 cutover. It never
 * supplies native draft identity or physical allocation.
 * A stable synthetic uid for one compose window. Same second-resolution shape
 * as the staged Sent copy — but a uid IDENTIFIES a draft, so it cannot be a
 * bare clock reading: two windows opened in the same second were handed the
 * same one, and the second save then overwrote the first draft's .eml and its
 * index entry. Only ever moves forward.
 */
let _lastDraftUid = 0;
export const newDraftUid = () => {
  const now = Math.floor(Date.now() / 1000);
  _lastDraftUid = now > _lastDraftUid ? now : _lastDraftUid + 1;
  return _lastDraftUid;
};

/** Stable session identity, allocated before asynchronous save or handoff. */
export { newDraftId } from './composeSession';

const snapshotFields = ['to', 'cc', 'bcc', 'subject', 'html', 'text', 'inReplyTo', 'references'];
const physicalTuple = identity => ({ accountId: identity.accountId, mailbox: identity.mailbox, uid: identity.uid });

/** Serialize the complete native contract; UI descriptors never grant proof. */
export async function saveLocalDraft({ draftId, revision, accountId, fromAddress, displayName, payload, snapshot = payload, snippet, previousIdentity }) {
  if (!draftId || !Number.isSafeInteger(revision) || revision < 1 || !accountId
      || snapshotFields.some(field => typeof snapshot?.[field] !== 'string') || !Array.isArray(snapshot?.attachments)) {
    throw new Error('A complete draft with stable identity and revision is required');
  }
  const request = { draftId, revision, accountId, fromAddress: fromAddress ?? '', displayName: displayName ?? '',
    snapshot: { ...Object.fromEntries(snapshotFields.map(field => [field, snapshot[field]])),
      attachments: snapshot.attachments.map(attachment => ({
        filename: attachment.filename, contentType: attachment.contentType,
        ...Object.fromEntries(['content', 'encoding', 'cid'].filter(field => attachment[field] != null).map(field => [field, attachment[field]])),
        ...((attachment.source || attachment._source) ? { source: {
          ...physicalTuple(attachment.source || attachment._source), attachmentIndex: (attachment.source || attachment._source).attachmentIndex,
        } } : {}),
      })),
    }, snippet: snippet ?? '', ...(previousIdentity ? { previousIdentity: physicalTuple(previousIdentity) } : {}),
  };
  const startedGeneration = getDraftProjection().generation;
  let response;
  try {
    response = await send('drafts.save', request);
  } catch (error) {
    // A lost reply may already have accepted content. Reconcile this identity;
    // the caller still retains and retries its same immutable revision.
    await reconcileLocalDraft(draftId).catch(() => {});
    throw error;
  }
  if (response?.draftId !== draftId || !['saved', 'unchanged', 'superseded'].includes(response.disposition)) throw new Error('Draft save outcome unavailable');
  publishDraftOutcome(response, startedGeneration);
  // The caller decides acceptance from disposition/revision. A superseded
  // response can inform projection but never claims submitted content saved.
  return response;
}

export async function reconcileLocalDraft(draftId, { isCurrent = () => true } = {}) {
  if (!draftId) throw new Error('Draft identity required');
  const startedGeneration = getDraftProjection().generation;
  const response = await send('drafts.list', { draftId });
  if (!Array.isArray(response?.drafts) || !Array.isArray(response?.managed)) throw new Error('Draft state unavailable');
  if (isCurrent()) for (const record of response.managed) publishDraftOutcome(record, startedGeneration);
  return response;
}

async function readDraft(params) {
  const startedGeneration = getDraftProjection().generation;
  const response = await send('drafts.list', { ...params, includeContent: true });
  if (!Array.isArray(response?.drafts)) throw new Error('Draft open outcome unavailable');
  for (const record of response.managed || []) publishDraftOutcome(record, startedGeneration);
  return response;
}

/** Canonical-ID discard; a tuple must first pass native legacy adoption. */
export async function deleteLocalDraft({ draftId, accountId, mailbox, uid } = {}) {
  if (!draftId) {
    if (!accountId || !mailbox || !uid) return;
    const response = await readDraft({ identity: { accountId, mailbox, uid } });
    draftId = response.drafts[0]?.draftId || response.managed?.[0]?.draftId;
    if (!draftId) throw new Error('Draft identity unavailable');
  }
  const startedGeneration = getDraftProjection().generation;
  const response = await send('drafts.discard', { draftId });
  if (response?.draftId !== draftId || response.discarded !== true || !['complete', 'pending'].includes(response.cleanup)) throw new Error('Draft discard outcome unavailable');
  publishDraftOutcome(response, startedGeneration);
  return response;
}

export function discardDraftFor(saved) {
  return deleteLocalDraft({ draftId: saved?._draftId, accountId: saved?._draftAccountId || saved?._accountId,
    mailbox: saved?._draftMailbox, uid: saved?._draftUid });
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

// A reply's or forward's original goes back beside the body, never into the
// editor (it would drop tables and styles), and a picture it shows by cid:
// keeps that Content-ID so it still arrives in place.
function _withOriginal(html, attachments) {
  const { body, quotedHtml, forward } = splitWireHtml(html);
  const cidIn = att => {
    return htmlReferencesCid(quotedHtml, att.contentId) ? { cid: bareContentId(att.contentId) } : {};
  };
  return {
    body,
    cidIn,
    original: {
      _quotedHtml: quotedHtml,
      _forward: forward,
      ...(quotedHtml && { _contextHtml: quotedHtml }),
      ...(forward && { _showContext: true }),
    },
  };
}

/**
 * Compose `initialData` for a draft read back out of the vault.
 *
 * `entry` is the raw local-index row, `eml` the parsed .eml — the two halves of
 * one draft, because neither alone holds all of it.
 *
 * A reply's quote or a forward's original was written after the body
 * (replyWireHtml) and is split off again here (_withOriginal).
 */
export function draftToInitialData({ accountId, mailbox, uid, entry, eml, draftId, revision }) {
  // Every draft this app writes is multipart with an HTML part, so the text
  // branch is a floor, not a path: it exists so a draft whose HTML part is
  // somehow unreadable reopens with the user's words in it rather than blank.
  const { body: html, cidIn, original } = _withOriginal(eml.html, eml.attachments);
  const body = html || (eml.text ? _escapeHtml(eml.text).replace(/\r?\n/g, '<br>') : '');
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
    // parse calls an attachment here is a file the user attached, or one a
    // forward carries (with its cid when the original shows it).
    attachments: (eml.attachments || []).map(att => ({
      filename: att.filename,
      contentType: att.contentType,
      size: att.size,
      content: att.content,
      ...cidIn(att),
    })),
    ...original,
    _accountId: accountId,
    _fromAddress: entry?.from?.address || eml.from?.address || '',
    _draftNativeContent: { revision,
      ...(typeof eml.html === 'string' ? { html: eml.html } : {}),
      ...(typeof eml.text === 'string' ? { text: eml.text } : {}),
      ...(typeof entry?.from?.name === 'string' ? { displayName: entry.from.name }
        : typeof eml.from?.name === 'string' ? { displayName: eml.from.name } : {}),
    },
    // Stable identity selects native current bytes; the tuple is the last
    // accepted presentation location, which can change on a content revision.
    ...(draftId ? { _draftId: draftId, _draftRevision: revision, _draftAcceptedRevision: revision, _draftAccountId: accountId } : {}),
    _draftUid: uid,
    _draftMailbox: mailbox,
  };
}

// `maildir_read` parses no In-Reply-To or References, so a scheduled reply's
// threading survives only in the raw headers. `rawSource` is base64 from the
// vault and plain text from the browser demo backend (base64 has no ':').
function _threadingHeaders(rawSource) {
  let raw = rawSource || '';
  // ponytail: the first 48 KB of the message; a header block longer than that
  // loses whatever threading lines sit past it.
  if (!raw.includes(':')) { try { raw = atob(raw.slice(0, 65536)); } catch { return {}; } }
  const head = raw.split(/\r?\n\r?\n/, 1)[0].replace(/\r?\n[ \t]+/g, ' ');
  const header = name => head.match(new RegExp(`^${name}:[ \\t]*(.*)$`, 'im'))?.[1].trim() || '';
  return { inReplyTo: header('In-Reply-To'), references: header('References') };
}

/**
 * Compose `initialData` for a scheduled email opened for editing, read from
 * its frozen .eml in the vault's `Scheduled` mailbox. `row` is the
 * `scheduled.list` row.
 *
 * Unlike a draft, the window does NOT adopt the uid and mailbox it was read
 * from: `_draftUid`/`_draftMailbox` would make autosave overwrite the frozen
 * message and a later Send or Schedule delete it. The row keeps the message
 * until a replacement is saved over it (`_editScheduledId`, composeSend.js),
 * so closing the window loses nothing.
 */
export function scheduledEmlToInitialData({ row, eml }) {
  let envelope = {};
  try { envelope = JSON.parse(row.envelope) || {}; } catch { /* the .eml's own From below */ }
  // The frozen message went through buildOutgoingPayload, which turned every
  // picture in the body into a cid: part. In the editor they are data: URIs
  // again, and they are not files the user attached.
  // Only the body's: the original keeps its cid: parts, which go out again.
  const { body: html, cidIn, original } = _withOriginal(eml.html || '', eml.attachments);
  const body = html
    ? replaceCidUrls(html, eml.attachments)
    : (eml.text ? _escapeHtml(eml.text).replace(/\r?\n/g, '<br>') : '');
  const to = _addressList(eml.to);
  const subject = eml.subject || '';
  return {
    to,
    cc: _addressList(eml.cc),
    bcc: _addressList(eml.bcc),
    subject,
    body,
    ..._threadingHeaders(eml.rawSource),
    // `isFromOriginal` + `_baseline`: opening it is not a change. Without them
    // the window reads as dirty at once, autosaves a Drafts copy of a message
    // that is still scheduled, and asks to discard on a close that changed
    // nothing.
    attachments: getRealAttachments(eml.attachments, html).map(att => ({
      filename: att.filename,
      contentType: att.contentType,
      size: att.size,
      content: att.content,
      isFromOriginal: true,
      ...cidIn(att),
    })),
    ...original,
    _baseline: { to, subject, body },
    _accountId: row.accountId,
    _fromAddress: envelope.from || eml.from?.address || '',
    _scheduleDraft: { localTime: row.localTime, tz: row.tz },
    // The follow-up reminder the schedule carries (handlers/scheduled.rs).
    _remindDays: Number(envelope.remindDays) || 0,
    _editScheduledId: row.id,
    // What the row held when it was opened: the account it is bound to (the
    // daemon cannot move a row to another account's vault) and the time the
    // compose notice names, which the picker's `_scheduleDraft` stops being
    // as soon as it is touched.
    _editScheduledRow: { accountId: row.accountId, localTime: row.localTime, tz: row.tz },
  };
}

/**
 * Open (accountId, mailbox, uid) in compose if it is a draft this app wrote.
 *
 * Returns false for every other row — including a message archived FROM a
 * server, which shares the same 'local' render source and must still open in
 * the viewer. The caller carries on as usual when it gets false.
 */
export async function openLocalDraft(accountId, mailbox, uid, draftId) {
  if (!_composeOpener) return false;
  // A row may already carry stable identity even after its old UID was cleaned.
  if (typeof draftId === 'object') draftId = draftId?.draftId;
  if (!draftId) {
    const entry = await db.getLocalIndexEntry(accountId, mailbox, uid);
    // Source alone also describes staged sends; admission requires the legacy
    // archived user-draft shape and native verification of bytes/purpose.
    if (entry?.source !== 'local_draft' || !entry.flags?.includes('archived') || !entry.flags?.includes('draft') || mailbox === 'Scheduled') return false;
  }
  try {
    const response = await readDraft(draftId ? { draftId } : { identity: { accountId, mailbox, uid } });
    const current = response.drafts[0];
    // A content reply can predate a terminal decision published while it waited.
    if (getDraftProjection().managed.some(record => record.draftId === current?.draftId && record.discarded)) return true;
    if (!response.terminal && !response.pending && !response.missingBody && current?.eml && current?.draftId) {
      _composeOpener(draftToInitialData(current));
    }
    // Recognized unavailable drafts must not fall through to an ordinary viewer.
    return true;
  } catch (error) {
    console.warn('[localDrafts] Draft unavailable:', error);
    return true;
  }
}

function publishDraftOutcome(response, startedGeneration) {
  const previous = getDraftProjection();
  observeDraftOutcome(response, startedGeneration);
  const groups = draftProjectionGroups(previous);
  for (const [accountId, mailbox] of groups) {
    const existing = getArchivedGroup(accountId, mailbox);
    const projected = projectDraftUids(existing || new Set(), accountId, mailbox, previous);
    if (existing != null || projected.size) setArchivedGroup(accountId, mailbox, projected);
  }
  const s = useMailStore.getState();
  const visible = groups.filter(([accountId, mailbox]) => (s.activeAccountId === accountId && s.activeMailbox === mailbox)
    || (s.unifiedInbox && mailbox === _resolveMailboxPath(getAccountCacheMailboxes(accountId) || [], s.unifiedFolder || 'INBOX')));
  // Remove old exact tuples even on account move; only add rows for groups in
  // view. Unrelated account/mailbox rows and keyed set members remain intact.
  const rows = entries => {
    const kept = projectDraftRows(entries || [], s.activeAccountId, s.activeMailbox, previous, false);
    for (const [accountId, mailbox] of visible) kept.push(...projectDraftRows([], accountId, mailbox));
    return kept;
  };
  const ids = values => {
    let next = new Set(values || []);
    for (const [accountId, mailbox] of groups) next = projectDraftKeyedUids(next, accountId, mailbox, previous, false);
    for (const [accountId, mailbox] of visible) next = projectDraftKeyedUids(next, accountId, mailbox);
    return next;
  };
  useMailStore.setState({ localEmails: rows(s.localEmails), emails: projectDraftRows(s.emails || [], s.activeAccountId, s.activeMailbox, previous, false),
    archivedEmailIds: ids(s.archivedEmailIds), savedEmailIds: ids(s.savedEmailIds) });
  useMailStore.getState().updateSortedEmails?.();
}
