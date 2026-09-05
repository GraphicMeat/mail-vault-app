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

const invoke = (cmd, args) => window.__TAURI__?.core?.invoke?.(cmd, args);

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
    return await invoke('op_journal_queue', { entry: { id: 0, op, accountId, mailbox, uids, arg, at: 0 } });
  } catch (e) {
    console.warn('[db] Could not journal op:', op, e);
    return null;
  }
}

/** Forget these uids for this op/account/mailbox — dealt with, one way or another. */
export async function clearOps({ op, accountId, mailbox, uids }) {
  if (!op || !accountId || !mailbox || !uids?.length) return;
  try {
    await invoke('op_journal_clear', { op, accountId, mailbox, uids });
  } catch (e) {
    console.warn('[db] Could not clear journal op:', op, e);
  }
}

/** Every unfinished op, oldest first. */
export async function readOps() {
  try {
    const ops = await invoke('op_journal_read');
    return Array.isArray(ops) ? ops : [];
  } catch (e) {
    console.warn('[db] Could not read the op journal:', e);
    return [];
  }
}
