// Offsets: the worker speaks UTF-8 bytes into its layout text; the DOM
// speaks UTF-16 code units. Conversions never split a code point.
const encoder = new TextEncoder();

export function utf8Length(s) {
  return encoder.encode(s).length;
}

/** UTF-8 byte offset of UTF-16 index `i` in `s`; inside a surrogate pair snaps back. */
export function utf16ToUtf8(s, i) {
  let k = Math.max(0, Math.min(i, s.length));
  const code = s.charCodeAt(k - 1);
  if (k > 0 && k < s.length && code >= 0xd800 && code <= 0xdbff) k -= 1;
  return utf8Length(s.slice(0, k));
}

const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

export function graphemeCount(s) {
  if (!s) return 0;
  if (!segmenter) return [...s].length;
  let n = 0;
  for (const _ of segmenter.segment(s)) n++; // eslint-disable-line no-unused-vars
  return n;
}

/** letter-spacing that makes `run.text` at `run.fontPx` exactly `run.w` wide. */
export function fitRun(run, measure) {
  const n = graphemeCount(run.text);
  if (!n) return { letterSpacing: 0, width: run.w };
  const measured = measure(run.text, run.fontPx) || 0;
  const letterSpacing = (run.w - measured) / n;
  return { letterSpacing: Number.isFinite(letterSpacing) ? letterSpacing : 0, width: run.w };
}

/** Canvas text width in CSS px, in the layer's own font. */
export function createMeasure(fontFamily) {
  let ctx = null;
  const cache = new Map();
  return (text, fontPx) => {
    const key = `${fontPx}\u0000${text}`;
    if (cache.has(key)) return cache.get(key);
    if (!ctx) {
      const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas');
      ctx = canvas.getContext('2d');
    }
    if (!ctx) return 0;
    ctx.font = `${fontPx}px ${fontFamily}`;
    const w = ctx.measureText(text).width;
    if (cache.size > 5000) cache.clear();
    cache.set(key, w);
    return w;
  };
}
