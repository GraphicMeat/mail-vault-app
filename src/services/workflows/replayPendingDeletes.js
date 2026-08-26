// ── replayPendingDeletes — finish server deletes the last session never sent ──

import * as db from '../db';
import * as api from '../api';
import { ensureFreshToken } from '../authUtils';
import { isGraphAccount } from '../graphConfig';
import { markServerDeleted } from './messageMutations';

/**
 * Relay to the Rust log as well as the console.
 *
 * This runs before any UI exists and reports on work the user cannot see, so a
 * console-only line is invisible in exactly the situations worth diagnosing —
 * a packaged build, or a headless runner where the webview console goes nowhere.
 */
const log = (...args) => {
  const msg = args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  console.log(msg);
  window.__TAURI__?.core?.invoke?.('log_from_frontend', { message: msg }).catch(() => {});
};

/** A failure that says "try again later", not "this message cannot be deleted". */
const isCredentialsProblem = (message) =>
  /password missing|no password|authentication|auth failed|login failed|credential/i.test(message || '');

/**
 * Re-issue every server delete the user confirmed but that never reached the
 * server, then forget it.
 *
 * The journal is written before the optimistic update of a delete and cleared
 * after the last round-trip (see messageMutations.deleteSelectedFromServer), so
 * anything still in it belongs to a session that died mid-delete — a reload, a
 * quit, a crash. Those messages are still on the server while the user watched
 * their rows disappear, so finishing the job is the only outcome that matches
 * what they were shown.
 *
 * Entries are cleared once attempted, whether or not the delete succeeded: a
 * uid that fails twice will fail forever — the message is already gone, or the
 * mailbox is, or the UID space was reissued — and a journal that never drains
 * would re-attempt it on every launch for the life of the install. The one
 * exception is a credentials failure, which says nothing about the message and
 * everything about when we asked.
 */
export async function replayPendingDeletes() {
  const { useMailStore } = await import('../../stores/mailStore');
  const finish = (result) => {
    // Park the outcome in the store. It is the only trace this leaves: the work
    // happens before any UI exists, and on a packaged build the console goes
    // nowhere. Something has to be able to answer "did the last launch finish
    // what the one before it started".
    useMailStore.setState({ pendingDeleteReplay: { ...result, at: Date.now() } });
    return result;
  };

  const entries = await db.readPendingDeletes();
  if (!entries.length) return finish({ attempted: 0, deleted: 0, failed: 0, kept: 0, errors: [] });
  log(`[replayPendingDeletes] ${entries.length} unfinished delete group(s) from a previous session:`, entries);

  // Wait for credentials before touching a server.
  //
  // Accounts land in the store as soon as they are read, but their passwords
  // arrive with the keychain, which is a separate async load behind an OS
  // permission prompt. Replaying against the store's first snapshot failed
  // every delete with "Password missing" — and then cleared the journal,
  // turning a recoverable delay into permanent data loss. The timeout is a
  // backstop for a keychain that never resolves (a denied prompt): leaving the
  // journal untouched is the right outcome there, not hanging forever.
  db.startKeychainLoad();
  await Promise.race([
    new Promise((resolve) => db.onKeychainReady(() => resolve())),
    new Promise((resolve) => setTimeout(resolve, 30_000)),
  ]);

  // Read accounts from the db rather than the store: this runs at launch, and
  // the store's copy is whatever had loaded by the time the effect fired.
  let accounts = [];
  try {
    accounts = await db.getAccounts();
  } catch (e) {
    log('[replayPendingDeletes] could not load accounts, keeping everything queued:', String(e?.message || e));
    return finish({ attempted: 0, deleted: 0, failed: 0, kept: entries.length, errors: [] });
  }

  let attempted = 0;
  let deleted = 0;
  let failed = 0;
  let kept = 0;
  const errors = [];

  for (const { accountId, mailbox, uids } of entries) {
    if (!accountId || !mailbox || !uids?.length) continue;

    const account = accounts.find((a) => a.id === accountId);
    // Account removed since, or a Graph account that should never have been
    // journalled: nothing here can act on it, so stop carrying it.
    if (!account || isGraphAccount(account)) {
      await db.clearPendingDeletes(accountId, mailbox, uids);
      continue;
    }

    let fresh;
    try {
      fresh = await ensureFreshToken(account);
    } catch (e) {
      kept += uids.length;
      log(`[replayPendingDeletes] ${account.email}: cannot authenticate, keeping ${uids.length} queued:`, String(e?.message || e));
      continue;
    }

    // `done` is "answered, one way or another" — cleared from the journal.
    // A credentials failure is not an answer, so those uids stay.
    const done = [];
    const removed = [];
    for (const uid of uids) {
      attempted++;
      try {
        await api.deleteEmail(fresh, uid, mailbox);
        deleted++;
        done.push(uid);
        removed.push(uid);
      } catch (e) {
        const message = String(e?.message || e);
        failed++;
        errors.push(`${mailbox}/${uid}: ${message}`);
        log(`[replayPendingDeletes] ${account.email} ${mailbox} uid ${uid} failed:`, message);
        if (isCredentialsProblem(message)) kept++;
        else done.push(uid);
      }
    }
    if (done.length) await db.clearPendingDeletes(accountId, mailbox, done);

    // A replayed delete is still this app deleting the server copy, so a
    // surviving vault copy earns the same stamp the live paths write — without
    // it, a delete that finished after a crash leaves the row saying "also
    // still on the server" for good. See stores/slices/custody.js.
    for (const uid of removed) await markServerDeleted(accountId, mailbox, uid);

    if (removed.length) {
      // Prune the header sidecar too, or the row comes straight back.
      //
      // The session that died never got to its own prune, and the cache is what
      // the list paints from on the next visit — so without this the message is
      // gone from the server and still on screen. Empty emails + null total:
      // this writes no headers and leaves the stored count alone, it only drops
      // the uids (same shape the delete workflows use when the view has moved).
      await db.saveEmailHeaders(accountId, mailbox, [], null, { removedUids: removed });

      // If that mailbox is what the user is looking at right now, reload it —
      // the rows on screen were painted before the delete landed.
      const s = useMailStore.getState();
      if (s.activeAccountId === accountId && s.activeMailbox === mailbox) {
        s.loadEmails?.();
      }
    }
  }

  log(`[replayPendingDeletes] finished ${attempted} unfinished delete(s): ${deleted} ok, ${failed} failed, ${kept} still queued`);
  return finish({ attempted, deleted, failed, kept, errors });
}
