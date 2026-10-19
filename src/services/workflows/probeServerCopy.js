/**
 * Ask the server whether it still holds a message, anywhere.
 *
 * The gold "your only copy" row makes the loudest claim this app makes. A uid
 * missing from one mailbox is the everyday result of an archive, a filter, or
 * a delete-to-Bin, so only a sweep of every folder for the Message-ID may say
 * the server lost it. See stores/slices/custody.js.
 *
 * The daemon owns the question (`custody.probe_server_copy`): it reads the
 * custody entry, sweeps every selectable folder and stamps the answer:
 *
 *   found anywhere             -> 'present', and any stale absence stamp is torn up
 *   complete and found nowhere -> 'absent'  -> `serverAbsent` on the vault entry
 *   anything else              -> 'unknown', and nothing is written
 *
 * This side resolves which message is meant (the open view, its own row),
 * and repaints the rows in memory from the
 * answer.
 */

import * as api from '../api';
import { hasValidCredentials } from '../authUtils';
import { isGraphAccount } from '../graphConfig';
import { applyServerRemoval, indexEntryFor } from './messageMutations';
import { _resolveUnifiedContext, spansMailboxes, sameMessage, vaultKey } from '../../stores/slices/unifiedHelpers';

/**
 * @param {number} uid
 * @param {{accountId?: string, mailbox?: string}} [scope]
 * @returns {Promise<{state: 'present'|'absent'|'unknown', reason?: string,
 *                    locations?: {mailbox: string, uid: number}[],
 *                    failed?: string[], checkedAt?: string}>}
 */
export async function probeServerCopy(uid, scope = {}) {
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();
  const state = get();

  const isUnified = spansMailboxes(state);
  const unified = isUnified ? _resolveUnifiedContext(uid, state) : null;
  const accountId = scope.accountId || unified?.accountId || state.activeAccountId;
  const rawMailbox = scope.mailbox || unified?.mailbox || state.activeMailbox;
  // 'UNIFIED' is a view, not a mailbox: it names no folder to look the vault
  // entry up in.
  const mailbox = rawMailbox === 'UNIFIED' ? 'INBOX' : rawMailbox;
  const account = unified?.account || state.accounts.find(a => a.id === accountId);

  if (!account || !hasValidCredentials(account)) return { state: 'unknown', reason: 'offline' };
  // Graph addresses messages by Graph id and has no IMAP folder sweep; the
  // question is not available here rather than answered "absent". A fail-closed
  // guard that inherits the failure branch is how Delete Everywhere became a
  // permanent no-op for every Microsoft account.
  if (isGraphAccount(account)) return { state: 'unknown', reason: 'graph' };

  // This message's own row, placed by where it lives: a row with no folder used
  // to match any folder, and so any account's, and its Message-ID was swept for.
  // The daemon prefers the custody entry's Message-ID; the row's is for a
  // message it has no entry for.
  const target = { accountId, mailbox, uid };
  const row = [...(state.localEmails || []), ...(state.sortedEmails || []), ...(state.emails || [])]
    .find(e => sameMessage(e, target, state));
  // With no custody entry, a stamp is written from the row, and only for a
  // message the vault holds: an entry for one it does not would put a row on
  // screen with nothing behind it.
  const vaultRow = state.archivedEmailIds?.has(vaultKey(accountId, mailbox, uid))
    ? [...(state.localEmails || []), ...(state.emails || []), ...(state.sortedEmails || [])].find(e => sameMessage(e, target, state))
    : null;

  let result;
  try {
    result = await api.probeServerCopy(account, {
      accountId, mailbox, uid,
      messageId: row?.messageId || null,
      fallbackEntry: vaultRow?.subject ? indexEntryFor(vaultRow) : null,
    });
  } catch (e) {
    // A sweep that errored says nothing about the server's contents.
    console.warn('[probeServerCopy] Probe failed for uid', uid, e);
    return { state: 'unknown', reason: 'error' };
  }

  if (result?.state === 'present') {
    // A stamp the sweep tore up must not keep painting a row gold.
    if (result.cleared) _restampRows(useMailStore, uid, accountId, mailbox, { serverAbsent: false });
    return { state: 'present', locations: result.locations };
  }
  if (result?.state !== 'absent') return result || { state: 'unknown', reason: 'error' };

  // Repaint now rather than waiting for the next disk read: the rows already
  // in memory carry custody with them (db.getArchivedEmails stamps it at read
  // time), so they need the same field to go gold in this paint.
  _restampRows(useMailStore, uid, accountId, mailbox, { serverAbsent: true, serverAbsentAt: result.checkedAt });

  // The list may still be showing a server row for this uid from an older
  // enumeration, and a server row shadows the vault row it duplicates: the
  // stamp would be written and the row would stay quiet. The server has just
  // answered a stronger version of the question a failed body fetch asks, so
  // route it through the same path that answer already takes. NOT a delete:
  // `deletedByUs` stays false, because we did not.
  const stale = (get().emails || []).some(e => sameMessage(e, target, get()));
  if (stale) {
    await applyServerRemoval(uid, {
      accountId, mailbox, isUnified, skipRefresh: true, clearSelection: false,
    });
  }

  return result;
}

// A uid names a message only inside one (account, mailbox): never restamp a
// row that merely shares the number. The sweep was a round trip: the screen may
// show another folder by now, and its unstamped rows are that folder's.
function _restampRows(useMailStore, uid, accountId, mailbox, fields) {
  const get = () => useMailStore.getState();
  const matches = (e) => sameMessage(e, { accountId, mailbox, uid }, get());
  const restamp = (list) => (list || []).map(e => (matches(e) ? { ...e, ...fields } : e));
  useMailStore.setState({
    localEmails: restamp(get().localEmails),
    emails: restamp(get().emails),
  });
  get().updateSortedEmails();
}
