/**
 * Ask the server whether it still holds a message — anywhere.
 *
 * The gold "your only copy" row makes the loudest claim this app makes, and
 * until now it could only be made about a message this app itself created or
 * itself deleted. The third case — someone else deleted your mail and the
 * vault is what is left — was unprovable, because every signal the app had was
 * scoped to ONE mailbox: a uid missing from INBOX is the everyday result of an
 * archive, a filter, or a delete-to-Bin, and printing that as "the server lost
 * it" made ordinary mail gold. See stores/slices/custody.js.
 *
 * `imap.find_message_id` sweeps every selectable folder for the Message-ID and
 * reports whether it managed to visit them all. This workflow turns that into
 * a durable custody fact:
 *
 *   found anywhere            → 'present', and any stale absence stamp is torn up
 *   complete and found nowhere → 'absent'  → `serverAbsent` on the vault entry
 *   anything else              → 'unknown', and nothing is written
 *
 * "Anything else" is the important branch. A folder that would not open could
 * be the folder holding the message, an offline account proves nothing, and a
 * message with no Message-ID cannot be looked up at all. None of those are
 * absence, and none of them may become gold.
 */

import * as api from '../api';
import * as db from '../db';
import { ensureFreshToken, hasValidCredentials } from '../authUtils';
import { isGraphAccount } from '../graphConfig';
import { applyServerRemoval, stampVaultEntry } from './messageMutations';
import { _resolveUnifiedContext, spansMailboxes } from '../../stores/slices/unifiedHelpers';

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
  // 'UNIFIED' is a view, not a mailbox — it names no folder to look the vault
  // entry up in.
  const mailbox = rawMailbox === 'UNIFIED' ? 'INBOX' : rawMailbox;
  const account = unified?.account || state.accounts.find(a => a.id === accountId);

  if (!account || !hasValidCredentials(account)) return { state: 'unknown', reason: 'offline' };
  // Graph addresses messages by Graph id and has no IMAP folder sweep; the
  // question is not available here rather than answered "absent". A fail-closed
  // guard that inherits the failure branch is how Delete Everywhere became a
  // permanent no-op for every Microsoft account.
  if (isGraphAccount(account)) return { state: 'unknown', reason: 'graph' };

  // The Message-ID has to come from somewhere durable: the row in memory may
  // already be gone (the vanished-message path calls this right after pruning
  // it), and the vault entry outlives both.
  const entry = await db.getLocalIndexEntry(accountId, mailbox, uid);
  const row = [...(state.localEmails || []), ...(state.sortedEmails || []), ...(state.emails || [])]
    .find(e => e.uid === uid && (e._mailbox == null || e._mailbox === mailbox));
  const messageId = entry?.message_id || entry?.messageId || row?.messageId || null;
  if (!messageId) return { state: 'unknown', reason: 'no-message-id' };

  let probe;
  try {
    const fresh = await ensureFreshToken(account);
    // stopOnFirst: presence needs one hit, absence needs every folder. The
    // common answer — the message is still there — costs one round trip.
    probe = await api.findMessageId(fresh || account, messageId, { stopOnFirst: true });
  } catch (e) {
    // A sweep that errored says nothing about the server's contents.
    console.warn('[probeServerCopy] Probe failed for uid', uid, e);
    return { state: 'unknown', reason: 'error' };
  }

  if (probe?.found?.length) {
    // It is on the server after all. If a previous sweep stamped absence, that
    // stamp is now a lie on disk — tear it up before it paints another row gold.
    if (entry?.serverAbsent === true) {
      await stampVaultEntry(accountId, mailbox, uid, { serverAbsent: false, serverAbsentAt: null });
      _restampRows(useMailStore, uid, accountId, mailbox, { serverAbsent: false });
    }
    return { state: 'present', locations: probe.found };
  }

  if (!probe?.complete) {
    return { state: 'unknown', reason: 'incomplete', failed: probe?.failed || [] };
  }

  // Every selectable folder answered and none of them has it.
  const checkedAt = new Date().toISOString();
  const stamped = await stampVaultEntry(accountId, mailbox, uid, {
    serverAbsent: true,
    serverAbsentAt: checkedAt,
  });
  // No vault copy, no claim: gold says "the vault is what you have left", and
  // there is nothing left if the message was never archived here.
  if (!stamped) return { state: 'unknown', reason: 'not-in-vault' };

  // Repaint now rather than waiting for the next disk read — the rows already
  // in memory carry custody with them (db.getArchivedEmails stamps it at read
  // time), so they need the same field to go gold in this paint.
  _restampRows(useMailStore, uid, accountId, mailbox, { serverAbsent: true, serverAbsentAt: checkedAt });

  // The list may still be showing a server row for this uid from an older
  // enumeration, and a server row shadows the vault row it duplicates — the
  // stamp would be written and the row would stay quiet. The server has just
  // answered a stronger version of the question a failed body fetch asks, so
  // route it through the same path that answer already takes. NOT a delete:
  // `deletedByUs` stays false, because we did not.
  const stale = (get().emails || []).some(e => e.uid === uid
    && (e._mailbox == null || e._mailbox === mailbox)
    && (e._accountId == null || e._accountId === accountId));
  if (stale) {
    await applyServerRemoval(uid, {
      accountId, mailbox, isUnified, skipRefresh: true, clearSelection: false,
    });
  }

  return { state: 'absent', checkedAt, searched: probe.searched };
}

// A uid names a message only inside one (account, mailbox) — never restamp a
// row that merely shares the number.
function _restampRows(useMailStore, uid, accountId, mailbox, fields) {
  const get = () => useMailStore.getState();
  const matches = (e) => e.uid === uid
    && (e._mailbox == null || e._mailbox === mailbox)
    && (e._accountId == null || e._accountId === accountId);
  const restamp = (list) => (list || []).map(e => (matches(e) ? { ...e, ...fields } : e));
  useMailStore.setState({
    localEmails: restamp(get().localEmails),
    emails: restamp(get().emails),
  });
  get().updateSortedEmails();
}
