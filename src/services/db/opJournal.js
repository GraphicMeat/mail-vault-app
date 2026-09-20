// ── db/opJournal — durable journal of server mutations that may not have run ──
//
// "Delete from server" runs from here: the row is hidden optimistically and the
// workflow then awaits one IMAP round-trip per message. Reload or quit inside
// that window and this context dies before the command is sent — the message is
// never deleted, nothing errors, nothing retries, and it is back on the next
// launch having looked deleted the whole time.
//
// Writing the intent before the first round-trip and clearing it after the last
// lets the next launch finish what the user already confirmed.
//
// Generalised from deletes to flags and moves. See src-tauri/src/op_journal.rs.

import { send } from '../transport';

/**
 * Record an intent. Resolves to the entry id, or null when journalling failed.
 *
 * Best-effort by design: a journal that cannot be written must never block the
 * mutation the user is asking for right now. Losing durability is only worse
 * than nothing if it is silent, hence the warn.
 */
export async function queueOp({ op, accountId, mailbox, uids, arg = {} }) {
  if (!op || !accountId || !mailbox || !uids?.length) return null;
  try {
    return await send('op_journal_queue', { entry: { id: 0, op, accountId, mailbox, uids, arg, at: 0 } });
  } catch (e) {
    console.warn('[db] Could not journal op:', op, e);
    return null;
  }
}

/**
 * Forget these uids for this op/account/mailbox/arg — dealt with, one way or
 * another.
 *
 * `arg` is part of the identity, not a detail: the flag path writes one entry
 * per (flag, action), so a star and a mark-read on the same message are two
 * entries under one (op, account, mailbox, uid). Clearing without it emptied
 * both, and the one that had NOT been sent was silently dropped.
 */
export async function clearOps({ op, accountId, mailbox, uids, arg = {} }) {
  if (!op || !accountId || !mailbox || !uids?.length) return;
  for (const uid of uids) _failures.delete(failureKey({ op, accountId, mailbox, uid }));
  try {
    await send('op_journal_clear', { op, accountId, mailbox, uids, arg });
  } catch (e) {
    console.warn('[db] Could not clear journal op:', op, e);
  }
}

/** Every unfinished op, oldest first. */
export async function readOps() {
  try {
    const ops = await send('op_journal_read');
    return Array.isArray(ops) ? ops : [];
  } catch (e) {
    console.warn('[db] Could not read the op journal:', e);
    return [];
  }
}

// ── why a queued op last failed ──
//
// Session-only, deliberately. The durable part of "this delete never landed"
// is the journal entry itself, and `entry.at` already answers "failing for how
// long". The error text is worth showing and worth nothing to persist: every
// launch replays the entry and writes the current reason, which is the only
// one that can still be acted on.

const _failures = new Map();

export const failureKey = ({ op, accountId, mailbox, uid }) => `${op}|${accountId}|${mailbox}|${uid}`;

/** Record why this uid's op did not land. */
export function noteOpFailure({ op, accountId, mailbox, uid }, message) {
  if (!op || !accountId || !mailbox || uid == null) return;
  _failures.set(failureKey({ op, accountId, mailbox, uid }), { message: String(message || ''), at: Date.now() });
}

/** The map the pending-actions list reads, keyed by `failureKey`. */
export function opFailures() {
  return _failures;
}
