const escapeHtml = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// Convert plain text to basic HTML for initial editor content. Escaped: a
// received plain-text mail is quoted through here, and "Ann <ann@x.com> wrote:"
// or a pasted tag is characters, never markup.
export function textToHtml(text) {
  if (!text) return '';
  return text
    .split('\n')
    .map(line => `<p>${escapeHtml(line) || '<br>'}</p>`)
    .join('');
}
