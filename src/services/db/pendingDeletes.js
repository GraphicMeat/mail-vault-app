// ── db/pendingDeletes — durable journal of confirmed-but-unfinished server deletes ──
//
// "Delete from server" runs from here: the row is hidden optimistically and the
// workflow then awaits one IMAP round-trip per message. Reload or quit inside
// that window and this context dies before the command is sent — the message is
// never deleted, nothing errors, nothing retries, and it is back on the next
// launch having looked deleted the whole time.
//
// Writing the intent before the first round-trip and clearing it after the last
// lets the next launch finish what the user already confirmed. See
// src-tauri/src/pending_delete.rs for the on-disk shape.

const invoke = (cmd, args) => window.__TAURI__?.core?.invoke?.(cmd, args);

/**
 * Record that these uids are owed a server delete.
 *
 * Best-effort by design: a journal that cannot be written must never block the
 * delete the user is asking for right now. Losing durability is worse than
 * nothing only if it is silent, hence the warn.
 */
export async function queuePendingDeletes(accountId, mailbox, uids) {
  if (!uids?.length || !accountId || !mailbox) return;
  try {
    await invoke('pending_delete_queue', { accountId, mailbox, uids });
  } catch (e) {
    console.warn('[db] Could not journal pending deletes:', e);
  }
}

/** Drop uids from the journal — they have been dealt with, one way or another. */
export async function clearPendingDeletes(accountId, mailbox, uids) {
  if (!uids?.length || !accountId || !mailbox) return;
  try {
    await invoke('pending_delete_clear', { accountId, mailbox, uids });
  } catch (e) {
    console.warn('[db] Could not clear pending deletes:', e);
  }
}

/** `[{ accountId, mailbox, uids }]` — everything still owed a server delete. */
export async function readPendingDeletes() {
  try {
    const entries = await invoke('pending_delete_read');
    return Array.isArray(entries) ? entries : [];
  } catch (e) {
    console.warn('[db] Could not read pending deletes:', e);
    return [];
  }
}
