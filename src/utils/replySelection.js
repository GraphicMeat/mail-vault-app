// Selection belongs to the reply trigger, not the asynchronous body resolver.
// It is converted to inert HTML because it joins the quote later.
export function replySelection(root, selection = typeof document === 'undefined' ? null : document.getSelection?.()) {
  if (!selectionWithin(root, selection)) return '';
  return quoteText(selection.toString());
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
