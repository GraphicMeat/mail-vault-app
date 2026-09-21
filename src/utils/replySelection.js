// Selection belongs to the reply trigger, not the asynchronous body resolver.
// It is converted to inert HTML because it joins the quote later.
export function replySelection(root, selection = typeof document === 'undefined' ? null : document.getSelection?.()) {
  if (!root || !selection || selection.isCollapsed || !selection.rangeCount) return '';
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return '';
  return String(selection.toString())
    .replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char]))
    .replace(/\r?\n/g, '<br>');
}
