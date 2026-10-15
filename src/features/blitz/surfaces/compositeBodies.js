import { imageRender } from '../service';
import { decodePng } from './rasterize';
import { usePrivacyStore, isPrivacyMasking } from '../../../stores/privacyStore';

const box = (r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
function intersect(a, b) {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

/** The part of an element on screen: clipped by every scrolling or clipping ancestor up to the root. */
function visibleRect(el, root) {
  let r = intersect(box(el.getBoundingClientRect()), box(root.getBoundingClientRect()));
  for (let p = el.parentElement; p && p !== root; p = p.parentElement) {
    const cs = getComputedStyle(p);
    if (/(auto|scroll|hidden|clip)/.test(`${cs.overflowX} ${cs.overflowY}`)) r = intersect(r, box(p.getBoundingClientRect()));
  }
  return r;
}

/**
 * The app shot (captureAppWindow) clones the DOM without the Blitz tile layers
 * (data-capture-exclude) and calls this to paint each settled body over its
 * visible rect, from the live doc (render.image).
 *
 * A busy body is never drawn: its doc is not the current one, and the hold box
 * carries data-blitz-masked="true" even with privacy off. Under a redacted
 * capture or any privacy masking, a body not rendered masked is never drawn
 * either (fail closed); a masked doc is already redacted by the pre-pass.
 *
 * Opens and closes nothing: a doc the worker lost (render_unknown_doc) or a
 * PNG that does not decode skips that body and the rest still draw.
 */
export async function compositeBlitzBodies(canvas, root, { scale, redact }, deps = { imageRender, decode: decodePng }) {
  const masking = !!redact || isPrivacyMasking(usePrivacyStore.getState());
  const rootRect = root.getBoundingClientRect();
  const settled = (body, docId) => body.isConnected
    && body.getAttribute('aria-busy') !== 'true'
    && body.getAttribute('data-blitz-doc') === docId
    && (!masking || body.getAttribute('data-blitz-masked') === 'true');
  let ctx = null;
  let drawn = 0;
  for (const body of root.querySelectorAll('[data-renderer="blitz"]')) {
    if (body.closest('[data-capture-exclude]')) continue;
    const docId = body.getAttribute('data-blitz-doc');
    const tiles = body.querySelector('[data-blitz-tiles]');
    if (!tiles || docId == null || !settled(body, docId)) continue;
    const vis = visibleRect(tiles, root);
    if (vis.width <= 0 || vis.height <= 0) continue;
    let bitmap;
    try { bitmap = await deps.decode((await deps.imageRender(Number(docId))).png); } catch { continue; }
    // The body may have re-rendered (privacy flip, new message) while the image was made.
    if (!settled(body, docId)) continue;
    const r = tiles.getBoundingClientRect();
    ctx ||= canvas.getContext('2d');
    ctx.save();
    ctx.beginPath();
    ctx.rect((vis.left - rootRect.left) * scale, (vis.top - rootRect.top) * scale, vis.width * scale, vis.height * scale);
    ctx.clip();
    ctx.drawImage(bitmap, (r.left - rootRect.left) * scale, (r.top - rootRect.top) * scale, r.width * scale, r.height * scale);
    ctx.restore();
    drawn += 1;
  }
  return drawn;
}
