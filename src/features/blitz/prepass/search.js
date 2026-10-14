// The open search's terms, painted with the iframe's own highlighter on the
// pre-pass document: same marks, same pinned style. Runs AFTER privacy (as
// in the iframe: useBodyPrivacy, then useSearchHighlight on release), so a
// mark never splits a name before the redaction pass sees it.
import { applySearchHighlight, highlightTerms } from '../../../utils/iframeSearchHighlight';

export function markSearch(doc, searchQuery) {
  let hits = applySearchHighlight(doc, highlightTerms(searchQuery));
  // A fold toggle's label is one text node the worker rewrites on a click; the
  // iframe's own toggle assigns textContent, so a mark never survives there.
  for (const mark of doc.querySelectorAll('[data-mv-fold-toggle] mark.mv-search-hit')) {
    const toggle = mark.closest('[data-mv-fold-toggle]');
    mark.replaceWith(doc.createTextNode(mark.textContent));
    toggle.normalize();
    hits--;
  }
  return hits;
}
