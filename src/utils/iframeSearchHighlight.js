/**
 * Highlight the search terms inside the message body.
 *
 * The body renders in a same-origin iframe whose document we build ourselves,
 * so the parent can walk it directly — no script injected into the frame (the
 * frame's CSP would need a nonce), and, more importantly, no change to the
 * srcDoc: that string is memoized behind the tracker scan and the link scan,
 * and folding the query into it would rebuild and reload the whole frame on
 * every keystroke.
 *
 * Only text nodes are touched, one at a time, so a match can never span an
 * element boundary and the markup around it is left exactly as the mail
 * author wrote it. Clearing puts the original text nodes back.
 */

const MARK_CLASS = 'mv-search-hit';
const STYLE_ID = 'mv-search-hit-style';
// Their text is markup, not reading matter; `TEXTAREA` because a value is not
// something to rewrite under the user.
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA']);

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The terms worth marking: lowercased, deduped, one character dropped.
 * A single letter would paint most of the message.
 */
export function highlightTerms(query) {
  return [...new Set(String(query || '').toLowerCase().split(/\s+/).filter(t => t.length >= 2))];
}

/** Put every marked run back as plain text. Safe on a frame that has gone. */
export function clearSearchHighlight(doc) {
  const marks = doc?.body?.querySelectorAll?.(`mark.${MARK_CLASS}`);
  if (!marks?.length) return;
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (!parent) continue;
    parent.replaceChild(doc.createTextNode(mark.textContent), mark);
    // Or the next pass sees the run split into three nodes and misses a match
    // that straddles the seam.
    parent.normalize();
  }
}

function ensureStyle(doc) {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  // Colours are pinned rather than themed: this element is created after Dark
  // Reader has run, so it inherits none of its work, and black on amber reads
  // in both themes.
  style.textContent = `mark.${MARK_CLASS}{background:#ffd54f;color:#000;border-radius:2px;padding:0 1px;}`;
  (doc.head || doc.body).appendChild(style);
}

/**
 * Mark every occurrence of `terms` in `doc`. Returns the number of hits drawn.
 * An empty term list just clears — that is what closing the search does.
 */
export function applySearchHighlight(doc, terms) {
  clearSearchHighlight(doc);
  if (!doc?.body || !terms?.length) return 0;

  const re = new RegExp(terms.map(escapeRegExp).join('|'), 'gi');
  // Collected first: replacing a node while the walker is on it invalidates
  // the traversal.
  const walker = doc.createTreeWalker(doc.body, 4 /* SHOW_TEXT */, {
    acceptNode: (node) => (node.data.trim() && !SKIP_TAGS.has(node.parentNode?.nodeName)
      ? 1 /* ACCEPT */
      : 2 /* REJECT */),
  });
  const nodes = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);

  let hits = 0;
  for (const node of nodes) {
    const text = node.data;
    re.lastIndex = 0;
    let match;
    let last = 0;
    let fragment = null;
    while ((match = re.exec(text)) !== null) {
      fragment ||= doc.createDocumentFragment();
      if (match.index > last) fragment.appendChild(doc.createTextNode(text.slice(last, match.index)));
      const mark = doc.createElement('mark');
      mark.className = MARK_CLASS;
      mark.textContent = match[0];
      fragment.appendChild(mark);
      last = match.index + match[0].length;
      hits++;
    }
    if (!fragment) continue;
    if (last < text.length) fragment.appendChild(doc.createTextNode(text.slice(last)));
    node.parentNode?.replaceChild(fragment, node);
  }

  if (hits) ensureStyle(doc);
  return hits;
}
