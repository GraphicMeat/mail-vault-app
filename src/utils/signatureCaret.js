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
