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
// Pure and React-free so it can be unit tested without a live ComposeModal:
// App.jsx supplies `buildQuote` (a synchronous `replyTo => { quotedHtml,
// contextHtml }`, imported dynamically there so a plain reply-fill never
// pulls TipTap into App's own chunk — see src/utils/replyQuote.js).
export function applyReplyFill(windows, { mode, replyTo, _fillFrom }, buildQuote) {
  const target = windows.find(w => sameReply(w, { mode, replyTo: _fillFrom }));
  // Gone (sent/discarded/closed): nothing to patch, and never create one.
  // Detached: a native window's state lives in its own webview, not here
  // (services/composeWindow.js) — not fed through this path.
  if (!target || target.detached) return windows;
  if (!target.minimized) {
    // The live ComposeModal instance picks this up itself (its
    // `quotedBodyReadyRef` effect) and rebuilds the quote without touching
    // anything already typed.
    return windows.map(w => (w.id === target.id ? { ...w, replyTo } : w));
  }
  // Minimized: no ComposeModal is mounted to react to a patched `replyTo` —
  // restoreCompose reads straight from snapshot/initialData, so the quote
  // has to land there instead. `minimized` itself is left alone.
  const { quotedHtml, contextHtml } = buildQuote(replyTo);
  const withQuote = data => data && { ...data, _quotedHtml: quotedHtml, _contextHtml: contextHtml };
  return windows.map(w => (w.id === target.id
    ? { ...w, replyTo, snapshot: withQuote(w.snapshot), initialData: withQuote(w.initialData) }
    : w));
}
