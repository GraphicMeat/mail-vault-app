import { utf16ToUtf8, utf8Length } from './textMetrics';

const SPAN = 'span[data-node]';

function spans(layerEl) {
  return [...layerEl.querySelectorAll(SPAN)];
}

export function selectionInLayer(selection, layerEl) {
  if (!selection || !layerEl || selection.rangeCount === 0 || selection.isCollapsed) return false;
  return selection.getRangeAt(0).intersectsNode(layerEl);
}

// Endpoints speak the worker's language: the inline root's node id and a UTF-8
// byte offset into its layout text. `data-start` is the span's own byte start;
// the DOM offset inside it is UTF-16 and converts without splitting a code point.
const at = (span, utf16) => ({
  node: Number(span.dataset.node),
  offset: Number(span.dataset.start) + utf16ToUtf8(span.textContent, utf16),
});
const startOf = (span) => ({ node: Number(span.dataset.node), offset: Number(span.dataset.start) });
const endOf = (span) => ({ node: Number(span.dataset.node), offset: Number(span.dataset.start) + utf8Length(span.textContent) });

/** The span a DOM boundary point resolves to, as [span, utf16 offset in it]. */
function resolve(container, offset, layerEl, all, edge) {
  const whole = document.createRange();
  whole.selectNodeContents(layerEl);
  // A point outside the layer clamps to the layer's first or last span.
  if (!layerEl.contains(container)) {
    const side = whole.comparePoint(container, offset);
    const span = side < 0 ? all[0] : all[all.length - 1];
    return span ? [span, side < 0 ? 0 : span.textContent.length] : null;
  }
  if (container.nodeType === 3) {
    const span = container.parentElement.closest(SPAN);
    if (span) return [span, offset];
  }
  // An element boundary: the span at or after (start) / before (end) that point.
  const probe = document.createRange();
  probe.setStart(container, offset);
  if (edge === 'start') {
    const span = all.find(s => probe.comparePoint(s, 0) >= 0);
    return span ? [span, 0] : null;
  }
  const span = [...all].reverse().find(s => probe.comparePoint(s, s.childNodes.length) <= 0);
  return span ? [span, span.textContent.length] : null;
}

// A selection only partly inside the layer (a drag from the header into the
// body, one body of a thread) clamps to the layer's first/last span. How text
// outside the layer, or several bodies, compose into one copy is plan D's call.
export function selectionEndpoints(selection, layerEl) {
  if (!selectionInLayer(selection, layerEl)) return null;
  const all = spans(layerEl);
  if (!all.length) return null;
  const r = selection.getRangeAt(0);
  const s = resolve(r.startContainer, r.startOffset, layerEl, all, 'start');
  const e = resolve(r.endContainer, r.endOffset, layerEl, all, 'end');
  if (!s || !e) return null;
  return {
    start: s[1] === 0 ? startOf(s[0]) : at(s[0], s[1]),
    end: e[1] === e[0].textContent.length ? endOf(e[0]) : at(e[0], e[1]),
  };
}

// A range boundary inside `span` as a UTF-16 index into its text; a boundary
// on the span element itself is its child index (0 or 1).
function within(span, container, offset, fallback) {
  if (container === span) return offset > 0 ? span.textContent.length : 0;
  return span.contains(container) ? offset : fallback;
}

// Between two selected spans: a new inline root is a new line. Within one
// root the byte gap between the spans decides (a dropped unselectable run
// leaves one): none means the text is contiguous.
function separator(prev, span) {
  if (prev.dataset.node !== span.dataset.node) return '\n';
  const gap = Number(span.dataset.start) - (Number(prev.dataset.start) + utf8Length(prev.textContent));
  return gap > 0 ? ' ' : '';
}

/**
 * The selected layer text, roots joined by "\n": the plain-copy and reply
 * fallback. A span that draws a newline or a tab as a space keeps its real
 * text in `data-raw` (same length), and that is what is read.
 */
export function layerPlainText(selection, layerEl) {
  if (!selectionInLayer(selection, layerEl)) return '';
  const r = selection.getRangeAt(0);
  let out = '';
  let prev = null;
  for (const span of spans(layerEl)) {
    if (!r.intersectsNode(span)) continue;
    const shown = span.textContent;
    const t = span.dataset.raw?.length === shown.length ? span.dataset.raw : shown;
    const from = within(span, r.startContainer, r.startOffset, 0);
    const to = within(span, r.endContainer, r.endOffset, t.length);
    if (prev) out += separator(prev, span);
    out += t.slice(from, to);
    prev = span;
  }
  return out;
}

export function selectLayer(layerEl, first, last) {
  if (!first || !last) return;
  const r = document.createRange();
  r.setStart(first.firstChild || first, 0);
  const end = last.firstChild || last;
  r.setEnd(end, end.length ?? end.childNodes.length);
  const s = window.getSelection();
  s.removeAllRanges();
  s.addRange(r);
}
