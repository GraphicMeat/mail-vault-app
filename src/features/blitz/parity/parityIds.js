// Parity ids for the Blitz parity harness (plan B). This one function stamps
// the Blitz pre-pass document and also measures the iframe's live document
// (the e2e spec serialises it), so both sides name every element the same way.
//
// An id is the element's path below <body>: `tag[n]` segments joined by '/'.
// n counts siblings of the same tag that are not skipped. Skipped are
// <script> and Dark Reader's own nodes (`.darkreader`), with their subtrees.
// It is a path, not a running counter, so a node that one side inserts
// cannot shift every id after it.
//
// SELF-CONTAINED: no imports and no outer references.
export function assignParityIds(root, stamp) {
  const out = [];
  const skip = (el) => el.localName === 'script' || !!(el.classList && el.classList.contains('darkreader'));
  const walk = (parent, prefix) => {
    const counts = {};
    for (let el = parent.firstElementChild; el; el = el.nextElementSibling) {
      if (skip(el)) continue;
      const tag = el.localName;
      counts[tag] = (counts[tag] || 0) + 1;
      const id = `${prefix}${tag}[${counts[tag]}]`;
      if (stamp) el.setAttribute('data-mv-id', id);
      out.push({ el, id });
      walk(el, `${id}/`);
    }
  };
  if (root) walk(root, '');
  return out;
}

/** Pre-pass step 6: stamp ids only when the e2e harness asks. */
export function stampParityIds(doc) {
  if (!globalThis.__MV_PARITY__ || !doc?.body) return 0;
  return assignParityIds(doc.body, true).length;
}
