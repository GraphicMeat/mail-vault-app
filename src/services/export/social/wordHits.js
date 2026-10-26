import { wordTokens, wordKey } from '../../../utils/privacy/wordKey';
import { maskText } from '../../../utils/privacy/piiDetector';
import { headerCardHtml } from '../exportDocument';

/**
 * The hit map of a social card: where each readable word sits on the content
 * canvas, so a click on the preview can redact or reveal it.
 *
 * Built in three steps. collectWords measures the rendered (already masked)
 * document: each word's text and rects, and for a word inside a mask the index
 * of the mask (`data-mv-i`, put there by redactBodyForExport's onText hook; the
 * original itself is never in the markup). resolveWords turns each into
 * `{ k, on, rects }`: k its wordKey, on whether it is masked now. The header is
 * masked as plain text, so its words are matched to the unmasked header's by
 * order, and any word that does not fit the match (it is not the same word, or
 * masked in a way a click could not undo) is left out: a click never lands on
 * the wrong word.
 */

// A page with more words than this is mapped up to here: the Range work per word is the cost.
export const MAX_WORDS = 6000;
const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'TITLE']);

function textNodes(doc) {
  const walker = doc.createTreeWalker(doc.body, 4 /* SHOW_TEXT */, {
    acceptNode: node => (SKIP.has(node.parentNode?.nodeName?.toUpperCase()) ? 2 : 1),
  });
  const out = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n);
  return out;
}

/**
 * Every word of a laid-out document with its rects, in canvas pixels
 * (`scale` is the rasterizer's): `{ i, ti, mask, text, rects }`. `i` counts
 * every word in document order, ones with no rect (hidden) included; `mask` is
 * the enclosing mask's index or null; `ti` the word's place inside that mask.
 */
export function collectWords(doc, scale = 1) {
  const words = [];
  let i = 0;
  for (const node of textNodes(doc)) {
    const span = node.parentNode?.closest?.('.mv-pii[data-mv-i]');
    const mask = span ? Number(span.getAttribute('data-mv-i')) : null;
    for (const [ti, t] of wordTokens(node.data).entries()) {
      const at = i++;
      if (words.length >= MAX_WORDS) continue;
      const range = doc.createRange();
      range.setStart(node, t.start);
      range.setEnd(node, t.end);
      const rects = [...(range.getClientRects?.() ?? [])]
        .filter(r => r.width > 0 && r.height > 0)
        .map(r => [r.left * scale, r.top * scale, r.width * scale, r.height * scale]);
      if (rects.length) words.push({ i: at, ti, mask, text: t.text, rects });
    }
  }
  return words;
}

/** The words of the unmasked header, in document order: what the masked header's words are matched to. */
export function plainHeaderWords(message, { hideTo = false } = {}) {
  const doc = new DOMParser().parseFromString(`<body>${headerCardHtml(message, { hideTo })}</body>`, 'text/html');
  return textNodes(doc).flatMap(node => wordTokens(node.data));
}

// The rendered word is the plain one, or the plain one with some letters and
// digits turned to x (a mask, or the part of a word a mask covers).
export function sameWord(plain, rendered) {
  if (plain.length !== rendered.length) return false;
  for (let c = 0; c < plain.length; c++) if (rendered[c] !== plain[c] && rendered[c] !== 'x') return false;
  return true;
}

/**
 * `raw`: the words collectWords found in the header (`head`) and the body
 * (`body`, rects already below the header). `masks`: the originals the body's
 * masks hide, by index. `plainHead`: plainHeaderWords. Returns `[{ k, on, rects }]`.
 */
export function resolveWords({ head = [], body = [], masks = [], plainHead = [] }) {
  const out = [];
  for (const w of head) {
    const plain = plainHead[w.i];
    if (!plain || !sameWord(plain.text, w.text)) continue;
    out.push({ k: plain.key, on: w.text !== plain.text, rects: w.rects });
  }
  for (const w of body) {
    if (w.mask == null) { out.push({ k: wordKey(w.text), on: false, rects: w.rects }); continue; }
    const original = wordTokens(masks[w.mask] ?? '')[w.ti];
    // A mask is x's: the word read back from it must be the one it hides, in size.
    if (original && w.text === maskText(original.text)) out.push({ k: original.key, on: true, rects: w.rects });
  }
  return out;
}

/**
 * A point on the shown preview (`x`, `y` in CSS px from its corner, `shown` its
 * CSS size) as a point on the content canvas, or null when it falls outside the
 * content (on the background, the frame or the lockup). `full` is the whole
 * image's size and `layout` layoutSocial's for it.
 */
export function contentPointAt({ x, y, shown, full, layout }) {
  const c = layout.content;
  const fx = (x * full.w) / shown.w;
  const fy = (y * full.h) / shown.h;
  if (fx < c.dx || fy < c.dy || fx >= c.dx + c.dw || fy >= c.dy + c.dh) return null;
  return { x: c.sx + ((fx - c.dx) * c.sw) / c.dw, y: c.sy + ((fy - c.dy) * c.sh) / c.dh };
}

/** The word under a point of the content canvas, or null. */
export function wordAt(words, point) {
  if (!point || !words) return null;
  return words.find(w => w.rects.some(([rx, ry, rw, rh]) => point.x >= rx && point.x < rx + rw && point.y >= ry && point.y < ry + rh)) ?? null;
}
