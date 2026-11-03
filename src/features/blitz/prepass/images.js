// The worker refuses a picture too large to draw (src-render/src/refused.rs) and reports its box
// by number. The number is stamped here, on every <img> in document order, so the reader can find
// the picture's src again without trusting that two parsers agree on what counts as an <img>.
const STAMP = 'data-mv-img';

export function stampImages(doc) {
  let n = 0;
  for (const img of doc.querySelectorAll('img')) img.setAttribute(STAMP, String(n++));
}

// The src of the picture stamped `id` in the pre-passed `html`, or null. Parsed on demand: it is
// only asked when someone clicks, and a src can be tens of MB, so none is kept around.
export function imageSrcAt(html, id) {
  if (!html || !/^\d+$/.test(String(id))) return null;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return doc.querySelector(`img[${STAMP}="${id}"]`)?.getAttribute('src') ?? null;
}
