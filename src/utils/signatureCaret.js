// Where the caret belongs when Tab leaves the subject: the end of the writing
// space, not wherever the editor was last. The body is built as
// `<p></p><p>--</p>` + signature (see ComposeModal's signatureHtml), so the writing
// space ends at the node in front of that `--` paragraph — a reply's quote and
// the signature both sit after it. Returns null when there is no separator
// (signature off), and the caller falls back to the top of the document, which
// is where a reply is written.
export function signatureCaretPos(doc) {
  let target = null;
  let prevOffset = 0;
  let prevSize = 0;
  doc.forEach((node, offset, index) => {
    if (target == null && index > 0 && node.textContent.trim() === '--') {
      target = prevOffset + prevSize - 1;
    }
    prevOffset = offset;
    prevSize = node.nodeSize;
  });
  return target;
}

// The blank line in front of `--`, as ComposeModal writes it and as the editor
// hands it back once it has padded it for display.
const BLANKS = ['<p></p>', '<p><br></p>'];

/**
 * Swap one signature block (`<p></p><p>--</p>` + signature) for another in a
 * body the person may already be writing. `above` is for a forward, whose
 * signature sits over the original rather than under the text.
 * ponytail: matches the block as written; a signature edited by hand in the
 * body is not found, so the new one is added beside it.
 */
export function swapSignature(body, from, to, { above = false } = {}) {
  const core = from.replace(/^<p><\/p>/, '');
  const at = core ? (above ? body.indexOf(core) : body.lastIndexOf(core)) : -1;
  if (at !== -1) {
    const blank = BLANKS.find(b => body.slice(0, at).endsWith(b)) || '';
    return body.slice(0, at - blank.length) + to + body.slice(at + core.length);
  }
  if (!to) return body;
  return above ? to + body : body + to;
}
