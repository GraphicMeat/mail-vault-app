// ── One compose window per (message, mode) ───────────────────────────────────
//
// The sender's address is a compose trigger, so a double-click on it would
// stack a second reply on the first. A reply to the message already open in that mode comes forward
// instead — the rule openDraftCompose already applies to a draft's vault uid.

const key = (m) => m.messageId || `${m._accountId || ''}:${m._mailbox || ''}:${m.uid}`;

/** True when two compose states answer the same message in the same mode. */
export function sameReply(a, b) {
  if (!a?.replyTo || !b?.replyTo) return false;
  return a.mode === b.mode && key(a.replyTo) === key(b.replyTo);
}
