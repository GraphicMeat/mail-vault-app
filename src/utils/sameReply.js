// ── One compose window per (message, mode) ───────────────────────────────────
//
// The sender's address is a compose trigger, so a double-click on it would
// stack a second reply on the first. A reply to the message already open in that mode comes forward
// instead — the rule openDraftCompose already applies to a draft's vault uid.

const key = (m) => m.messageId || `${m._accountId || ''}:${m._mailbox || ''}:${m.uid}`;

/** True when two compose states answer the same message in the same mode. */
export function sameReply(a, b) {
  if ((a.snapshot || a.initialData)?._draftCleanupOnly || (b.snapshot || b.initialData)?._draftCleanupOnly || (a.snapshot || a.initialData)?._draftTerminal || (b.snapshot || b.initialData)?._draftTerminal) return false;
  if (!a?.replyTo || !b?.replyTo) return false;
  return a.mode === b.mode && key(a.replyTo) === key(b.replyTo);
}

// ── Filling in a radial reply's quote once it resolves ───────────────────────
//
// A radial reply/replyAll opens on the header alone (RowQuickActions.jsx) and
// calls App's openCompose a second time once resolveMessageBody lands. That
// second call is fill-only, never open-or-focus: matched against the
// ORIGINAL header (`_fillFrom`, stable even if a messageId only shows up on
// the resolved copy) rather than the resolved `replyTo` itself, and it must
// never reopen a window the user sent, discarded or closed, and never pull a
// minimized one back out.
//
// App prepares outside its reducer, then commits only to the captured window.
// Complete immutable issued draft bytes stay untouched until ordinary save.
export function applyReplyFill(windows, { mode, replyTo, _fillFrom, _fillWindowId }, prepared) {
  const target = windows.find(w => (_fillWindowId == null || w.id === _fillWindowId)
    && sameReply(w, { mode, replyTo: _fillFrom }));
  if (!target || target.detached) return windows;
  if (!target.minimized) return windows.map(w => w.id === target.id ? { ...w, replyTo, preparedQuote: prepared } : w);
  const { quotedHtml, contextHtml, bodyAvailable } = prepared.result;
  const withQuote = data => data && (bodyAvailable || !data._quotedHtml)
    ? { ...data, _quotedHtml: quotedHtml, _contextHtml: contextHtml } : data;
  return windows.map(w => w.id === target.id
    ? { ...w, replyTo, snapshot: withQuote(w.snapshot), initialData: withQuote(w.initialData) } : w);
}
