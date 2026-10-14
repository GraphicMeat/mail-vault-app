// Selection belongs to the reply trigger, not the asynchronous body resolver.
// It is converted to inert HTML because it joins the quote later.
export function replySelection(root, selection = typeof document === 'undefined' ? null : document.getSelection?.()) {
  if (!selectionWithin(root, selection)) return '';
  return quoteText(selection.toString());
}

// The quote of a selection in an alternative body renderer, from its handle
// `{ selectionRoot(), selectionText() }`: the body's own text for the
// selection (Blitz: its copy text, which keeps the <br> newlines its layer
// draws as spaces) when the selection lies inside its root, escaped as
// replySelection escapes; else replySelection over its root, or over
// `fallbackRoot` (the plain body) when it has none (held, failed, absent).
export function altBodyQuote(alt, selection, fallbackRoot = null) {
  const root = alt?.selectionRoot?.() ?? null;
  const own = root && alt.selectionText && selectionWithin(root, selection) ? alt.selectionText() : '';
  return own ? quoteText(own) : replySelection(root ?? fallbackRoot, selection);
}

// A live selection that lies inside `root`: the only one a reply may quote.
export function selectionWithin(root, selection) {
  if (!root || !selection || selection.isCollapsed || !selection.rangeCount) return false;
  return root.contains(selection.getRangeAt(0).commonAncestorContainer);
}

// Selected plain text as inert quote HTML: escaped, line breaks as <br>.
export function quoteText(text) {
  return String(text)
    .replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char]))
    .replace(/\r?\n/g, '<br>');
}
